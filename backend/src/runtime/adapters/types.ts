/**
 * daemon 侧执行器适配器 SPI —— prototype/src/core/adapter.ts 的服务端对应物。
 *
 * 形态刻意对齐前端契约（同名的 probe / start / send / cancel / resolvePermission），
 * 但职责收窄：适配器只做「原生协议 → RuntimeEvent 流」的翻译，
 * 会话台账、事件盖章（TraceRecord）、广播由 RuntimeHost 统一管。
 *
 * 验收标准沿用契约原文：新增一家工具 = 一个 adapter 文件 + host 注册一行，
 * core（host/wsd/trace）不改。
 */

import type {
  ConnectionState,
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
  UnitId,
} from "../../contract.ts";

export interface ExecutorModelInfo {
  readonly id: ModelId;
  readonly displayName: string;
  /** 上下文限制（token） */
  readonly contextWindow?: number;
  /** 最大单轮输出限制（token） */
  readonly maxOutput?: number;
  /** 支持的推理档位（low, medium, high, max, ultra 等） */
  readonly reasoningLevels?: readonly string[];
  /** 默认推理档位 */
  readonly defaultReasoningLevel?: string;
  /** CLI 声明的可选上下文长度档（value 原样透传回 set_config_option，绝不本地换算） */
  readonly contextLengths?: readonly { readonly value: string; readonly label: string }[];
  /** 探测那一刻执行器正生效的上下文档 value */
  readonly defaultContextLength?: string;
  /** 是否支持多模态输入（图片/附件） */
  readonly multimodal?: boolean;
  /** 输入价格（美元/百万 token） */
  readonly inputPerMTok?: number;
  /** 输出价格（美元/百万 token） */
  readonly outputPerMTok?: number;
}

/**
 * 一次模型同步的结果。
 *
 * ## 为什么要带 source
 *
 * `models` 光秃秃一个数组没法回答用户最常问的那句「它到底刷新了没」——
 * 拿回来的既可能是刚从 CLI 问到的实时清单，也可能是一份从没动过的静态兜底，
 * 两者长得一模一样。所以同步必须**如实标记来源**，界面照实显示，别让人
 * 对着一个没刷新的列表以为「刷新过了就是这样」。
 */
export interface ModelSyncOutcome {
  readonly models: readonly ExecutorModelInfo[];
  /** live = 这次真的问过 CLI；static = 实时源不可用，用的是内置兜底清单 */
  readonly source: "live" | "static";
  /** source=static 时的原因（超时/未安装/命令不存在…）。UI 拿它当 tooltip */
  readonly reason?: string;
  readonly elapsedMs: number;
}

export interface StartRequest {
  readonly unitId: UnitId;
  readonly unitName: string;
  /** 工作目录（agent 在这里干活） */
  readonly rootPath: string;
  readonly prompt: string;
  /** null = 用执行器自己的默认模型 */
  readonly model: ModelId | null;
  /** 权限模式（zcode 语义：yolo 不问权限，build 问） */
  readonly mode?: "plan" | "build" | "edit" | "yolo";
  /** 推理力度（zcode → model.options.reasoningLevel；codex → model_reasoning_effort） */
  readonly reasoningLevel?: string;
  /** 上下文长度档（执行器侧原始 value）：仅声明了可选档的执行器应用，其余忽略 */
  readonly contextLength?: string;
}

/**
 * 执行器原生模型默认值 —— 写进 CLI 自己的配置文件的那几个键（cc-switch 同思路）。
 *
 * 只描述「字段级补丁」：一条字段 = 一个稳定 key（UI 提交用）+ 当前值（空串 = 未设置，
 * 提交空串 = 删键回到 CLI 自己的默认）。整份文件的其余键（hooks / permissions /
 * MCP / 用户手写的任何东西）一律不碰 —— 这是字段清单而不是文件模板的原因。
 */
export interface NativeModelField {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "number" | "enum";
  /** kind = enum 时的可选项（思考强度一类） */
  readonly options?: readonly string[];
  /** 当前生效值；空串 = 该键未设置 */
  readonly value: string;
  readonly placeholder?: string;
  readonly hint?: string;
  /** 候选建议（host 侧注入的执行器当前模型清单）—— UI 渲染成可选项，选而不手打 */
  readonly suggestions?: readonly string[];
}

export interface NativeModelConfig {
  /** 写入的目标文件（UI 展示「改的是哪份配置」用） */
  readonly configPath: string;
  /** 生效口径说明（哪些场景会用到这些默认值） */
  readonly note: string;
  readonly fields: readonly NativeModelField[];
}

/**
 * 执行器模型目录的一条可编辑条目（codex 的 model-catalogs 一类）。
 *
 * 目录是「清单级」编辑面：增删模型、改显示名/窗口/推理档位/可见性，
 * 整体生效于 CLI 的模型选择面（TUI 的 /model 与工作台选择器都吃它）。
 */
export interface ModelCatalogEntry {
  readonly slug: string;
  readonly display_name: string;
  /** 上下文窗口（token）。undefined = 该条目不声明（跟随 CLI 默认） */
  readonly context_window?: number;
  /** 推理档位（effort id 列表） */
  readonly supported_reasoning_levels?: readonly string[];
  readonly default_reasoning_level?: string;
  /** "list" = 可选；"hide" = 不出现在选择面（codex 的合法变体：list/hide/none）。其他值原样透传 */
  readonly visibility: string;
  /** 支持图片输入（codex 的 input_modalities 含 image） */
  readonly multimodal?: boolean;
}

/** 提交行：origSlug 缺省 = 新增条目；有值 = 对该条目的就地编辑（含改名） */
export interface ModelCatalogWriteRow extends ModelCatalogEntry {
  readonly origSlug?: string;
}

export interface ModelCatalogInfo {
  /** 当前生效的目录文件；null = 未配置目录（entries 是「当前生效清单」的种子，保存即接管） */
  readonly activePath: string | null;
  readonly note: string;
  readonly entries: readonly ModelCatalogEntry[];
  /** 目录文件是别的工具管的（如 cc-switch）—— 提示用户编辑可能被对方重生成 */
  readonly managedByExternal?: string;
}

// ---- 供应商级配置（pi / opencode 一类「多家共存」的累加式面）------------------------

/** 一个供应商条目：baseUrl/apiKey/api + 模型 id 清单 */
export interface ProviderEntry {
  /** 供应商键（配置里的 id，也是模型 id 的前缀） */
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** pi = api 协议（openai-completions 等）；opencode = npm 包名（@ai-sdk/openai-compatible） */
  readonly api: string;
  readonly models: readonly string[];
}

/** 提交行：origKey 缺省 = 新增；models 为该供应商的完整模型 id 清单（表外即删除） */
export interface ProviderWriteRow extends ProviderEntry {
  readonly origKey?: string;
}

export interface NativeProvidersInfo {
  readonly configPath: string;
  readonly note: string;
  readonly providers: readonly ProviderEntry[];
  /** 文件暂不可编辑时的说明（如 JSONC 含注释） */
  readonly managedByExternal?: string;
}

export type AdapterSink = (event: RuntimeEvent) => void;

export interface AdapterSession {
  readonly id: SessionId;
  /**
   * 再发一轮（多轮会话由适配器自己决定怎么续：同会话追加或 --resume）。
   * loop = 本轮的参数覆盖（推理力度 / 上下文长度 / 采样），不改变会话级配置。
   */
  send(text: string, loop?: { readonly mode?: StartRequest["mode"]; readonly reasoningLevel?: string; readonly contextLength?: string }): Promise<void>;
  cancel(): Promise<void>;
  resolvePermission(requestId: string, decision: "allow" | "deny" | "always"): Promise<void>;
  /**
   * 执行器侧的原生会话引用（zcode 的 --resume id / codex 的 thread id）。
   * daemon 把它存进 state.db，重启后 reattach 用 —— 会话续命的关键。
   * 首轮结束前是 null。
   */
  externalRef(): string | null;
}

export interface ExecutorAdapter {
  readonly id: string;
  readonly displayName: string;
  /** 单字符徽标（与前端 RuntimePresentation.glyph 同语义） */
  readonly glyph: string;
  /**
   * 标了就是**测试夹具**，不是真的 CLI 工具。界面要照实显示出来。
   *
   * 目前只有 mockperm（见 adapters/mockperm.ts）：它每轮都真的挂起等审批，
   * 是权限闸唯一的端到端验收手段 —— 真执行器启动时就把权限定死了，中途不问你。
   */
  readonly testOnly?: true;
  /** 非空硬要求（契约原文）：空清单的执行器注册即拒 */
  readonly models: readonly ExecutorModelInfo[];
  readonly capabilities: RuntimeCapabilities;
  /**
   * 该执行器在 cwd 下**原生读取**的项目上下文文件名（规范大写，如 "AGENTS.md"）。
   * ADR 0014 D4 —— 唯一的防双注注册表（openclaw 把这件事硬编码在每个适配层里，
   * 这里做成声明式能力位）。host 的注入计划据此判定：声明了 AGENTS.md 的执行器
   * 不再由工作台注入同一文件（原生读取每轮新鲜，优于冻结快照）。
   *
   * **只标注验证过的**：不确定的执行器不标（auto 语义 = 未声明 → 工作台注入兜底，
   * 宁双注勿漏注）。核对清单见 docs/20 P2-4。
   */
  readonly nativeContextFiles?: readonly string[];
  /**
   * 动态对齐/刷新模型清单与上下文参数（支持的 CLI 会实时查询，失败时保留 fallback）。
   *
   * ## 零用量硬约束
   *
   * 这条路径**绝不允许**发 prompt、起 turn 或调用任何会话创建接口去「试一下模型好不好用」。
   * 合法实现只有两类：跑 CLI 的只读列清单命令，或读 CLI 自带的本地目录/配置文件。
   * 违反这条约束 = 用户点一下刷新按钮就烧掉一次订阅额度，比不刷新还糟。
   */
  syncModels?(): Promise<ModelSyncOutcome>;
  /** 该执行器是否实现了 syncModels（没实现的界面要标「无动态探测源」，别让人空按） */
  readonly modelsDiscoverable?: boolean;
  /**
   * 列出该执行器在 rootPath 下的**原生斜杠命令**（可选能力）。
   *
   * - 命令来自执行器自己的声明面（Claude SDK supportedCommands / Codex prompts
   *   目录 / OpenCode GET /command），不是工作台编的静态表；
   * - 执行是透传语义：调用方把 "/name args" 当普通 turn 文本发进会话，
   *   分发由执行器完成（个别 CLI —— codex/opencode —— 由适配器在 send 里
   *   做与 TUI 等价的展开/路由，见各自实现）；
   * - rootPath 影响命令清单（项目级自定义命令）；适配器自定缓存与 TTL；
   * - 没有原生命令面的执行器不实现此方法，UI 菜单只显示工作台本地命令。
   */
  listCommands?(rootPath: string): Promise<readonly NativeCommandInfo[]>;
  /**
   * 读/写该执行器**原生配置文件里的模型默认值**（可选能力，cc-switch 同思路）。
   *
   * - 只有存在稳定文件级模型默认面的 CLI 才实现（claude 的 settings.json env、
   *   codex 的 config.toml 顶层键）；ACP 系执行器的模型参数走会话内 configOption
   *   逐轮下发，没有可写的持久面，不实现 —— 界面对未实现者显示「随会话下发」。
   * - write 的 values 以字段 key 为准，空串 = 删键；返回写后重读的完整配置。
   * - 实现方必须字段级补丁 + 原子写（临时文件 rename），绝不整份覆盖用户配置。
   */
  readModelDefaults?(): NativeModelConfig;
  writeModelDefaults?(values: Readonly<Record<string, string>>): NativeModelConfig;
  /**
   * 读/写执行器的**模型目录**（可选能力，cc-switch 同思路）：清单级编辑面 ——
   * 增删模型、改显示名/上下文窗口/推理档位/可见性，写进 CLI 自己的目录文件
   * （codex 的 model-catalogs/*.json，经 config.toml 的 model_catalog_json 挂载）。
   * 未配置目录时 read 返回当前生效清单作种子（保存即创建并接管）；
   * 目录文件归别家工具管（cc-switch）时如实上报 managedByExternal。
   */
  readModelCatalog?(): Promise<ModelCatalogInfo>;
  writeModelCatalog?(rows: readonly ModelCatalogWriteRow[]): Promise<ModelCatalogInfo>;
  /**
   * 读/写执行器的**供应商配置**（可选能力）：多家供应商共存的累加式面 ——
   * pi 的 models.json providers、opencode 的 provider(s) 段。条目级 patch，
   * 未暴露字段（headers/compat 一类）随行保留；保存后由 host 顺带刷模型清单。
   */
  readModelProviders?(): NativeProvidersInfo;
  writeModelProviders?(rows: readonly ProviderWriteRow[]): NativeProvidersInfo;
  /**
   * 使 listCommands 的适配器内部缓存全部失效（可选能力）。
   * 技能停用/恢复后 host 会调用它 —— 只清 host 侧落盘缓存不够：适配器自己
   * 还有 10 分钟 TTL 的内存缓存，不清的话旧清单会被原样返回并**重新落盘**，
   * 斜杠菜单最长 10 分钟还显示已停用的技能。实现方应清空全部 rootPath 条目。
   */
  invalidateCommands?(): void;
  /**
   * 交互式 TUI 的启动命令名（可选）。终端「一键直启」拼 pwsh 命令时用它
   * 替换裸 id —— 适用于「TUI 由另一个 shim 拉起」的执行器（dsh 的 TUI 走
   * dst shim，裸 dsh 是 automation/web 入口不是 TUI）。缺省 = 裸 id 即命令。
   */
  readonly tuiCommand?: string;
  /** 探测本机是否可用（版本/认证），结果缓存与否由适配器自己定 */
  probe(): Promise<ProbeResult>;
  /** 建会话并开始把翻译好的事件喂给 sink；返回后 host 补发 session.started */
  start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession>;
  /**
   * 把一个已存在的外部会话接回 daemon（Phase 3 resumeSession 的执行器侧）。
   * sessionId 是 daemon 侧稳定 id（事件全用它），ref 是 externalRef 存的值，
   * rootPath 是会话原工作目录（执行器冷恢复常需要 workspace 才能找到会话）。
   */
  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession;
  /** daemon 关停时回收子进程 */
  disconnect(): Promise<void>;
}

/** 会话未找到等通用错误的便捷构造 */
export function adapterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
