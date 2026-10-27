/**
 * Grok Build（xAI grok）执行器适配器 —— **ACP 形态：`grok agent stdio` 常驻子进程**
 * （docs/13 Phase 4 Tier 2 升级；原 `grok -p --output-format streaming-messages-json`
 * 每轮一进程 headless 形态退役）。
 *
 * 协议事实（grok 1.0.52 本机实测，2026-10-14）：
 * - initialize {protocolVersion:1, clientCapabilities:{fs,terminal}} →
 *   {agentCapabilities:{loadSession:true, sessionCapabilities:{list,resume,close},
 *   promptCapabilities:{embeddedContext:true}, mcpCapabilities:{http,sse}}}
 * - session/new {cwd, mcpServers:[]} → {sessionId:"<uuidv7>", models:{
 *   currentModelId:"grok-4.7", availableModels:[{modelId,name,_meta:{totalContextTokens,
 *   supportsReasoningEffort, reasoningEfforts…}}]}}
 * - session/prompt {sessionId, prompt:[{type:"text",text}]} → 阻塞到轮末 {stopReason}
 * - 通知 session/update（标准 ACP）：
 *   agent_message_chunk / agent_thought_chunk（content:{type:"text",text}，
 *   带 _meta.totalTokens —— 上下文累计，轮末差值出 usage）
 *   tool_call{toolCallId,title,rawInput{command,…}}
 *   tool_call_update{status:in_progress|completed|failed,content:[{type:"content",
 *   content:{type:"text",text}}]}（tool_call_update 的 content.text 是实时输出流）
 * - 权限：高风险命令走反向请求 session/request_permission（标准 ACP）
 * - x.ai 扩展通知（_x.ai/*）：models/update、session_notification（tool_call_delta_chunk
 *   等）、sessions/changed、queue/changed —— 不翻译进事件流，仅留调试日志
 * - 多轮：同 sessionId 再 session/prompt；daemon 重启后 session/resume {sessionId}
 * - grok 二进制在 ~/.grok/bin/grok.exe（PATH 常缺席；exec.ts 的 locateOnPath 已含该回退）
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { hasDotSegment, readStandardAgentsWorkspace, listMarkdownFilesPruned } from "./discovery.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../log.ts";

// ---- ACP 线缆类型（宽松，同 mcode/dsh） ---------------------------------------

interface AcpContent {
  type?: string;
  text?: string;
  content?: unknown;
}

interface AcpUpdate {
  sessionUpdate?: string;
  content?: AcpContent | AcpContent[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  _meta?: { totalTokens?: number };
}

interface AcpRequest {
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string };
    options?: { optionId?: string; name?: string; kind?: string }[];
  };
}

interface AcpResponse {
  id?: number;
  result?: { sessionId?: string; stopReason?: string; models?: GrokModels };
  error?: { code?: number; message?: string };
}

interface GrokModels {
  currentModelId?: string;
  availableModels?: Array<{
    modelId?: string;
    name?: string;
    _meta?: { totalContextTokens?: number; supportsReasoningEffort?: boolean; reasoningEfforts?: string[] };
  }>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface GrokSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** grok 的 ACP sessionId（uuidv7），session/new 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  initialized: boolean;
  closed: boolean;
  nextId: number;
  readonly pending: Map<number, PendingRequest>;
  /** 本轮聚合：assistant 文本（prompt 阻塞返回时发 completed） */
  turnText: string;
  turnMessageId: string | null;
  /** 轮起点的 _meta.totalTokens（差值出 usage） */
  usedBefore: number | null;
  usedNow: number | null;
  usageCount: number;
}

const DEFAULT_GROK_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "grok-4.7" as ModelId,
    displayName: "Grok 4.7",
    contextWindow: 256000,
    reasoningLevels: ["low", "high"],
    multimodal: true,
  },
];

export class GrokAdapter implements ExecutorAdapter {
  readonly id = "grok";
  readonly displayName = "Grok Build";
  readonly glyph = "G";
  // 原生读取 cwd 下的 AGENTS.md（官方 docs.x.ai/build：「AGENTS.md, plugins, hooks,
  // and MCP servers all work」，与 Claude Code 项目资产零配置兼容）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [...DEFAULT_GROK_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  async syncModels(): Promise<ModelSyncOutcome> {
    // 模型清单随 session/new 下发：起一个临时 ACP 进程问一次（8s 预算，失败保底静态清单）。
    // ⚠ 零用量：只发 initialize + session/new，读回包里已有的模型清单后立刻 kill，
    // **不发 session/prompt** —— ACP 的 session/new 本身不消耗 token。
    const t0 = Date.now();
    try {
      const harvested = await new Promise<ExecutorModelInfo[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("grok models 探测超时")), 12000);
        void (async () => {
          const cmd = await resolveCommand("grok");
          const child = spawn(cmd.file, [...cmd.prefixArgs, "agent", "stdio"], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          let nextId = 0;
          const waiters = new Map<number, (r: AcpResponse) => void>();
          createInterface({ input: child.stdout }).on("line", (line) => {
            let f: AcpResponse | AcpRequest;
            try {
              f = JSON.parse(line) as AcpResponse;
            } catch {
              return;
            }
            if (f.id !== undefined && waiters.has(f.id)) {
              waiters.get(f.id)!(f);
              waiters.delete(f.id);
            }
          });
          const req = (method: string, params: Record<string, unknown>): Promise<AcpResponse> => {
            const id = ++nextId;
            return new Promise((res) => {
              waiters.set(id, res);
              child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            });
          };
          const init = await req("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });
          if (init.error !== undefined) throw new Error(init.error.message ?? "initialize failed");
          const sn = await req("session/new", { cwd: process.env["USERPROFILE"] ?? ".", mcpServers: [] });
          child.kill();
          clearTimeout(timer);
          const models = sn.result?.models?.availableModels ?? [];
          const out = models
            .filter((m): m is typeof m & { modelId: string } => typeof m.modelId === "string")
            .map((m) => ({
              id: m.modelId as ModelId,
              displayName: m.name ?? m.modelId,
              contextWindow: m._meta?.totalContextTokens && m._meta.totalContextTokens > 0 ? m._meta.totalContextTokens : 256000,
              reasoningLevels:
                m._meta?.supportsReasoningEffort === true ? (m._meta.reasoningEfforts ?? ["low", "high"]) : undefined,
              multimodal: true,
            }));
          resolve(out);
        })().catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
      if (harvested.length > 0) {
        this._models = harvested;
        log.info("grok models synced via ACP session/new", { count: harvested.length });
        return { models: harvested, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("grok 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this._models, source: "static", reason: "ACP session/new 未返回可用模型", elapsedMs: Date.now() - t0 };
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // session/resume（sessionCapabilities.resume 实测 true）
    fileDiff: false, // diff 走 x.ai/* 扩展通知，暂不翻译
    terminal: false,
    permissions: true, // session/request_permission 反向流（标准 ACP）
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // mcpCapabilities http/sse；session/new 可挂 mcpServers
    usage: true, // agent_message_chunk._meta.totalTokens 差值
    multimodal: true,
    streaming: "realtime", // agent_message_chunk 真 token 流
    steering: "turn-end", // prompt 阻塞语义：轮边界入队
  };

  private readonly sessions = new Map<string, GrokSession>();

  // ---- 原生斜杠命令面 -----------------------------------------------------------

  /** 命令缓存（内置目录 + 文件级发现合并结果；TTL 同其他适配器口径） */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * grok 的命令面三段：内置目录（~/.grok/README.md v1.0.52 官方 Slash Commands
   * 表，见 builtin-catalogs.ts）+ 技能/子智能体（官方 File Locations 约定：
   * `~/.grok/{skills,agents}` 与 `<root>/.grok/{skills,agents}`，另有
   * `~/.claude/skills` Claude Code 兼容源）。ACP 协议没有命令发现 API，
   * 文件级是唯一无进程事实源；目录还没创建时返回空段（如实）。
   * 执行语义：透传 —— grok agent stdio 不拦截斜杠命令，文本到模型。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < GrokAdapter.COMMAND_TTL_MS) return hit.commands;
    const commands = [...builtinCommandsFor(this.id), ...readGrokSkills(rootPath), ...readGrokAgents(rootPath)];
    this.commandCache.set(rootPath, { commands, at: Date.now() });
    return commands;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("grok");
      const out = await execLines(cmd, ["--version"], 15000);
      void this.syncModels().catch(() => {});
      return {
        state: { status: "ready", version: out.trim() || "unknown" },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 grok（~/.grok/bin/grok.exe 或 PATH）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: GrokSession = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      ref: null,
      sink,
      child: null,
      initialized: false,
      closed: false,
      nextId: 0,
      pending: new Map(),
      turnText: "",
      turnMessageId: null,
      usedBefore: null,
      usedNow: null,
      usageCount: 0,
    };
    this.sessions.set(state.sessionId, state);
    // 会话建立是异步的：host 拿到 AdapterSession 后调 send，send 里确保进程+握手+session/new
    return this.sessionImpl(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: GrokSession = {
      sessionId,
      rootPath,
      ref: null, // session/resume 成功后再填（ref 就是 resume 参数）
      sink,
      child: null,
      initialized: false,
      closed: false,
      nextId: 0,
      pending: new Map(),
      turnText: "",
      turnMessageId: null,
      usedBefore: null,
      usedNow: null,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    state.pending; // reattach 记录在 state.ref 之外：用字段存 resume 目标
    (state as { resumeRef?: string }).resumeRef = ref;
    return this.sessionImpl(state);
  }

  private sessionImpl(state: GrokSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.ensureSession(state);
        if (state.ref === null) throw new Error("grok 会话未建立");
        state.turnText = "";
        state.turnMessageId = null;
        state.usedBefore = state.usedNow;
        const r = await this.request(state, "session/prompt", {
          sessionId: state.ref,
          prompt: [{ type: "text", text }],
        });
        if ((r as AcpResponse).error !== undefined) {
          state.sink?.({
            type: "error",
            sessionId: state.sessionId,
            message: `grok session/prompt 失败：${(r as AcpResponse).error?.message ?? "unknown"}`,
            recoverable: false,
          });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
          return;
        }
        // 阻塞返回 = 轮落定：completed + usage + idle
        if (state.turnText !== "" && state.turnMessageId !== null) {
          state.sink?.({ type: "message.completed", sessionId: state.sessionId, messageId: state.turnMessageId, text: state.turnText });
        }
        if (state.usedBefore !== null && state.usedNow !== null && state.usedNow > state.usedBefore) {
          state.sink?.({
            type: "usage",
            sessionId: state.sessionId,
            inputTokens: state.usedNow - state.usedBefore,
            outputTokens: 0,
            costUsd: 0,
            model: "grok",
            requestId: `grok:${state.ref}:${process.pid}:${++state.usageCount}`,
          });
        }
        state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      },
      cancel: async () => {
        if (state.ref === null) return;
        // ACP 标准：session/cancel（grok 支持与否实测未证；失败只置 idle 不硬杀）
        const r = (await this.request(state, "session/cancel", { sessionId: state.ref })) as AcpResponse;
        if (r.error !== undefined) {
          log.debug("grok session/cancel 被拒", { err: r.error.message });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
        }
      },
      resolvePermission: async (requestId: string, decision: "allow" | "deny" | "always") => {
        const acpId = Number(requestId.replace(/^grok:/, ""));
        if (!Number.isFinite(acpId)) return;
        // 标准 ACP 三档：allow→allow_once（grok 无 always 档时降 once），deny→reject
        this.replyRaw(state, acpId, {
          outcome: { outcome: "selected", optionId: decision === "deny" ? "reject" : decision === "always" ? "always" : "allow" },
        });
        state.sink?.({
          type: "permission.resolved",
          sessionId: state.sessionId,
          requestId,
          decision: decision === "always" ? "allow" : decision,
        });
      },
      externalRef: () => state.ref,
    };
  }

  async disconnect(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.closed = true;
      s.child?.kill();
    }
    this.sessions.clear();
  }

  // ---- 进程 / 握手 / 请求基线 ---------------------------------------------------

  private async ensureSession(state: GrokSession): Promise<void> {
    if (state.ref !== null) return;
    const cmd = await resolveCommand("grok");
    const child = spawn(cmd.file, [...cmd.prefixArgs, "agent", "stdio"], {
      cwd: state.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    state.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(state, line));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s !== "") log.debug("grok stderr", { line: s.slice(0, 160) });
    });
    child.once("exit", (code) => {
      log.info("grok ACP 进程退出", { code, session: state.sessionId });
      state.child = null;
      state.initialized = false;
      state.ref = null;
    });

    const init = (await this.request(state, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })) as AcpResponse;
    if (init.error !== undefined) throw new Error(`grok initialize 失败：${init.error.message}`);
    state.initialized = true;

    // reattach：先 resume，失败回落新会话
    const resumeRef = (state as { resumeRef?: string }).resumeRef;
    if (resumeRef !== undefined) {
      const r = (await this.request(state, "session/resume", { sessionId: resumeRef })) as AcpResponse;
      if (r.error === undefined && r.result !== undefined) {
        state.ref = resumeRef;
        return;
      }
      log.debug("grok session/resume 回落新会话", { err: r.error?.message });
    }
    const sn = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: [] })) as AcpResponse;
    if (sn.error !== undefined) throw new Error(`grok session/new 失败：${sn.error.message}`);
    state.ref = sn.result?.sessionId ?? null;
    // 模型清单顺手吸收
    const models = sn.result?.models?.availableModels;
    if (Array.isArray(models) && models.length > 0) {
      const harvested = models
        .filter((m): m is typeof m & { modelId: string } => typeof m.modelId === "string")
        .map((m) => ({
          id: m.modelId as ModelId,
          displayName: m.name ?? m.modelId,
          contextWindow: m._meta?.totalContextTokens ?? 256000,
        }));
      if (harvested.length > 0 && harvested.length !== this._models.length) this._models = harvested;
    }
  }

  private request(state: GrokSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++state.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`grok ${method} 超时`));
      }, 120_000);
      state.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private replyRaw(state: GrokSession, id: number, result: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private onLine(state: GrokSession, line: string): void {
    const s = line.trim();
    if (s === "") return;
    let f: AcpResponse | AcpRequest;
    try {
      f = JSON.parse(s) as AcpResponse;
    } catch {
      return;
    }
    // 响应
    if (f.id !== undefined && (f as AcpResponse).result !== undefined) {
      const p = state.pending.get(f.id);
      if (p !== undefined) {
        state.pending.delete(f.id);
        p.resolve(f);
      }
      return;
    }
    if (f.id !== undefined && (f as AcpResponse).error !== undefined) {
      const p = state.pending.get(f.id);
      if (p !== undefined) {
        state.pending.delete(f.id);
        p.resolve(f);
      }
      return;
    }
    const req = f as AcpRequest;
    // 反向请求（权限）
    if (req.method !== undefined && req.id !== undefined) {
      if (req.method === "session/request_permission") {
        const tc = req.params?.toolCall;
        const options = req.params?.options ?? [];
        // optionId 按语义挑：allow_once / always / reject（grok 档位以实际下发为准）
        state.sink?.({
          type: "permission.requested",
          sessionId: state.sessionId,
          requestId: `grok:${req.id}`,
          kind: tc?.kind === "execute" ? "shell" : tc?.kind === "edit" ? "file_write" : "tool",
          detail: tc?.title ?? "grok 审批",
          risk: tc?.kind === "execute" ? "high" : "medium",
        });
        // 决策回执在 resolvePermission（requestId 携带 acp id）；选项留痕
        log.debug("grok 权限选项", { options: options.map((o) => `${o.optionId}:${o.kind}`).join(",") });
        return;
      }
      // 未知反向请求：婉拒（0 号 option 或 reject）
      this.replyRaw(state, req.id, { outcome: { outcome: "rejected" } });
      return;
    }
    // 通知
    if (req.method === "session/update") this.onUpdate(state, (f as unknown as { params?: { update?: AcpUpdate; sessionId?: string } }).params?.update);
    else if (req.method !== undefined && req.method.startsWith("_x.ai")) {
      log.debug("grok x.ai 通知", { method: req.method });
    }
  }

  private textOfContent(content: AcpContent | AcpContent[] | undefined): string {
    if (content === undefined) return "";
    const arr = Array.isArray(content) ? content : [content];
    return arr
      .map((c) => (typeof c.text === "string" ? c.text : this.textOfContent(c.content as AcpContent | AcpContent[] | undefined)))
      .join("");
  }

  private onUpdate(state: GrokSession, u: AcpUpdate | undefined): void {
    if (u === undefined) return;
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.textOfContent(u.content);
        if (text !== "") {
          if (state.turnMessageId === null) state.turnMessageId = `msg_${state.sessionId.slice(5, 13)}`;
          sink({ type: "message.delta", sessionId, messageId: state.turnMessageId, role: "assistant", text });
          state.turnText += text;
        }
        if (u._meta?.totalTokens !== undefined) state.usedNow = u._meta.totalTokens;
        break;
      }
      case "agent_thought_chunk": {
        const text = this.textOfContent(u.content);
        if (text !== "") sink({ type: "reasoning.delta", sessionId, messageId: `think_${Date.now()}`, text });
        if (u._meta?.totalTokens !== undefined) state.usedNow = u._meta.totalTokens;
        break;
      }
      case "tool_call": {
        const raw = (u.rawInput ?? {}) as Record<string, unknown>;
        sink({
          type: "tool.started",
          sessionId,
          callId: u.toolCallId ?? `call_${Date.now()}`,
          toolName: typeof raw["command"] === "string" ? "shell" : (u.title ?? "tool"),
          title: u.title ?? "",
          input: raw,
        });
        break;
      }
      case "tool_call_update": {
        if (u.status === "completed" || u.status === "failed") {
          const output = this.textOfContent(u.content);
          sink({
            type: "tool.completed",
            sessionId,
            callId: u.toolCallId ?? `call_${Date.now()}`,
            ok: u.status === "completed",
            output: output.slice(0, 4000),
          });
        }
        break;
      }
      case "user_message_chunk":
      case "plan":
        break;
      case "available_commands_update": {
        // grok ACP 的运行时命令面推送 —— 比静态目录更强的事实源，直接覆盖缓存。
        // 通知形状官方文档没写（本机暂未捕获到样本），宽容解析 + 未识别时留痕。
        const parsed = parseGrokCommandsUpdate(u);
        if (parsed !== null) {
          this.commandCache.set(state.rootPath, { commands: parsed, at: Date.now() });
          log.info("grok 命令面运行时更新", { rootPath: state.rootPath, count: parsed.length });
        } else {
          log.debug("grok available_commands_update 未识别形状", { keys: Object.keys(u ?? {}) });
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---- 文件级发现（官方 File Locations 约定，零进程）----------------------------

/** 扁平 yaml frontmatter 宽松解析：只取 name/description 两键 */
function parseGrokFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return out;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return out;
  for (const line of raw.slice(raw.indexOf("\n") + 1, end).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

/** 技能段：`<base>/.grok/skills/<name>/SKILL.md`（+ ~/.claude/skills 兼容源，官方 Claude Code compat 约定） */
function readGrokSkills(rootPath: string): readonly NativeCommandInfo[] {
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: join(homedir(), ".grok", "skills"), source: "user" },
    { dir: join(rootPath, ".grok", "skills"), source: "project" },
    { dir: join(homedir(), ".claude", "skills"), source: "user" },
  ];
  const out: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (seen.has(entry)) continue; // .grok 优先，.claude 兼容源只补缺
      const skillFile = join(dir, entry, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      seen.add(entry);
      out.push({ name: entry, description: parseGrokFrontmatter(raw).description, source, kind: "skill" });
    }
  }
  const standard = readStandardAgentsWorkspace(rootPath);
  for (const s of standard.skills) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

/** 子智能体段：`<base>/.grok/agents/*.md`（frontmatter name/description；缺 name 用文件名） */
function readGrokAgents(rootPath: string): readonly NativeCommandInfo[] {
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: join(homedir(), ".grok", "agents"), source: "user" },
    { dir: join(rootPath, ".grok", "agents"), source: "project" },
  ];
  const out: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = listMarkdownFilesPruned(dir).map((f) => join(dir, f));
    } catch {
      continue;
    }
    for (const file of files) {
      const fileName = file.split(/[\/]/).pop()!.replace(/\.md$/i, "");
      if (fileName === "") continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const fm = parseGrokFrontmatter(raw);
      const name = fm.name && fm.name !== "" ? fm.name : fileName;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: fm.description, source, kind: "agent" });
    }
  }
  const standard = readStandardAgentsWorkspace(rootPath);
  for (const a of standard.agents) {
    if (!seen.has(a.name)) {
      seen.add(a.name);
      out.push(a);
    }
  }
  return out;
}

/** available_commands_update 的宽容解析：认得的形状返回命令段，认不得返回 null（留痕用） */
function parseGrokCommandsUpdate(u: AcpUpdate | undefined): readonly NativeCommandInfo[] | null {
  if (u === undefined) return null;
  const raw = u as AcpUpdate & { commands?: unknown };
  // 形状 A：{ sessionUpdate: "available_commands_update", commands: [{name, description…}] }
  if (Array.isArray(raw.commands)) {
    const out: NativeCommandInfo[] = [];
    for (const c of raw.commands as unknown[]) {
      const e = c as { name?: unknown; description?: unknown; argumentHint?: unknown; inputHint?: unknown };
      if (typeof e?.name !== "string" || e.name === "") continue;
      out.push({
        name: e.name,
        description: typeof e.description === "string" ? e.description : undefined,
        argumentHint: typeof e.argumentHint === "string" ? e.argumentHint : typeof e.inputHint === "string" ? e.inputHint : undefined,
        kind: "command",
      });
    }
    return out.length > 0 ? out : null;
  }
  return null;
}
