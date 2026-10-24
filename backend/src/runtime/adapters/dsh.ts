/**
 * DeepSeek Harness（dsh）执行器适配器 —— ACP 形态：`dsh acp`（= --profile acp）常驻子进程，
 * JSON-RPC（newline-delimited）over stdio，与 mcode.ts 同构。
 *
 * 为什么走 ACP 而不是 cherry-studio 的进程内 SDK 形态：cherry（GPL，只看思路）
 * 用 `@deepseek-ai/dsh-sdk-client` 动态 import 把 dsh 嵌进主进程（dshSdk.ts 的
 * ESM-only 注释是关键约束）。daemon 的 SPI 以子进程协议为中心，而 dsh 官方把 ACP
 * 定位成 automation-only 的程序化入口（packages/acp/acp），无需引入厂商依赖即可拿到
 * 同样的会话/权限/用量面 —— 选 ACP，cherry 只借鉴「resume token 事件化」这一
 * 已在契约里的点（session.ref / externalRef = dsh sessionId）。
 *
 * 协议事实（dsh 0.2.0-rc.2 实测 + packages/acp/acp 源码走查）：
 * - initialize → {protocolVersion:1, agentInfo:{name:"deepseek-harness-acp"},
 *   agentCapabilities:{sessionCapabilities:{close,list,resume}}, authMethods:[]}
 *   —— 无 modes、无 loadSession 标志；authenticate 是 no-op（本机已登录，凭据走 DSH_HOME）
 * - session/new {cwd, mcpServers} → {sessionId:UUID, configOptions:[{id:"model",…}]}
 *   模型选择走 session/setConfigOption，value 是 JSON 串 `'["provider","model"]'`
 * - session/prompt → session/update 通知 + 阻塞到轮末 {stopReason}
 *   - agent_message_chunk / agent_thought_chunk（content:{type:"text"}）
 *   - tool_call{toolCallId,title:name,kind:"other",status:"in_progress",rawInput}
 *   - tool_call_update{toolCallId,status:"completed"|"failed",content:[{type:"content",content}]}
 *     —— 无 rawOutput、无 diff 块，故 fileDiff 如实报 false
 *   - usage_update{used,size} —— 会话累计 token，无成本字段；按轮差值出 usage
 * - 权限是最小形态：session/request_permission {sessionId,
 *   toolCall:{toolCallId}, options:[allow-once/allow_once, reject-once/reject_once]}
 *   —— detail 用此前 tool_call 通知里记下的工具名（通知先于权限请求到达）
 * - reattach：session/resume {sessionId, cwd, mcpServers}，cwd 必须与原会话一致；
 *   恢复的历史语义更新会以 session/update 重放到客户端（轮外到达的 chunk 被丢弃，
 *   tool_call 保留 —— 时间线上可见历史，与 mcode 同款行为）
 * - 关停：stdin EOF 即自退（实测 exit 0）——「serve until the client disconnects」
 *
 * 启动形态的特殊性：npm 全局的 dsh shim 指向源码 checkout（需要 tsx，本机已坏），
 * 实际可用的是桌面版自带的 cli/bin/dsh.cmd —— 内容是 ELECTRON_RUN_AS_NODE=1 起
 * DeepSeek Harness.exe 跑 cli.js。cmd.exe 转发会在带空格路径上碎掉，所以 resolveDshLaunch
 * 直接解析 shim 拿 exe+js 原生 spawn（可 kill、无引号问题），cmd wrapper 只做兜底。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
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
import { pickAcpModelOptions, pickAcpSelectOption, queryAcpSessionNew } from "./acp-models.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand, type ResolvedCommand } from "../exec.ts";
import { acpMcpServers } from "../../ctrl/store.ts";
import { log } from "../../log.ts";

// ---- ACP 线缆类型（宽松，同 mcode） -------------------------------------------

interface AcpContent {
  type?: string;
  text?: string;
  /** ACP 的内容块是**可嵌套**的：工具结果形如 `{type:"content", content:{type:"text",…}}` */
  content?: AcpContent | AcpContent[];
}

interface AcpUpdate {
  sessionUpdate?: string;
  content?: AcpContent | AcpContent[];
  messageId?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  used?: number;
  size?: number;
}

interface AcpRequest {
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    toolCall?: { toolCallId?: string };
    options?: { optionId?: string; name?: string; kind?: string }[];
  };
}

interface AcpResponse {
  id?: number;
  result?: { sessionId?: string; stopReason?: string };
  error?: { code?: number; message?: string };
}

// ---- 启动命令解析 --------------------------------------------------------------

type DshLaunch = ResolvedCommand & { readonly env?: NodeJS.ProcessEnv };

/**
 * 桌面版 shim 形如：
 *   "%~dp0..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\app.asar\...\cli.js" %*
 * 解出 exe + 前缀参数 + 脚本路径，配 ELECTRON_RUN_AS_NODE=1 原生 spawn。
 */
export async function resolveDshLaunch(): Promise<DshLaunch> {
  const cmd = await resolveCommand("dsh");
  if (cmd.via !== "shim-fallback") return cmd;
  // shim-fallback 的 prefixArgs 固定 ['/d','/s','/c', shimPath]（见 exec.ts）
  const shimPath = cmd.prefixArgs[3];
  if (shimPath === undefined) return cmd;
  try {
    const text = readFileSync(shimPath, "utf8");
    const m = text.match(/^\s*"([^"]+\.exe)"\s+([^\r\n]*?)\s*"([^"]+\.js)"/im);
    if (m?.[1] !== undefined && m[3] !== undefined) {
      const base = dirname(shimPath);
      const exe = resolve(base, m[1].replace(/%~dp0/gi, `${base}\\`));
      const script = resolve(base, m[3].replace(/%~dp0/gi, `${base}\\`));
      const extraArgs = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
      log.info("dsh launch via desktop shim", { exe, script });
      return { file: exe, prefixArgs: [...extraArgs, script], via: "exe", env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
  } catch {
    // 读不了 shim 就走 cmd wrapper 兜底（路径含空格时会失败，probe 会如实报告）
  }
  return cmd;
}

// ---- 会话台账 ------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  readonly acpId: number;
  readonly options: readonly { optionId?: string; name?: string; kind?: string }[];
}

interface TurnAcc {
  turnText: string;
  readonly messageId: string;
  /** 轮起点前的累计用量（usage 差值口径用） */
  readonly usedBefore: number;
}

interface DshSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly model: ModelId | null;
  /** dsh 的 ACP sessionId（UUID），session/new 或 session/resume 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  launch: DshLaunch | null;
  initialized: boolean;
  sessionLoaded: boolean;
  /** 模型 configOption 只在本进程首轮流前设置一次（会话级选择，不是轮级参数） */
  modelApplied: boolean;
  closed: boolean;
  cancelled: boolean;
  lastUsed: number;
  usageCount: number;
  nextId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly permissionPending: Map<string, PendingPermission>;
  /** toolCallId → 工具名（权限事件的 detail 用；dsh 的权限请求只带 toolCallId） */
  readonly toolTitles: Map<string, string>;
  turn: TurnAcc | null;
}

/** `["deepseek-official","deepseek-v4-flash"]` → `deepseek-official/deepseek-v4-flash`；认不出来返回 null */
function parseDshModelValue(value: string): string | null {
  if (value.startsWith("[")) {
    try {
      const arr = JSON.parse(value) as unknown;
      if (Array.isArray(arr)) {
        const parts = arr.filter((x): x is string => typeof x === "string" && x !== "");
        if (parts.length > 0) return parts.join("/");
      }
    } catch {
      return null;
    }
    return null;
  }
  return value === "" ? null : value;
}

export class DshAdapter implements ExecutorAdapter {
  readonly id = "dsh";
  readonly displayName = "DeepSeek Harness";
  readonly glyph = "D";
  // 原生读取 cwd 下的 AGENTS.md（其 e2e workspace-context 套件以 AGENTS.md 为默认
  // instruction file candidate，见本地克隆 apps/cli/tests/.../workspace-context-resume）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [
    // DeepSeek Harness 官方长程架构（ACP 管道直连官方端点，支持 1M 上下文调度）
    {
      id: "deepseek-official/deepseek-v4-flash" as ModelId,
      displayName: "DeepSeek V4 Flash（默认）",
      contextWindow: 1000000,
      reasoningLevels: ["low", "medium", "high"],
      multimodal: false,
    },
    {
      id: "deepseek-official/deepseek-flash" as ModelId,
      displayName: "DeepSeek V41 Flash",
      contextWindow: 1000000,
      multimodal: false,
    },
    {
      id: "deepseek-official/deepseek-v4-pro" as ModelId,
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1000000,
      reasoningLevels: ["low", "medium", "high", "max"],
      multimodal: false,
    },
  ];

  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  /**
   * 动态对齐模型清单：`dsh acp`（= `dsh --profile acp`）的 session/new 把可选模型
   * 放在 `configOptions[category=model]` 里随建会话一起回，**不发 prompt → 零用量**。
   *
   * ## dsh 的两个特别之处
   *
   * 1. 选项是**分组**的（`[{group:"deepseek-official", options:[...]}, {group:"deepseek-account",…}]`），
   *    拍平后同名的 `deepseek-flash` 会在两个分组各出现一次 —— 按 id 去重，
   *    保留先到的（官方组在前）。
   * 2. value 是个 **JSON 串** `["deepseek-official","deepseek-v4-flash"]`，
   *    还原成工作台惯用的 `provider/model` 形态。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const launch = await resolveDshLaunch();
      const result = await queryAcpSessionNew(launch.file, launch.prefixArgs, ["acp"], {
        timeoutMs: 30000,
        env: launch.env,
      });
      const { options } = pickAcpModelOptions(result);
      if (options.length === 0) {
        return { models: this._models, source: "static", reason: "session/new 未返回模型选单", elapsedMs: Date.now() - t0 };
      }
      const efforts = pickAcpSelectOption(result, "reasoning_effort").options.map((o) => o.value);
      const prior = new Map<string, ExecutorModelInfo>(this._models.map((m) => [m.id as string, m]));
      const out: ExecutorModelInfo[] = [];
      for (const opt of options) {
        const id = parseDshModelValue(opt.value);
        if (id === null || out.some((m) => m.id === id)) continue;
        const old = prior.get(id);
        out.push({
          id: id as ModelId,
          displayName: opt.name,
          // 上下文窗口 ACP 不报（只有模型选单），按基础名从上一份清单继承，
          // 首次同步继承的是内置兜底 —— 刷新一次不会把窗口洗成未知
          contextWindow: old?.contextWindow,
          reasoningLevels: old?.reasoningLevels ?? (efforts.length > 0 ? efforts : undefined),
          multimodal: old?.multimodal,
        });
      }
      if (out.length > 0) {
        this._models = out;
        log.info("dsh models synced via ACP session/new", { count: out.length });
        return { models: out, source: "live", elapsedMs: Date.now() - t0 };
      }
      return { models: this._models, source: "static", reason: "模型选单格式无法解析", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("dsh 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true, // session/resume（要求 cwd 与原会话一致）
    fileDiff: false, // tool_call_update 只有 content 包装块，无结构化 diff（源码走查）
    terminal: false,
    permissions: true, // request_permission 反向流（最小形态：allow-once / reject-once）
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // session/new 可挂 http 型 mcpServers（daemon 暂不透传）
    usage: true, // usage_update 只有 token 数，无成本
    multimodal: false, // promptCapabilities.image 由 provider 决定，保守报 false
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, DshSession>();

  /**
   * 交互式 TUI 的启动命令：dst shim（@deepseek-harness-tui/dsh-tui，裸命令即
   * 启动 dsh-tui profile ≡ `dsh --profile dsh-tui`）。本适配器（dsh acp）只管
   * headless 驱动；终端「一键直启」用 dst —— 原独立 dst 适配器已并入此处，
   * terminal.create 拼装 pwsh 命令时会用 tuiCommand 替换裸 id。
   */
  readonly tuiCommand = "dst";


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * DSH 原生命令、技能与子智能体面：
   * 内置目录（见 builtin-catalogs.ts）+ 原生技能（.dsh/skills 与 .agents/skills）+
   * 子智能体（.dsh/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 DSH。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < DshAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverGenericToolSkillsAndAgents(this.id, rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const launch = await resolveDshLaunch();
      const out = await execLines(launch, ["--version"], 30000, { env: launch.env });
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
            ? { status: "not_installed", hint: "未安装 dsh CLI（DeepSeek Harness 桌面版或 npm @deepseek-ai/dsh）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: DshSession = this.newState(`sess_${randomUUID()}` as SessionId, req.rootPath, req.model ?? null, sink);
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        if (state.ref !== null && state.child !== null && state.initialized) {
          this.notify(state, "session/cancel", { sessionId: state.ref });
        }
      },
      resolvePermission: async (requestId, decision) => {
        this.resolvePermission(state, requestId, decision);
      },
      externalRef: () => state.ref,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state = this.newState(sessionId, rootPath, null, sink);
    state.ref = ref; // session/resume 时用；cwd 不匹配或不可恢复时回落新会话
    return {
      id: sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        if (state.ref !== null && state.child !== null && state.initialized) {
          this.notify(state, "session/cancel", { sessionId: state.ref });
        }
      },
      resolvePermission: async (requestId, decision) => {
        this.resolvePermission(state, requestId, decision);
      },
      externalRef: () => state.ref,
    };
  }

  private newState(sessionId: SessionId, rootPath: string, model: ModelId | null, sink: AdapterSink): DshSession {
    const state: DshSession = {
      sessionId,
      rootPath,
      model,
      ref: null,
      sink,
      child: null,
      launch: null,
      initialized: false,
      sessionLoaded: false,
      modelApplied: false,
      closed: false,
      cancelled: false,
      lastUsed: 0,
      usageCount: 0,
      nextId: 1,
      pending: new Map(),
      permissionPending: new Map(),
      toolTitles: new Map(),
      turn: null,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.closed = true;
      for (const p of st.pending.values()) p.reject(adapterError("adapter_disposed", "adapter is shutting down"));
      st.pending.clear();
      const child = st.child;
      // dsh「serve until the client disconnects」：stdin EOF 即自退（实测 exit 0），
      // kill 只作兜底；拆掉我们这侧的流让 daemon 事件循环排空
      child?.stdin?.end();
      const killTimer = setTimeout(() => {
        if (child !== null && child.exitCode === null) child.kill();
      }, 3000);
      killTimer.unref?.();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      st.child = null;
    }
    this.sessions.clear();
  }

  // ---- 进程与协议通道 ---------------------------------------------------------

  private async ensureSession(state: DshSession): Promise<void> {
    if (state.child === null) {
      const launch = state.launch ?? (await resolveDshLaunch());
      state.launch = launch;
      // 常驻协议进程：stdin 是协议通道，绝不能关（exec.ts closeStdin 语义）
      const child = spawn(launch.file, [...launch.prefixArgs, "acp"], {
        cwd: state.rootPath,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...launch.env },
      });
      state.child = child;
      child.stdout?.setEncoding("utf8");
      let buf = "";
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line !== "") this.handleWireLine(state, line);
        }
      });
      child.stderr?.setEncoding("utf8");
      createInterface({ input: child.stderr }).on("line", (line) =>
        log.debug("dsh acp stderr", { line: line.slice(0, 200) }),
      );
      child.once("close", () => {
        state.child = null;
        state.initialized = false;
        const err = adapterError("executor_exited", "dsh acp process exited");
        for (const p of state.pending.values()) p.reject(err);
        state.pending.clear();
      });
    }
    if (!state.initialized) {
      await this.request(state, "initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, 60000);
      state.initialized = true;
    }
    if (state.ref === null) {
      // mcpServers 动态注入（docs/14 §2.4）：dsh 无落盘 MCP 配置，浏览器/电脑控制的
      // 条目由 ctrl/store 的 provider 给出（两个能力都停用时为空数组）；搜索条目
      // 按 bot 区分，provider 拿会话工作目录（state.rootPath）决定给不给。
      // dsh 若拒收，按「全量 → 仅 stdio → 空」三级降级重试——注入是增强，
      // 不能把会话本身搞死；中间级保住浏览器条目不被 http 条目连坐。
      const injected = acpMcpServers(state.rootPath);
      let res: { sessionId?: string };
      try {
        res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: injected }, 60000)) as {
          sessionId?: string;
        };
      } catch (err: unknown) {
        const stdioOnly = injected.filter((e) => e.command !== undefined);
        if (injected.length === 0 || stdioOnly.length === injected.length) throw err;
        try {
          log.warn("dsh session/new rejected full mcpServers, retrying stdio-only", {
            dropped: injected.filter((e) => e.command === undefined).map((e) => e.name),
            error: err instanceof Error ? err.message : String(err),
          });
          res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: stdioOnly }, 60000)) as {
            sessionId?: string;
          };
        } catch (err2: unknown) {
          log.warn("dsh session/new rejected stdio mcpServers too, starting without MCP", {
            error: err2 instanceof Error ? err2.message : String(err2),
          });
          res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: [] }, 60000)) as {
            sessionId?: string;
          };
        }
      }
      if (typeof res.sessionId !== "string" || res.sessionId === "") {
        throw adapterError("acp_no_session", "dsh acp session/new returned no sessionId");
      }
      state.ref = res.sessionId;
      state.sessionLoaded = true;
    } else if (!state.sessionLoaded) {
      await this.resumeSession(state);
    }
  }

  private async resumeSession(state: DshSession): Promise<void> {
    try {
      await this.request(state, "session/resume", { sessionId: state.ref, cwd: state.rootPath, mcpServers: acpMcpServers(state.rootPath) }, 60000);
      state.sessionLoaded = true;
    } catch (err: unknown) {
      // cwd 变了 / 会话不可恢复：回落新会话，宁可丢历史也不能永久不可用
      log.warn("dsh session/resume failed, falling back to a fresh session", {
        ref: state.ref,
        error: err instanceof Error ? err.message : String(err),
      });
      state.ref = null;
      state.sessionLoaded = false;
      await this.ensureSession(state);
    }
  }

  private request(state: DshSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.child === null) return Promise.reject(adapterError("executor_exited", "dsh acp not running"));
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? null
        : setTimeout(() => {
            state.pending.delete(id);
            reject(adapterError("acp_timeout", `${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
      state.pending.set(id, {
        resolve: (v) => {
          if (timer !== null) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer !== null) clearTimeout(timer);
          reject(e);
        },
      });
      state.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(state: DshSession, method: string, params: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleWireLine(state: DshSession, line: string): void {
    let msg: (AcpRequest & AcpResponse) | null = null;
    try {
      msg = JSON.parse(line) as AcpRequest & AcpResponse;
    } catch {
      return;
    }
    if (msg === null) return;

    // ① agent → client 的请求（权限审批）；未知请求按协议礼貌回 method not found
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        this.onPermissionRequest(state, msg.id, msg.params ?? {});
      } else {
        this.respond(state, msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
      }
      return;
    }
    // ② 响应
    if (msg.id !== undefined) {
      const p = state.pending.get(msg.id);
      if (p === undefined) return;
      state.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error.message ?? "acp request failed"));
      else p.resolve(msg.result ?? {});
      return;
    }
    // ③ 通知
    if (msg.method === "session/update") {
      this.onSessionUpdate(state, msg.params as { update?: AcpUpdate });
    }
  }

  private respond(state: DshSession, id: number, body: Record<string, unknown>): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // ---- turn 执行 ----

  private async runTurn(state: DshSession, prompt: string): Promise<void> {
    state.cancelled = false;
    await this.ensureSession(state);
    await this.applyModel(state);

    const acc: TurnAcc = { turnText: "", messageId: `msg_${Date.now()}`, usedBefore: state.lastUsed };
    state.turn = acc;
    try {
      const res = (await this.request(state, "session/prompt", {
        sessionId: state.ref,
        prompt: [{ type: "text", text: prompt }],
      })) as { stopReason?: string };
      this.finalizeTurn(state, acc, res.stopReason ?? "end_turn", state.cancelled);
    } catch (err: unknown) {
      if (state.cancelled) {
        this.finalizeTurn(state, acc, "cancelled", true);
        return;
      }
      state.sink?.({
        type: "error",
        sessionId: state.sessionId,
        message: `dsh session/prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      });
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
    } finally {
      state.turn = null;
    }
  }

  /** StartRequest.model → ACP configOption "model"，value 是 JSON 串 '["provider","model"]' */
  private async applyModel(state: DshSession): Promise<void> {
    if (state.model === null || state.modelApplied || state.ref === null) return;
    state.modelApplied = true;
    const slash = state.model.indexOf("/");
    if (slash <= 0) return; // 非 provider/model 形态，交给 dsh 默认
    try {
      await this.request(state, "session/setConfigOption", {
        sessionId: state.ref,
        configId: "model",
        value: JSON.stringify([state.model.slice(0, slash), state.model.slice(slash + 1)]),
      });
    } catch (err: unknown) {
      log.debug("dsh applyModel failed (continuing with default model)", {
        model: state.model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private finalizeTurn(state: DshSession, acc: TurnAcc, stopReason: string, cancelled: boolean): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }
    if (state.lastUsed > acc.usedBefore) {
      sink({
        type: "usage",
        sessionId,
        // usage_update 只有会话累计 token（used），无成本字段 —— 差值出账，costUsd 恒 0
        inputTokens: Math.max(0, state.lastUsed - acc.usedBefore),
        outputTokens: 0,
        costUsd: 0,
        model: state.model ?? "dsh-default",
        decodeMs: undefined,
        requestId: `dsh:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }
    if (!cancelled && stopReason !== "end_turn" && stopReason !== "cancelled") {
      sink({ type: "error", sessionId, message: `dsh turn ended with stopReason=${stopReason}`, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionId 可继续 session/prompt）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- session/update → RuntimeEvent ------------------------------------------

  private onSessionUpdate(state: DshSession, params: { update?: AcpUpdate }): void {
    const sink = state.sink;
    const update = params.update;
    if (sink === null || update === undefined) return;
    const sessionId = state.sessionId;
    const acc = state.turn;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = chunkText(update.content);
        if (text !== "" && acc !== null) {
          acc.turnText += text;
          sink({ type: "message.delta", sessionId, messageId: acc.messageId, role: "assistant", text });
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = chunkText(update.content);
        if (text !== "" && acc !== null) {
          sink({ type: "reasoning.delta", sessionId, messageId: acc.messageId, text });
        }
        break;
      }
      case "tool_call": {
        if (update.toolCallId === undefined) break;
        if (update.title !== undefined) state.toolTitles.set(update.toolCallId, update.title);
        sink({
          type: "tool.started",
          sessionId,
          callId: update.toolCallId,
          toolName: update.title ?? "tool",
          title: update.title ?? "tool",
          input: update.rawInput ?? null,
        });
        break;
      }
      case "tool_call_update": {
        if (update.toolCallId === undefined) break;
        if (update.status === "completed" || update.status === "failed") {
          const output = chunkText(update.content);
          sink({
            type: "tool.completed",
            sessionId,
            callId: update.toolCallId,
            ok: update.status === "completed",
            output: output.slice(0, 8000),
          });
          state.toolTitles.delete(update.toolCallId);
        }
        break;
      }
      case "usage_update": {
        if (typeof update.used === "number") state.lastUsed = update.used;
        break;
      }
      default:
        break; // config_option_update 等不翻译
    }
  }

  // ---- 权限审批（agent → client 反向请求） --------------------------------------

  private onPermissionRequest(state: DshSession, acpId: number, params: NonNullable<AcpRequest["params"]>): void {
    const sink = state.sink;
    if (sink === null) {
      this.respond(state, acpId, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const requestId = params.toolCall?.toolCallId ?? `perm_${acpId}`;
    state.permissionPending.set(requestId, { acpId, options: params.options ?? [] });
    // dsh 的权限请求只带 toolCallId：detail 用此前 tool_call 通知记下的工具名兜底
    const title = state.toolTitles.get(requestId);
    sink({
      type: "permission.requested",
      sessionId: state.sessionId,
      requestId,
      kind: "tool",
      detail: title !== undefined ? `dsh 请求执行工具：${title}` : "dsh 请求执行工具",
      risk: "medium",
    });
  }

  private resolvePermission(state: DshSession, requestId: string, decision: "allow" | "deny" | "always"): void {
    const pending = state.permissionPending.get(requestId);
    if (pending === undefined) {
      log.warn("resolvePermission on unknown dsh request", { requestId });
      return;
    }
    state.permissionPending.delete(requestId);
    // dsh 只有 allow_once / reject_once 两档（源码事实）：always 降级为 allow_once
    const want = decision === "deny" ? "reject_once" : "allow_once";
    const option = pending.options.find((o) => o.kind === want) ?? pending.options[0];
    this.respond(state, pending.acpId, {
      result: { outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId } },
    });
    state.sink?.({
      type: "permission.resolved",
      sessionId: state.sessionId,
      requestId,
      decision: decision === "always" ? "allow" : decision,
    });
  }
}

// ---- 小工具 -------------------------------------------------------------------

function asBlockArray(content: AcpContent | AcpContent[] | undefined): AcpContent[] {
  if (content === undefined) return [];
  return Array.isArray(content) ? content : [content];
}

function chunkText(content: AcpContent | AcpContent[] | undefined): string {
  let out = "";
  for (const b of asBlockArray(content)) {
    if (b.type === "text" || b.type === undefined) {
      out += b.text ?? "";
      continue;
    }
    // ⚠ 嵌套形态必须解开：ACP 的 tool_call_update 内容是
    // `content:[{type:"content", content:{type:"text", text:"…"}}]`，
    // 只认 type==="text" 会让**每个** tool.completed 的 output 都是空串
    // （时间线里工具输出整段消失）。mcode 是同一份协议，那边早就这么处理了。
    if (b.type === "content") out += chunkText(b.content);
  }
  return out;
}
