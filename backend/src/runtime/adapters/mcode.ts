/**
 * MiniMax Code（mcode）执行器适配器 —— ACP 形态：`mcode acp` 常驻子进程，
 * JSON-RPC（newline-delimited）over stdio，接法参考 t3code packages/effect-acp 的 client。
 *
 * 与 pi/codex 的「每轮一个进程」不同，ACP 是常驻协议进程（同 zcode app-server 形态）：
 *   spawn → initialize → session/new（attach: session/load）→ N × session/prompt → close
 *
 * 协议事实（mcode acp 0.5.5 实测 + minimax-code packages/tui/src/acp 源码走查）：
 * - initialize {protocolVersion:1, clientCapabilities:{fs,terminal}} →
 *   {protocolVersion, agentCapabilities:{loadSession:true,...}, agentInfo:{name:"minimax-code",version}}
 *   本机已登录时无需 authenticate（未登录时 session/new 会报错，如实上抛）
 * - session/new {cwd, mcpServers:[]} → {sessionId:"mvs_…", modes:{availableModes:[default,plan]}}
 * - session/prompt {sessionId, prompt:[{type:"text",text}]} → 阻塞到本轮落定 {stopReason}
 * - 通知 session/update：agent_message_chunk / agent_thought_chunk（content:{type:"text"}）、
 *   tool_call{toolCallId,name,kind,status,rawInput,content[]} / tool_call_update{status,rawOutput,content[]}、
 *   content 块含 {type:"diff",path,oldText,newText} —— 结构化 diff 的来源（fileDiff 能力）；
 *   另有 plan_update{entries} / usage_update{used,size,cost} / available_commands_update /
 *   session_info_update / current_mode_update（后四者不翻译）
 * - 权限是反向请求：agent → client `session/request_permission`
 *   {sessionId, toolCall:{toolCallId,title,name,kind,rawInput}, options:[{optionId,name,kind}]}
 *   —— 翻成 permission.requested，resolvePermission 按 option.kind 择项回
 *   {outcome:{outcome:"selected",optionId}}（requestId 复用 toolCallId，mcode 二者一一对应）
 * - 多轮：同一 sessionId 直接再 session/prompt；daemon 重启后 session/load（loadSession 能力）
 *   把外部会话接回来 —— externalRef 即 mcode 的 sessionId
 * - 取消：通知 session/cancel {sessionId}，prompt 以 stopReason:"cancelled" 收尾
 * - usage_update 的 used/cost 是会话累计值，这里按轮差值出 usage 事件（口径注释在 finalize）
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  adapterError,
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type NativeModelConfig,
  type StartRequest,
} from "./types.ts";
import { readMcodeModelDefaults, writeMcodeModelDefaults } from "./model-defaults.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { discoverGenericToolSkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type { NativeCommandInfo } from "../../contract.ts";
import { pickAcpContextLengthOption, pickAcpModelOptions, pickAcpSelectOption, queryAcpSessionNew } from "./acp-models.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { log } from "../../log.ts";

// ---- ACP 线缆类型（宽松） ----------------------------------------------------

interface AcpContent {
  type?: string;
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  /** {type:"content", content:{type:"text",…}} 的嵌套块 */
  content?: AcpContent;
}

interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpContent[];
}

/** session/update 载荷：不同 sessionUpdate 共用一个宽松形状（块内容单/复数皆有） */
interface AcpUpdate {
  sessionUpdate?: string;
  content?: AcpContent | AcpContent[];
  messageId?: string;
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  toolCall?: AcpToolCall;
  entries?: { content?: string; status?: string }[];
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string };
}

interface AcpNotification {
  method?: string;
  params?: { sessionId?: string; update?: AcpUpdate };
}

interface AcpRequest {
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    toolCall?: AcpToolCall;
    options?: { optionId?: string; name?: string; kind?: string }[];
  };
}

interface AcpResponse {
  id?: number;
  result?: { sessionId?: string; stopReason?: string; modes?: { availableModes?: { id?: string }[] } };
  error?: { code?: number; message?: string };
}

// ---- 会话台账 ----------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  readonly acpId: number;
  readonly options: readonly { optionId?: string; name?: string; kind?: string }[];
}

interface TurnAcc {
  sawAny: boolean;
  turnText: string;
  readonly messageId: string;
  /** plan_update 首见 → plan.proposed，此后只发 plan.step.updated */
  planId: string | null;
  planStatuses: string[];
  /** 本轮起点前的累计用量（usage 差值口径用） */
  readonly usedBefore: number;
  readonly costBefore: number;
}

interface McodeSession {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  /** 用户选的模型（工作台 ModelId = 模型基础名，ACP 侧真实值查 _modelValues） */
  model: ModelId | null;
  /** 上下文长度档（执行器侧原始 value）；send loop 可逐轮覆盖 */
  contextLength: string | null;
  /** 上一次成功下发的上下文档（同值不重发） */
  appliedContextLength: string | null;
  /** mcode 的 ACP sessionId（"mvs_…"），session/new 后才有 */
  ref: string | null;
  sink: AdapterSink | null;
  child: ChildProcess | null;
  initialized: boolean;
  closed: boolean;
  cancelled: boolean;
  /** 跨轮累计用量（usage_update 是会话累计值，出轮差值） */
  lastUsed: number;
  lastCost: number;
  /** usage 幂等键计数（WP-10） */
  usageCount: number;
  nextId: number;
  /** 本进程对本 ACP 会话已 session/load（session/new 亦视为已加载） */
  sessionLoaded: boolean;
  /** 模式/权限档只在本进程首轮流前设置一次（进程级偏好，不是轮级参数） */
  modeApplied: boolean;
  readonly pending: Map<number, PendingRequest>;
  readonly permissionPending: Map<string, PendingPermission>;
  /** 本轮 translation 台账（session/prompt 在途时非空） */
  turn: TurnAcc | null;
}

/**
 * mcode 设置配置项的方法名 —— **snake_case**。
 *
 * 踩过的坑：本机 mcode 0.6.8 对 `session/setConfigOption`（camelCase）回
 * `-32601 Method not found`，真正的名字是 `session/set_config_option`。
 * 8 个候选方法实测下来只有它被接受（session/setConfigOption / set_config /
 * setConfig / session/set_model / session/setModel / mcode/session/config/set … 全是 -32601）。
 *
 * 之前写成 camelCase 的后果是**静默失效**：调用被 try/catch 吞掉只留 debug 日志，
 * 权限档与模型选择看起来「设了」，实际执行器一直用它自己的默认值。
 */
const ACP_SET_CONFIG_OPTION = "session/set_config_option";

/** 下发模型/权限档这类配置项的等待上限。它们发在 turn 前面，卡住就是整轮卡住 */
const MODEL_SET_TIMEOUT_MS = 15000;

/** `m:minimax:MiniMax-M3:v:thinking` → { base: "MiniMax-M3", variant: "thinking" }；认不出来返回 null */
function parseMcodeModelValue(value: string): { base: string; variant: string } | null {
  const parts = value.split(":");
  if (parts.length >= 5 && parts[0] === "m" && parts[3] === "v") {
    const base = parts[2];
    if (base !== undefined && base !== "") return { base, variant: parts[4] ?? "" };
  }
  // 不认识的形态：整体当 id，宁可原样透传也不瞎猜（瞎猜出来的 id 会让 setConfigOption 静默失败）
  return value === "" ? null : { base: value, variant: "" };
}

/**
 * 组装一条模型记录。
 *
 * live 探测只给得出 id 和名称（ACP 的 configOption 不带窗口/档位），所以
 * **能力字段从上一份清单按基础名继承** —— 首次同步时继承的是内置兜底清单里的值，
 * 于是「实时 id + 已知窗口」两件事同时成立，而不是刷新一次把上下文窗口洗成未知。
 */
function toMcodeModelInfo(
  base: string,
  name: string,
  parsed: { base: string; variant: string },
  prior: Map<string, ExecutorModelInfo>,
): ExecutorModelInfo {
  const old = prior.get(parsed.base);
  const hasThinking = parsed.variant === "thinking";
  const levels = old?.reasoningLevels ?? (hasThinking ? ["medium"] : undefined);
  return {
    id: base as ModelId,
    displayName: name,
    contextWindow: old?.contextWindow,
    maxOutput: old?.maxOutput,
    reasoningLevels: levels === undefined ? undefined : [...levels],
    defaultReasoningLevel: hasThinking ? (old?.defaultReasoningLevel ?? "medium") : old?.defaultReasoningLevel,
    // 上下文档位沿用上一份清单：本轮探测没声明时不清空（与 reasoningLevels 同一继承口径）
    contextLengths: old?.contextLengths,
    defaultContextLength: old?.defaultContextLength,
    multimodal: old?.multimodal,
    inputPerMTok: old?.inputPerMTok,
    outputPerMTok: old?.outputPerMTok,
  };
}

export class McodeAdapter implements ExecutorAdapter {
  readonly id = "mcode";
  readonly displayName = "MiniMax Code";
  readonly glyph = "M";
  private _models: ExecutorModelInfo[] = [
    // 真实 MiniMax Code 官方模型生态（对齐 ~/.minimax/config.yaml）
    {
      id: "MiniMax-M3.1-Flash-Preview" as ModelId,
      displayName: "M3.1 Flash Preview（默认）",
      contextWindow: 512000,
      maxOutput: 128000,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      multimodal: true,
    },
    {
      id: "MiniMax-M3" as ModelId,
      displayName: "MiniMax M3",
      contextWindow: 512000,
      maxOutput: 128000,
      reasoningLevels: ["low", "medium", "high", "max"],
      multimodal: true,
    },
    {
      id: "MiniMax-M2.7-highspeed" as ModelId,
      displayName: "MiniMax M2.7 Highspeed",
      contextWindow: 200000,
      maxOutput: 128000,
      reasoningLevels: ["low", "medium", "high"],
      multimodal: false,
    },
    {
      id: "MiniMax-M2.7" as ModelId,
      displayName: "MiniMax M2.7",
      contextWindow: 200000,
      maxOutput: 128000,
      multimodal: false,
    },
  ];

  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  /**
   * 工作台 ModelId（基础名，如 `MiniMax-M3`）→ ACP 侧真实 configOption 值
   * （如 `m:minimax:MiniMax-M3:v:thinking`）。syncModels 时建表，start 时查表。
   */
  private readonly _modelValues = new Map<string, string>();

  /**
   * 上下文长度这类 select 型 configOption 的写回 id（syncModels 时发现）。
   *
   * 只在 CLI 自己声明过该 configOption 时才非空 —— 我们从不猜 configId：
   * 对不存在的 id 调 set_config_option 会被静默吞掉，界面上「设了」实际没设，
   * 正是 mcode.ts 头注释里踩过的那个坑。没发现 = 界面不出上下文档滑动条。
   */
  private _contextConfigId: string | null = null;

  /**
   * 动态对齐模型清单：`mcode acp` 的 session/new 把当前账号可选模型放在
   * `configOptions[category=model]` 里，随建会话一起回，**不发 prompt → 零用量**。
   *
   * ## 为什么 id 用基础名而不是 ACP 的原始值
   *
   * ACP 的 value 是 `m:minimax:MiniMax-M3:v:thinking`，同一个模型带两个变体
   * （`v:` 与 `v:thinking`）。直接把 value 当 id 会让界面出现「同一个模型两行」，
   * 且和落盘在 bot.json 里的历史 modelHint 全对不上。所以对外统一暴露基础名，
   * 变体折叠进 `reasoningLevels`，原始 value 存 _modelValues 供 start 时回填。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("mcode");
      const result = await queryAcpSessionNew(cmd.file, cmd.prefixArgs, ["acp"], { timeoutMs: 30000 });
      const { current, options } = pickAcpModelOptions(result);
      if (options.length === 0) {
        return { models: this._models, source: "static", reason: "session/new 未返回模型选单", elapsedMs: Date.now() - t0 };
      }

      // 推理档位来自另一个 configOption（thinkingEffort），比模型选单更权威
      const efforts = pickAcpSelectOption(result, "thinkingEffort").options.map((o) => o.value);
      // 上下文长度档（如 M3.1 Flash 的 512K / 1M）：同样只在 CLI 自己声明过才收录
      const ctxOpt = pickAcpContextLengthOption(result);
      this._contextConfigId = ctxOpt.options.length > 0 && ctxOpt.configId ? ctxOpt.configId : null;
      const prior = new Map(this._models.map((m) => [m.id, m]));
      const values = new Map<string, string>();
      const out: ExecutorModelInfo[] = [];
      for (const opt of options) {
        const parsed = parseMcodeModelValue(opt.value);
        if (parsed === null) continue;
        const existing = values.get(parsed.base);
        if (existing !== undefined && existing !== opt.value) {
          // 同一基础名的另一个变体：当前会话正用的那个优先，否则保留先到的
          if (current !== existing) continue;
          const idx = out.findIndex((m) => m.id === parsed.base);
          if (idx >= 0) {
            out[idx] = toMcodeModelInfo(parsed.base, opt.name, parsed, prior);
            values.set(parsed.base, opt.value);
          }
          continue;
        }
        values.set(parsed.base, opt.value);
        const info = toMcodeModelInfo(parsed.base, opt.name, parsed, prior);
        // 推理档位来自另一个 configOption（thinkingEffort），比静态清单里的猜测权威
        const withEfforts = efforts.length > 0
          ? {
              ...info,
              reasoningLevels: [...efforts],
              defaultReasoningLevel: info.defaultReasoningLevel ?? efforts[0],
            }
          : info;
        out.push(
          ctxOpt.options.length > 0
            ? {
                ...withEfforts,
                contextLengths: ctxOpt.options.map((o) => ({ value: o.value, label: o.name })),
                defaultContextLength: ctxOpt.current,
              }
            : withEfforts,
        );
      }
      if (out.length > 0) {
        this._models = out;
        this._modelValues.clear();
        for (const [k, v] of values) this._modelValues.set(k, v);
        log.info("mcode models synced via ACP session/new", { count: out.length });
        return { models: out, source: "live", elapsedMs: Date.now() - t0 };
      }
      return { models: this._models, source: "static", reason: "模型选单格式无法解析", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("mcode 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }

  /** 原生模型默认值 —— config.yaml 顶层 defaultModel / defaultLightModel（cc-switch 同款：只动这两个键） */
  readModelDefaults(): NativeModelConfig {
    return readMcodeModelDefaults();
  }

  writeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
    return writeMcodeModelDefaults(values);
  }

  /** 把工作台 ModelId 还原成 ACP 的 configOption value（没同步过就返回 null） */
  private acpModelValue(model: ModelId | null): string | null {
    if (model === null) return null;
    return this._modelValues.get(model) ?? null;
  }
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: true, // tool_call content 带 {type:"diff",path,oldText,newText}
    terminal: false,
    permissions: true, // ACP request_permission 反向流，真审批
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: true, // session/new 可挂 mcpServers（daemon 暂不透传）
    usage: true,
    multimodal: false, // promptCapabilities.image=false（实测）
    streaming: "realtime",
    steering: "turn-end", // ACP 有 mid-turn 的物理通道，未接前如实报 turn-end
  };

  private readonly sessions = new Map<string, McodeSession>();


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * MCode 原生命令、技能与子智能体面：
   * 内置目录（见 builtin-catalogs.ts）+ 原生技能（.mcode/skills 与 .agents/skills）+
   * 子智能体（.mcode/agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 MCode。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < McodeAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverGenericToolSkillsAndAgents(this.id, rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("mcode");
      const out = await execLines(cmd, ["--version"], 15000);
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
            ? { status: "not_installed", hint: "未安装 mcode CLI（MiniMax Code）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: McodeSession = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      mode: req.mode ?? "build",
      model: req.model,
      contextLength: req.contextLength ?? null,
      appliedContextLength: null,
      ref: null,
      sink,
      child: null,
      initialized: false,
      closed: false,
      cancelled: false,
      lastUsed: 0,
      lastCost: 0,
      usageCount: 0,
      nextId: 1,
      pending: new Map(),
      permissionPending: new Map(),
      sessionLoaded: false,
      modeApplied: false,
      turn: null,
    };
    this.sessions.set(state.sessionId, state);

    return {
      id: state.sessionId,
      send: async (text: string, loop) => {
        if (loop?.contextLength !== undefined) state.contextLength = loop.contextLength;
        if (loop?.mode !== undefined && loop.mode !== state.mode) {
          state.mode = loop.mode;
          state.modeApplied = false;
        }
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
    const state: McodeSession = {
      sessionId,
      rootPath,
      mode: "build",
      model: null, // 续接的会话沿用它自己当时的模型，不重设
      contextLength: null, // 同上：沿用会话自己的档位
      appliedContextLength: null,
      ref, // session/load 时用；load 失败才回落 session/new
      sink,
      child: null,
      initialized: false,
      closed: false,
      cancelled: false,
      lastUsed: 0,
      lastCost: 0,
      usageCount: 0,
      nextId: 1,
      pending: new Map(),
      permissionPending: new Map(),
      sessionLoaded: false,
      modeApplied: false,
      turn: null,
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string, loop) => {
        if (loop?.contextLength !== undefined) state.contextLength = loop.contextLength;
        if (loop?.mode !== undefined && loop.mode !== state.mode) {
          state.mode = loop.mode;
          state.modeApplied = false;
        }
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

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.closed = true;
      // 先拒绝在途请求（与 zcode 同款语义），再杀进程、拆 stdio：
      // mcode 会派生 tools-host 之类孙进程，单 kill 后管道仍可能被握住，
      // 显式销毁我们这一侧的流才能让 daemon 的事件循环排空、干净退出
      for (const p of st.pending.values()) p.reject(adapterError("adapter_disposed", "adapter is shutting down"));
      st.pending.clear();
      const child = st.child;
      if (child !== null && child.exitCode === null) child.kill();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      st.child = null;
    }
    this.sessions.clear();
  }

  // ---- 进程与协议通道 ---------------------------------------------------------

  /** 确保子进程已起、已完成 initialize；首推 session/new，续命 session/load */
  private async ensureSession(state: McodeSession): Promise<void> {
    if (state.child === null) {
      const cmd = await resolveCommand("mcode");
      // closeStdin 语义见 exec.ts：常驻协议进程的 stdin 就是协议通道，绝不能关
      const child = spawn(cmd.file, [...cmd.prefixArgs, "acp"], {
        cwd: state.rootPath,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
        log.debug("mcode acp stderr", { line: line.slice(0, 200) }),
      );
      child.once("close", () => {
        state.child = null;
        state.initialized = false;
        const err = adapterError("executor_exited", "mcode acp process exited");
        for (const p of state.pending.values()) p.reject(err);
        state.pending.clear();
      });
    }
    if (!state.initialized) {
      await this.request(state, "initialize", {
        protocolVersion: 1,
        // fs/terminal 能力都不给：agent 保持自食其力，daemon 不当代答
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, 30000);
      state.initialized = true;
    }
    if (state.ref === null) {
      const res = (await this.request(state, "session/new", { cwd: state.rootPath, mcpServers: [] }, 60000)) as {
        sessionId?: string;
      };
      if (typeof res.sessionId !== "string" || res.sessionId === "") {
        throw adapterError("acp_no_session", "mcode acp session/new returned no sessionId");
      }
      state.ref = res.sessionId;
      state.sessionLoaded = true; // 本进程刚建的会话，无需 load
    } else if (!state.sessionLoaded) {
      await this.loadSession(state);
    }
  }

  private async loadSession(state: McodeSession): Promise<void> {
    try {
      await this.request(state, "session/load", { sessionId: state.ref, cwd: state.rootPath, mcpServers: [] }, 60000);
      state.sessionLoaded = true;
    } catch (err: unknown) {
      // ref 失效（mcode 侧被删/换机）：回落新会话，宁可丢历史也不能永久不可用
      log.warn("mcode session/load failed, falling back to a fresh session", {
        ref: state.ref,
        error: err instanceof Error ? err.message : String(err),
      });
      state.ref = null;
      state.sessionLoaded = false;
      await this.ensureSession(state);
    }
  }

  private request(state: McodeSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (state.child === null) return Promise.reject(adapterError("executor_exited", "mcode acp not running"));
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

  private notify(state: McodeSession, method: string, params: unknown): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleWireLine(state: McodeSession, line: string): void {
    let msg: (AcpNotification & AcpRequest & AcpResponse) | null = null;
    try {
      msg = JSON.parse(line) as AcpNotification & AcpRequest & AcpResponse;
    } catch {
      return; // 非 JSON 横幅忽略
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
    // ③ 通知：session/update 翻译，其余忽略
    if (msg.method === "session/update" && msg.params?.update !== undefined) {
      this.onSessionUpdate(state, msg.params.update);
    }
  }

  private respond(state: McodeSession, id: number, body: Record<string, unknown>): void {
    state.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // ---- turn 执行 ----

  private async runTurn(state: McodeSession, prompt: string): Promise<void> {    state.cancelled = false;
    await this.ensureSession(state);
    await this.applyMode(state);
    await this.applyContextLength(state);

    const acc: TurnAcc = {
      sawAny: false,
      turnText: "",
      messageId: `msg_${Date.now()}`,
      planId: null,
      planStatuses: [],
      usedBefore: state.lastUsed,
      costBefore: state.lastCost,
    };
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
      const sink = state.sink;
      if (sink !== null) {
        sink({
          type: "error",
          sessionId: state.sessionId,
          message: `mcode session/prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        });
        sink({ type: "session.status", sessionId: state.sessionId, status: "failed" });
      }
    } finally {
      state.turn = null;
    }
  }

  /** daemon 四档 → ACP 模式/权限档；失败只降级不挡轮（模式是偏好不是前提） */
  private async applyMode(state: McodeSession): Promise<void> {
    if (state.modeApplied || state.ref === null) return;
    state.modeApplied = true;

    // 选中的模型必须真的下发，否则界面上「选了 A 实际跑 B」——比没有下拉更糟。
    // 失败不挡轮（老版本可能没有该 configId），但要留痕。
    //
    // ⚠ 必须给超时：request 的 timeoutMs 是可选的，不传就是无限等。模型下发是
    // 发在 turn 前面的，一旦 CLI 不回（老版本无此 configId 而选择不回错误、
    // 或进程半死不活），整轮对话就永久卡在「发送中」——用户只能杀 daemon。
    const modelValue = this.acpModelValue(state.model);
    if (modelValue !== null) {
      try {
        await this.request(
          state,
          ACP_SET_CONFIG_OPTION,
          { sessionId: state.ref, configId: "model", value: modelValue },
          MODEL_SET_TIMEOUT_MS,
        );
      } catch (err: unknown) {
        log.debug("mcode applyModel failed (continuing with agent default)", {
          model: state.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (state.model !== null) {
      log.debug("mcode 选中模型无对应 ACP 值（未同步过模型清单？），沿用 agent 默认", { model: state.model });
    }

    try {
      if (state.mode === "plan") {
        await this.request(state, "session/setMode", { sessionId: state.ref, modeId: "plan" }, MODEL_SET_TIMEOUT_MS);
      } else {
        // 权限档（实测可选值 default | auto | bypassPermissions）：
        // build=default（按策略问）、edit=auto（自动放行编辑）、yolo=bypassPermissions
        const permissionMode = state.mode === "yolo" ? "bypassPermissions" : state.mode === "edit" ? "auto" : "default";
        await this.request(
          state,
          ACP_SET_CONFIG_OPTION,
          { sessionId: state.ref, configId: "permissionMode", value: permissionMode },
          MODEL_SET_TIMEOUT_MS,
        );
      }
    } catch (err: unknown) {
      // 方法名写错 / 老版本没有该方法时降级走会话默认档。
      // ⚠ 这次失败是**静默**的：权限档设不上意味着实际跑的是执行器默认档，
      // 界面上却显示用户选的那档。所以这里必须留痕，不能只压 debug 了事。
      log.warn("mcode 权限档/模式下发失败，本轮沿用执行器默认档", {
        mode: state.mode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 下发上下文长度档（如 M3.1 Flash 的 512K / 1M）。
   *
   * 只在 CLI 自己声明过该 configOption（syncModels 发现了 configId）且用户
   * 显式选了档时才发 —— 从不猜 id，猜错会被 set_config_option 静默吞掉。
   * 同值不重发（config 是会话级的，重发只是浪费一次往返）；失败降级不挡轮，
   * 但要留痕（与权限档同一理由：静默失效会让界面显示的档与实际跑的不一致）。
   */
  private async applyContextLength(state: McodeSession): Promise<void> {
    if (state.contextLength === null || state.ref === null) return;
    if (this._contextConfigId === null) {
      // 未发现过该 configOption：不硬发。留 debug 足够 —— 界面根本不会出滑动条
      log.debug("mcode 未发现上下文长度 configOption，跳过下发", { contextLength: state.contextLength });
      return;
    }
    if (state.appliedContextLength === state.contextLength) return;
    try {
      await this.request(
        state,
        ACP_SET_CONFIG_OPTION,
        { sessionId: state.ref, configId: this._contextConfigId, value: state.contextLength },
        MODEL_SET_TIMEOUT_MS,
      );
      state.appliedContextLength = state.contextLength;
    } catch (err: unknown) {
      log.warn("mcode 上下文长度档下发失败，本轮沿用会话当前档", {
        configId: this._contextConfigId,
        contextLength: state.contextLength,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private finalizeTurn(state: McodeSession, acc: TurnAcc, stopReason: string, cancelled: boolean): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (acc.turnText !== "") {
      sink({ type: "message.completed", sessionId, messageId: acc.messageId, text: acc.turnText });
    }

    // usage_update 的 used/cost 是会话累计值：按轮差值出账（首轮差值 = 全量，口径一致）
    if (state.lastUsed > acc.usedBefore || state.lastCost > acc.costBefore) {
      sink({
        type: "usage",
        sessionId,
        inputTokens: Math.max(0, state.lastUsed - acc.usedBefore),
        outputTokens: 0, // mcode 只报会话累计，不拆输入/输出
        costUsd: Math.max(0, state.lastCost - acc.costBefore),
        model: "mcode-default",
        decodeMs: undefined,
        requestId: `mcode:${state.ref ?? state.sessionId}:p${process.pid}:${++state.usageCount}`,
      });
    }

    if (!cancelled && stopReason !== "end_turn" && stopReason !== "cancelled") {
      sink({ type: "error", sessionId, message: `mcode turn ended with stopReason=${stopReason}`, recoverable: false });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }
    // agent loop 语义：turn 落定 ≠ 会话结束（同一 sessionId 可继续 session/prompt）
    sink({ type: "session.status", sessionId, status: "idle" });
  }

  // ---- session/update → RuntimeEvent ------------------------------------------

  private onSessionUpdate(state: McodeSession, update: AcpUpdate): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;
    const acc = state.turn;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = chunkText(update.content);
        if (text !== "" && acc !== null) {
          acc.sawAny = true;
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
        const call = update;
        if (call.toolCallId === undefined) break;
        sink({
          type: "tool.started",
          sessionId,
          callId: call.toolCallId,
          toolName: call.name ?? call.title ?? "tool",
          title: call.title ?? call.name ?? "tool",
          input: call.rawInput ?? null,
        });
        // 一次性完成的 tool_call（start 即终态）：补发 completed
        if (call.status === "completed" || call.status === "failed") {
          this.emitToolCompleted(state, call.toolCallId, call.status === "completed", call.rawOutput, call.content);
        }
        break;
      }
      case "tool_call_update": {
        if (update.toolCallId === undefined) break;
        if (update.status === "completed" || update.status === "failed") {
          this.emitToolCompleted(state, update.toolCallId, update.status === "completed", update.rawOutput, update.content);
        }
        break;
      }
      case "plan_update": {
        if (acc === null) break;
        const entries = update.entries ?? [];
        const statuses = entries.map((e) => e.status ?? "pending");
        if (acc.planId === null) {
          acc.planId = `plan_${Date.now()}`;
          acc.planStatuses = statuses;
          sink({
            type: "plan.proposed",
            sessionId,
            planId: acc.planId,
            title: "执行计划",
            steps: entries.map((e, i) => ({ id: `step_${i}`, title: e.content ?? `step ${i + 1}`, status: mapPlanStatus(statuses[i]) })),
          });
        } else {
          for (let i = 0; i < entries.length && i < acc.planStatuses.length; i++) {
            if (statuses[i] !== acc.planStatuses[i]) {
              sink({ type: "plan.step.updated", sessionId, planId: acc.planId, stepId: `step_${i}`, status: mapPlanStatus(statuses[i]) });
            }
          }
          acc.planStatuses = statuses;
        }
        break;
      }
      case "usage_update": {
        if (typeof update.used === "number") state.lastUsed = update.used;
        if (typeof update.cost?.amount === "number") state.lastCost = update.cost.amount;
        break;
      }
      default:
        break; // available_commands_update / session_info_update / current_mode_update 等不翻译
    }
  }

  private emitToolCompleted(
    state: McodeSession,
    callId: string,
    ok: boolean,
    rawOutput: unknown,
    content: AcpContent | AcpContent[] | undefined,
  ): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    let output = "";
    for (const block of asBlockArray(content)) {
      if (block.type === "diff" && block.path !== undefined) {
        // 结构化 diff：算 +/- 行数发 file.diff + file.changed（项目视图的核心输入）
        const { additions, deletions } = diffLineCounts(block.oldText, block.newText);
        sink({ type: "file.diff", sessionId, path: block.path, additions, deletions });
        sink({ type: "file.changed", sessionId, path: block.path, change: "modified" });
      } else if (block.type === "content" && block.content?.type === "text") {
        output += block.content.text ?? "";
      }
    }
    if (output === "" && rawOutput !== undefined && rawOutput !== null) {
      output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    }
    sink({ type: "tool.completed", sessionId, callId, ok, output: output.slice(0, 8000) });
  }

  // ---- 权限审批（agent → client 反向请求） --------------------------------------

  private onPermissionRequest(state: McodeSession, acpId: number, params: NonNullable<AcpRequest["params"]>): void {
    const sink = state.sink;
    if (sink === null) {
      this.respond(state, acpId, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const call = params.toolCall ?? {};
    const requestId = call.toolCallId ?? `perm_${acpId}`;
    state.permissionPending.set(requestId, { acpId, options: params.options ?? [] });
    sink({
      type: "permission.requested",
      sessionId: state.sessionId,
      requestId,
      kind: permissionKind(call.kind),
      detail: [call.title ?? call.name ?? "tool", summarizeInput(call.rawInput)].filter((s) => s !== "").join(" "),
      risk: call.kind === "delete" ? "high" : call.kind === "execute" ? "medium" : "low",
    });
  }

  private resolvePermission(state: McodeSession, requestId: string, decision: "allow" | "deny" | "always"): void {
    const pending = state.permissionPending.get(requestId);
    if (pending === undefined) {
      log.warn("resolvePermission on unknown mcode request", { requestId });
      return;
    }
    state.permissionPending.delete(requestId);
    // 按 option.kind 择项（不依赖 mcode 的 optionId 字面量）：allow→allow_once、
    // always→allow_always、deny→reject_once；找不到就选第一项兜底
    const want = decision === "deny" ? "reject_once" : decision === "always" ? "allow_always" : "allow_once";
    const option = pending.options.find((o) => o.kind === want) ?? pending.options[0];
    this.respond(state, pending.acpId, {
      result: { outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId } },
    });
    state.sink?.({
      type: "permission.resolved",
      sessionId: state.sessionId,
      requestId,
      decision,
    });
  }
}

// ---- 小工具 -------------------------------------------------------------------

/** 块内容单/复数归一（agent_message_chunk 单块、tool_call 块数组） */
function asBlockArray(content: AcpContent | AcpContent[] | undefined): AcpContent[] {
  if (content === undefined) return [];
  return Array.isArray(content) ? content : [content];
}

/** 提取文本块正文（chunk 事件用） */
function chunkText(content: AcpContent | AcpContent[] | undefined): string {
  return asBlockArray(content)
    .filter((b) => b.type === "text" || b.type === undefined)
    .map((b) => b.text ?? "")
    .join("");
}

function permissionKind(kind: string | undefined): "file_write" | "shell" | "network" | "tool" {
  switch (kind) {
    case "execute":
      return "shell";
    case "edit":
    case "delete":
      return "file_write";
    case "fetch":
      return "network";
    default:
      return "tool";
  }
}

function mapPlanStatus(status: string | undefined): "pending" | "in_progress" | "done" {
  if (status === "in_progress") return "in_progress";
  if (status === "completed" || status === "done") return "done";
  return "pending";
}

/** 多重集合行比较的 +/- 行数（够 file.diff 的计量用，不追求 LCS 精度） */
function diffLineCounts(oldText: string | undefined, newText: string | undefined): { additions: number; deletions: number } {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = (newText ?? "").split("\n");
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else additions++;
  }
  let deletions = 0;
  for (const n of counts.values()) deletions += n;
  return { additions, deletions };
}

function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
