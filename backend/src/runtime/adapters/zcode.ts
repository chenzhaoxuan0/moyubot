/**
 * ZCode 执行器适配器 —— 双传输：app-server（全能力，首选）+ `-p --json`（自动回退）。
 *
 * 【app-server 路径】`zcode app-server --stdio`（ZCode Protocol v1，NDJSON JSON-RPC 方言）：
 * - 真流式：session/subscribe 后 model.streaming(text_delta/reasoning_delta) 逐块推送；
 * - 工具事件：tool.updated(scheduled/result/error) → tool.started/completed；
 * - 权限反向流：interaction/requestPermission 挂起 → permission.requested →
 *   resolvePermission 应答 —— 与 Phase 4 权限闸/前端权限卡真实闭环（mode=build 时生效）；
 * - 多轮：同会话 session/send 原生续聊；usage 真 provider 计数（turn 级，缺时差值兜底）；
 * - 认证：standalone 引导读共享凭据库 + 内部认证头端口，daemon 无需任何 key。
 *
 * 【fork 前置补丁】（awb/standalone-app-server 分支，已并入本机安装的 CLI）：
 * app-server 入口原先不传 standalone 引导（-p/TUI 传了），registry 恒空 →
 * "Select a model before continuing"；且认证头端口不内接，turn 死在 prepare。
 * 两处都在 apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts。
 *
 * 【回退】app-server 起不动（未打补丁的安装 / registry 空 / spawn 失败）时，
 * 进程级降级到 -p 路径：真实回复/usage/多轮（--resume）仍在，但无流式、
 * 无工具事件、无权限流（yolo 单轮）。能力边界见 PrintTransport。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import { hasDotSegment, listMarkdownFilesPruned } from "./discovery.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
  UnitId,
} from "../../contract.ts";
import { isShellTool } from "../../contract.ts";
import { execLines, resolveCommand, spawnLines, type ResolvedCommand } from "../exec.ts";
import { ZCODE_METHODS, type ZcodeFrameLoose, type ZcodeSessionEventEnvelope } from "./zcode-protocol.ts";
import { log } from "../../log.ts";

const RPC_TIMEOUT_MS = 180_000;
/** 本机（bigmodel 个人套餐）的 registry providerId；写错会被 create 拒绝并回落默认模型 */
const CODING_PLAN_PROVIDER_ID = "account:bigmodel-individual-coding-plan";


// ---- 翻译辅助 --------------------------------------------------------------

function classifyPermission(toolName: string): "file_write" | "shell" | "network" | "tool" {
  const n = toolName.toLowerCase();
  if (/edit|write|patch|apply|replace/.test(n)) return "file_write";
  if (isShellTool(toolName)) return "shell";
  if (/fetch|web|http|curl|browser|search/.test(n)) return "network";
  return "tool";
}

function mapRisk(riskLevel: unknown): "low" | "medium" | "high" {
  if (riskLevel === "low") return "low";
  if (riskLevel === "high" || riskLevel === "critical") return "high";
  return "medium";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ==== 传输一：app-server（全能力）==========================================

interface AppServerSessionState {
  readonly sessionId: SessionId;
  readonly unitId: UnitId;
  readonly model: ModelId | null;
  readonly rootPath: string;
  sink: AdapterSink | null;
  currentMessageId: string | null;
  ended: boolean;
  /** resume/订阅完成门：send 必须等它（否则竞态打在不活跃会话上——冒烟实证） */
  ready: Promise<void>;
  /** turn 级 usage 缺失时用 session/usage 总量差值兜底 */
  cumulative: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** toolCallId → server 反向请求 id（权限应答按原 id 回；"" = 反向请求未到） */
  readonly pendingPermissions: Map<string, string>;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
}

export class ZcodeAppServerTransport {
  private child: ChildProcess | null = null;
  private connecting: Promise<void> | null = null;
  private rpcSeq = 0;
  private readonly pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly sessions = new Map<string, AppServerSessionState>();

  async ensureConnected(): Promise<void> {
    if (this.child !== null && this.child.exitCode === null) return;
    if (this.connecting !== null) return this.connecting;

    this.connecting = (async () => {
      const cmd = await resolveCommand("zcode");
      const child = spawnLines(cmd, ["app-server", "--stdio"], {
        closeStdin: false, // stdin 就是协议通道，EOF = 服务端优雅退出（冒烟实证）
        onLine: (line) => this.handleLine(line),
        onStderrLine: (line) => log.debug("zcode app-server stderr", { line: line.slice(0, 200) }),
        onExit: (code) => {
          log.warn("zcode app-server exited", { code });
          this.child = null;
          this.connecting = null;
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(Object.assign(new Error("zcode app-server process exited"), { code: "adapter_died" }));
          }
          this.pending.clear();
          for (const st of this.sessions.values()) this.failSession(st, "executor process exited", "executor_exited");
        },
      });
      this.child = child;
      log.info("zcode app-server spawned", { pid: child.pid, via: cmd.via });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let msg: ZcodeFrameLoose;
    try {
      msg = JSON.parse(line) as ZcodeFrameLoose;
    } catch {
      log.warn("zcode app-server sent non-JSON line", { line: line.slice(0, 120) });
      return;
    }

    // 对 client 请求的响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        p.reject(Object.assign(new Error(msg.error.message ?? "protocol error"), { code: `proto_${msg.error.code ?? "unknown"}` }));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // 通知：事件流
    if (msg.method === "session/event") {
      void this.dispatchProtocolEvent((msg.params ?? {}) as ZcodeSessionEventEnvelope);
      return;
    }

    // 反向请求：每类响应都有严格 schema，必须按各自形状回
    if (msg.id !== undefined && msg.method !== undefined) {
      this.handleReverseRequest(String(msg.id), msg.method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
  }

  private writeLine(frame: unknown): void {
    this.child?.stdin?.write(JSON.stringify(frame) + "\n");
  }

  rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    return this.ensureConnected().then(() => new Promise<T>((resolve, reject) => {
      const id = String(++this.rpcSeq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: "rpc_timeout" }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.writeLine({ id, method, params });
    }));
  }

  /** fork 补丁未安装（registry 空）时的特征错误 —— 触发进程级降级到 -p */
  static isRegistryEmptyError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Select a model|Provider Registry/i.test(msg);
  }

  private emitFor(st: AppServerSessionState, event: RuntimeEvent): void {
    if (st.ended && event.type !== "session.ended" && event.type !== "error") return;
    st.sink?.(event);
  }

  private failSession(st: AppServerSessionState, message: string, reason: string): void {
    if (st.ended) return;
    st.ended = true;
    this.denyPendingPermissions(st, reason);
    st.sink?.({ type: "error", sessionId: st.sessionId, message, recoverable: false });
    st.sink?.({ type: "session.ended", sessionId: st.sessionId, reason });
  }

  private async dispatchProtocolEvent(p: ZcodeSessionEventEnvelope): Promise<void> {
    const sessionId = str(p.sessionId);
    if (sessionId === undefined) return;
    const st = this.sessions.get(sessionId);
    if (st === undefined) return;

    const payload = p.payload ?? {};
    switch (p.type) {
      case "turn.started": {
        st.currentMessageId = str(payload["messageId"]) ?? null;
        break;
      }
      // 真流式：model.streaming 是协议暴露的增量通道（part.delta 在该 deliveryKind 下不到）
      case "model.streaming": {
        const kind = str(payload["kind"]);
        const delta = str(payload["delta"]);
        if (delta === undefined || delta === "") break;
        const messageId = str(payload["assistantMessageId"]) ?? st.currentMessageId ?? `msg_${String(p.seq ?? 0)}`;
        if (kind === "text_delta") {
          this.emitFor(st, { type: "message.delta", sessionId: st.sessionId, messageId, role: "assistant", text: delta });
        } else if (kind !== undefined && kind.startsWith("reasoning")) {
          this.emitFor(st, { type: "reasoning.delta", sessionId: st.sessionId, messageId, text: delta });
        }
        break;
      }
      case "tool.updated": {
        const kind = str(payload["kind"]);
        const callId = str(payload["toolCallId"]);
        if (callId === undefined) break;
        if (kind === "scheduled") {
          st.pendingPermissions.set(callId, "");
          const toolName = str(payload["toolName"]) ?? "tool";
          this.emitFor(st, {
            type: "tool.started",
            sessionId: st.sessionId,
            callId,
            toolName,
            title: str(payload["description"]) ?? toolName,
            input: payload["input"] ?? null,
          });
        } else if (kind === "result") {
          st.pendingPermissions.delete(callId);
          this.emitFor(st, {
            type: "tool.completed",
            sessionId: st.sessionId,
            callId,
            ok: true,
            output: JSON.stringify(payload["result"] ?? null),
          });
        } else if (kind === "error") {
          st.pendingPermissions.delete(callId);
          this.emitFor(st, {
            type: "tool.completed",
            sessionId: st.sessionId,
            callId,
            ok: false,
            output: JSON.stringify(payload["error"] ?? "tool error"),
          });
        }
        // started/progress/batch 是协议内部的精细态，契约里没有对应事件
        break;
      }
      case "turn.completed": {
        const response = str(payload["response"]) ?? "";
        const messageId = st.currentMessageId ?? `msg_${String(p.seq ?? 0)}`;
        this.emitFor(st, { type: "message.completed", sessionId: st.sessionId, messageId, text: response });
        await this.emitUsage(st, payload);
        this.denyPendingPermissions(st, "turn finished");
        // agent loop 语义：一轮完成 ≠ 会话结束。会话保持开启，session/send 续聊；
        // session.ended 只在 session.closed / 执行器退出时发。
        const resultType = str(payload["resultType"]) ?? "completed";
        this.emitFor(st, {
          type: "session.status",
          sessionId: st.sessionId,
          status: resultType === "success" ? "idle" : `failed:${resultType}`,
        });
        break;
      }
      case "turn.failed": {
        const err = payload["error"] as { message?: string } | undefined;
        this.denyPendingPermissions(st, "turn failed");
        this.emitFor(st, { type: "error", sessionId: st.sessionId, message: err?.message ?? "turn failed", recoverable: false });
        // turn 失败通常可重试（模型/网络/配置），会话保持开启
        this.emitFor(st, { type: "session.status", sessionId: st.sessionId, status: "failed" });
        break;
      }
      case "session.closed": {
        if (!st.ended) {
          st.ended = true;
          this.denyPendingPermissions(st, "session closed");
          this.emitFor(st, { type: "session.ended", sessionId: st.sessionId, reason: str(payload["reason"]) ?? "closed" });
        }
        break;
      }
      default:
        break;
    }
  }

  private async emitUsage(st: AppServerSessionState, turnPayload: Record<string, unknown>): Promise<void> {
    let input = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["inputTokens"]);
    let output = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["outputTokens"]);
    let cacheRead = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["cacheReadTokens"]);
    let cacheWrite = num((turnPayload["usage"] as Record<string, unknown> | undefined)?.["cacheCreationTokens"]);
    if (input === undefined || output === undefined) {
      try {
        const snap = await this.rpc<Record<string, unknown>>("session/usage", { sessionId: st.sessionId });
        const tIn = (num(snap["inputTokens"]) ?? 0) + (num(snap["cacheReadTokens"]) ?? 0) + (num(snap["cacheCreationTokens"]) ?? 0);
        const tOut = num(snap["outputTokens"]) ?? 0;
        const tCr = num(snap["cacheReadTokens"]) ?? 0;
        const tCw = num(snap["cacheCreationTokens"]) ?? 0;
        input = Math.max(0, tIn - st.cumulative.input);
        output = Math.max(0, tOut - st.cumulative.output);
        cacheRead = Math.max(0, tCr - st.cumulative.cacheRead);
        cacheWrite = Math.max(0, tCw - st.cumulative.cacheWrite);
        st.cumulative = { input: tIn, output: tOut, cacheRead: tCr, cacheWrite: tCw };
      } catch {
        input = input ?? 0;
        output = output ?? 0;
      }
    }
    this.emitFor(st, {
      type: "usage",
      sessionId: st.sessionId,
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // 套餐按订阅计价，token 是 ground truth；美元由 Phase 6 价目表统一估算
      costUsd: 0,
      model: st.model ?? "zcode-default",
      decodeMs: num(turnPayload["duration"]),
      requestId: `zcode:${st.sessionId}:p${process.pid}:${++st.usageCount}`,
    });
  }

  private denyPendingPermissions(st: AppServerSessionState, why: string): void {
    for (const [callId, serverMsgId] of st.pendingPermissions) {
      if (serverMsgId !== "") {
        this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: why } });
      }
      st.pendingPermissions.delete(callId);
    }
  }

  /**
   * 反向请求分派。schema 事实源：ZCode 克隆 packages/shared/src/zcode-protocol/index.ts。
   * 原则：daemon 是无人值守的 host —— 能自动答的自动答，权限留给前端，绝不悬挂。
   */
  private handleReverseRequest(serverMsgId: string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "interaction/requestPermission":
        this.handlePermissionRequest(serverMsgId, params);
        return;
      case "session/requestRuntimePreferences":
        this.writeLine({ id: serverMsgId, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } });
        return;
      case "interaction/requestUserInput":
        log.warn("declining requestUserInput (no interactive user)", { prompt: params["prompt"] });
        this.writeLine({ id: serverMsgId, result: { action: "decline", reason: "daemon runs unattended" } });
        return;
      case "interaction/requestProviderRuntimeHeaders":
        // fork 补丁接了内部认证头端口后不该到这；到了也如实说没有
        this.writeLine({ id: serverMsgId, result: { headersApplied: false, errorMessage: "daemon holds no provider credentials" } });
        return;
      case "interaction/requestOfficialMcpAuthHeaders":
        this.writeLine({ id: serverMsgId, result: { ok: false, reason: "official_auth_unavailable" } });
        return;
      default:
        log.error("unknown reverse interaction, replying deny", { method, keys: Object.keys(params) });
        this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: `unsupported interaction: ${method}` } });
    }
  }

  private handlePermissionRequest(serverMsgId: string, params: Record<string, unknown>): void {
    const toolCallId = str(params["toolCallId"]) ?? `perm_${serverMsgId}`;
    const toolName = str(params["toolName"]) ?? "tool";
    let st: AppServerSessionState | undefined;
    const sid = str(params["sessionId"]);
    if (sid !== undefined) st = this.sessions.get(sid);
    if (st === undefined) {
      for (const s of this.sessions.values()) {
        if (s.pendingPermissions.has(toolCallId)) { st = s; break; }
      }
    }
    if (st === undefined) {
      this.writeLine({ id: serverMsgId, result: { decision: "deny", reason: "no owning session" } });
      return;
    }
    st.pendingPermissions.set(toolCallId, serverMsgId);
    this.emitFor(st, {
      type: "permission.requested",
      sessionId: st.sessionId,
      requestId: toolCallId,
      kind: classifyPermission(toolName),
      risk: mapRisk(params["riskLevel"]),
      detail: str(params["reason"]) ?? toolName,
    });
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    await this.ensureConnected();

    const createParams: Record<string, unknown> = {
      workspace: { workspacePath: req.rootPath, workspaceKey: req.rootPath },
      mode: req.mode ?? "yolo",
      persistence: "immediate",
    };
    if (req.model !== null) {
      // registry 的 providerId 因登录渠道而异；写错会被 setModel 拒绝 → 回落默认模型
      createParams["model"] = { providerId: CODING_PLAN_PROVIDER_ID, modelId: req.model };
    }

    let created: Record<string, unknown>;
    try {
      created = await this.rpc<Record<string, unknown>>(ZCODE_METHODS.sessionCreate, createParams);
    } catch (err: unknown) {
      if (req.model === null) throw err;
      log.warn("session/create with model failed, using executor default", {
        model: req.model,
        error: err instanceof Error ? err.message : String(err),
      });
      delete createParams["model"];
      created = await this.rpc<Record<string, unknown>>(ZCODE_METHODS.sessionCreate, createParams);
    }

    const session = created["session"] as Record<string, unknown> | undefined;
    const nativeId = str(session?.["sessionId"]);
    if (nativeId === undefined) {
      throw Object.assign(new Error(`session/create returned no sessionId`), { code: "protocol_error" });
    }

    const st: AppServerSessionState = {
      sessionId: nativeId as SessionId,
      unitId: req.unitId,
      model: req.model,
      rootPath: req.rootPath,
      sink,
      currentMessageId: null,
      ended: false,
      ready: Promise.resolve(),
      cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pendingPermissions: new Map(),
      usageCount: 0,
    };
    this.sessions.set(nativeId, st);
    return this.makeAppServerSession(st);
  }

  /** resume：跨 daemon 重启后，新 app-server 进程经 session/resume 载入持久化会话。
   *  workspace 必带 —— 冷恢复按 workspace 定位会话，缺了会报 "Session is not active"（探针实证）。 */
  reattach(state: AppServerSessionState, _ref: string): AdapterSession {
    this.sessions.set(state.sessionId, state);
    const bootstrap = async (): Promise<void> => {
      await this.ensureConnected();
      await this.rpc(ZCODE_METHODS.sessionResume, {
        sessionId: state.sessionId,
        workspace: { workspacePath: state.rootPath, workspaceKey: state.rootPath },
      });
      await this.rpc(ZCODE_METHODS.sessionSubscribe, { sessionId: state.sessionId, deliveryKind: "desktop-continuous" });
    };
    state.ready = bootstrap().catch((err: unknown) => {
      log.warn("zcode session resume failed", {
        sessionId: state.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return this.makeAppServerSession(state);
  }

  private makeAppServerSession(st: AppServerSessionState): AdapterSession {
    // 先订阅再发 prompt，事件一条不漏
    const ensureSubscribed = async (): Promise<void> => {
      await this.rpc(ZCODE_METHODS.sessionSubscribe, { sessionId: st.sessionId, deliveryKind: "desktop-continuous" });
    };

    return {
      id: st.sessionId,
      send: async (text: string) => {
        st.ended = false;
        await st.ready;
        await ensureSubscribed();
        await this.rpc("session/send", { sessionId: st.sessionId, content: text });
      },
      cancel: async () => {
        // session/stop 可插队；turn 会以 resultType:"cancelled" 收尾
        await this.rpc("session/stop", { sessionId: st.sessionId });
      },
      resolvePermission: async (requestId, decision) => {
        const serverMsgId = st.pendingPermissions.get(requestId);
        // always 暂按 allow 放行；规则表落盘是 host 侧 Phase 4 的事
        const wire = decision === "deny" ? "deny" : "allow";
        if (serverMsgId !== undefined && serverMsgId !== "") {
          this.writeLine({ id: serverMsgId, result: { decision: wire, reason: decision } });
        }
        st.pendingPermissions.delete(requestId);
        this.emitFor(st, { type: "permission.resolved", sessionId: st.sessionId, requestId, decision });
      },
      externalRef: () => st.sessionId,
    };
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("adapter is shutting down"), { code: "adapter_disposed" }));
    }
    this.pending.clear();
    this.sessions.clear();
    if (child !== null && child.exitCode === null) child.kill();
  }
}

// ==== 传输二：-p --json（回退，能力受限但真实）==============================

interface PrintSessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** CLI 的原生会话 id（--resume 用），首轮结束才有 */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  running: boolean;
  cancelled: boolean;
  child: ChildProcess | null;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
}

interface CliTurnResult {
  sessionId?: string;
  traceId?: string;
  turnId?: string;
  response?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

class PrintTransport {
  private readonly sessions = new Map<string, PrintSessionState>();

  async probeVersion(cmd: ResolvedCommand): Promise<string> {
    return (await execLines(cmd, ["--version"], 15000)).trim();
  }

  start(state: PrintSessionState, _req: StartRequest): AdapterSession {
    this.sessions.set(state.sessionId, state);
    return {
      id: state.sessionId,
      send: async (text: string) => {
        // 首轮（cliSessionId 还是 null）自然不带 --resume，多轮由 CLI 侧持久化续接
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        // -p 默认 yolo，没有权限反向流
        log.warn("resolvePermission called on zcode -p session (no permission stream)");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: PrintSessionState = {
      sessionId,
      rootPath,
      cliSessionId: ref,
      sink,
      running: false,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    return this.start(state, { unitId: "unknown" as never, unitName: "", rootPath: state.rootPath, prompt: "", model: null });
  }

  disconnect(): void {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
  }

  private async spawnTurn(state: PrintSessionState, prompt: string): Promise<void> {
    // 评审 P1：cancelled 只描述"cancel 杀掉的那一轮"；不复位会把后续轮的失败误判为 idle
    state.cancelled = false;
    const resumeId = state.cliSessionId;
    const cmd = await resolveCommand("zcode");
    const args = ["-p", prompt, "--json", "--cwd", state.rootPath];
    if (resumeId !== null) args.push("--resume", resumeId);

    const stdout: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => stdout.push(line),
      onStderrLine: (line) => log.debug("zcode -p stderr", { line: line.slice(0, 200) }),
      // 不在 exit 回调里收尾：正常路径在 await exit 之后统一处理（避免双重 ended）
    });
    state.child = child;
    state.running = true;

    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    state.child = null;
    state.running = false;

    const parsed = this.parseTurnOutput(stdout.join("\n"));
    if (parsed === null) {
      // 会话线程仍在（--resume 可续），不发 ended
      if (!state.cancelled) {
        state.sink?.({ type: "error", sessionId: state.sessionId, message: `zcode -p produced no JSON (exit ${exitCode})`, recoverable: false });
      }
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: state.cancelled ? "idle" : "failed" });
      return;
    }
    if (parsed.sessionId !== undefined) state.cliSessionId = parsed.sessionId;
    this.emitTurn(state, parsed);
  }

  private parseTurnOutput(raw: string): CliTurnResult | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as CliTurnResult;
    } catch {
      return null;
    }
  }

  private emitTurn(state: PrintSessionState, r: CliTurnResult): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    const messageId = r.turnId ?? r.traceId ?? `msg_${Date.now()}`;

    const text = r.response ?? (r.is_error === true ? r.result ?? "" : "");
    if (text !== "") {
      sink({ type: "message.delta", sessionId, messageId, role: "assistant", text });
      sink({ type: "message.completed", sessionId, messageId, text });
    }

    const u = r.usage;
    if (u !== undefined && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
      sink({
        type: "usage",
        sessionId,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheCreationTokens,
        costUsd: 0,
        model: "zcode-default",
        requestId: `zcode:${sessionId}:p${process.pid}:${++state.usageCount}`,
        decodeMs: r.duration_ms,
      });
    }

    if (r.is_error === true) {
      sink({ type: "error", sessionId, message: r.result ?? "turn failed", recoverable: false });
      // agent loop 语义：turn 失败 ≠ 会话结束（--resume 可续聊）
      sink({ type: "session.status", sessionId, status: "failed" });
    } else {
      sink({ type: "session.status", sessionId, status: "idle" });
    }
  }
}

// ==== 适配器门面 ============================================================

/**
 * 文件级命令发现（协议不可用时的回退）：ZCode 自定义命令就是 markdown 文件 ——
 * `<base>/.zcode/commands` 与 `<base>/.agents/commands`（base = 用户家目录或项目根，
 * 上游 adapters/src/commands/roots.ts 的同款约定），frontmatter 认 description /
 * argument-hint 两键。只列自定义段（内置命令清单没有独立事实源，不猜）。
 */
function readZcodeCustomCommands(rootPath: string): readonly NativeCommandInfo[] {
  const out: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  const bases: Array<{ base: string; source: "user" | "project" }> = [
    { base: rootPath, source: "project" },
    { base: homedir(), source: "user" },
  ];
  for (const { base, source } of bases) {
    for (const ns of [".zcode", ".agents"]) {
      const dir = join(base, ns, "commands");
      let files: string[];
      try {
        files = listMarkdownFilesPruned(dir).map((f) => join(dir, f));
      } catch {
        continue;
      }
      for (const file of files) {
        const name = file.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
        if (name === "" || seen.has(name)) continue; // 项目级覆盖用户级（上游同款优先级）
        seen.add(name);
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        out.push({ ...parseZcodeCommandFile(name, raw), source });
      }
    }
  }
  return out;
}

/** frontmatter 解析（description / argument-hint 两键，扁平 yaml），与上游口径一致 */
function parseZcodeCommandFile(name: string, raw: string): Omit<NativeCommandInfo, "source"> {
  let description: string | undefined;
  let argumentHint: string | undefined;
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end !== -1) {
      for (const line of raw.slice(raw.indexOf("\n") + 1, end).split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        if (key === "description" && value !== "") description = value;
        else if (key === "argument-hint" && value !== "") argumentHint = value;
      }
    }
  }
  return {
    name,
    description,
    argumentHint,
    // 正文首行兜底描述（上游 extractDescription 同款语义）
    ...(description === undefined
      ? { description: raw.split(/\r?\n/).find((l) => l.trim() !== "" && !l.startsWith("---"))?.trim().slice(0, 120) || undefined }
      : {}),
  };
}

/**
 * 文件级技能发现：`<base>/.zcode/skills` 与 `<base>/.agents/skills` 下的
 * `<name>/SKILL.md`（frontmatter 认 name/description，缺 name 用目录名）。
 * 与 readZcodeCustomCommands 同款 base × ns 组合，项目级覆盖用户级。
 */
function readZcodeSkills(rootPath: string): readonly NativeCommandInfo[] {
  const out: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  const bases: Array<{ base: string; source: "user" | "project" }> = [
    { base: rootPath, source: "project" },
    { base: homedir(), source: "user" },
  ];
  for (const { base, source } of bases) {
    for (const ns of [".zcode", ".agents"]) {
      const dir = join(base, ns, "skills");
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const skillPath = join(dir, entry, "SKILL.md");
        if (!existsSync(skillPath)) continue;
        let raw: string;
        try {
          raw = readFileSync(skillPath, "utf8");
        } catch {
          continue; // 目录里没有 SKILL.md = 不是技能（可能是数据目录），跳过
        }
        const fm = parseZcodeCommandFile(entry, raw);
        const name = entry; // 名字一律用目录名（"/name" 触发口径）
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, description: fm.description, source, kind: "skill" });
      }
    }
  }
  return out;
}

/**
 * 文件级子智能体发现：`<base>/.zcode/agents` 与 `<base>/.agents/agents` 下的
 * *.md（frontmatter 认 name/description；上游 subagent 定义就是这些文件）。
 * 协议口 subagents/readRuntimeConfig 需要 sessionId，listCommands 场景没有 ——
 * 文件级是唯一无会话事实源。
 */
function readZcodeAgents(rootPath: string): readonly NativeCommandInfo[] {
  const out: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  const bases: Array<{ base: string; source: "user" | "project" }> = [
    { base: rootPath, source: "project" },
    { base: homedir(), source: "user" },
  ];
  for (const { base, source } of bases) {
    for (const ns of [".zcode", ".agents"]) {
      const dir = join(base, ns, "agents");
      let files: string[];
      try {
        files = listMarkdownFilesPruned(dir).map((f) => join(dir, f));
      } catch {
        continue;
      }
      for (const file of files) {
        const fileName = file.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
        if (fileName === "") continue;
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const fm = parseZcodeCommandFile(fileName, raw);
        // frontmatter name 优先（上游 subagent_type 语义），缺省用文件名
        const fmName = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim();
        const name = fmName && fmName !== "" ? fmName : fileName;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, description: fm.description, source, kind: "agent" });
      }
    }
  }
  return out;
}


// ---- 模型清单发现（读 CLI 自带目录，零用量）------------------------------------

/** 内置目录里 providerRules 的一条（本机实际 providerId 形如 `account:<providerFamily>-<mode>`） */
interface ZcodeProviderRule {
  readonly providerId?: string;
  readonly config?: {
    readonly builtinModelIds?: readonly string[];
    readonly visibility?: string;
  };
}

/** 内置目录里 modelRules 的一条：按 modelMatch 正则命中，**先命中先算** */
interface ZcodeModelRule {
  readonly modelMatch?: string;
  readonly config?: {
    readonly properties?: {
      readonly contextWindow?: number;
      readonly inputFormat?: { readonly supportsImage?: boolean };
    };
    readonly optionSpecs?: {
      readonly maxOutputTokens?: { readonly max?: number };
      readonly reasoningLevel?: { readonly values?: readonly string[] };
    };
  };
}

interface ZcodeBuiltinCatalog {
  readonly config?: {
    // ⚠ 实测 0.16.9 里这两个是**对象**不是数组（`{templateRules, providerRules}` /
    // `{modelRules, modelApiRules, …}`）。早期版本可能是数组，两种都认 ——
    // 目录格式随 CLI 升级变过，这里写死一种等于给未来的自己埋雷。
    readonly providerConfigRules?: ZcodeRuleGroup<ZcodeProviderRule> | readonly ZcodeRuleGroup<ZcodeProviderRule>[];
    readonly modelConfigRules?: ZcodeRuleGroup<ZcodeModelRule> | readonly ZcodeRuleGroup<ZcodeModelRule>[];
  };
}

interface ZcodeRuleGroup<T> {
  readonly providerRules?: readonly T[];
  readonly modelRules?: readonly T[];
}

/** 取规则组里的目标数组：对象或单元素数组两种形态都归一成一维数组 */
function flattenRuleGroups<T>(
  groups: ZcodeRuleGroup<T> | readonly ZcodeRuleGroup<T>[] | undefined,
  key: "providerRules" | "modelRules",
): readonly T[] {
  if (groups === undefined || groups === null) return [];
  const list = Array.isArray(groups) ? groups : [groups as ZcodeRuleGroup<T>];
  const out: T[] = [];
  for (const g of list) {
    const arr = g[key];
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

/**
 * 定位 zcode 自带的模型目录 `provider/zcode-builtin.json`。
 *
 * 它随 dist 一起发布在 CLI 主脚本旁边（`<dist>/provider/zcode-builtin.json`），
 * 所以从 resolveCommand 解析出的脚本路径往上找即可，不猜全局安装路径。
 */
function locateZcodeCatalog(cmd: ResolvedCommand): string | null {
  const script = [...cmd.prefixArgs].reverse().find((a) => /\.(?:c|m)?js$/i.test(a));
  const bases: string[] = [];
  if (script !== undefined) {
    const dir = dirname(script);
    bases.push(join(dir, "provider", "zcode-builtin.json"));
    bases.push(join(dir, "..", "config", "provider", "zcode-builtin.json"));
  }
  const shim = cmd.prefixArgs[3];
  if (shim !== undefined && shim.toLowerCase().endsWith(".cmd")) {
    const dir = dirname(shim);
    bases.push(join(dir, "node_modules", "zcode", "dist", "provider", "zcode-builtin.json"));
  }
  for (const p of bases) {
    const abs = resolve(p);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * 按规则集解析一个模型的属性。
 *
 * ## 语义是「按序合并、后者覆盖」，不是「首个命中即返回」
 *
 * 目录里的规则**互相重叠**，写成首个命中就返回会拿到错答案 —— 实测：
 * `GLM-5.3` 同时命中 `[0] .*`（ctx=200000）、`[3] .*glm-5(?:…)?`（200000）、
 * `[6] .*glm-5\.3(?:-flash)?…`（**1000000**）。首个命中给出 200000，是错的。
 *
 * 而且覆盖是**按字段**的：`GLM-5.3-Flash` 命中 `[6]`（有 contextWindow）与
 * `[7]`（只带别的属性、不带 contextWindow），若后者整体替换前者，窗口就又丢了。
 * 所以逐条 merge，只让该条**显式给出**的字段覆盖，未给出的字段保留原值。
 */
/** 合并后的模型属性（字段与 ZcodeModelRule.config 同形） */
interface ZcodeResolvedModelConfig {
  readonly contextWindow?: number;
  readonly supportsImage?: boolean;
  readonly maxOutput?: number;
  readonly reasoningLevels?: readonly string[];
}

function resolveZcodeModelConfig(rules: readonly ZcodeModelRule[], model: string): ZcodeResolvedModelConfig {
  let contextWindow: number | undefined;
  let supportsImage: boolean | undefined;
  let maxOutput: number | undefined;
  let reasoningLevels: readonly string[] | undefined;
  for (const rule of rules) {
    const pattern = rule.modelMatch;
    if (typeof pattern !== "string" || pattern === "") continue;
    let matched: boolean;
    try {
      matched = new RegExp(pattern, "i").test(model);
    } catch {
      // 目录里的正则写坏了就当这条不匹配，不能让整个同步炸掉
      continue;
    }
    if (!matched) continue;
    const props = rule.config?.properties;
    // 逐字段覆盖：该条没给的字段保持原值（undefined 不清空）
    if (typeof props?.contextWindow === "number") contextWindow = props.contextWindow;
    if (typeof props?.inputFormat?.supportsImage === "boolean") supportsImage = props.inputFormat.supportsImage;
    const specs = rule.config?.optionSpecs;
    if (typeof specs?.maxOutputTokens?.max === "number") maxOutput = specs.maxOutputTokens.max;
    const values = specs?.reasoningLevel?.values;
    if (Array.isArray(values)) reasoningLevels = values;
  }
  return { contextWindow, supportsImage, maxOutput, reasoningLevels };
}

export class ZcodeAdapter implements ExecutorAdapter {
  readonly id = "zcode";
  readonly displayName = "ZCode";
  readonly glyph = "Z";
  // 原生读取 cwd 下的 AGENTS.md（工作区 agentsMd 机制，本产品自身的运行时即证据）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [
    {
      id: "GLM-5.3-Flash" as ModelId,
      displayName: "GLM-5.3 Flash（默认）",
      contextWindow: 1000000,
      maxOutput: 131072,
      reasoningLevels: ["low", "high", "max"],
      multimodal: true,
    },
    {
      id: "GLM-5.3" as ModelId,
      displayName: "GLM-5.3",
      contextWindow: 1000000,
      maxOutput: 131072,
      reasoningLevels: ["low", "high", "max"],
      multimodal: false,
    },
    {
      id: "GLM-5-Turbo" as ModelId,
      displayName: "GLM-5 Turbo",
      contextWindow: 200000,
      maxOutput: 32768,
      reasoningLevels: ["low", "high", "max"],
      multimodal: false,
    },
  ];

  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  /**
   * 动态对齐模型清单 —— 读 CLI 自带的 `provider/zcode-builtin.json`，**零用量**（纯读本地文件）。
   *
   * ## 为什么是读文件而不是问 CLI
   *
   * zcode 0.16.9 的 app-server **没有模型列表接口**：实测 `provider/list`、`model/list`、
   * `models/list`、`config/list`、`session/models` 全部 `-32601 Method not found`；
   * CLI 也没有 `zcode models` 子命令（`quota` 只报用量）。但 dist 里那份 180KB 的
   * 内置目录把该有的全给了：`providerRules[].builtinModelIds`（每个**订阅套餐**能用哪些模型）
   * + `modelRules[]`（按正则给上下文窗口/输入格式/推理档位）。
   *
   * ## 为什么必须按套餐筛
   *
   * 目录里列的是**所有套餐**的并集。不同套餐给的模型完全不同 —— 实测本机
   * `bigmodel-individual-coding-plan` 只给 `GLM-5.3` 与 `GLM-5.3-Flash`，而
   * `GLM-5-Turbo` 属于 start-plan。把并集直接当清单，用户就会在下拉里选到一个
   * 自己订阅里根本没有的模型，发起会话才失败。所以这里用 `zcode quota --json` 报的
   * 真实 providerId 精确取那一条规则（该命令只读额度，不调模型）。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("zcode");
      const catalogPath = locateZcodeCatalog(cmd);
      if (catalogPath === null) {
        return {
          models: this._models,
          source: "static",
          reason: "未找到 zcode 内置模型目录 provider/zcode-builtin.json",
          elapsedMs: Date.now() - t0,
        };
      }
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ZcodeBuiltinCatalog;
      const providerRules = flattenRuleGroups(catalog.config?.providerConfigRules, "providerRules");
      const modelRules = flattenRuleGroups(catalog.config?.modelConfigRules, "modelRules");
      if (providerRules.length === 0 || modelRules.length === 0) {
        return { models: this._models, source: "static", reason: "内置模型目录结构不识别", elapsedMs: Date.now() - t0 };
      }

      // 真实套餐：quota 报的是裸 id（bigmodel-individual-coding-plan），规则键带 account: 前缀
      let providerId = CODING_PLAN_PROVIDER_ID;
      let level: string | undefined;
      try {
        const q = await execLines(cmd, ["quota", "--json"], 12000);
        const parsed = JSON.parse(q) as { readonly ok?: boolean; readonly providerId?: string; readonly level?: string };
        if (parsed.ok === true && typeof parsed.providerId === "string" && parsed.providerId !== "") {
          providerId = parsed.providerId.startsWith("account:") ? parsed.providerId : `account:${parsed.providerId}`;
          level = parsed.level;
        }
      } catch (err: unknown) {
        log.debug("zcode quota 取套餐失败，按已知的本机套餐兜底", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const rule = providerRules.find((r) => r.providerId === providerId);
      const modelIds = rule?.config?.builtinModelIds ?? [];
      if (modelIds.length === 0) {
        return {
          models: this._models,
          source: "static",
          reason: `内置目录里没有套餐 ${providerId} 的模型清单`,
          elapsedMs: Date.now() - t0,
        };
      }
      if (rule?.config?.visibility === "hidden") {
        log.debug("zcode 当前套餐在内置目录里标为 hidden，仍按其模型清单展示", { providerId });
      }

      const prior = new Map<string, ExecutorModelInfo>(this._models.map((m) => [m.id as string, m]));
      const out: ExecutorModelInfo[] = [];
      for (const id of modelIds) {
        const resolved = resolveZcodeModelConfig(modelRules, id);
        const old = prior.get(id);
        out.push({
          id: id as ModelId,
          displayName: level === undefined ? id : `${id}（${level} 档）`,
          contextWindow: resolved.contextWindow ?? old?.contextWindow,
          maxOutput: resolved.maxOutput ?? old?.maxOutput,
          // 内置目录的推理档是 disabled/enabled 这种开关式，不是 low/medium/high。
          // 照搬会让界面出现一个看不懂的二值下拉，不如不给。
          reasoningLevels: old?.reasoningLevels,
          defaultReasoningLevel: old?.defaultReasoningLevel,
          multimodal: resolved.supportsImage ?? old?.multimodal,
        });
      }
      if (out.length > 0) {
        this._models = out;
        log.info("zcode models synced from builtin catalog", { providerId, count: out.length });
        return { models: out, source: "live", elapsedMs: Date.now() - t0 };
      }
      return { models: this._models, source: "static", reason: "套餐模型清单为空", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("zcode 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }
  // 能力声明跟传输状态走（docs/08 WP-4）：app-server = 真流式；print 回退 = 批量。
  // 注册表在 probe 前读到的快照是 app-server 档——probe 返回值才是权威。
  get capabilities(): RuntimeCapabilities {
    return {
      resumeSession: true,
      fileDiff: false,
      terminal: false,
      permissions: true, // app-server 反向权限流（fork 补丁后）；降级到 -p 时实际不触发
      subagents: false,
      worktrees: false,
      sandbox: true,
      mcp: true,
      usage: true,
      multimodal: true,
      streaming: this.transport === "app-server" ? "realtime" : "batch",
      steering: "turn-end", // mid-turn 的物理条件具备（常驻进程），实现前如实报 turn-end
    };
  }

  /** 进程级传输状态：app-server 起不动时降级到 print，本次 daemon 生命周期内不再回头 */
  private transport: "app-server" | "print" = "app-server";
  private readonly appServer = new ZcodeAppServerTransport();
  private readonly print = new PrintTransport();

  /** 原生命令缓存（readPresentation 结果；TTL 与其他适配器同口径） */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * ZCode 的原生命令面（三段）：
   * - 命令：协议官方声明口 `workspace/readPresentation` 的 slashCommands
   *   （上游 packages/shared zcodeSlashCommandSchema；本地 workspaceKey = workspacePath）
   * - 技能：`skills/referenceCatalog`（zcodeSkillsReferenceCatalog，scope =
   *   workspace|user|plugin）。技能在 zcode 里也以 "/name" 触发，但归属技能组；
   *   与 slashCommands 重名的条目从命令段剔除（技能目录是更强的分类事实源）
   * - 子智能体：`subagents/readRuntimeConfig` 需要 sessionId（listCommands 没有），
   *   按上游约定扫 `.zcode/agents` 与 `.agents/agents` 的 *.md（frontmatter
   *   name/description）。选中插入 "/name "，能否分发由 zcode 自己决定。
   * 命令执行是透传："/name args" 作为 turn 文本走 session/send，服务端自己分发。
   * app-server 不可用（print 回退档）时全部走文件级发现。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < ZcodeAdapter.COMMAND_TTL_MS) return hit.commands;

    const agents = readZcodeAgents(rootPath);
    if (this.transport !== "app-server") {
      const fileLevel = [...readZcodeCustomCommands(rootPath), ...readZcodeSkills(rootPath), ...agents];
      if (fileLevel.length > 0 || hit === undefined) this.commandCache.set(rootPath, { commands: fileLevel, at: Date.now() });
      return fileLevel;
    }
    try {
      const r = await this.appServer.rpc<{ slashCommands?: readonly {
        name?: string;
        description?: string;
        inputHint?: string;
        source?: "builtin" | "custom";
      }[] }>(
        ZCODE_METHODS.workspaceReadPresentation,
        { workspace: { workspacePath: rootPath, workspaceKey: rootPath } },
        20000,
      );
      const commands: NativeCommandInfo[] = [];
      for (const c of r?.slashCommands ?? []) {
        if (typeof c?.name !== "string" || c.name === "") continue;
        commands.push({
          name: c.name,
          description: c.description || undefined,
          argumentHint: c.inputHint || undefined,
          builtin: c.source === "builtin" ? true : undefined,
          source: c.source === "builtin" ? "builtin" : undefined,
        });
      }
      // 技能目录（失败容忍：老版本 app-server 没有该方法时整段缺席，不猜）
      const skills = await this.fetchSkillsViaProtocol(rootPath).catch(() => [] as readonly NativeCommandInfo[]);
      const skillNames = new Set(skills.map((s) => s.name));
      const merged = [
        ...commands.filter((c) => !skillNames.has(c.name) || c.builtin === true),
        ...skills,
        ...agents,
      ];
      this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
      return merged;
    } catch (err: unknown) {
      // app-server 起不来（本机 0.16.9 实测 "Bundled 与 Active Release 均不可用"）
      // → 文件级发现兜底：自定义三段照样能列，内置段缺席（没有独立事实源，不猜）
      log.debug("zcode readPresentation 失败，回落文件级命令发现", { rootPath, error: err instanceof Error ? err.message : String(err) });
      const fileLevel = [...readZcodeCustomCommands(rootPath), ...readZcodeSkills(rootPath), ...agents];
      if (fileLevel.length > 0 || hit === undefined) this.commandCache.set(rootPath, { commands: fileLevel, at: Date.now() });
      return fileLevel;
    }
  }

  /** `skills/referenceCatalog` → 技能段条目（scope 映射 source；名字冲突项目/工作区优先） */
  private async fetchSkillsViaProtocol(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const r = await this.appServer.rpc<{ skills?: readonly {
      name?: string;
      description?: string;
      scope?: "workspace" | "user" | "plugin";
      pluginName?: string;
    }[] }>(
      ZCODE_METHODS.skillsReferenceCatalog,
      { workspace: { workspacePath: rootPath, workspaceKey: rootPath } },
      15000,
    );
    const out: NativeCommandInfo[] = [];
    const seen = new Set<string>();
    for (const s of r?.skills ?? []) {
      if (typeof s?.name !== "string" || s.name === "" || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        name: s.name,
        description: s.description || undefined,
        source: s.scope === "workspace" ? "project" : s.scope === "plugin" ? "plugin" : "user",
        kind: "skill",
      });
    }
    return out;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("zcode");
      const version = (await execLines(cmd, ["--version"], 15000)).trim() || "unknown";
      return {
        state: {
          status: "ready",
          version: `${version} (${this.transport === "app-server" ? "app-server" : "print 回退"})`,
        },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      return {
        state: { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    if (this.transport === "app-server") {
      try {
        return await this.startViaAppServer(req, sink);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof Error && "code" in err ? String(err.code) : "";
        const registryEmpty = ZcodeAppServerTransport.isRegistryEmptyError(err);
        // 评审 P2：rpc_timeout 不再触发降级——单次 RPC 慢（180s）不代表进程死了，
        // disconnect 会打死其它健康会话在途的全部 RPC；只对"进程真死/无模型"降级
        if (registryEmpty || code === "adapter_died") {
          log.warn("zcode app-server unavailable, degrading to -p transport (this process)", {
            error: msg,
            hint: "安装带 awb/standalone-app-server 补丁的 zcode CLI 可恢复全能力（真流式/工具事件/权限流）",
          });
          this.transport = "print";
          await this.appServer.disconnect().catch(() => {});
        } else {
          throw err;
        }
      }
    }
    return this.startViaPrint(req, sink);
  }

  private async startViaAppServer(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    return this.appServer.start(req, sink);
  }

  private startViaPrint(req: StartRequest, sink: AdapterSink): AdapterSession {
    const state: PrintSessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      cliSessionId: null,
      sink,
      running: false,
      cancelled: false,
      child: null,
      usageCount: 0,
    };
    if (req.model !== null) {
      log.warn("zcode -p path cannot select a model; using CLI default", { model: req.model });
    }
    return this.print.start(state, req);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    if (this.transport === "print") return this.print.reattach(sessionId, ref, rootPath, sink);
    // app-server 会话的重挂：ref 即原生 sessionId
    const state: AppServerSessionState = {
      sessionId,
      unitId: "unknown" as never,
      model: null,
      rootPath,
      sink,
      currentMessageId: null,
      ended: false,
      ready: Promise.resolve(),
      cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pendingPermissions: new Map(),
      usageCount: 0,
    };
    const attached = this.appServer.reattach(state, ref);
    return attached;
  }

  async disconnect(): Promise<void> {
    await this.appServer.disconnect();
    this.print.disconnect();
  }
}
