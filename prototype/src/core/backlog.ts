/**
 * 待办 / GTD（backlog）—— 目标维度的时间机制，与自动化（过程维度）相对。
 *
 * 定位（2026-10 设计共识，ADR-0001/0002/0003）：
 * - 待办 = 给定目标下的 agent 自主性；定时任务 = 给定过程下的 agent 执行。
 * - 独立建表、复用 headless 执行链路；确认门（任何待办启动前必须用户明确同意）
 *   是铁规则，心跳 agent 只提议、无权启动。
 * - 状态机全落 DB（跨重启）：草稿→就绪→待确认→执行中→待验收→完成，旁路休眠。
 *
 * 本文件与 automation.ts 一样是前后端共享契约：daemon（backend/src）与 UI
 * 引用同一份类型；信号帧（BacklogSignal）经 wsd 的 backlog 帧广播，不走
 * RuntimeEvent（那些是 per-session 的，待办信号是 daemon 级的）。
 */

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

import type { LaunchMode } from "./automation.ts";

/**
 * 待办生命周期：
 *   draft → ready → awaiting_confirm → executing → awaiting_review → done
 *                                            ↘（失败回 ready）
 *                executing → blocked（结构化问人，docs/33 §2：回答后回 executing）
 *                executing → dropped（执行器判定无需处理，静默终态）
 *   任意活跃态 → sleeping（被反复忽略 / 明确拒绝 / 手动），手动唤醒回 ready
 */
export type BacklogStatus =
  | "draft"
  | "ready"
  | "awaiting_confirm"
  | "executing"
  | "blocked"
  | "awaiting_review"
  | "done"
  | "dropped"
  | "sleeping";

export const BACKLOG_STATUS_LABEL: Record<BacklogStatus, string> = {
  draft: "草稿",
  ready: "就绪",
  awaiting_confirm: "待确认",
  executing: "执行中",
  blocked: "受阻",
  awaiting_review: "待验收",
  done: "已完成",
  dropped: "无需处理",
  sleeping: "休眠",
};

/** 活跃态 = 还在生命周期里流转（清单默认视图只看这些）；dropped 是静默终态 */
export function isActiveStatus(s: BacklogStatus): boolean {
  return s !== "done" && s !== "dropped";
}

// ---------------------------------------------------------------------------
// 待办条目
// ---------------------------------------------------------------------------

/** 大小只是展示标签，不参与调度权重（共识 Q1） */
export type BacklogSize = "big" | "small";

export interface BacklogRunRef {
  readonly runId: number;
  readonly sessionId: string | null;
  /** running | done | failed | skipped（precheck 条件门拦下） */
  readonly status: string;
  readonly runtimeId: string;
  /** 谁派发的：autopilot（闲时托管）/ manual（手动立即执行）/ gtd（心跳确认后） */
  readonly trigger: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly detail: string | null;
  /** 执行结果态（docs/33 §2）：report 态或 stopReason 推断 —— ready/blocked/failed/dropped/limit/refusal */
  readonly outcome?: string | null;
  /** 执行器的一句话结果（report.summary；日报与 L1 通知的数据面） */
  readonly summary?: string | null;
  readonly model?: string | null;
  /** 用量归因 JSON（tokens/cost/duration，从会话 stats 按时间窗取） */
  readonly usageJson?: string | null;
  /** 产物深链（文件/会话） */
  readonly deliverable?: string | null;
  /** 重试指向的旧尝试（docs/33 §5 Dispatch 尝试身份） */
  readonly retryOf?: number | null;
}

/** 授权记录（docs/33 §3）：任务为什么可以被（自动）执行的凭据 */
export interface BacklogMandate {
  /** explicit = 用户亲手键入；inferred = 粘贴/渠道/GTD 等间接来源 */
  readonly strength: "explicit" | "inferred";
  /** 授权依据：typed = 键入 / pasted = 粘贴 / gtd = GTD 收录 / channel = 渠道捕获 / classifier = 分类沉淀 */
  readonly basis: string;
  readonly acceptedAt: number;
  /** observe 模式（docs/33 §3.1）：true = 本会自动跑但被观察期拦下（回看后可放行） */
  readonly wouldAutoRun?: boolean;
}

/** 派发单增量（docs/33 §3.3）：executor/model/launchMode/targetSessionId 是顶层字段 */
export interface BacklogAssignment {
  /** 记忆注入档位：minimal = MEMORY.md 语义柱（默认）；full = bot 上下文清单整套；none = 不注入记忆 */
  readonly memory?: "none" | "minimal" | "full";
  /** 附加指令：拼在任务 prompt 之后、report 约定之前 */
  readonly appendPrompt?: string;
  /** 技能白名单（bot 绑定技能时过滤注入目录；自由技能则拼进 prompt 引导） */
  readonly skills?: readonly string[];
}

export interface BacklogItem {
  readonly id: number;
  readonly title: string;
  /** 目标原话（人写的或收件箱收录的） */
  readonly goal: string;
  /** 确认后将执行的启动 prompt（目标录入时模板生成，可手改） */
  readonly prompt: string;
  /** 归属工作单元（继承其工作目录；执行时以该目录为 cwd） */
  readonly unitId: string;
  readonly unitName: string;
  readonly rootPath: string;
  /** 默认/上次使用的执行器（弹窗确认时可改选，选择会记忆回这里） */
  readonly runtimeId: string;
  readonly model: string | null;
  readonly mode: string | null;
  readonly size: BacklogSize | null;
  /** 执行方式（缺省 = terminal）：terminal / chat（对话页前台）/ headless（纯后台），见 automation.ts 的 LaunchMode */
  readonly launchMode?: LaunchMode;
  readonly status: BacklogStatus;
  /**
   * 闲时自动执行（autopilot）：true = 引擎在空闲且余量足够时**直接派发**，不进
   * 确认门，跑完自动验收 —— 清单（inbox）分类产出的任务默认 true；
   * false = 走原心跳提议 + 确认门（ADR-0001 铁规则原样保留）。
   */
  readonly auto: boolean;
  /**
   * 指定在某个已有会话里执行（接得上就 resume 发 prompt，接不上回落新开）；
   * null = 新开会话。
   */
  readonly targetSessionId: string | null;
  /** 订阅的话题指纹（docs/33 §1）：沉淀时挂源条目的 thread_key；
   *  同话题后续条目直通本任务（pendingInput 暂存），不重过分类器 */
  readonly subscriptions: readonly string[];
  /** 直通追加暂存的上下文：派发时拼进 prompt 前缀、消费即清；
   *  非空时 autoReview 不自动结案（追加没被执行过的任务不该静默关闭） */
  readonly pendingInput: string | null;
  /** 授权记录（docs/33 §3）：只记录不重验 —— observe 模式回看「它本会自动跑」的凭据 */
  readonly mandate: BacklogMandate | null;
  /** blocked 时给人的问题文本（docs/33 §2 结构化问人；回答后清空回 executing） */
  readonly attention: string | null;
  /** 派发单（docs/33 §3.3）：executor/model/launchMode/targetSessionId 在顶层字段，
   *  这里存增量 —— memory 档位 / 附加指令 / 技能白名单 */
  readonly assignment: BacklogAssignment | null;
  /** 派发前条件门命令（docs/33 §5）：非 0 退出即 skip（记 skipped run，任务留 ready） */
  readonly precheck: string | null;
  /** 连续被忽略计数：达到上限进休眠（明确拒绝直接休眠） */
  readonly ignoreCount: number;
  readonly lastProposedAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastError: string | null;
  /** 验收打回时的备注 */
  readonly reviewNote: string | null;
  /** manual = UI 录入；inbox = GTD.md 收件箱统合收录 */
  readonly source: "manual" | "inbox";
  /** 手动排序位（小在前）——顺序即优先级 */
  readonly sortPos: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 最近一次运行（卡片展示用） */
  readonly lastRun: BacklogRunRef | null;
  /** 历史运行总次数（推进面板「跑过 N 次」） */
  readonly runCount: number;
}

// ---------------------------------------------------------------------------
// 余量（订阅执行器的窗口可用量）
// ---------------------------------------------------------------------------

export type HeadroomSource = "probe" | "ledger" | "unknown";

export interface QuotaHeadroom {
  readonly runtimeId: string;
  readonly subscribed: boolean;
  /** 剩余百分比 0..100；null = 未知（探针失败且无账本兜底） */
  readonly percent: number | null;
  readonly resetsAt: number | null;
  /** 一行摘要（探针原文要点 / 账本估算口径），弹窗与状态页显示 */
  readonly summary: string | null;
  readonly source: HeadroomSource;
  readonly checkedAt: number | null;
}

// ---------------------------------------------------------------------------
// 提议（心跳 → 用户的确认门）
// ---------------------------------------------------------------------------

export interface BacklogProposal {
  readonly id: string;
  readonly itemId: number;
  readonly title: string;
  readonly prompt: string;
  /** 心跳 agent 写的提议理由（用户看的第一行话） */
  readonly message: string;
  /** 余量够不够完成目标的一句话预估（心跳 agent 的判断） */
  readonly estimate: string | null;
  readonly suggestedRuntimeId: string | null;
  /** 提议时刻的余量快照（确认弹窗里的执行器选择依据） */
  readonly quotas: readonly QuotaHeadroom[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// 总状态（全局工作状态机，右上角状态点）
// ---------------------------------------------------------------------------

/**
 * 工作中 → 空闲 →（周期到）跳动中 →（有心跳产出）待确认 →（确认）执行中
 * →（跑完）待验收 →（验收通过/打回）回空闲/就绪。
 * forceBusy 压倒一切自动判定。
 */
export type WorkPhase =
  | "busy"
  | "idle"
  | "beating"
  | "awaiting_confirm"
  | "executing"
  | "awaiting_review";

export const WORK_PHASE_LABEL: Record<WorkPhase, string> = {
  busy: "工作中",
  idle: "空闲",
  beating: "心跳中",
  awaiting_confirm: "待确认",
  executing: "执行中",
  awaiting_review: "待验收",
};

export interface BacklogStateSnapshot {
  readonly phase: WorkPhase;
  /** 一句话判定依据（状态点详情里显示） */
  readonly reason: string;
  /** 用户最近活动（非 automation 来源会话的活动口径） */
  readonly lastUserActivityAt: number;
  /** 空闲判定阈值（分钟，配置值） */
  readonly idleMinutes: number;
  readonly forceBusy: boolean;
  readonly heartbeatEnabled: boolean;
  readonly nextBeatAt: number | null;
  readonly lastBeatAt: number | null;
  /** 上一次心跳的结果：proposed / silence / no-candidates / skipped:<原因> / failed:<原因> */
  readonly lastBeatOutcome: string | null;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
  readonly enabled: boolean;
  /** 心跳周期（分钟） */
  readonly intervalMinutes: number;
  /** 空闲判定：距用户最近活动 ≥ N 分钟 */
  readonly idleMinutes: number;
  /** 提议超时（分钟）：超时视为本次忽略 */
  readonly proposalTimeoutMinutes: number;
  /** 连续忽略上限：达到即休眠 */
  readonly maxIgnoreCount: number;
  /** 心跳会话跑在哪个执行器上（用户可指到有冗余的订阅执行器 —— 以烧 token 为目的） */
  readonly runtimeId: string;
  readonly model: string | null;
  /** 为**未打勾**（非 auto）的就绪任务弹提议（旧确认门流程）。默认关：
   * 打勾模型是主流程 —— 取消勾 = 不执行也不打扰；想恢复旧的提议-确认门再打开。 */
  readonly proposeNonAuto: boolean;
}

export type ProbeFormat = "zcode-quota" | "mmx-json" | "raw";

export interface RuntimeQuotaConfig {
  readonly subscribed: boolean;
  /** 余量探针命令（本机 shell 执行）；null = 无探针，走账本估算 */
  readonly probeCmd: string | null;
  readonly probeFormat: ProbeFormat;
  /** 账本估算兜底：滚动窗口时长（小时） */
  readonly windowHours: number;
  /** 账本估算兜底：窗口内请求数上限；null = 不估（只显示计数） */
  readonly limit: number | null;
}

export interface BacklogConfig {
  readonly heartbeat: HeartbeatConfig;
  /** 订阅执行器余量配置（runtimeId → 配置） */
  readonly runtimes: Readonly<Record<string, RuntimeQuotaConfig>>;
  /** 用量耗尽自动续跑：恢复后自动往撞墙的那个对话里发一句「继续」 */
  readonly quotaResume: QuotaResumeConfig;
  /** 每日收件箱统合：atMinutes = 一天内的分钟数（22:00 = 1320） */
  readonly consolidate: { readonly enabled: boolean; readonly atMinutes: number };
  /** 飞书出站：提议与结果通知发到哪个机器人/会话 */
  readonly feishu: {
    readonly enabled: boolean;
    readonly botId: string;
    readonly accountId: string;
    readonly receiveId: string;
    /** 确认会话消息进清单（docs/33 §1.4 渠道候选准入）：开 = 该会话消息成为
     *  清单条目（thread_key=feishu:<chat>，走分类）；关 = 仅话题直通生效（同话题
     *  追加仍直达任务），其余消息照常进 bot 聊天 —— 默认关，不改变现有行为 */
    readonly inboxCapture: boolean;
  };
  /**
   * 闲时自动执行（autopilot）——「用量还有富余就持续把清单做完」的引擎面：
   * 空闲（无运行会话 + 超过空闲阈值）且余量 ≥ 阈值时，直接派发下一条
   * ready + auto 的待办，不进确认门；跑完自动验收。
   */
  readonly autopilot: AutopilotConfig;
}

export interface AutopilotConfig {
  readonly enabled: boolean;
  /** 同时在跑的自动任务上限（1 = 单飞，与心跳时代的执行纪律同口径） */
  readonly maxConcurrent: number;
  /** 余量地板：执行器剩余百分比低于此值不再派发（探针读数 null = 放行） */
  readonly headroomFloorPercent: number;
  /** 跑完自动验收（true = done；false = 仍进待验收，人工过目） */
  readonly autoReview: boolean;
}

/**
 * 用量耗尽自动续跑（QuotaResume）。
 *
 * 订阅执行器的 5 小时窗口被打满时，会话多半停在半路。等窗口重置后自动发一句
 * 「继续」，agent 就在**原来那个对话**里接着干 —— 不新开对话，上下文不丢。
 *
 * 开关口径：`runtimes[id].subscribed` 才是真正的用户意图（用户自己勾的订阅制），
 * 这里只是说「对勾了的执行器要不要顺带自动排续跑」。默认开 —— 续跑是派一条
 * 一次性的定时消息，后果可控；而默认关的话这个功能会安静地不工作，用户看不出原因。
 */
export interface QuotaResumeConfig {
  readonly enabled: boolean;
  /** 剩余百分比 ≤ 此值即判「用尽」，开始排续跑。默认 2 —— 避开 0% 边界抖动 */
  readonly exhaustedPercent: number;
  /** 恢复后等几分钟再发（配额系统往往不是整点立刻生效，留一分钟余量） */
  readonly delayMinutes: number;
  /** 发出去的那句话 */
  readonly message: string;
  /** 只盯这几个执行器；null = 盯全部 subscribed 的 */
  readonly runtimes: readonly string[] | null;
}

/** 提议/结果通知的飞书出站默认关：出站地址是用户环境的事实，得他填 */
export const DEFAULT_BACKLOG_CONFIG: BacklogConfig = {
  heartbeat: {
    enabled: false,
    intervalMinutes: 30,
    idleMinutes: 10,
    proposalTimeoutMinutes: 10,
    maxIgnoreCount: 3,
    runtimeId: "",
    model: null,
    proposeNonAuto: false,
  },
  // zcode / mcode 是本机实测过的订阅执行器（zcode quota 由用户自加，mmx 自带），
  // 预置好探针命令，其余执行器由用户按需补
  runtimes: {
    zcode: { subscribed: true, probeCmd: "zcode quota", probeFormat: "zcode-quota", windowHours: 5, limit: null },
    mcode: { subscribed: true, probeCmd: "mmx quota show --output json", probeFormat: "mmx-json", windowHours: 5, limit: null },
  },
  consolidate: { enabled: true, atMinutes: 22 * 60 },
  quotaResume: {
    enabled: true,
    exhaustedPercent: 2,
    delayMinutes: 1,
    message: "用量窗口已恢复，请接着刚才中断的工作继续推进。",
    runtimes: null,
  },
  feishu: { enabled: false, botId: "steward", accountId: "main", receiveId: "", inboxCapture: false },
  // autopilot 默认开（maxConcurrent=1 单飞）：这是 personal agent 的核心定位 ——
  // 有闲置用量就持续把清单做完；开关在待办设置里随时可关。
  autopilot: { enabled: true, maxConcurrent: 1, headroomFloorPercent: 10, autoReview: true },
};

// ---------------------------------------------------------------------------
// 信号（daemon → 前端的 backlog 帧）
// ---------------------------------------------------------------------------

export type BacklogSignal =
  | { readonly kind: "proposal"; readonly proposal: BacklogProposal }
  | {
      readonly kind: "settled";
      readonly proposalId: string;
      readonly itemId: number;
      readonly decision: "confirmed" | "rejected" | "expired";
    }
  | { readonly kind: "state"; readonly snapshot: BacklogStateSnapshot }
  /** 清单数据变了（前端重拉 backlog.list） */
  | { readonly kind: "items" }
  | { readonly kind: "notice"; readonly level: "info" | "warn" | "success"; readonly text: string };

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 录入时只写目标，prompt 草稿由模板生成（共识 Q1c：可后续手改） */
export function draftPromptOf(goal: string): string {
  return `目标：${goal}\n\n请先给出简短计划，然后规划并执行。完成后汇报：做了什么、产出在哪、如何验证。`;
}

/** 相对时间描述（与 automation.ts 的 formatRelative 同风格） */
export function formatBacklogRelative(target: number, from = Date.now()): string {
  const diff = target - from;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "后" : "前";
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.round(abs / 3_600_000);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.round(abs / 86_400_000);
  if (day < 30) return `${day} 天${suffix}`;
  return new Date(target).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
