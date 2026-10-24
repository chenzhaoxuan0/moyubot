/**
 * 搜索工具契约 —— bot 级联网搜索（workbench-search 桥）的共享形态。
 *
 * 领域语义（对齐浏览器/电脑控制的 docs/14 心智，但作用域是 **per-bot**）：
 * - 配置与密钥都在 daemon 侧（`<homeDir>/search-keys.json`），按 botId 分槽——
 *   不进 bot.json、不进浏览器（README「密钥放在哪」的硬规矩）；
 * - 执行器侧只装一个与 bot 无关的 stdio 桥（`<homeDir>/mcp/search-bridge.mjs`，
 *   条目名 `workbench-search`）：它拿会话 cwd 问 daemon「这个工作区有没有搜索」，
 *   有才暴露 `web_search` 工具——所以同一条全局条目能做到按 bot 开关；
 * - 提供商（tavily / deepseek / doubao）是 daemon 内的适配器注册表，加一家 = 一个 def。
 */

/** 已接入的搜索提供商（注册表见 backend/src/searchctl/providers.ts） */
export type SearchProviderId = "tavily" | "deepseek" | "doubao" | "yuanbao";

/** 提供商目录条目（`search.providers` / 设置页直显） */
export interface SearchProviderInfo {
  readonly id: SearchProviderId;
  readonly label: string;
  /** key 形态提示（「tvly- 开头」「ARK 平台 API Key」…） */
  readonly keyHint: string;
  /** 申请密钥的官方页面 */
  readonly docsUrl: string;
  /** 免费额度/计费说明（一句话，UI 直显） */
  readonly freeTierNote: string;
  /** 该家有没有余量查询 API（没有就只显示本机计数） */
  readonly quotaSupported: boolean;
}

/** 配额快照 —— 各家字段归一；查不到的维度留 null，绝不算出来骗人 */
export interface SearchQuotaSnapshot {
  readonly provider: SearchProviderId;
  readonly ok: boolean;
  readonly error?: string;
  /** 计划名（free / paygo …） */
  readonly plan?: string | null;
  /** 周期内已用次数 */
  readonly used?: number | null;
  /** 周期总额度（1000 之类；null = 无固定上限） */
  readonly limit?: number | null;
  /** 剩余次数（limit-used 推不出来时 null） */
  readonly remaining?: number | null;
  /** 余额型计费（元，字符串保精度） */
  readonly balance?: string | null;
  /** 额度重置/到期时间（epoch ms；无概念 null） */
  readonly resetsAt?: number | null;
  /** 原始口径备注（「免费期至…」「按量计费」） */
  readonly note?: string | null;
  readonly fetchedAt: number;
}

/** 单个 bot 的搜索状态（`search.status` / overview 行） */
export interface SearchBotStatus {
  readonly botId: string;
  readonly botName: string;
  /** 工作目录（总览里指认 bot 用） */
  readonly rootPath: string;
  /** false = 未配置（桥对这个工作区不暴露工具） */
  readonly configured: boolean;
  readonly provider: SearchProviderId | null;
  /** daemon 侧是否已存密钥 */
  readonly apiKeySet: boolean;
  /** 掩码（`tvly-••••ab12`）——只给头尾，明文永不回浏览器 */
  readonly apiKeyMasked: string | null;
  /** 本机本月经桥的调用次数（daemon kv 计数；口径是「这个工作台用了多少」） */
  readonly localUsageMonth: number;
  /** 最新配额快照（有余量 API 且 key 可用时才有；失败也带 ok:false 快照） */
  readonly quota: SearchQuotaSnapshot | null;
}

/** `search.overview` 的返回 —— 全局设置「搜索」分区一次拉全 */
export interface SearchOverview {
  readonly providers: readonly SearchProviderInfo[];
  readonly bots: readonly SearchBotStatus[];
  /** 桥脚本绝对路径（扇出条目里的 command 指向它） */
  readonly bridgePath: string;
  /** workbench-search 条目是否已写进执行器原生配置（≥1 个 bot 配置了搜索即应有） */
  readonly entryInstalled: boolean;
  readonly fanout: readonly { readonly executorId: string; readonly ok: boolean; readonly error?: string }[];
  readonly notes: readonly { readonly executorId: string; readonly note: string }[];
  readonly actions: readonly {
    readonly seq: number;
    readonly at: number;
    readonly action: string;
    readonly detail: string;
  }[];
}

/** bot 设置/新建流里的搜索草稿形状见 ui/SearchSection.tsx 的 SearchDraftState（随保存经 `search.configure` 落 daemon 侧存储） */
