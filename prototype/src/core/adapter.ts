/**
 * RuntimeAdapter SPI —— 整个项目的战略接缝。
 *
 * 形态参照 t3code 的 packages/client-runtime/src/connection/registry.ts
 * （ConnectionRegistration + ConnectionDriver），但刻意做了三处削减：
 *
 *  1. 去掉 Effect / Schema —— t3 的 Effect 依赖极深，前端引入纯负担。
 *     这里用纯 TS 判别联合，零学习成本。
 *  2. transport（怎么连）下沉到工厂，UI 只面向能力（能干什么）。
 *  3. 强制能力声明 —— UI 靠 capabilities 做渐进增强，
 *     某个工具不支持 diff 时不渲染 diff 面板，而不是渲染一个空壳。
 *
 * 验收标准（决定了"拒绝巨量 fork 税"能否落地）：
 *  新增一家工具 = 一个 adapter 目录 + 两个文件（adapter.ts + mapper.ts），
 *  core/ 与 ui/ 一行不改。
 */

import type { RuntimeEvent } from "./events.ts";
import type { ModelId } from "./models.ts";
import type { RuntimeId, Session, SessionId, WorkUnit } from "./units.ts";

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

/**
 * 六家工具的真实接入方式（都已在对话中确认过可行）：
 * - acp      : Agent Client Protocol，dsh 原生支持，JSON-RPC over stdio
 * - jsonrpc  : Claude Code / Codex 风格
 * - rpc      : pi 的 framed CBOR，传输中立
 * - http     : ZCode 的 agent-server
 * - process  : 直接 spawn CLI + 解析 stdout
 * - internal : 本工作台自己实现的编排器（T3 Orchestrator driver 路线）
 */
export type TransportKind = "acp" | "jsonrpc" | "rpc" | "http" | "process" | "internal";

export interface TransportDescriptor {
  readonly kind: TransportKind;
  /** 可执行文件绝对路径或 URL，由设置层解析注入 */
  readonly endpoint: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** 是否需要用户目录作为 cwd */
  readonly requiresCwd: boolean;
}

// ---------------------------------------------------------------------------
// 能力声明 —— UI 渐进增强的唯一依据
// ---------------------------------------------------------------------------

export interface RuntimeCapabilities {
  /** 能否恢复历史会话 */
  readonly resumeSession: boolean;
  /** 是否能给出结构化 diff（项目视图必需） */
  readonly fileDiff: boolean;
  /** 是否有内建终端 */
  readonly terminal: boolean;
  /** 是否支持权限审批流 */
  readonly permissions: boolean;
  /** 是否支持 spawn 子代理（任务内组合多 agent） */
  readonly subagents: boolean;
  /** 是否支持 worktree 隔离（并行 fan-out 必需） */
  readonly worktrees: boolean;
  /** 是否有沙箱执行（bot模式三件套之一，dsh / ZCode 有，Claude Code 无） */
  readonly sandbox: boolean;
  /** 是否支持 MCP */
  readonly mcp: boolean;
  /** 是否暴露 token/成本计量 */
  readonly usage: boolean;
  /** 是否支持语音/多模态输入 */
  readonly multimodal: boolean;
  /**
   * 流式真实性（docs/08 WP-4）：realtime = 轮内事件持续到达（工具与文本块随生产即推，
   * delta 粒度由协议与网关决定）；batch = 轮末一次性灌入（UI 不渲染假光标）。
   * 声明跟实现走，不跟协议走——批量翻译的实现即使协议带 delta 也是 batch。
   */
  readonly streaming: "realtime" | "batch";
  /**
   * steering 能到的边界（docs/08 WP-4）：mid-turn = turn 进行中可注入；
   * turn-end = 只能排队到本轮落定后随下一轮发出；none = 完全不支持。
   * 常驻协议进程（zcode app-server）具备 mid-turn 的物理条件，未实现前仍如实报 turn-end。
   */
  readonly steering: "mid-turn" | "turn-end" | "none";
}

/** 全能力，用于对照。适配器应显式声明自己缺什么，而不是全给 true。 */
export const FULL_CAPABILITIES: RuntimeCapabilities = {
  resumeSession: true,
  fileDiff: true,
  terminal: true,
  permissions: true,
  subagents: true,
  worktrees: true,
  sandbox: true,
  mcp: true,
  usage: true,
  multimodal: true,
  streaming: "realtime",
  steering: "mid-turn",
};

// ---------------------------------------------------------------------------
// 展示元数据 —— 让每家工具在 UI 上"平等一等"
// ---------------------------------------------------------------------------

export interface RuntimePresentation {
  readonly displayName: string;
  readonly vendor: string;
  /** 品牌色，用于徽标与顶栏高亮 */
  readonly accent: string;
  /** 单字符图标（原型期先用文字，Electron 期换 SVG） */
  readonly glyph: string;
  /** 一句话定位 */
  readonly tagline: string;
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

export type ConnectionState =
  | { readonly status: "not_installed"; readonly hint: string }
  | { readonly status: "unprobed" }
  | { readonly status: "stopped" }
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly version?: string; readonly pid?: number }
  | { readonly status: "error"; readonly message: string };

export interface ProbeResult {
  readonly state: ConnectionState;
  readonly capabilities?: Partial<RuntimeCapabilities>;
  /** 探测耗时，用于设置页显示"启动慢"警告 */
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// 请求类型
// ---------------------------------------------------------------------------

/**
 * agent loop 参数 —— 一次会话/一轮的执行面旋钮。
 *
 * 透传语义（daemon 落到各家 CLI 的能力不同，不支持的项会被忽略并记日志，
 * 不报错）：mode 全执行器生效；reasoningLevel 在 zcode（model options）与
 * codex（model_reasoning_effort）上生效；temperature / topP 目前仅 codex
 * 支持（zcode 协议无采样位）；maxTurns 由 daemon 强制（超预算拒发新轮）。
 */
export interface LoopParams {
  /** 权限模式：plan / build(默认询问) / edit / yolo(全放行) */
  readonly mode: "plan" | "build" | "edit" | "yolo";
  /** 推理力度（zcode: max/high/…；codex: minimal~high，max 映射为 high） */
  readonly reasoningLevel?: string;
  /**
   * 上下文长度档（执行器侧原始 value，原样透传）：仅「CLI 自己声明了可选窗口档」
   * 的执行器有效（mcode 的 512K/1M 一类）；不支持的执行器忽略并记日志。
   */
  readonly contextLength?: string;
}

export interface MemoryInjectionOptions {
  readonly scopes?: readonly ("semantic" | "daily" | "procedural")[];
  readonly dailyDate?: string;
  readonly dailyLimit?: number;
}

export interface StartSessionRequest {
  readonly unit: WorkUnit;
  /** bot模式：读 AGENTS.md 当岗位说明书。项目模式：当作普通开发上下文 */
  readonly prompt: string;
  /**
   * 这次用哪个模型。
   *
   * 必填而非可选：模型是这个产品里**和执行器同等重要**的一个决策
   * （用户要能「一并设置」）。留成 optional 等于「有时有模型有时没有」，
   * 结果就是每个适配器各自决定默认值 —— 六家六个口径。
   * 不想让用户选，就该在注册时把 `models` 声明成只有一个。
   */
  readonly model: ModelId;
  /**
   * 会话谱系（ADR 0012）：切换执行器开新段时传旧段所属谱系 id（旧段的
   * conversationId ?? 旧段自身 id）。缺省 = 新谱系。时间线按谱系连续渲染。
   */
  readonly conversationId?: string;
  /**
   * 只读转录交接（ADR 0012，opt-in）：携带上文切换 —— daemon 把 fromSessionId
   * 那段的最近消息构造成 HANDOFF 前缀拼进新段首条消息（会进入新执行器的
   * 原生历史）。缺省 = 不携带。
   */
  readonly handoff?: { readonly fromSessionId: SessionId };
  /**
   * 对话分叉（ADR 0013）：在 ofSessionId 的 anchorMessageId 那轮边界开新段。
   * 锚点兼容两种形态：助手消息 id（message.completed，UI 主入口「从回复处分叉」）
   * 或用户消息 id（user-N，编辑重发 revision 用）。branch = 含锚点轮整轮
   * （through）；revision = 锚点轮之前（before）。fork_at_seq 由 daemon 从账本
   * 解析（前端不持有可靠 seq）；fork 启动时 HANDOFF 自动带 seq 上界
   * （只携带分叉点之前的前缀）。
   */
  readonly fork?: {
    readonly ofSessionId: SessionId;
    readonly anchorMessageId: string;
    readonly kind: "branch" | "revision";
  };
  /** 项目模式：指定 worktree 以实现并行隔离 */
  readonly worktree?: { readonly path: string; readonly branch: string };
  /** agent loop 参数（省略 = 各执行器默认；mode 缺省视为 build） */
  readonly loop?: LoopParams;
  /** 记忆注入配置（可选指定 semantic / daily / procedural 作用域） */
  readonly memoryOptions?: MemoryInjectionOptions;
  /** 关联的附件列表 */
  readonly attachments?: readonly import("./attachments.ts").ChatAttachment[];
  /** 本次启动覆盖的上下文清单（单次选择或首轮关闭） */
  readonly contextManifestOverride?: import("./units.ts").ContextManifest;
}

export interface SendMessageRequest {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly attachments?: readonly import("./attachments.ts").ChatAttachment[];
  /** 下一轮的 loop 参数覆盖（mode 可用于切换计划/实施，reasoning/context 可逐轮调） */
  readonly loop?: Partial<LoopParams>;
  /** 本轮续聊附带注入的上下文清单（用户主动勾选时生效） */
  readonly contextInject?: { readonly manifest?: import("./units.ts").ContextManifest };
}


export type PermissionDecision = "allow" | "deny" | "always";

// ---------------------------------------------------------------------------
// 适配器接口
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly presentation: RuntimePresentation;
  readonly transport: TransportDescriptor;
  readonly capabilities: RuntimeCapabilities;

  // ---- 生命周期 ----
  /** 探测本机是否装了、能否连上。UI 顶栏据此显示可用状态。 */
  probe(): Promise<ProbeResult>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // ---- 会话 ----
  listSessions(unit: WorkUnit): Promise<readonly Session[]>;
  startSession(req: StartSessionRequest): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  sendMessage(req: SendMessageRequest): Promise<void>;
  cancel(sessionId: SessionId): Promise<void>;

  // ---- steer 待发送队列管理（T3 排队消息的操作面；daemon 适配器实现，mock 可缺省）----
  /** 删除一条排队插话。「编辑回填」= 删除成功后前端把文本放回输入框 */
  removeQueuedSend?(sessionId: SessionId, id: string): Promise<void>;
  /** 立刻发送：取消当前轮，轮落定后这条排队消息优先进去 */
  sendQueuedNow?(sessionId: SessionId, id: string): Promise<void>;
  /** 恢复暂停的队列（用户停止/轮失败后 daemon 不再自动出队） */
  resumeQueuedSends?(sessionId: SessionId): Promise<void>;

  // ---- 权限 ----
  resolvePermission(sessionId: SessionId, requestId: string, decision: PermissionDecision): Promise<void>;

  // ---- 事件流 ----
  /**
   * 归一化事件流。适配器内部把原生协议翻译成 RuntimeEvent union。
   * 这是唯一的数据出入口，UI 永远不碰原生格式。
   */
  events(): AsyncIterable<RuntimeEvent>;

  /**
   * 账本回放（ADR 0012）：从 daemon 账本读该会话的全量已盖章事件
   * （热环 + 落盘账本双路径），供聊天页重建时间线（openSession）。
   * 可选 —— 非 daemon 适配器没有账本，不实现。
   */
  eventsSince?(sessionId: SessionId): Promise<readonly { seq: number; at: number; event: RuntimeEvent }[]>;

  // ---- 轨迹（eval 闭环）----
  /** 导出该会话的完整轨迹，供 LLM judge 消费 */
  exportTrace(sessionId: SessionId): Promise<string>;
}

// ---------------------------------------------------------------------------
// 适配器工厂
// ---------------------------------------------------------------------------

export interface AdapterFactory {
  readonly id: RuntimeId;
  readonly presentation: RuntimePresentation;
  readonly transport: TransportDescriptor;
  readonly capabilities: RuntimeCapabilities;
  /**
   * 这是测试夹具（mockperm），不是真的 CLI 工具。
   * 界面照实标出来 —— 否则用户会以为那是个没听说过的厂商。
   */
  readonly testOnly?: true;
  /**
   * 这个 CLI 能用哪些模型 —— 强制声明，理由同 capabilities。
   *
   * Claude Code 只接 Anthropic，Codex 只接 OpenAI，
   * 而 OpenCode / pi / ZCode 是厂商中立的。UI 靠它决定「切到这个执行器后，
   * 模型下拉里该出现哪几个」，不用在 UI 里写厂商 if。
   *
   * 非空是硬要求：空清单意味着这个执行器没法开工，注册时就该被拒。
   */
  readonly models: readonly ModelId[];
  /** 从 daemon 传来的原生模型元数据（含 displayName 与上下文限制等动态对齐参数） */
  readonly rawModels?: readonly RawExecutorModel[];
  /**
   * 上面那份 rawModels 是从 daemon 的兜底缓存来的，写于何时；缺省 = 本次真探到。
   *
   * 注册时冻结的是**那一刻**的快照，所以这个标记必须一起冻进来 ——
   * 否则页面刷新后界面会说「已刷新」而其实拿的是上次的结果。
   */
  readonly modelsCachedAt?: number;
  /** 真正的适配器实例化在这里做（可能需要 spawn 进程） */
  create(): Promise<RuntimeAdapter>;
}

export interface RawExecutorModel {
  readonly id: ModelId;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoningLevels?: readonly string[];
  readonly defaultReasoningLevel?: string;
  readonly contextLengths?: readonly import("./models.ts").ContextLengthOption[];
  readonly defaultContextLength?: string;
  readonly multimodal?: boolean;
  readonly inputPerMTok?: number;
  readonly outputPerMTok?: number;
}

// ---------------------------------------------------------------------------
// 原生斜杠命令（native slash commands）
// ---------------------------------------------------------------------------

/**
 * 执行器原生的斜杠命令条目 —— 菜单数据的唯一形态。
 *
 * 语义约定（对齐 Claude Code supportedCommands / Codex prompts / OpenCode command）：
 * - `name` 不带前导斜杠（UI 渲染 `/name`，发送时拼上）。
 * - 执行方式是**透传**：文本原样发给执行器会话，由执行器自己分发（claude SDK 的
 *   slash-command dispatch / codex 的 prompts 展开 / opencode 的 command 路由）。
 *   工作台不在中间翻译语义 —— 这是与旧版「本地假命令」的本质区别。
 * - `argumentHint` 直接来自执行器自己的声明（如 "<file>"），原样展示。
 */
export interface NativeCommandInfo {
  /** 命令名，不带前导斜杠（如 "compact"） */
  readonly name: string;
  readonly description?: string;
  /** 参数提示（如 "<file>"、"[query]"）——执行器原生声明，原样展示 */
  readonly argumentHint?: string;
  /** 别名（/cost ↔ /stats 这类）；键入别名也应命中 */
  readonly aliases?: readonly string[];
  /** 执行器自带的内置命令（区别于用户/项目自定义） */
  readonly builtin?: boolean;
  /**
   * 命令来源：builtin = 执行器内置；user/project/plugin = 各自目录里发现的
   * 自定义命令。展示徽标用，执行路径不区分。
   */
  readonly source?: "builtin" | "user" | "project" | "plugin";
  /**
   * 条目种类（菜单分组用，对齐 ZCode 斜杠面板的 命令/技能/子智能体 三段）：
   * - command：斜杠命令，选中插入 "/name "，由执行器原生分发
   * - skill：技能（SKILL.md 目录），zcode/claude 均可 "/name" 触发，同透传语义
   * - agent：子智能体定义，选中插入 "/name "；能否分发由执行器自己决定，
   *   不可分发时执行器会把文本当普通输入 —— 不在中间翻译语义
   * 缺省 = command（存量数据不带 kind 也按命令渲染）。
   */
  readonly kind?: "command" | "skill" | "agent";
}
