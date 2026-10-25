/**
 * OpenClaw 执行器适配器 —— 统一调用 `openclaw agent -m <text> --json` 与 `openclaw agent exec`。
 *
 * 协议事实（openclaw 2026.10 实测与源码走查）：
 * - 源码库：C:\Users\chenziyu\project\Agent\openclaw
 * - 本机安装：npm 全局包（openclaw.cmd / openclaw.ps1）
 * - 执行指令：
 *   - Gateway 模式：`openclaw agent -m <prompt> --json [--session-id <id>] [--model <model>]`
 *   - 本地独立模式：`openclaw agent exec <prompt> --json --cwd <rootPath> [--model <model>]`
 * - 输出信封：
 *   - payloads: [{text: string, mediaUrl}]
 *   - meta.agentMeta: {sessionId, provider, model, usage:{input, output, cacheRead, cost:{total}}}
 *   - terminalReply: {disposition, text}
 * - 模型发现：`openclaw models list` 输出已配置的模型列表
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  adapterError,
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { discoverGenericToolSkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type { NativeCommandInfo } from "../../contract.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand, spawnLines, type ResolvedCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- Gateway 直连客户端（docs/13 Phase 4 Tier 1：WS 控制面 + token 认证） --------
//
// 协议事实（openclaw 2026.10.2 本机实测，2026-10-14）：
// - WS 在 Gateway 端口根路径；帧：{type:"req",id,method,params} ↔ {type:"res",id,ok,payload|error}
//   事件帧 {type:"event",event:…}；connect 以普通 req 发（method:"connect"），
//   protocol 必须落 [3,4]（v4 网关 minProbe=3）
// - connect params：client.id 必须是枚举（"cli"），client.mode "cli"，role "operator"，
//   scopes 要显式带 ["operator.read","operator.write"]（缺 write 时 agent 方法 403），
//   auth.token 取 ~/.openclaw/openclaw.json 的 gateway.auth.token
// - agent 方法：{message, idempotencyKey} → 先回 accepted {runId,status:"accepted"}，
//   轮末同一 id 再回终态 {status:"ok",result:{payloads:[{text}],meta:{durationMs,
//   agentMeta:{sessionId,provider,model,usage:{input,output,cacheRead,cost:{total}}}}}}
// - "agent"/"chat" 事件在轮内推送（runId 归属），可做流式增量

class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, (f: Record<string, unknown>) => void>();
  private helloOk = false;
  /** 轮内事件回调（runId 归属过滤由调用方做） */
  eventHandler: ((event: Record<string, unknown>) => void) | null = null;

  /** 连到现成 Gateway（读 ~/.openclaw/openclaw.json 的 token/port）；失败返回 null（调用方回落 CLI） */
  async connect(): Promise<boolean> {
    if (this.helloOk && this.ws !== null) return true;
    try {
      const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".";
      const cfg = JSON.parse(readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8")) as {
        gateway?: { port?: number; auth?: { token?: string } };
      };
      const port = cfg.gateway?.port ?? 18789;
      const token = cfg.gateway?.auth?.token;
      if (token === undefined) return false;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      this.ws = ws;
      ws.onmessage = (ev: MessageEvent) => this.onMessage(String(ev.data));
      ws.onclose = () => {
        this.helloOk = false;
        this.ws = null;
        for (const [, resolve] of this.pending) resolve({ ok: false, error: { message: "gateway connection closed" } });
        this.pending.clear();
      };
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("gateway ws 连接超时")), 5000);
        ws.onopen = () => {
          clearTimeout(t);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error("gateway ws 连接失败"));
        };
      });
      const hello = await this.request("connect", {
        minProtocol: 3,
        maxProtocol: 4,
        client: { id: "cli", displayName: "MoyuBot", version: "0.1.0", platform: process.platform, mode: "cli" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        auth: { token },
      });
      if (hello["ok"] !== true) {
        log.info("openclaw gateway connect 被拒（回落 CLI 传输）", { error: JSON.stringify(hello["error"] ?? {}).slice(0, 160) });
        this.close();
        return false;
      }
      this.helloOk = true;
      return true;
    } catch (err: unknown) {
      log.debug("openclaw gateway 不可达（回落 CLI 传输）", { error: err instanceof Error ? err.message : String(err) });
      this.close();
      return false;
    }
  }

  private onMessage(raw: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (f["type"] === "res" && typeof f["id"] === "string") {
      const p = this.pending.get(f["id"]);
      if (p !== undefined) {
        this.pending.delete(f["id"]);
        p(f);
      }
      return;
    }
    if (f["type"] === "event" && typeof f["event"] === "object" && f["event"] !== null) {
      this.eventHandler?.(f["event"] as Record<string, unknown>);
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (ws === null) return Promise.resolve({ ok: false, error: { message: "gateway not connected" } });
    const id = `awb${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { message: `${method} timeout` } });
      }, timeoutMs);
      this.pending.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /**
   * agent 方法的专用请求：同一 id 会收到两帧 res（先 accepted {runId}，轮末再回
   * 终态 {status,result}）。这里 accepted 即回，终态由返回的 Promise 给出。
   */
  requestTurn(
    params: Record<string, unknown>,
    onAccepted: (runId: string | null) => void,
    timeoutMs = 300_000,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (ws === null) return Promise.resolve({ ok: false, error: { message: "gateway not connected" } });
    const id = `awb${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { message: "agent turn timeout" } });
      }, timeoutMs);
      let acceptedSeen = false;
      this.pending.set(id, (f) => {
        const payload = (f["payload"] ?? {}) as Record<string, unknown>;
        if (!acceptedSeen && payload["status"] === "accepted") {
          acceptedSeen = true;
          onAccepted(typeof payload["runId"] === "string" ? payload["runId"] : null);
          return; // 挂起继续等终态帧
        }
        clearTimeout(timer);
        resolve(f);
      });
      ws.send(JSON.stringify({ type: "req", id, method: "agent", params }));
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.helloOk = false;
  }
}

interface OpenClawResponse {
  runId?: string;
  status?: string;
  ok?: boolean;
  final?: string;
  sessionId?: string;
  error?: { type?: string; message?: string };
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
    finalAssistantVisibleText?: string;
    meta?: {
      durationMs?: number;
      agentMeta?: {
        sessionId?: string;
        provider?: string;
        model?: string;
        contextTokens?: number;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
          cost?: { total?: number };
        };
      };
    };
  };
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  model: ModelId | null;
  reasoningLevel: string | undefined;
  cliSessionId: string | null;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  usageCount: number;
  /** Gateway 传输的轮内状态（gwRunId 归属过滤 / 流式增量防抖） */
  gwRunId: string | null;
  gwText: string;
  gwMessageId: string | null;
}

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "minimax-portal/MiniMax-M3" as ModelId,
    displayName: "MiniMax M3",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "minimax-portal/MiniMax-M2.7" as ModelId,
    displayName: "MiniMax M2.7",
    contextWindow: 205_000,
    multimodal: false,
  },
  {
    id: "minimax-portal/MiniMax-M2.5" as ModelId,
    displayName: "MiniMax M2.5",
    contextWindow: 205_000,
    multimodal: false,
  },
  {
    id: "openclaw-default" as ModelId,
    displayName: "OpenClaw Default",
    contextWindow: 200_000,
    multimodal: true,
  },
];

const LOCAL_OPENCLAW_ENTRY = "C:\\Users\\chenziyu\\project\\Agent\\openclaw\\openclaw.mjs";

async function resolveOpenclawCommand(): Promise<ResolvedCommand> {
  try {
    return await resolveCommand("openclaw");
  } catch {
    if (existsSync(LOCAL_OPENCLAW_ENTRY)) {
      return { file: process.execPath, prefixArgs: [LOCAL_OPENCLAW_ENTRY], via: "npm-shim" };
    }
    throw Object.assign(new Error("openclaw executable not found on PATH or local source"), {
      code: "not_installed",
    });
  }
}

export class OpenclawAdapter implements ExecutorAdapter {
  readonly id = "openclaw";
  readonly displayName = "OpenClaw";
  readonly glyph = "O";
  readonly tuiCommand = "openclaw";

  private dynamicModels: readonly ExecutorModelInfo[] | null = null;
  private readonly sessions = new Map<SessionId, SessionState>();
  /** Gateway 直连（docs/13 Tier 1）：连得上就用它，连不上回落 CLI 传输 */
  private readonly gw = new GatewayClient();

  get models(): readonly ExecutorModelInfo[] {
    return this.dynamicModels ?? STATIC_MODELS;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: true,
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  /** 动态对齐/刷新模型清单：实时调用 `openclaw models list` */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveOpenclawCommand();
      const stdout = await execLines(cmd, ["models", "list"], 30000);
      if (!stdout || stdout.trim() === "") {
        return { models: this.models, source: "static", reason: "openclaw models list 无输出", elapsedMs: Date.now() - t0 };
      }

      const list: ExecutorModelInfo[] = [];
      const lines = stdout.split(/\r?\n/);
      let started = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("Model") && trimmed.includes("Input")) {
          started = true;
          continue;
        }
        if (!started) continue;

        const parts = trimmed.split(/\s{2,}/);
        if (parts.length >= 2) {
          const modelId = parts[0]?.trim();
          const inputType = parts[1]?.trim() ?? "";
          const ctxStr = parts[2]?.trim() ?? "";

          if (modelId && !modelId.includes(" ")) {
            let contextWindow = 200_000;
            if (ctxStr.endsWith("k") || ctxStr.endsWith("K")) {
              contextWindow = parseInt(ctxStr, 10) * 1000;
            } else if (ctxStr.endsWith("m") || ctxStr.endsWith("M")) {
              contextWindow = parseInt(ctxStr, 10) * 1_000_000;
            }

            const name = modelId.split("/").pop() ?? modelId;
            list.push({
              id: modelId as ModelId,
              displayName: name,
              contextWindow,
              multimodal: inputType.includes("image"),
            });
          }
        }
      }

      if (list.length > 0) {
        this.dynamicModels = list;
        log.info("openclaw models synced dynamically", { count: list.length });
        return { models: list, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("openclaw models list failed, using fallback models", { error: reason });
      return { models: this.models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this.models, source: "static", reason: "models list 输出未匹配到条目", elapsedMs: Date.now() - t0 };
  }


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * OpenClaw 原生命令、技能与子智能体面：
   * 内置目录（见 builtin-catalogs.ts）+ 原生技能（.openclaw/skills 与 .agents/skills）+
   * 子智能体（.openclaw/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 OpenClaw。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < OpenclawAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverGenericToolSkillsAndAgents(this.id, rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveOpenclawCommand();
      const versionOut = await execLines(cmd, ["--version"], 10000).catch(() =>
        execLines(cmd, ["-V"], 10000),
      );
      const version = versionOut.split(/\r?\n/)[0]?.trim() || "ready";
      return {
        state: { status: "ready", version },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? {
                status: "not_installed",
                hint: "未在 PATH 中找到 openclaw CLI（可在终端运行 npm i -g openclaw 或检查 C:\\Users\\chenziyu\\project\\Agent\\openclaw）",
              }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const sessionId = `sess_${randomUUID()}` as SessionId;
    const state: SessionState = {
      sessionId,
      rootPath: req.rootPath,
      mode: req.mode,
      model: req.model,
      reasoningLevel: req.reasoningLevel,
      cliSessionId: null,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
      gwRunId: null,
      gwText: "",
      gwMessageId: null,
    };
    this.sessions.set(sessionId, state);

    // 适配器契约：start() 不发轮（host 在 start 返回后会调 send(prompt) 驱动首轮）。
    // 这里曾自作主张 spawnTurn(req.prompt)，与 host 的自动 send 叠成双轮（每轮两份回复）。
    return this.sessionHandle(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      model: null,
      reasoningLevel: undefined,
      cliSessionId: ref,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
      gwRunId: null,
      gwText: "",
      gwMessageId: null,
    };
    this.sessions.set(sessionId, state);
    return this.sessionHandle(state);
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) st.child?.kill();
    this.sessions.clear();
    this.gw.close();
  }

  private sessionHandle(state: SessionState): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.reasoningLevel = loop.reasoningLevel;
        // Gateway 直连优先；任何失败回落既有 CLI 传输（一轮一进程 --json）
        if (await this.gw.connect()) {
          const ok = await this.sendViaGateway(state, text);
          if (ok) return;
        }
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
        if (state.gwRunId !== null) {
          void this.gw.request("agent.cancel", { runId: state.gwRunId }, 10000).catch(() => undefined);
        }
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on openclaw");
      },
      externalRef: () => state.cliSessionId,
    };
  }

  /** Gateway 直连发一轮。返回 false = 失败（调用方回落 CLI）。 */
  private async sendViaGateway(state: SessionState, prompt: string): Promise<boolean> {
    const sink = state.sink;
    const sessionId = state.sessionId;
    this.gw.eventHandler = (event) => this.onGatewayEvent(state, event);
    state.cancelled = false;
    state.gwRunId = null;
    state.gwText = "";
    state.gwMessageId = null;

    sink?.({ type: "session.status", sessionId, status: "running" });
    const params: Record<string, unknown> = {
      message: prompt,
      idempotencyKey: `awb-${Date.now()}-${state.usageCount + 1}`,
    };
    const send = (p: Record<string, unknown>): Promise<Record<string, unknown>> =>
      this.gw.requestTurn(p, (runId) => {
        state.gwRunId = runId;
      });
    // 多轮续聊：先带上一轮的 gateway sessionId；closed schema 拒绝未知字段时去掉重试
    let r: Record<string, unknown>;
    if (state.cliSessionId !== null) {
      r = await send({ ...params, sessionId: state.cliSessionId });
      if (r["ok"] !== true && JSON.stringify(r["error"] ?? {}).includes("unexpected property")) {
        r = await send(params);
      }
    } else {
      r = await send(params);
    }
    if (r["ok"] !== true) {
      log.info("openclaw gateway agent 失败（回落 CLI 传输）", { error: JSON.stringify(r["error"] ?? {}).slice(0, 200) });
      return false;
    }
    const payload = (r["payload"] ?? {}) as Record<string, unknown>;
    if (payload["status"] !== undefined && String(payload["status"]) !== "ok" && payload["result"] === undefined) {
      sink?.({ type: "error", sessionId, message: `openclaw gateway 轮失败：${String(payload["status"])}`, recoverable: true });
      sink?.({ type: "session.status", sessionId, status: "failed" });
      return true; // gateway 链路本身正常，不回落 CLI 重发
    }
    this.finishGatewayTurn(state, payload as { result?: Record<string, unknown> });
    return true;
  }

  /** Gateway 轮终态 → 事件流收口 */
  private finishGatewayTurn(state: SessionState, payload: { result?: Record<string, unknown> }): void {
    const sink = state.sink;
    const sessionId = state.sessionId;
    const result = (payload.result ?? payload) as Record<string, unknown>;
    const payloads = Array.isArray(result["payloads"]) ? (result["payloads"] as Array<{ text?: string }>) : [];
    const text = payloads.map((p) => p.text ?? "").join("").trim();
    const meta = (result["meta"] ?? {}) as Record<string, unknown>;
    const agentMeta = (meta["agentMeta"] ?? {}) as Record<string, unknown>;
    if (typeof agentMeta["sessionId"] === "string") state.cliSessionId = agentMeta["sessionId"];
    const messageId = state.gwMessageId ?? `msg_${Date.now()}`;
    if (state.gwText !== "" && state.gwText !== text) {
      // 流式增量已发过部分，补齐差量后收口
      if (text.startsWith(state.gwText)) sink?.({ type: "message.delta", sessionId, messageId, role: "assistant", text: text.slice(state.gwText.length) });
      else sink?.({ type: "message.delta", sessionId, messageId, role: "assistant", text });
    } else if (state.gwText === "") {
      sink?.({ type: "message.delta", sessionId, messageId, role: "assistant", text });
    }
    sink?.({ type: "message.completed", sessionId, messageId, text });

    const usage = (agentMeta["usage"] ?? {}) as Record<string, unknown>;
    const cost = (usage["cost"] ?? {}) as Record<string, unknown>;
    const input = Number(usage["input"] ?? 0);
    const output = Number(usage["output"] ?? 0);
    const cacheRead = Number(usage["cacheRead"] ?? 0);
    if (input > 0 || output > 0) {
      sink?.({
        type: "usage",
        sessionId,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        costUsd: typeof cost["total"] === "number" ? cost["total"] : 0,
        model: typeof agentMeta["model"] === "string" ? agentMeta["model"] : "openclaw",
        requestId: `openclaw:${state.cliSessionId ?? sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    sink?.({ type: "session.status", sessionId, status: "idle" });
  }

  /** Gateway 轮内事件（agent/chat）：尽力流式（字段形状宽容） */
  private onGatewayEvent(state: SessionState, event: Record<string, unknown>): void {
    const sink = state.sink;
    if (sink === null) return;
    const kind = String(event["type"] ?? event["event"] ?? "");
    // runId 归属：本会话的轮才翻
    const runId = typeof event["runId"] === "string" ? event["runId"] : null;
    if (state.gwRunId !== null && runId !== null && runId !== state.gwRunId) return;
    if (kind.includes("message") || kind === "chat" || kind === "agent") {
      const text =
        typeof event["text"] === "string" ? event["text"] :
        typeof event["delta"] === "string" ? event["delta"] :
        typeof (event["message"] as Record<string, unknown> | undefined)?.["text"] === "string"
          ? String((event["message"] as Record<string, unknown>)["text"])
          : "";
      if (text !== "") {
        const messageId = state.gwMessageId ?? `msg_${Date.now()}`;
        state.gwMessageId = messageId;
        // 增量语义不保证：只在文本变长时发差量（全量快照事件防抖）
        if (text.length > state.gwText.length && text.startsWith(state.gwText)) {
          sink({ type: "message.delta", sessionId: state.sessionId, messageId, role: "assistant", text: text.slice(state.gwText.length) });
          state.gwText = text;
        } else if (!text.startsWith(state.gwText) && state.gwText === "") {
          sink({ type: "message.delta", sessionId: state.sessionId, messageId, role: "assistant", text });
          state.gwText = text;
        }
      }
    }
  }

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveOpenclawCommand();

    // 优先走 `openclaw agent -m ... --json`
    const args = ["agent", "-m", prompt, "--json"];
    if (state.cliSessionId !== null) {
      args.push("--session-id", state.cliSessionId);
    }
    if (state.model !== null) {
      args.push("--model", state.model);
    }
    if (state.reasoningLevel !== undefined && state.reasoningLevel !== "") {
      args.push("--thinking", state.reasoningLevel);
    }

    const collectedStdout: string[] = [];
    const messageId = `msg_${Date.now()}`;

    state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "running" });

    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => {
        collectedStdout.push(line);
      },
      onStderrLine: (line) => log.debug("openclaw stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;

    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    state.child = null;

    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }

    const fullText = collectedStdout.join("\n").trim();

    // 检查是否因为网关未运行而失败，若是则降级为 `agent exec`
    if (exitCode !== 0 && (fullText.includes("A Gateway is running") || fullText.includes("failed to connect") || fullText.includes("ECONNREFUSED"))) {
      log.info("openclaw agent returned gateway error, attempting local agent exec fallback");
      await this.spawnTurnExecFallback(state, prompt, messageId);
      return;
    }

    this.processResponse(state, messageId, fullText, exitCode);
  }

  /** 本地独立执行降级：`openclaw agent exec <prompt> --json --cwd <rootPath>` */
  private async spawnTurnExecFallback(
    state: SessionState,
    prompt: string,
    messageId: string,
  ): Promise<void> {
    const cmd = await resolveOpenclawCommand();
    const args = ["agent", "exec", prompt, "--json", "--cwd", state.rootPath];
    if (state.model !== null) {
      args.push("--model", state.model);
    }
    if (state.reasoningLevel !== undefined && state.reasoningLevel !== "") {
      args.push("--thinking", state.reasoningLevel);
    }

    const collectedStdout: string[] = [];
    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => {
        collectedStdout.push(line);
      },
      onStderrLine: (line) => log.debug("openclaw agent exec stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;

    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    state.child = null;

    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }

    this.processResponse(state, messageId, collectedStdout.join("\n").trim(), exitCode);
  }

  private processResponse(
    state: SessionState,
    messageId: string,
    rawOutput: string,
    exitCode: number | null,
  ): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    // 提取可能的 JSON 块
    let parsed: OpenClawResponse | null = null;
    const jsonStart = rawOutput.indexOf("{");
    const jsonEnd = rawOutput.lastIndexOf("}");

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(rawOutput.slice(jsonStart, jsonEnd + 1)) as OpenClawResponse;
      } catch {
        // 解析失败走下文兜底
      }
    }

    if (parsed) {
      const isOk = parsed.ok !== false && parsed.status !== "error";
      const replyPayload = parsed.result?.payloads?.[0]?.text ??
        parsed.result?.finalAssistantVisibleText ??
        parsed.final ??
        "";

      const agentMeta = parsed.result?.meta?.agentMeta;
      const returnedSessionId = agentMeta?.sessionId ?? parsed.sessionId;
      if (returnedSessionId) {
        state.cliSessionId = returnedSessionId;
      }

      if (isOk) {
        if (replyPayload && replyPayload !== "") {
          sink({
            type: "message.delta",
            sessionId,
            messageId,
            role: "assistant",
            text: replyPayload,
          });
        }

        sink({
          type: "message.completed",
          sessionId,
          messageId,
          text: replyPayload,
        });

        const usage = agentMeta?.usage;
        if (usage) {
          state.usageCount += 1;
          sink({
            type: "usage",
            sessionId,
            model: (agentMeta?.model ?? state.model ?? "openclaw-default") as ModelId,
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead,
            costUsd: usage.cost?.total ?? 0,
          });
        }

        sink({ type: "session.status", sessionId, status: "idle" });
        return;
      }

      const errMsg = parsed.error?.message ?? "OpenClaw agent reported an error";
      sink({ type: "error", sessionId, message: errMsg, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed_executor" });
      return;
    }

    // 非 JSON 输出或直接文本
    if (exitCode === 0 && rawOutput !== "") {
      sink({
        type: "message.delta",
        sessionId,
        messageId,
        role: "assistant",
        text: rawOutput,
      });
      sink({
        type: "message.completed",
        sessionId,
        messageId,
        text: rawOutput,
      });
      sink({ type: "session.status", sessionId, status: "idle" });
      return;
    }

    sink({
      type: "error",
      sessionId,
      message: rawOutput !== "" ? rawOutput : `openclaw process exited with code ${exitCode}`,
      recoverable: false,
    });
    sink({ type: "session.status", sessionId, status: "failed_executor" });
  }
}
