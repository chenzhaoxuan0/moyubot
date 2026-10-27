/**
 * 领域原语：一个文件夹 = 一个工作单元，两种身份。
 *
 * 设计要点：bot模式与项目模式不是两类软件，而是同一个 WorkUnit 的两种 kind。
 * 运行原语（目录 / agent 定义 / 会话 / 技能 / 权限）对两者完全一致。
 */

import type { SteerQueueItem } from "./events.ts";

// ---------------------------------------------------------------------------
// 品牌化 ID
// ---------------------------------------------------------------------------

export type UnitId = string & { readonly __brand: "UnitId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type RuntimeId = string & { readonly __brand: "RuntimeId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const asUnitId = (v: string): UnitId => v as UnitId;
export const asSessionId = (v: string): SessionId => v as SessionId;
export const asRuntimeId = (v: string): RuntimeId => v as RuntimeId;
export const asModelId = (v: string): ModelId => v as ModelId;
// ---------------------------------------------------------------------------
// 工作单元
// ---------------------------------------------------------------------------

/**
 * 身份模型。两者共享同一套运行时原语，只是"关注点"不同：
 * - bot 关心：人设、日程、渠道、长期记忆、产出归档（招聘）
 * - project  关心：看板、diff、PR、会话短寿、worktree 隔离（组队施工）
 */
export type UnitKind = "bot" | "project";

/** 从 AGENTS.md 派生的身份定义。零迁移的关键：文件即数据库。 */
export interface WorkspaceIdentity {
  /** 人设/岗位说明书摘要 */
  readonly role: string;
  /** 头像或 emoji */
  readonly avatar?: string;
  /**
   * 主动人格提示词。
   *
   * @deprecated ADR 0014 D5：正文已物化为 <rootPath>/SOUL.md（文件即数据库，与
   * AGENTS.md 同构），此字段只在保存时迁移、读时兼容一个版本。新代码请用 soulMd。
   */
  readonly persona?: string;
  /** 来源文件路径（相对单元根目录） */
  readonly sourcePath: string;
  /** 最后一次解析时间 */
  readonly loadedAt: number;
}

export interface UnitSchedule {
  /** 下一次自动触发时间戳 */
  readonly nextRunAt?: number;
  /** 最近一次触发 */
  readonly lastRunAt?: number;
  /** 人类可读的 cron / 自然语言描述 */
  readonly description: string;
  readonly enabled: boolean;
}

/**
 * 密钥**引用**而非明文。对齐 openclaw 的 `SecretRef`（extensions/feishu/src/accounts.ts
 * 用 `coerceSecretRef`）：配置里只存「去哪取」，不存值。
 *
 * 形态上的好处是 push 泄漏时密钥根本不在文件里——docs/09 7.5 节的 git 泄漏检查
 * 从「安全前提」降级为「仍值得做的兜底」。
 */
export interface SecretRef {
  /** env = 进程环境变量；file = 相对 rootPath 的文件；vault = 本地受限凭证库；literal = 直接值 */
  readonly source: "env" | "file" | "vault" | "literal";
  /** env 模式下的变量名 / file 模式下的相对路径 / vault 模式下的凭证 ID */
  readonly id: string;
}

/**
 * 一个 bot 在某个渠道上的**一个账号**。
 *
 * 为什么是「多账号」而不是「多渠道」：飞书一个应用 = 一个机器人。想让每个 bot 对应
 * 一个飞书机器人，就是给每个 bot 挂一个飞书账号。这与 openclaw 的
 * `channels.feishu.accounts.<accountId>` 同一套结构，只是方向相反。
 *
 * 飞书账号里只填 **lark-cli 的 profile 名**，不填 appId/appSecret：本机的
 * `lark-cli` 已经是全部飞书能力（长连接、事件解密、内容预渲染、markdown、附件、
 * 文档、云盘）的持有者，而 `--profile` 是**按调用指定**的全局 flag —— 于是
 * 「每 bot 一个飞书机器人」= 每 bot 一个 profile = 一条独立长连接。
 * 凭据由 profile 自己管，agent-workbench 不碰密钥。
 */
export interface ChannelAccount {
  /** 账号 id，同一渠道内唯一。缺省 "main"。 */
  readonly id: string;
  /** lark-cli profile 名（`lark-cli profile list` 可查）。一个 profile = 一个飞书机器人 */
  readonly profile?: string;
  /** 海外站走 Lark。默认飞书国内站 */
  readonly domain?: "feishu" | "lark";
  /** 允许响应的发送者 open_id 白名单。空 = 不限（⚠️ 意味着任何人都能驱动这个 bot） */
  readonly allowFrom?: readonly string[];
  /** 群聊里只在被 @ 时响应。默认 true；单聊不受影响 */
  readonly mentionOnly?: boolean;
  /**
   * Telegram / Discord：**Bot Token 的环境变量名**（只存变量名，token 本身不落盘）。
   * daemon 侧同时认这个字段与旧的明文 `botToken`。
   */
  readonly botTokenEnv?: string;
  /** Telegram / Discord：明文 Token（仅用于测试或迁移，建议优先 botTokenEnv / SecretRef） */
  readonly botToken?: string;
  /** 关联的安全凭证引用（如微信扫码产出的 vault:weixin:<botId>） */
  readonly secretRef?: SecretRef;
  /** Telegram：只应答这个会话 id */
  readonly chatId?: string;
  /** 微信 iLink Bot ID */
  readonly ilinkBotId?: string;
  /** Discord：限定的 Guild ID（服务器） */
  readonly discordGuildId?: string;
  /** Discord：限定的 Channel ID */
  readonly discordChannelId?: string;
  /** 远程交互式确认门审批（按钮回传）。开启时敏感操作在 IM 弹按钮，不自动 yolo 放行 */
  readonly interactiveApproval?: boolean;
  /** 收到消息时加的表情：飞书/IM 表情枚举名 */
  readonly ackEmoji?: string;
  /** 答完时加的表情 */
  readonly doneEmoji?: string;
  /** 是否流式刷新输出 */
  readonly streaming?: boolean;
  /** 渠道自身的能力位（对齐 openclaw ChannelPlugin 的可选槽，只实现用得上的） */
  readonly options?: Readonly<Record<string, string>>;
}

/**
 * bot 的外联渠道——"bot 找得到你"的声明面。
 *
 * `config` 是**旧形态**（单账号、凭据明文），只为不打断已落盘的 bot.json 保留；
 * 新写入一律走 `accounts`。
 */
export interface BotChannel {
  readonly kind: "telegram" | "feishu" | "weixin" | "discord" | "webhook";
  readonly enabled: boolean;
  readonly accounts?: readonly ChannelAccount[];
  /** @deprecated 单账号旧形态。读时若 accounts 缺省则由它归一出一个 default 账号 */
  readonly config?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// 上下文清单（ADR 0014 / docs/20）
// ---------------------------------------------------------------------------

/**
 * 每 bot 一份的注入决策清单，住在 bot.json 的 `contextManifest` 节。
 *
 * 定位立场：context 是显式资产、注入是显式决定——**默认全关（裸跑）**，
 * 新建与存量同一规则（没写的就是不注入）。权威在 daemon：
 * host.startSession 从 bot 定义自读，渠道会话与工作台会话据此天然一致。
 */
/** 命名的自定义注入预设（2026-10-23）：name 供两处 UI 展示，manifest 是快照本体 */
export interface NamedContextPreset {
  readonly name: string;
  readonly manifest: ContextManifest;
}

/** 默认清单（ADR 0014）：全关 Bare——新建与存量同一规则；预设行与输入框胶囊共用 */
export const DEFAULT_CONTEXT_MANIFEST: ContextManifest = {
  agentsMd: "off",
  soul: false,
  user: false,
  memorySemantic: false,
  memoryDaily: false,
  memoryStanding: false,
  skills: false,
};

/**
 * 默认预设名（2026-10-26 指针模型 v2）：「默认」不再是虚拟常量，而是预设名单里
 * 一条真实可编辑的条目 —— 在默认下改注入清单就是改这条预设，可保存、可改名，
 * 与自定义预设同权。旧的「自动保存」草稿槽概念废除（存量条目迁移为普通自定义
 * 预设，可改名/删除）。
 */
export const DEFAULT_PRESET_NAME = "默认";

/**
 * 预设名单兜底：空名单时种一条「默认」（Bare 全关）。名单非空就完全信盘上 ——
 * 用户把「默认」改名或删光是合法状态，不补种；选中指针的兜底见
 * resolveActivePresetName（回落名单第一条）。
 */
export function ensureContextPresets(
  presets: readonly NamedContextPreset[] | undefined,
): NamedContextPreset[] {
  const list = presets ?? [];
  return list.length > 0 ? [...list] : [{ name: DEFAULT_PRESET_NAME, manifest: DEFAULT_CONTEXT_MANIFEST }];
}

/**
 * 选中指针解析：指向名单里真实存在的条目；空串 / 旧虚拟默认的存量指针
 * "default" / 指向已被删掉的条目 → 回落名单第一条（迁移后即「默认」）。
 * 永远返回名单内的名字 —— 两个消费面（设置页 / 输入框胶囊）的高亮口径一致。
 */
export function resolveActivePresetName(
  active: string | undefined,
  presets: readonly NamedContextPreset[],
): string {
  const a = active ?? "";
  if (a !== "" && a !== "default" && presets.some((c) => c.name === a)) return a;
  return presets[0]?.name ?? DEFAULT_PRESET_NAME;
}

/** 注入矩阵的比对键（firstTurnInject 不参与「与预设一致」的判定） */
const CONTEXT_MANIFEST_KEYS = ["agentsMd", "soul", "user", "memorySemantic", "memoryDaily", "memoryStanding", "skills"] as const;

/** 两份清单在七个注入开关上是否一致（预设高亮/去重写判定的口径） */
export function sameContextManifest(a: ContextManifest, b: ContextManifest): boolean {
  return CONTEXT_MANIFEST_KEYS.every((k) => a[k] === b[k]);
}

export interface ContextManifest {
  /**
   * 是否开启新会话首轮自动注入（缺省为 true）。
   * 用户可在 Bot 设置中将其置为 false 实现该 Bot 默认裸跑，仅在输入框手动勾选时注入。
   */
  readonly firstTurnInject?: boolean;
  /**
   * AGENTS.md 是唯一三态项。auto（默认）= 执行器声明原生读取则不注入（防双注），
   * 未声明则注入兜底——宁双注勿漏注，岗位说明书静默丢失比浪费 token 严重（ADR 0014）。
   */
  readonly agentsMd?: "auto" | "on" | "off";
  /** <rootPath>/SOUL.md 人设（用户维护，只读注入） */
  readonly soul?: boolean;
  /** <homeDir>/USER.md 关于「人」的全局层（对外渠道 bot 默认关） */
  readonly user?: boolean;
  /** MEMORY.md 长期事实 */
  readonly memorySemantic?: boolean;
  /** memory/daily/<今日>.md 当日精炼 */
  readonly memoryDaily?: boolean;
  /** STANDING.md 红线。唯一「存在即注入」倾向的项：默认关保护的是不被倾倒，不是不设防 */
  readonly memoryStanding?: boolean;
  /** 技能目录注入（Phase 4 接线，先占位） */
  readonly skills?: boolean;
}

/**
 * 整节缺失时的归一结果 = 全关（2026-10-22 用户定夺：默认注入一律为 0，取消最初
 * 「存量 bot 保持 semantic+standing」的兼容 seeding——裸跑是默认，打开是显式决定）。
 * 唯一例外是 agentsMd 的 auto：对已标注原生读取的执行器它就是不注入（防双注）。
 */
export const LEGACY_CONTEXT_MANIFEST: ContextManifest = {
  firstTurnInject: true,
  agentsMd: "auto",
  soul: false,
  user: false,
  memorySemantic: false,
  memoryDaily: false,
  memoryStanding: false,
  skills: false,
};

/**
 * 归一任何来源的 manifest（bot.json 原始 JSON / RPC 参数 / UI 草稿）。
 *
 * 整节缺失/畸形与「节存在但字段缺」现在归一到同一结果：全关 + agentsMd auto
 *（字段级缺省本来就是 false）——心智模型只剩一条：**没写的就是不注入**。
 */
export function normalizeContextManifest(raw: unknown): ContextManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return LEGACY_CONTEXT_MANIFEST;
  const m = raw as Partial<ContextManifest>;
  return {
    firstTurnInject: m.firstTurnInject !== false,
    agentsMd: m.agentsMd === "on" || m.agentsMd === "off" ? m.agentsMd : "auto",
    soul: m.soul === true,
    user: m.user === true,
    memorySemantic: m.memorySemantic === true,
    memoryDaily: m.memoryDaily === true,
    memoryStanding: m.memoryStanding === true,
    skills: m.skills === true,
  };
}

/** 单轮对话上下文覆盖模式 */
export type TurnContextOverrideMode = "bot_default" | "off" | "custom";

/** 单轮或会话临时注入配置（Composer 工具栏使用） */
export interface TurnContextConfig {
  readonly mode: TurnContextOverrideMode;
  /** 当 mode === 'custom' 时生效的临时清单 */
  readonly customManifest?: ContextManifest;
  /** 是否在本会话后续轮次持续保持（默认 false，发送后即复位为默认） */
  readonly persistForSession?: boolean;
}

/**
 * 计算当前轮实际生效的注入清单。
 * 返回 null 表示完全不注入（裸跑）。
 */
export function resolveEffectiveTurnManifest(
  config: TurnContextConfig | undefined,
  botManifest: ContextManifest | undefined,
  isFirstTurn: boolean,
): ContextManifest | null {
  const normBot = normalizeContextManifest(botManifest);
  const mode = config?.mode ?? "off";

  if (mode === "off") return null;
  if (mode === "custom" && config?.customManifest) {
    return normalizeContextManifest(config.customManifest);
  }
  // mode === "bot_default"
  if (isFirstTurn) {
    if (normBot.firstTurnInject === false) return null;
    return normBot;
  }
  // 续聊时若用户主动选择 "bot_default"，则附带 bot 预设清单
  return normBot;
}

/**
 * AGENTS.md 三态的最终判定（auto 在这里落地，host 注入前收口）。
 * nativeReadsAgentsMd = 当前执行器是否声明原生读取 cwd 下的 AGENTS.md。
 */
export function resolveAgentsMdInjection(
  mode: "auto" | "on" | "off",
  nativeReadsAgentsMd: boolean,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !nativeReadsAgentsMd;
}

/**
 * 判断一段文本是否包含实质性内容（排除 HTML 注释、Markdown 纯标题行、空白与括号说明等模板骨架）。
 *
 * 常见骨架：
 * - <!-- 请在此处填写... -->
 * - # SOUL.md / # 人设 / # 未命名
 * - （还没写岗位说明书） / （留空表示...）
 * 只有当存在实质正文时才返回 true。
 */
export function hasSubstantiveContent(text: string | null | undefined): boolean {
  if (!text) return false;
  const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const substantiveLines = noComments
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (l === "") return false;
      if (/^#{1,6}\s+.*$/.test(l)) return false;
      if (/^[（(].*[）)]$/.test(l)) return false;
      if (/^[-*]\s*[（(].*[）)]$/.test(l)) return false;
      return true;
    });
  return substantiveLines.join("").trim().length > 0;
}

/**
 * 每 bot 的技能绑定（ADR 0014 D8 / docs/20 P4）：名单制，住 bot.json 的 `skills` 节。
 * 与全局停用（技能源内搬 `.disabled/`）是两层：绑定是**工作台层**的注入过滤，
 * 不动文件系统；全局停用影响所有执行器，绑定只影响这个 bot 的注入目录。
 */
export interface SkillBinding {
  /**
   * "all"（缺省）= 注入清单包含全部启用中技能（受注入预算截断）；
   * 字符串数组 = 名单制（按技能文件夹名 dirName 匹配，缺省名同目录名）。
   */
  readonly enabled: "all" | readonly string[];
}

/** 归一任何来源的技能绑定（bot.json 原始 JSON / RPC 参数 / UI 草稿） */
export function normalizeSkillBinding(raw: unknown): SkillBinding {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { enabled: "all" };
  const enabled = (raw as { enabled?: unknown }).enabled;
  if (Array.isArray(enabled) && enabled.every((x) => typeof x === "string" && x !== "")) {
    return { enabled: enabled as readonly string[] };
  }
  return { enabled: "all" };
}

/** 运行时绑定：一个工作单元可以同时挂多个工具。 */
export interface RuntimeBinding {
  readonly runtimeId: RuntimeId;
  /**
   * 该单元在此运行时下的默认模型。
   *
   * 存在的意义：**同一个执行器，不同岗位该用不同的大脑**。
   * 写公众号的bot用 Haiku 跑量，写代码的项目用 Opus —— 都是 ZCode，但不该同价。
   *
   * 它是 hint 不是命令：指向一个该 CLI 不接的模型时会被静默忽略，
   * 回落顺序是 用户所选 → 本 hint → 执行器默认。
   */
  readonly modelHint?: ModelId;
  /** 是否为该单元的主要执行器 */
  readonly primary: boolean;
}

export interface WorkUnit {
  readonly id: UnitId;
  /** 一级身份就是文件夹。绝对路径。 */
  readonly rootPath: string;
  readonly name: string;
  readonly kind: UnitKind;
  readonly identity?: WorkspaceIdentity;
  /** 自定义头像（data URL，上传时已居中裁成 96×96）。缺省 = 按名字生成的彩色头像 */
  readonly avatar?: string;
  readonly schedule?: UnitSchedule;
  readonly bindings: readonly RuntimeBinding[];
  /**
   * 上下文清单（ADR 0014）：每 bot 一份的注入决策矩阵。daemon 读时归一
   * （normalizeContextManifest），新建流写显式全关——权威在 bot.json。
   */
  readonly contextManifest?: ContextManifest;
  /** 每 bot 技能绑定（ADR 0014 D8）：注入目录的名单过滤，不影响全局停用 */
  readonly skills?: SkillBinding;
  /**
   * 工作区技能置顶名单（2026-10-23）：bot 设置的技能管理页里置顶的技能目录名。
   * 缺省 = 两个官方基础技能（agent-workbench / workbench-context）置顶——
   * init 播种的基础能力永远排最前，其余按用户置顶与名称排序。
   */
  readonly pinnedSkills?: readonly string[];
  /**
   * 本 bot 的注入预设名单（2026-10-26 指针模型 v2）：唯一事实源，第一条即
   * 「默认」（真实可编辑，不再是虚拟常量）。bot 设置与输入框的上下文胶囊
   * 两处同一份名单、同一写层；选中哪个预设，contextManifest 就镜像哪个预设
   * 的清单，开关改动直接写进当前选中的预设（自动保存）。改名/删除/新建均
   * 就地维护本名单。
   */
  readonly contextPresets?: readonly NamedContextPreset[];
  /**
   * 当前选中的预设（2026-10-23 四次定稿）：显式指针，不做内容比对——
   * "default" = 默认（Bare 全关）；预设名 = 选中该预设（之后的开关改动**就地更新
   * 该预设本体**，绝不跳回默认或自动保存）；"" / 缺省 = 未选中（改动进「自动保存」
   * 草稿槽）。注入判定永远只看 contextManifest，这个字段只是编辑面的光标。
   */
  readonly contextPresetActive?: string;
  /**
   * SOUL.md 的内容（ADR 0014 D5）。与 agentsMd 同构：不是副本的真相——真相在
   * `<rootPath>/SOUL.md`，listBots 重扫盘时读回来填这里；设置页保存直接写同一个
   * 文件。指针在、文件被删 → 空串 + UI 显示「文件缺失」。
   */
  readonly soulMd?: string;
  /** SOUL.md 的当前状态（路径 + hash 乐观锁基线，与 agentsMdMeta 同构） */
  readonly soulMdMeta?: {
    readonly path: string;
    readonly relPath: string;
    /** sha256 前 16 hex；保存时与盘上比对，不符即报冲突 */
    readonly hash: string;
    readonly mtimeMs: number;
    readonly bytes: number;
  };
  /** AGENTS.md / SKILL.md / automations 继续可用，UI 只是渲染层 */
  readonly assets: {
    readonly agentFiles: readonly string[];
    readonly skillDirs: readonly string[];
  };
  /**
   * AGENTS.md 的内容。**不是副本的真相**——真相在 `rootPath/<identity.sourcePath>` 那个文件里，
   * daemon 的 listBots 每次重扫盘时读回来填这里。所以在 VS Code 里改那个文件，下次打开
   * agent-workbench（或点重新加载）就会看到新内容；反过来设置页保存也直接写进同一个文件。
   *
   * 指针在、文件被删 → 这里是空串，UI 显示"文件缺失"而不是假装还有内容。
   */
  readonly agentsMd?: string;
  /**
   * 那个文件的当前状态。设置页要显示**路径**（用户才知道去 VS Code 改哪个文件），
   * 保存时把它当乐观锁基线传回 daemon。
   */
  readonly agentsMdMeta?: {
    readonly path: string;
    readonly relPath: string;
    /** sha256 前 16 hex；保存时与盘上比对，不符即报冲突 */
    readonly hash: string;
    readonly mtimeMs: number;
    readonly bytes: number;
  };
  /** bot.json 自增版本号（daemon 维护）。第二个乐观锁维度，抓 UI 侧并发。 */
  readonly revision?: number;
  /**
   * 记忆接入策略（对齐 waku 的记忆三柱，创建 bot 时声明）。
   * 真实运行时据此接入对应后端；原型期仅作为声明保存。
   */
  readonly memory?: {
    readonly semantic: boolean;
    readonly episodic: boolean;
    readonly procedural: boolean;
  };
  /**
   * 常驻 bot：后台服务性质（总管 / 心跳 / 用户拖进常驻区的 bot），侧栏独立
   * 分组置顶展示。合成 bot（steward/heartbeat）天生常驻；普通 bot 由用户
   * 在侧栏拖拽升降级（写穿 bot.json）。
   */
  readonly resident?: boolean;
  /**
   * 外部会话自动收录（写穿 bot.json，缺省 = 开）：daemon 周期扫描这个工作目录
   * 匹配的原生存储，把外部终端跑过、尚未认识的 CLI 会话自动落为导入行进侧栏。
   * 关闭是显式选择——关闭后仍可在「导入会话」分区手动补收。
   */
  readonly autoCollect?: boolean;
  /**
   * 合成 bot（总管 steward / 心跳 heartbeat）：系统级自建 bot，不可降级或移除常驻。
   */
  readonly synthetic?: boolean;
  /** 工作区级自定义提示词（在执行器提示词之外引导，留空不注入） */
  readonly customPrompt?: string;
  /** 软删除/已注销标记（为 true 时不出现在侧栏列表中，但磁盘数据完整保留） */
  readonly unregistered?: boolean;
  /**
   * 外联渠道（docs/08 WP-5）：IM / webhook 绑定。daemon 的渠道网关据此把
   * "消息进来 → 会话 → 回出去"接到具体 bot 上；缺省 = 纯工作台内 bot。
   */
  readonly channels?: readonly BotChannel[];
  readonly lastActiveAt?: number;
  readonly tags: readonly string[];
}

/**
 * 常驻判定：合成 bot（总管/心跳）天生常驻；普通 bot 由用户在侧栏/设置中升降级
 * （resident 字段写穿 bot.json）。steward 的 id/tags 兜底是旧数据兼容。
 */
export function isResidentUnit(u?: WorkUnit | null): boolean {
  if (!u) return false;
  if (u.resident === false) return false;
  if (u.resident === true) return true;
  return u.id === "steward" || u.id === "heartbeat" || (u.tags ?? []).includes("steward");
}

/**
 * 合成 bot（总管 / 心跳）不可取消常驻，亦不应有向普通区降级的意图。
 */
export function isSyntheticUnit(u?: WorkUnit | null): boolean {
  if (!u) return false;
  return u.synthetic === true || u.id === "steward" || u.id === "heartbeat";
}

/**
 * 项目判定（ADR 0011 弱标签）：kind 缺省按 bot 算——bot.json 手改缺字段
 * 不该把 bot 画成项目形态。侧栏分段器、⌘K 分组、Composer 占位符共用此判据。
 */
export function isProjectUnit(u?: WorkUnit | null): boolean {
  return u?.kind === "project";
}

/**
 * 侧栏与单元切换器共用的列表排序（两侧同序才好选）：常驻节在前（总管 steward
 * 最前，其余跟定义序），普通节跟用户拖拽序 —— unitOrder 未记录的单元排末尾。
 * unitOrder 由 useWorkbench 持有（会话内记忆，侧栏拖拽写入，两侧共享读取）。
 */
export function orderUnitsLikeSidebar(
  units: readonly WorkUnit[],
  unitOrder: readonly string[] | null,
): { residentUnits: WorkUnit[]; normalUnits: WorkUnit[] } {
  const residents: WorkUnit[] = [];
  const normals: WorkUnit[] = [];
  for (const u of units) (isResidentUnit(u) ? residents : normals).push(u);
  const stewardFirst = (list: WorkUnit[]): WorkUnit[] =>
    [...list].sort((a, b) => {
      const as = a.id === "steward" || (a.tags ?? []).includes("steward");
      const bs = b.id === "steward" || (b.tags ?? []).includes("steward");
      return as === bs ? 0 : as ? -1 : 1;
    });
  const orderedNormals = unitOrder
    ? stewardFirst(normals).sort(
        (a, b) => (unitOrder.indexOf(a.id) + 1 || 99) - (unitOrder.indexOf(b.id) + 1 || 99),
      )
    : stewardFirst(normals);
  return { residentUnits: stewardFirst(residents), normalUnits: orderedNormals };
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_permission"
  | "awaiting_input"
  | "failed"
  | "done";

/**
 * 会话来源。四个端是同一个 bot 的四扇窗口，来源不同**只**体现在这个字段上
 * （docs/09 §二推论 1：会话归属 bot，不归属端）——不产生第二套会话体系。
 */
export type SessionSource =
  | "workbench"
  | "mobile"
  | "feishu"
  | "telegram"
  | "weixin"
  | "discord"
  | "webhook"
  | "mcp"
  | "automation"
  /** 外部 agent 经 `aw` CLI / POST /rpc 驱动的轮次（docs/21 P4a）——与渠道同级的第五扇窗 */
  | "cli"
  /** 外部终端里跑的 CLI 会话，经「导入外部会话」收入历史（不是真实事件来源，仅台账标记） */
  | "imported"
  /** 从分享文件（session.export 导出的 bundle）导入的会话（docs/26）：跨机器传递的完整执行历史回放 */
  | "shared";

/** 来源徽标文案 —— Timeline / 历史弹窗共用（docs/13 结构化聊天恢复） */
export const SESSION_SOURCE_LABEL: Record<SessionSource, string> = {
  workbench: "工作台",
  mobile: "手机端",
  feishu: "飞书",
  telegram: "Telegram",
  weixin: "微信",
  discord: "Discord",
  webhook: "webhook",
  mcp: "MCP",
  automation: "自动化",
  cli: "CLI",
  imported: "导入",
  shared: "分享",
};

export interface Session {
  readonly id: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: RuntimeId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /**
   * 会话谱系（ADR 0012）：一条对话可跨多个执行器段（segment），每段是一个 Session，
   * 切换执行器开新段时把旧段的谱系 id 传进来。缺省 = 自身为谱系根。
   * 时间线、历史回看按谱系聚合渲染。
   */
  readonly conversationId?: string;
  /** 缺省 = 工作台 Composer 起的。IM/webhook/MCP 起的带各自标记，时间轴上显示徽标 */
  readonly source?: SessionSource;
  /** 实际生效的模型。hint 指向该 CLI 不接的模型时，这是回落后的那一个 */
  readonly modelActual?: string;
  /**
   * 被丢掉的 modelHint（docs/09 §六.1）。
   * 契约原文说它「会被静默忽略」——要补掉的正是这个静默：用户以为在用便宜模型，
   * 实际在烧贵的。非空 = 界面上必须弱提示一次。
   */
  readonly modelHintDropped?: string;
  /** 是否为项目模式下的短寿会话（worktree 隔离） */
  readonly ephemeral: boolean;
  /**
   * ADR 0012 readiness 事实（host 台账判定）：
   * live = daemon 进程内 impl 存活（可直接续聊）；
   * resumable = 有执行器原生引用（cli_ref）可接回。
   * 两者皆缺 = 仅历史（时间线可回看，新消息开新段）。缺省 = 旧 daemon / mock。
   */
  readonly live?: boolean;
  readonly resumable?: boolean;
  /**
   * 对话分叉血缘（ADR 0013）：fork 出的段指向父段 id 与父段账本 seq 上界。
   * forkKind: branch = 含锚点轮整轮（「从此处分叉」）；revision = 锚点轮之前
   * （「编辑重发」）。缺省 = 非分叉段。行创建后不可变。
   */
  readonly forkOf?: string;
  readonly forkAtSeq?: number;
  readonly forkKind?: "branch" | "revision";
  readonly worktree?: { readonly path: string; readonly branch: string };
  /**
   * 会话的实际工作目录（cwd）：普通会话 = 单元 rootPath，会话工作树 = ensure 后的
   * 工作树路径。源代码管理靠它防「删掉有活跃会话在跑的工作树」。缺省 = 旧 daemon。
   */
  readonly rootPath?: string;
  /**
   * T3 steer 待发送队列快照（daemon 权威，session.list / resume 返回时带上）。
   * 缺省 = 空（旧 daemon / 无排队）。前端打开会话时以此为初值，
   * 之后由 steer.queue 事件驱动更新。
   */
  readonly steerQueue?: readonly SteerQueueItem[];
  /**
   * 队列是否暂停：用户停止或轮失败后 daemon 不再自动出队，等显式恢复
   * （session.queue.resume）或下一条新消息（届时按 FIFO 续排）。缺省 = false。
   */
  readonly steerPaused?: boolean;
  readonly stats: SessionStats;
}

export interface SessionStats {
  readonly messages: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 估算成本（USD），用于按执行器 / 工作单元做用量统计 */
  readonly costUsd: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// 产出归档
// ---------------------------------------------------------------------------

export interface Deliverable {
  readonly id: string;
  readonly unitId: UnitId;
  readonly sessionId?: SessionId;
  readonly title: string;
  readonly kind: "file" | "diff" | "pr" | "report" | "image";
  readonly path?: string;
  readonly url?: string;
  readonly createdAt: number;
  readonly summary?: string;
}

// 注：原「附件」区（Attachment 类型 + store 的 attachments/addAttachment/removeAttachment
// + ComposerAttach 组件）已整体删除。附件面板列的是 4 个写死的假文件，加完之后
// attachments 从没进过任何执行器调用 —— 纯装饰。
// 真做附件需要两件事一起：真文件选择（Electron file dialog）+ 后端接收并交给执行器。
// 从这里重建，git log 有原形。

