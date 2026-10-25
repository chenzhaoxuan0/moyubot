/**
 * Codex 执行器适配器 —— 走 `codex app-server`（常驻 JSON-RPC 2.0 over stdio，
 * docs/13 Phase 4 Tier 1 升级，原 `codex exec --json` 每轮一进程形态退役）。
 *
 * 协议事实（codex-cli 0.162.1 本机实测，2026-10-14）：
 * - 握手：initialize {clientInfo{name,title,version}} → {userAgent,codexHome,…}
 * - 会话：thread/start {cwd} → thread.id；续接 thread/resume {threadId}
 * - 一轮：turn/start {threadId, input:[{type:"text",text}], options{model,effort,
 *   sandboxPolicy,approvalPolicy}} → turn.id（input 必须是数组，字符串会被 32600 拒）
 * - 事件：item/started|completed（userMessage/agentMessage/commandExecution/reasoning/
 *   fileChange…）、item/agentMessage/delta（真流式）、item/commandExecution/outputDelta、
 *   thread/tokenUsage/updated（total/last 两口径）、thread/status/changed、
 *   turn/completed、turn/failed、error
 * - 审批：server→client 请求（item/commandExecution/requestApproval 等）→ 回
 *   {decision:"approved"|"denied"}；译成 permission.requested 走统一权限闸
 * - usage 口径（对齐契约）：billedInput = inputTokens + cacheWriteInputTokens
 * - 会话事实源：app-server 同样落 ~/.codex/sessions rollout（Phase 1 reader 直读）
 * - **计划无线面**（2026-10-19 实测，0.162.x）：明确要求调用 update_plan 也不调，
 *   原生帧无任何 plan/todoList item 类型 —— host.planTools 的清单映射对 codex
 *   暂无输入。未来版本加了计划 item 时，未知类型有 debug 痕迹（见 item/started），
 *   到时在此处映射即可。
 *
 * 一个 adapter 共享一个 app-server 子进程（codex 自己的 daemon 设计），
 * 进程死掉下一次请求自动重连 + 重初始化（thread 幂等 resume）。
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type NativeModelConfig,
  type StartRequest,
} from "./types.ts";
import { readCodexModelDefaults, writeCodexModelDefaults } from "./model-defaults.ts";
import { readCodexModelCatalog, writeCodexModelCatalog } from "./codex-catalog.ts";
import type { ModelCatalogInfo, ModelCatalogWriteRow } from "./types.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { discoverCodexSkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- 线协议（宽松类型）--------------------------------------------------------

interface AppItem {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  status?: string;
  phase?: string;
  changes?: readonly { path?: string; kind?: string }[];
}

interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

interface Frame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// ---- 会话状态 ---------------------------------------------------------------

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  /** codex thread id（rollout 同 id；daemon 重启 reattach 用） */
  threadId: string | null;
  sink: AdapterSink | null;
  /** 本会话当前是否有进行中的 turn（send 据此决定 turn/start 还是 turn/steer） */
  turnActive: boolean;
  /** 流式 assistant 消息的 itemId → 是否已发过 delta（completed 时收尾） */
  streamed: Set<string>;
  /** 每轮 loop 参数（模型/推理力度），turn/start options 透传 */
  loop: { model?: string | null; reasoningLevel?: string };
  /** 会话级权限档：决定 sandboxPolicy + approvalPolicy */
  mode: StartRequest["mode"];
  /** 最近一次 tokenUsage（turn/completed 时出 usage 事件） */
  lastUsage: TokenUsage | undefined;
  usageCount: number;
  /** reattach 正在进行的异步 thread/resume promise；sendTurn/cancel 前需先等待完成 */
  readyPromise?: Promise<void>;
}

/** mode → codex 沙箱/审批档。plan 只读，yolo 全开不问，其余 workspace-write + 按需问。 */
function policyFor(mode: StartRequest["mode"]): { sandboxPolicy: { type: string }; approvalPolicy: string } {
  if (mode === "plan") return { sandboxPolicy: { type: "read-only" }, approvalPolicy: "untrusted" };
  if (mode === "yolo") return { sandboxPolicy: { type: "danger-full-access" }, approvalPolicy: "never" };
  return { sandboxPolicy: { type: "workspace-write" }, approvalPolicy: "on-request" };
}

// ---- 原生斜杠命令（custom prompts 的 TUI 等价发现/展开）-----------------------

interface CodexPromptDef {
  readonly info: NativeCommandInfo;
  /** 命令正文（去掉 frontmatter 后的 markdown）——展开时用 */
  readonly body: string;
}

/**
 * codex 的自定义提示词（TUI 里就是斜杠命令）：`$CODEX_HOME/prompts/*.md`（用户级）
 * 与 `<root>/.codex/prompts/*.md`（项目级）。app-server 协议没有命令发现面，
 * 但**文件本身就是声明**——直接读目录等价于 TUI 的命令面板；send 时做与 TUI
 * 相同的展开（$ARGUMENTS 替换），对用户来说就是同一个命令。
 */
function readCodexPrompts(rootPath: string): readonly CodexPromptDef[] {
  const codexHome = process.env["CODEX_HOME"] || join(homedir(), ".codex");
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: join(codexHome, "prompts"), source: "user" },
    { dir: join(rootPath, ".codex", "prompts"), source: "project" },
  ];
  const out: CodexPromptDef[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // 目录不存在 = 该层级没有自定义命令
    }
    for (const f of files) {
      const name = f.slice(0, -3);
      if (name === "" || seen.has(name)) continue; // 项目级覆盖用户级（TUI 同款优先级）
      seen.add(name);
      let raw: string;
      try {
        raw = readFileSync(join(dir, f), "utf8");
      } catch {
        continue;
      }
      const { info, body } = parsePromptFile(name, raw, source);
      out.push({ info, body });
    }
  }
  return out;
}

/** frontmatter 解析（description / argument-hint 两字段，其余忽略），正文原样 */
function parsePromptFile(
  name: string,
  raw: string,
  source: "user" | "project",
): { info: NativeCommandInfo; body: string } {
  let body = raw;
  const description: Record<string, string> = {};
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end !== -1) {
      const header = raw.slice(raw.indexOf("\n") + 1, end);
      body = raw.slice(raw.indexOf("\n", end + 1) + 1);
      for (const line of header.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        if (key === "description" || key === "argument-hint") description[key] = line.slice(i + 1).trim();
      }
    }
  }
  return {
    info: {
      name,
      description: description["description"] || undefined,
      argumentHint: description["argument-hint"] || undefined,
      source,
    },
    body,
  };
}

// ---- 常驻 app-server 连接 -----------------------------------------------------

class AppServerConnection {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (f: Frame) => void; timer: NodeJS.Timeout }>();
  /** server→client 请求（审批等）的处理器；params 原样、回执走 reply */
  approvalHandler: ((frame: Frame) => void) | null = null;
  /** 通知事件处理器（item/*、turn/*、thread/*） */
  eventHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;

  private async ensure(): Promise<void> {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) return;
    const cmd = await resolveCommand("codex");
    const child = spawn(cmd.file, [...cmd.prefixArgs, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.pending.clear();
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s !== "") log.debug("codex app-server stderr", { line: s.slice(0, 200) });
    });
    child.once("exit", (code) => {
      log.info("codex app-server exited", { code });
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ error: { code: -1, message: `app-server exited (${code})` } });
      }
      this.pending.clear();
      this.child = null;
    });
    await this.request("initialize", {
      clientInfo: { name: "agent-workbench", title: "MoyuBot", version: "0.1.0" },
    });
  }

  private onLine(line: string): void {
    const s = line.trim();
    if (s === "") return;
    let f: Frame;
    try {
      f = JSON.parse(s) as Frame;
    } catch {
      return;
    }
    // server→client 请求（审批 / 交互）
    if (f.method !== undefined && f.id !== undefined) {
      this.approvalHandler?.(f);
      return;
    }
    // 响应
    if (f.id !== undefined) {
      const p = this.pending.get(Number(f.id));
      if (p !== undefined) {
        this.pending.delete(Number(f.id));
        clearTimeout(p.timer);
        p.resolve(f);
      }
      return;
    }
    // 通知
    if (f.method !== undefined) this.eventHandler?.(f.method, f.params ?? {});
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<Frame> {
    return this.ensure().then(
      () =>
        new Promise<Frame>((resolve) => {
          const child = this.child;
          if (child === null || child.stdin === null) {
            resolve({ error: { code: -1, message: "app-server not running" } });
            return;
          }
          const id = ++this.nextId;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            resolve({ error: { code: -1, message: `${method} timeout` } });
          }, timeoutMs);
          this.pending.set(id, { resolve, timer });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        }),
    );
  }

  /** 回 server→client 请求（审批决定） */
  reply(id: number | string, result: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

// ---- 适配器 -------------------------------------------------------------------

const DEFAULT_CODEX_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "gpt-6-astra" as ModelId,
    displayName: "GPT-6 Astra",
    contextWindow: 272000,
    maxOutput: 128000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningLevel: "medium",
    multimodal: true,
  },
  {
    id: "gpt-5-1-codex" as ModelId,
    displayName: "GPT-5.1 Codex",
    contextWindow: 272000,
    maxOutput: 128000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "medium",
    multimodal: true,
  },
  {
    id: "gpt-5.6-luna" as ModelId,
    displayName: "GPT-5.6 Luna",
    contextWindow: 272000,
    maxOutput: 128000,
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "medium",
    multimodal: true,
  },
];

export class CodexAdapter implements ExecutorAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly glyph = "C";
  // 原生读取 cwd 下的 AGENTS.md（官方文档明确；openclaw 的 codex 适配层也据此排除注入）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [...DEFAULT_CODEX_MODELS];
  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("codex");
      const out = await execLines(cmd, ["debug", "models"], 8000);
      const parsed = JSON.parse(out) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          context_window?: number;
          default_reasoning_level?: string;
          supported_reasoning_levels?: Array<string | { effort?: string }>;
          input_modalities?: string[];
        }>;
      };
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        const synced = parsed.models
          .filter((m): m is typeof m & { slug: string } => typeof m.slug === "string" && m.slug.length > 0)
          .map((m) => {
            const reasoningLevels = Array.isArray(m.supported_reasoning_levels)
              ? m.supported_reasoning_levels
                  .map((r) => (typeof r === "string" ? r : r.effort))
                  .filter((r): r is string => typeof r === "string" && r.length > 0)
              : undefined;
            return {
              id: m.slug as ModelId,
              displayName: m.display_name ?? m.slug,
              contextWindow: m.context_window ?? 272000,
              reasoningLevels,
              defaultReasoningLevel: m.default_reasoning_level,
              multimodal: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : true,
            };
          });
        if (synced.length > 0) {
          this._models = synced;
          log.info("codex models synced dynamically", { count: synced.length });
          return { models: synced, source: "live", elapsedMs: Date.now() - t0 };
        }
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("codex debug models failed, using fallback models", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    // 命令跑通了但没给出可用条目 —— 也是「没刷到」，不能谎报 live
    return { models: this._models, source: "static", reason: "codex debug models 未返回可用条目", elapsedMs: Date.now() - t0 };
  }

  /** 原生模型默认值 —— config.toml 顶层 model_* 键（cc-switch 同款字段集） */
  readModelDefaults(): NativeModelConfig {
    return readCodexModelDefaults();
  }

  writeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
    return writeCodexModelDefaults(values);
  }

  /** 模型目录 —— model-catalogs 文件的清单级编辑（增删/显示名/窗口/档位/可见性） */
  async readModelCatalog(): Promise<ModelCatalogInfo> {
    return readCodexModelCatalog();
  }

  async writeModelCatalog(rows: readonly ModelCatalogWriteRow[]): Promise<ModelCatalogInfo> {
    return writeCodexModelCatalog(rows);
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    // turn/diff/updated 出 turn 级聚合 unified diff，按文件拆分后发 file.diff
    fileDiff: true,
    terminal: false,
    // app-server 双向 RPC：requestApproval 反向请求 → 统一权限闸
    permissions: true,
    subagents: false,
    worktrees: true,
    sandbox: true,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime", // item/agentMessage/delta 真 token 流
    steering: "mid-turn", // turn 进行中可 turn/steer
  };

  private readonly conn = new AppServerConnection();
  private readonly sessions = new Map<string, SessionState>();

  /** 原生命令缓存（prompts 目录读盘结果，TTL 同 claude 口径） */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /** 自定义提示词、技能与子智能体清单（菜单数据）。读盘很便宜，TTL 只是为了少抖。 */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < CodexAdapter.COMMAND_TTL_MS) return hit.commands;
    const custom = readCodexPrompts(rootPath).map((p) => p.info);
    const discovered = discoverCodexSkillsAndAgents(rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, custom, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  /**
   * /name args → 展开成 prompt 正文（TUI 等价：$ARGUMENTS 替换）。
   * 只展开**确实存在**的自定义命令；其余 "/" 开头文本原样透传（codex 会当普通文本）。
   * 每次现读文件而不是用缓存 —— 用户改完 .md 立即生效，跟 TUI 行为一致。
   */
  private expandNativeCommand(state: SessionState, text: string): string {
    if (!text.startsWith("/")) return text;
    const sp = text.search(/\s/);
    const name = text.slice(1, sp === -1 ? undefined : sp);
    if (name === "") return text;
    const def = readCodexPrompts(state.rootPath).find((p) => p.info.name === name);
    if (def === undefined) return text;
    const args = sp === -1 ? "" : text.slice(sp + 1).trim();
    log.debug("codex native command expanded", { name, rootPath: state.rootPath });
    return def.body.replaceAll("$ARGUMENTS", args).trim();
  }

  constructor() {
    this.conn.eventHandler = (method, params) => this.onNotify(method, params);
    this.conn.approvalHandler = (frame) => this.onServerCall(frame);
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("codex");
      const out = await execLines(cmd, ["--version"], 15000);
      void this.syncModels().catch(() => {});
      return {
        state: { status: "ready", version: out.trim() || "unknown" },
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
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      threadId: null,
      sink,
      turnActive: false,
      streamed: new Set(),
      loop: { model: req.model ?? null, reasoningLevel: req.reasoningLevel },
      mode: req.mode,
      lastUsage: undefined,
      usageCount: 0,
    };
    this.sessions.set(state.sessionId, state);

    const r = await this.conn.request("thread/start", { cwd: req.rootPath });
    if (r.error !== undefined) {
      throw Object.assign(new Error(`codex thread/start 失败：${r.error.message ?? "unknown"}`), { code: "start_failed" });
    }
    const thread = (r.result as { thread?: { id?: string } } | undefined)?.thread;
    if (thread?.id !== undefined) state.threadId = thread.id;

    return this.sessionImpl(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      threadId: ref,
      sink,
      turnActive: false,
      streamed: new Set(),
      loop: {},
      // reattach 无 mode 参数：与原 exec 路径一致取 build（workspace-write + on-request）
      mode: "build",
      lastUsage: undefined,
      usageCount: 0,
    };
    this.sessions.set(sessionId, state);
    state.readyPromise = this.conn
      .request("thread/resume", { threadId: ref, cwd: rootPath }, 20000)
      .then((r) => {
        if (r.error !== undefined) log.warn("codex thread/resume 失败或回落", { ref, err: r.error.message });
      })
      .catch((err: unknown) => {
        log.warn("codex thread/resume 异常", { ref, err: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        state.readyPromise = undefined;
      });
    return this.sessionImpl(state);
  }

  private sessionImpl(state: SessionState): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
        await this.sendTurn(state, this.expandNativeCommand(state, text));
      },
      cancel: async () => {
        if (state.readyPromise) await state.readyPromise;
        if (state.threadId === null) return;
        const r = await this.conn.request("turn/interrupt", { threadId: state.threadId }, 15000);
        if (r.error !== undefined) {
          log.debug("codex turn/interrupt 被拒", { err: r.error.message });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
        }
      },
      resolvePermission: async (requestId: string, decision: "allow" | "deny" | "always") => {
        // requestId 形如 `codex:<jsonRpcId>:<callId>`——reply 需要原始 JSON-RPC id
        const raw = requestId.split(":")[1] ?? "";
        const rpcId = /^-?\d+$/.test(raw) ? Number(raw) : raw;
        this.conn.reply(rpcId, { decision: decision === "deny" ? "denied" : "approved" });
        state.sink?.({
          type: "permission.resolved",
          sessionId: state.sessionId,
          requestId,
          decision: decision === "always" ? "allow" : decision,
        });
      },
      externalRef: () => state.threadId,
    };
  }

  async disconnect(): Promise<void> {
    await this.conn.kill();
    this.sessions.clear();
  }

  // ---- turn ----

  private async sendTurn(state: SessionState, text: string): Promise<void> {
    if (state.readyPromise) {
      await state.readyPromise;
    }
    if (state.threadId === null) {
      state.sink?.({ type: "error", sessionId: state.sessionId, message: "codex thread 未建立", recoverable: false });
      return;
    }
    const policy = policyFor(state.mode);
    const options: Record<string, unknown> = {
      ...policy,
      ...(state.loop.model ? { model: state.loop.model } : {}),
      ...(state.loop.reasoningLevel ? { effort: state.loop.reasoningLevel === "max" ? "high" : state.loop.reasoningLevel } : {}),
    };
    const params: Record<string, unknown> = {
      threadId: state.threadId,
      input: [{ type: "text", text }],
      options,
    };
    // turn 进行中 → steer（插话语义）；空闲 → 新 turn
    const method = state.turnActive ? "turn/steer" : "turn/start";
    const r = await this.conn.request(method, params);
    if (r.error !== undefined) {
      state.sink?.({ type: "error", sessionId: state.sessionId, message: `codex ${method} 失败：${r.error.message ?? "unknown"}`, recoverable: false });
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
      return;
    }
    state.turnActive = true;
    state.lastUsage = undefined;
  }

  // ---- 事件翻译 -------------------------------------------------------------

  private stateOfThread(threadId: unknown): SessionState | undefined {
    if (typeof threadId !== "string") return undefined;
    for (const s of this.sessions.values()) if (s.threadId === threadId) return s;
    return undefined;
  }

  private onNotify(method: string, p: Record<string, unknown>): void {
    if (method.startsWith("mcpServer") || method === "configWarning" || method === "warning" || method.startsWith("account/")) return;
    const state = this.stateOfThread(p["threadId"]);
    if (state === undefined) return;
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    switch (method) {
      case "item/started": {
        const item = (p["item"] ?? {}) as AppItem;
        if (item.type === "commandExecution") {
          sink({
            type: "tool.started",
            sessionId,
            callId: item.id ?? `call_${Date.now()}`,
            toolName: "shell",
            title: item.command ?? "shell",
            input: { command: item.command },
          });
        } else if (item.type !== "userMessage" && item.type !== "agentMessage" && item.type !== "reasoning" && item.type !== "fileChange") {
          // 计划映射（host.planTools）等着清单类 item 出现的那天：未知类型留
          // debug 痕迹，新 codex 加了 plan/todoList item 时这里第一时间看见
          log.debug("codex unhandled item type", { type: item.type, keys: Object.keys(item).join(",") });
        }
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = typeof p["itemId"] === "string" ? p["itemId"] : `msg_${Date.now()}`;
        const delta = typeof p["delta"] === "string" ? p["delta"] : "";
        if (delta !== "") {
          sink({ type: "message.delta", sessionId, messageId: itemId, role: "assistant", text: delta });
          state.streamed.add(itemId);
        }
        break;
      }
      case "item/commandExecution/outputDelta": {
        // 实时输出：契约没有 tool.delta，累计到 item.completed 一次性给（避免噪音事件海）
        break;
      }
      case "item/completed": {
        const item = (p["item"] ?? {}) as AppItem;
        this.onItemCompleted(state, item);
        break;
      }
      case "thread/tokenUsage/updated": {
        const tu = p["tokenUsage"] as { last?: TokenUsage } | undefined;
        if (tu?.last !== undefined) state.lastUsage = tu.last;
        break;
      }
      case "turn/completed": {
        state.turnActive = false;
        const usage = state.lastUsage;
        if (usage !== undefined) {
          const billedInput = (usage.inputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
          sink({
            type: "usage",
            sessionId,
            inputTokens: billedInput,
            outputTokens: (usage.outputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0),
            cacheReadTokens: usage.cachedInputTokens,
            cacheWriteTokens: usage.cacheWriteInputTokens,
            costUsd: 0,
            model: String(state.loop.model ?? "codex-default"),
            requestId: `codex:${state.threadId ?? sessionId}:p${process.pid}:${++state.usageCount}`,
          });
        }
        sink({ type: "session.status", sessionId, status: "idle" });
        break;
      }
      case "turn/failed":
      case "error": {
        state.turnActive = false;
        const msg =
          typeof p["message"] === "string"
            ? p["message"]
            : ((p["turn"] as { error?: { message?: string } } | undefined)?.error?.message ?? `${method} 事件`);
        sink({ type: "error", sessionId, message: msg, recoverable: true });
        sink({ type: "session.status", sessionId, status: "failed" });
        break;
      }
      case "turn/diff/updated": {
        const diff = typeof p["diff"] === "string" ? p["diff"] : "";
        if (diff !== "") this.emitFileDiffs(state, diff);
        break;
      }
      default:
        log.debug("codex unhandled notification", { method });
        break; // thread/started、thread/status/changed 等生命周期噪音，host 侧状态机不依赖
    }
  }

  private onItemCompleted(state: SessionState, item: AppItem): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    if (item.type === "agentMessage") {
      const text = item.text ?? "";
      const id = item.id ?? `msg_${Date.now()}`;
      if (state.streamed.has(id)) {
        // delta 已流过，只补完成信号
        sink({ type: "message.completed", sessionId, messageId: id, text });
      } else if (text !== "") {
        sink({ type: "message.delta", sessionId, messageId: id, role: "assistant", text });
        sink({ type: "message.completed", sessionId, messageId: id, text });
      }
      state.streamed.delete(id);
    } else if (item.type === "commandExecution") {
      sink({
        type: "tool.completed",
        sessionId,
        callId: item.id ?? `call_${Date.now()}`,
        ok: item.exitCode === 0 || item.status === "completed",
        output: item.aggregatedOutput ?? item.status ?? "",
      });
    } else if (item.type === "reasoning") {
      const text = item.text ?? "";
      if (text !== "") sink({ type: "reasoning.delta", sessionId, messageId: item.id ?? `r_${Date.now()}`, text });
    } else if (item.type === "fileChange") {
      for (const ch of item.changes ?? []) {
        if (ch.path === undefined) continue;
        const change = ch.kind === "add" ? "created" : ch.kind === "delete" ? "deleted" : "modified";
        sink({ type: "file.changed", sessionId, path: ch.path, change });
      }
    } else if (item.type === "error") {
      sink({ type: "error", sessionId, message: item.text ?? "item error", recoverable: true });
    }
  }

  /** turn 级聚合 unified diff → 按文件拆 file.diff（additions/deletions 计数） */
  private emitFileDiffs(state: SessionState, unified: string): void {
    const sink = state.sink;
    if (sink === null) return;
    const lines = unified.split(/\r?\n/);
    let file: string | null = null;
    let add = 0;
    let del = 0;
    const flush = (): void => {
      if (file !== null && (add > 0 || del > 0)) {
        sink({ type: "file.diff", sessionId: state.sessionId, path: file, additions: add, deletions: del });
      }
      file = null;
      add = 0;
      del = 0;
    };
    for (const l of lines) {
      if (l.startsWith("+++ ") || l.startsWith("--- ")) {
        if (l.startsWith("+++ ")) {
          flush();
          file = l.slice(4).replace(/^b\//, "").trim();
        }
        continue;
      }
      if (file === null) continue;
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
    flush();
  }

  /** server→client 请求：审批类 → permission.requested；其余自动婉拒并留痕 */
  private onServerCall(frame: Frame): void {
    const method = frame.method ?? "";
    const p = frame.params ?? {};
    const threadId = p["threadId"];
    const state = this.stateOfThread(threadId);
    const id = frame.id ?? 0;

    if (method.includes("requestApproval")) {
      if (state === undefined) {
        this.conn.reply(id, { decision: "denied" });
        return;
      }
      const callId = typeof p["callId"] === "string" ? p["callId"] : `appr_${id}`;
      const isFile = method.includes("fileChange");
      const detail =
        (isFile ? (p["changes"] ?? p["paths"]) : (p["command"] ?? p["title"])) instanceof Object
          ? JSON.stringify(isFile ? (p["changes"] ?? p["paths"]) : (p["command"] ?? p["title"])).slice(0, 300)
          : String(isFile ? (p["changes"] ?? p["paths"] ?? "") : (p["command"] ?? p["title"] ?? "")).slice(0, 300);
      state.sink?.({
        type: "permission.requested",
        sessionId: state.sessionId,
        requestId: `codex:${id}:${callId}`,
        kind: isFile ? "file_write" : "shell",
        detail,
        risk: "medium",
      });
      return;
    }
    // 未知反向请求：婉拒 + 留痕（协议演进时日志里能看到原始形状）
    log.info("codex app-server 未处理的反向请求已婉拒", { method, params: JSON.stringify(p).slice(0, 300) });
    this.conn.reply(id, { decision: "denied" });
  }
}
