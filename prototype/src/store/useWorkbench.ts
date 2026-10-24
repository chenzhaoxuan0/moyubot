import { create } from "zustand";
import type { Automation } from "../core/automation.ts";
import { canRuntimeUse, modelById, type ModelId, type ModelSpec } from "../core/models.ts";
import type { PermissionMode } from "../core/permission.ts";
import type {
  LoopParams,
  MemoryInjectionOptions,
  PermissionDecision,
  RuntimeAdapter,
} from "../core/adapter.ts";
import type { RuntimeEvent, SteerQueueItem } from "../core/events.ts";
import {
  asModelId,
  asRuntimeId,
  asSessionId,
  asUnitId,
  normalizeContextManifest,
  resolveEffectiveTurnManifest,
  LEGACY_CONTEXT_MANIFEST,
  type ContextManifest,
  type Deliverable,
  type Session,
  type SessionId,
  type SessionStatus,
  type TurnContextConfig,
  type UnitId,
  type WorkUnit,
} from "../core/units.ts";
import type { AutomationWriteInput, DaemonSessionRow } from "../adapters/daemon/client.ts";
import {
  normalizePrefs,
  parsePrefsMap,
  prefsOf,
  pruneEmptyPrefs,
  resolveVisibleModels,
  type ModelPrefsMap,
  type ProviderModelPrefs,
} from "../core/modelPrefs.ts";
import { runtimeRegistry, type RuntimeEntry } from "../core/registry.ts";
import { useHistoryPrefs } from "./useHistoryPrefs.ts";
import { useSidePane } from "./useSidePane.ts";
import type {
  ChannelIdentityMap,
  LarkBotIdentity,
  ModelSyncReport,
} from "../adapters/daemon/client.ts";

// 注册执行器：见文件末尾的 bootstrap（优先本地 daemon，回退 mock）。
// [BISECT] sync mock disabled

export type ViewMode = "bot" | "project";

/**
 * 执行器实例偏好 —— 对齐 T3 ProviderInstanceCard 的可编辑面：
 * 启用开关、显示名覆盖、端点覆盖、启动参数、环境变量、最近探测时间。
 */
export interface RuntimePref {
  readonly enabled: boolean;
  readonly displayName?: string;
  readonly endpoint?: string;
  readonly launchArgs?: string;
  readonly envVars?: readonly { key: string; value: string }[];
  readonly lastCheckedAt?: number;
}

/** agent loop 参数 —— 每执行器各记一份；未设置的位用默认值（见 run）
 *  ⚠ 不含采样参数（temperature/top_p）：zcode 协议无此位、codex 透传未证实被尊重，
 *  无效参数不进界面 —— 未来某家 CLI 真支持了再加回来。 */
export interface LoopParamsState {
  mode?: LoopParams["mode"];
  reasoningLevel?: string;
  /** 上下文长度档（执行器侧原始 value）：仅 CLI 声明了可选档的执行器出现在界面 */
  contextLength?: string;
}

const LOOP_PARAMS_KEY = "agent-workbench:loop-params";

function readLoopParams(): Record<string, LoopParamsState> {
  try {
    const raw = localStorage.getItem(LOOP_PARAMS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, LoopParamsState>);
  } catch {
    return {};
  }
}

/** 时间线条目：归一化事件 + 序号 + 时间戳。UI 唯一消费的会话数据形状 */
export interface TimelineItem {
  readonly id: number;
  readonly event: RuntimeEvent;
  readonly at: number;
}

/** 上下文容量徽标的数据面：最近一次 usage 事件的裸值 */
export interface UsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model: string;
  readonly at: number;
}

interface WorkbenchState {
  units: readonly WorkUnit[];
  /**
   * daemon 连接态（启动竞态的可见化）：pnpm dev 下 vite 页面先出、daemon 后就绪是
   * 常态，窗口期侧栏/设置页全是空的且无任何提示。文件末尾的 bootstrap 重试循环把
   * 自己的进度写进这里——connecting 时 app.tsx 盖一层启动视图，offline 时底栏挂
   * 常驻徽标（不挡操作，app 仍可浏览）。connected 后不再回退：会话中断线走各
   * rpc 的按需重连，不归启动态管。
   */
  daemonStatus: "connecting" | "connected" | "offline";
  activeUnitId: UnitId;
  /**
   * 侧栏普通节的拖拽排序（会话内记忆，不持久化）。放 store 是为了让单元
   * 切换器弹层读到同一份顺序——两侧同序才好选（orderUnitsLikeSidebar 消费）。
   */
  unitOrder: readonly string[] | null;
  runtimes: readonly RuntimeEntry[];
  activeRuntimeId: string;
  /**
   * 每个执行器各自记住一个模型：`runtimeId → ModelId`。
   *
   * 刻意**不存全局单一模型**。全局那个在切执行器时必然出现非法组合：
   * ZCode 选了 claude-sonnet-5，切到 Codex 后它根本不接 Anthropic 的模型。
   * 各存各的，切回来时你上次选的那个还在。
   */
  runtimeModels: Readonly<Record<string, ModelId>>;
  /**
   * 每个 CLI 各自的模型偏好（隐藏 / 排序 / 收藏 / 自定义模型）。
   * 对齐 T3code 的 `providerModelPreferences` + `customModels`。
   */
  modelPrefs: ModelPrefsMap;
  /** 偏好变更计数。偏好对象每次都是新的，effect 要个稳定的触发源 */
  modelPrefsVersion: number;
  /** 工作台发起的会话（daemon 侧的权威列表走 session.* RPC，这里是运行态视图） */
  sessions: readonly Session[];
  activeSessionId: SessionId | null;
  /** 每执行器的 agent loop 参数（mode/reasoning），localStorage 持久化 */
  loopParams: Record<string, LoopParamsState>;
  setLoopParam: (runtimeId: string, patch: Partial<LoopParamsState>) => void;
  timeline: readonly TimelineItem[];
  deliverables: readonly Deliverable[];
  busy: boolean;
  /**
   * 每会话 steer 待发送队列快照（daemon 权威）：steer.queue 事件驱动更新，
   * openSession 时从回放重建。队列 UI 只读这份，不做增量对账。
   */
  steerQueues: Readonly<Record<string, { items: readonly SteerQueueItem[]; paused: boolean }>>;
  /**
   * 每会话最近一次 usage 事件（上下文容量徽标的数据面）。
   * 「当前上下文占用」的近似值 = 最近一轮 input + 缓存读 + output ——
   * 每轮 input 都含全部历史，累计求和会严重高估，绝不能加总。
   */
  usageBySession: Readonly<Record<string, UsageSnapshot>>;
  /**
   * 输入历史（终端 ↑↓ 语义，Composer 用）：时间升序、末尾 = 最新一条。
   * 本端提交即追加（run 入口）；打开会话时按账本回放整段重建。
   * 连续重复去重，上限 200 条。
   */
  inputHistory: readonly string[];
  /** 输入框草稿。空态建议卡片点一下就能预填 */
  draft: string;
  /** 已裁决的权限请求：requestId → 决策。用于把权限卡切成「已处理」态 */
  permissionDecisions: Readonly<Record<string, string>>;
  /** 本次运行的权限模式（composer 右侧常驻） */
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  /**
   * 改某个 bot 的上下文清单（ADR 0014）：patch 合并进归一后的 manifest 后写穿
   * bot.json。注入开关的真相源自此在前端移除——旧的全局 memoryScopes 态退役，
   * 快捷开关（记忆选择器 / Context 面板）都走这一条路，渠道会话天然同步。
   */
  patchUnitContext: (unitId: UnitId | string, patch: Partial<ContextManifest>) => Promise<void>;
  /**
   * 按 bot 写任意定义字段（2026-10-23，预设指针等小写的统一通道）：fresh 读取 +
   * 三锁 + **冲突自愈**（store 锁基线过期时拉盘上真值重试一次——与 patchUnitContext
   * 同款；没有自愈的直写路径在基线过期时会「点了又弹回」）。silent 模式不弹通知，
   * 由调用方自行处理/吞掉。
   */
  putUnitFields: (unitId: UnitId | string, fields: Partial<WorkUnit>, opts?: { silent?: boolean }) => Promise<void>;
  /** 自愈写骨架（writeUnitWithHeal 的声明面；实现内部共用） */
  writeUnitWithHeal: (unitId: UnitId | string, build: (u: WorkUnit) => WorkUnit) => Promise<void>;
  /**
   * 输入框当前的单轮/临时上下文注入配置——**当前 bot 的视图**。真相在
   * turnContextByUnit（按 bot 记忆，2026-10-23：切走再切回保持原选择，
   * 不再重置回跟随预设）；写入永远走 setTurnContextConfig / resetTurnContextConfig。
   */
  turnContextConfig: TurnContextConfig;
  /** 每 bot 的临时注入配置（记忆面；视图 turnContextConfig 永远等于本表里 activeUnit 的条目） */
  turnContextByUnit: Record<string, TurnContextConfig>;
  setTurnContextConfig: (config: Partial<TurnContextConfig> | ((prev: TurnContextConfig) => TurnContextConfig)) => void;
  resetTurnContextConfig: () => void;
  pushNotice: (
    title: string,
    text: string,
    options?: { level?: "info" | "success" | "warn"; meta?: Readonly<Record<string, string>> },
  ) => void;
  /** 执行器实例偏好（T3 Providers 页逻辑：启用开关 / 覆盖 / 环境变量） */
  runtimePrefs: Readonly<Record<string, RuntimePref>>;
  setRuntimePref: (id: string, patch: Partial<Omit<RuntimePref, "enabled">> & { enabled?: boolean }) => void;
  /** 全量重探测（T3 的 Checked 刷新） */
  probeAll: () => Promise<void>;
  /**
   * 重新探测模型清单（设置页第二个按钮）。
   *
   * 与 probeAll 分开是刻意的：执行器探测只回答「装没装、版本多少」，模型刷新只回答
   * 「能用哪些模型、上下文窗口多少」。两者耗时差一个量级（后者要起 CLI），
   * 混在一个按钮里用户既不知道在等什么，也说不清列表为什么变了。
   */
  syncModelsAll: () => Promise<void>;
  /** 模型刷新进行中（按钮转圈 / 禁重复点） */
  syncingModels: boolean;
  /** 最近一次模型刷新的结果。report 里 source=static 的那些 = 没刷到，用的是内置兜底 */
  modelSync: { readonly at: number; readonly report: readonly ModelSyncReport[]; readonly error?: string } | null;
  /**
   * `lark-cli profile → 那个 profile 是哪个飞书机器人`（应用名 + 头像）。
   *
   * 没有它，侧栏只能显示一个通用图标 + 设置页只能显示一串 cli_xxx —— 用户
   * 无法判断哪个 bot 接的是哪个飞书机器人，而这正是「每 bot 一个机器人」的前提。
   */
  channelIdentity: ChannelIdentityMap;
  /**
   * 拉取机器人身份。不传 profiles = 问盘上所有已启用飞书账号（侧栏用）；
   * 传了 = 只认这几个（设置页正在配、还没保存的草稿 profile）。
   * 失败不抛：认不出来是常态，界面要显示「认不出来 + 原因」而不是空白。
   */
  refreshChannelIdentity: (profiles?: readonly string[]) => Promise<void>;

  setUnitOrder: (order: readonly string[]) => void;
  selectUnit: (id: UnitId) => void;
  addUnit: (u: WorkUnit, opts?: { createRoot?: boolean }) => Promise<void>;
  /**
   * 改已有单元（bot 设置页保存）。按 id 替换，不切 activeUnitId，同样写穿 bot.json
   * 与 AGENTS.md。guards 传进入设置页时看到的 revision / AGENTS.md hash 作乐观锁基线。
   *
   * 盘上在这期间被改过（VS Code 改了文件 / 另一个窗口保存）时**抛 code="conflict"**，
   * 且不会写盘——调用方负责弹「覆盖 / 重新加载 / 取消」。
   */
  updateUnit: (u: WorkUnit, guards?: BotWriteGuards) => Promise<void>;
  /**
   * 重拉某个单元的定义（settings 面板的「重新加载」）。daemon 无缓存，每次都重扫盘，
   * 所以这能拿到用户在 VS Code 里改完的 AGENTS.md 新内容。
   */
  reloadUnit: (id: UnitId) => Promise<WorkUnit | null>;
  /** 从工作台注销/软删除 Bot（不删除磁盘物理项目文件和代码） */
  unregisterUnit: (id: UnitId) => Promise<void>;
  /** 幂等初始化/补充工作区标准技能目录与记忆结构 */
  initWorkspace: (rootPath: string) => Promise<{ created: string[]; existed: string[] }>;
  selectSession: (id: SessionId | null) => void;
  /** 切换执行器。返回是否成功 —— 门禁（本轮未落定）时拒绝并推 notice（ADR 0012） */
  selectRuntime: (id: string) => boolean;
  /**
   * 携带上文切换（ADR 0012，opt-in，默认关）：开新段时把上一段的最近对话
   * 以只读转录前缀交给新执行器（有损、透明 —— 会成为其首条消息的一部分）。
   */
  handoffOnSwitch: boolean;
  setHandoffOnSwitch: (on: boolean) => void;
  /**
   * 对话分叉意图（ADR 0013 + docs/18 §〇 细化决议）：非空 = 下一次发送将在
   * 锚点轮边界开分叉段。「意图 + 发送才建段」—— 点「从此时分叉」/「编辑重发」
   * 只设意图（revision 顺带把锚点原文预填草稿），取消零持久化（台账无新行）。
   */
  pendingFork: {
    readonly ofSessionId: SessionId;
    readonly anchorMessageId: string;
    readonly kind: "branch" | "revision";
    /** 锚点轮的用户原文（编辑重发的草稿回填与提示条摘要用） */
    readonly anchorText?: string;
  } | null;
  /** 进入分叉意图态（源段粒度的 idle 门禁由调用方把关） */
  startFork: (intent: {
    ofSessionId: SessionId;
    anchorMessageId: string;
    kind: "branch" | "revision";
    anchorText?: string;
  }) => void;
  /** 放弃分叉意图 —— 零持久化 */
  cancelFork: () => void;
  /**
   * 编辑重发（就地编辑形态，参考 ZCode editUserQuery 的交互心智）：在用户消息
   * 原位编辑并点重发 —— revision 分叉意图 + 立即发送，不经过 composer 意图条。
   * 发送失败时意图保留（composer 提示条兜底可见可取消）。
   */
  editAndResend: (input: {
    ofSessionId: SessionId;
    anchorMessageId: string;
    text: string;
  }) => Promise<void>;
  /**
   * 在聊天页打开一个历史会话（ADR 0012 resume-in-chat）：
   * 从 daemon 账本重建时间线；会话可恢复（live / cli_ref）时接回执行器续聊，
   * 仅历史时打开只读视图 —— 新消息将在同一谱系开新段。
   */
  openSession: (input: { sessionId: SessionId; unitId: UnitId; runtimeId: string }) => Promise<void>;
  /** 换模型。非法组合（该执行器不接这个模型）静默拒绝，不改状态 */
  selectModel: (model: ModelId) => void;
  /** 改某个 CLI 的模型偏好。动作原子，不合法的输入原样返回由调用方处理 */
  setModelPrefs: (runtimeId: string, next: ProviderModelPrefs) => void;
  /** 批量入口：给一组动作依次应用，任一步失败则整组不动 */
  applyModelPrefs: (runtimeId: string, steps: readonly ((p: ProviderModelPrefs) => ProviderModelPrefs)[]) => void;
  setDraft: (v: string) => void;
  /** 发一条消息：活跃会话续聊，否则 startSession 开新会话（详见实现注释） */
  run: (
    prompt: string,
    opts?: {
      memoryOptions?: MemoryInjectionOptions;
      attachments?: readonly import("../core/attachments.ts").ChatAttachment[];
      /**
       * 在指定工作树里开**新会话**（源代码管理面板「在此工作树启动会话」）。
       * 给了它就跳过续聊判定 —— 工作树会话永远是新开的，daemon 侧负责
       * ensure（不存在则按 branch 创建）。
       */
      worktree?: { path: string; branch: string };
    },
  ) => Promise<void>;
  /** 停止当前运行 */
  cancelRun: () => void;
  /** 立刻发送一条排队消息：取消当前轮，轮落定后这条优先进去 */
  sendQueuedNow: (id: string) => Promise<void>;
  /** 删除一条排队消息（不回填输入框） */
  removeQueuedSend: (id: string) => Promise<void>;
  /** 编辑排队消息：先删（daemon 权威面）再把文本放回输入框；输入框有草稿时拒绝 */
  editQueuedSend: (id: string) => Promise<void>;
  /** 恢复暂停的待发送队列（用户停止/轮失败后不再自动出队） */
  resumeQueuedSends: () => Promise<void>;
  resolvePermission: (requestId: string, decision: PermissionDecision) => void;
  /**
   * 定时任务 —— 权威数据在 daemon（SQLite），这里只是运行态视图。
   * 每个动作都「先调 daemon、成功后刷新」，失败在 automationNotice 里说实话。
   */
  automations: readonly Automation[];
  /** 页面级通知（操作成败的一行实话）。null = 无 */
  automationNotice: { readonly kind: "error" | "info"; readonly text: string } | null;
  setAutomationNotice: (n: { readonly kind: "error" | "info"; readonly text: string } | null) => void;
  /** 从 daemon 重拉全量（启动、页面挂载、每次写操作之后） */
  refreshAutomations: () => Promise<void>;
  toggleAutomation: (id: string) => Promise<void>;
  createAutomationAction: (input: AutomationWriteInput) => Promise<boolean>;
  updateAutomationAction: (id: string, patch: AutomationWriteInput) => Promise<boolean>;
  deleteAutomationAction: (id: string) => Promise<void>;
  runAutomationNowAction: (id: string) => Promise<void>;
  /** 从 daemon 重新拉取并合并全量 Agent 机器人列表 */
  refreshUnits: () => Promise<void>;
}

/* ------------------------------------------------------------------ 模型偏好 */

/** 某个 CLI 适配器**声明**的内置模型（不含用户自定义）。
 *  ⚠ 未注册时的兜底必须是**稳定引用**的空数组：返回字面量 [] 会让
 *  visibleModelsFor 的缓存永不命中 → getSnapshot 每次新数组 →
 *  React 19 无限循环白屏（registry 异步装填的首个渲染窗口必踩）。 */
const EMPTY_MODELS: readonly ModelSpec[] = [];

function declaredOf(s: WorkbenchState, runtimeId: string): readonly ModelSpec[] {
  return s.runtimes.find((r) => r.id === runtimeId)?.models ?? EMPTY_MODELS;
}

/**
 * 某个 CLI 在选择器里**实际可选**的模型：声明 + 自定义 − 隐藏，再按偏好排序。
 * 可见性判定的唯一入口 —— 设置页、选择器、自检共用它，避免各写一套又漂移。
 *
 * ⚠⚠ 这里**必须**做引用记忆，返回稳定的数组。理由比一般情况更硬：
 * 自定义模型每次都由 `customToSpec` 现造一个新对象，所以数组里的元素
 * 引用每次都变。`useShallow` 逐元素比引用 → 永远不相等 → 缓存永不命中
 * → React 19 判为无限循环（"getSnapshot should be cached"）。
 * 这个坑在无自定义模型时看不见，一添加自定义模型立刻炸。
 *
 * 判据用**输入的引用**（declared / prefs 都是稳定来源），一次比较即可。
 *
 * 缓存按 runtimeId 分槽（Map）。曾经是单槽：只要渲染期间有第二个
 * runtime 来查一遍清单（比如选择器 rail 标题里的计数），订阅者的缓存槽
 * 就被踩掉，getSnapshot 下一次返回新数组 → React 19 无限循环 → 白屏。
 * 多槽后每个订阅者各占各的槽位，互不踩踏。
 */
let modelsMemo = new Map<string, { declared: readonly ModelSpec[]; prefs: ProviderModelPrefs; out: readonly ModelSpec[] }>();

export function visibleModelsFor(s: WorkbenchState, runtimeId: string): readonly ModelSpec[] {
  const declared = declaredOf(s, runtimeId);
  const prefs = prefsOf(s.modelPrefs, runtimeId);
  const hit = modelsMemo.get(runtimeId);
  if (hit && hit.declared === declared && hit.prefs === prefs) return hit.out;
  const out = resolveVisibleModels(declared, prefs);
  modelsMemo.set(runtimeId, { declared, prefs, out });
  return out;
}


const PREFS_KEY = "agent-workbench:model-prefs";

function readPrefs(): ModelPrefsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? parsePrefsMap(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function persistPrefs(map: ModelPrefsMap): void {
  try {
    // 只存非空的，空偏好不留痕 —— 否则 localStorage 里会堆一堆 `{}`
    const pruned = pruneEmptyPrefs(map);
    if (Object.keys(pruned).length === 0) window.localStorage.removeItem(PREFS_KEY);
    else window.localStorage.setItem(PREFS_KEY, JSON.stringify(pruned));
  } catch {
    /* ignore */
  }
}

/** 写盘乐观锁基线：进入设置页时看到的盘上真值 */
export interface BotWriteGuards {
  readonly ifRevision?: number;
  readonly ifAgentsMdHash?: string;
  /** SOUL.md 内容 hash 乐观锁（ADR 0014 D5，与 ifAgentsMdHash 同构） */
  readonly ifSoulMdHash?: string;
}

/** daemon 判定"盘上已被改过"时的错误码。前端据此弹三选一而不是静默覆盖。 */
export const BOT_CONFLICT = "conflict";

/**
 * 这个单元上所有**启用中**的飞书 profile。
 *
 * 停用的不算：它现在接不到消息，界面上也不该显示一个机器人头像，
 * 否则用户会以为「这个 bot 归它管」，而实际上消息根本不会来。
 */
export function feishuProfilesOf(unit: WorkUnit): readonly string[] {
  const out: string[] = [];
  for (const ch of unit.channels ?? []) {
    if (ch.kind !== "feishu" || ch.enabled !== true) continue;
    for (const acc of ch.accounts ?? []) {
      const p = (acc.profile ?? "").trim();
      if (p !== "") out.push(p);
    }
  }
  return out;
}

/** 写盘成功后把 daemon 回的 revision 写回 state——否则下次保存会拿旧基线撞自己。 */
function applyPutResult(
  set: (fn: (s: WorkbenchState) => Partial<WorkbenchState>) => void,
  _get: () => WorkbenchState,
  unitId: string,
  res: unknown,
): void {
  const revision = (res as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "number") return;
  set((s) => ({
    units: s.units.map((x) => (x.id === unitId ? { ...x, revision } : x)),
  }));
}

/** 时间线序号 —— 全局递增，pushUserBubble / pushNotice / 事件泵共用 */
let seq = 0;

/** 会话被用户打开/发送即视为「已读」—— 侧栏「完成未读」绿灯据此熄灭 */
function markSessionViewed(id: SessionId | string): void {
  useHistoryPrefs.getState().markViewed(`session-${String(id)}`);
}

function getInitialActiveUnit(): UnitId {
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("unit");
      if (q) {
        localStorage.setItem("agent-workbench:active-unit", q);
        return asUnitId(q);
      }
      const stored = localStorage.getItem("agent-workbench:active-unit");
      if (stored) return asUnitId(stored);
    } catch {}
  }
  return asUnitId("");
}

/** 临时注入配置的默认态（跟随 bot 预设） */
const DEFAULT_TURN_CONFIG: TurnContextConfig = { mode: "bot_default", persistForSession: false };

/**
 * 临时注入配置双写（2026-10-23 按 bot 记忆）：视图 turnContextConfig + 记忆表
 * turnContextByUnit[activeUnitId] 同步落——切走再切回时从记忆表恢复，
 * 不再重置回「跟随预设」。
 */
function writeTurnConfig(
  set: (partial: Partial<WorkbenchState> | ((s: WorkbenchState) => Partial<WorkbenchState>)) => void,
  get: () => WorkbenchState,
  cfg: TurnContextConfig,
): void {
  const key = String(get().activeUnitId ?? "");
  set((s) => ({
    turnContextConfig: cfg,
    turnContextByUnit: key !== "" ? { ...s.turnContextByUnit, [key]: cfg } : s.turnContextByUnit,
  }));
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  // 评审后清 mock（用户指示）：初始全空，一切数据来自真实 daemon——
  // 空态是设计的一部分（ZCode 原则：功能不因空而消失），不再用样例数据撑门面
  units: [],
  daemonStatus: "connecting",
  activeUnitId: getInitialActiveUnit(),
  unitOrder: null,
  runtimes: [],
  activeRuntimeId: "zcode",
  // 注册表订阅到位后由下方 subscribe 补齐各执行器的默认模型
  runtimeModels: {},
  syncingModels: false,
  modelSync: null,
  modelPrefs: readPrefs(),
  modelPrefsVersion: 0,
  sessions: [],
  activeSessionId: null,
  loopParams: readLoopParams(),
  timeline: [],
  deliverables: [],
  busy: false,
  steerQueues: {},
  usageBySession: {},
  inputHistory: [],
  draft: "",
  permissionDecisions: {},
  permissionMode: "bypass",

  setDraft: (draft) => set({ draft }),

  setPermissionMode: (permissionMode) => set({ permissionMode }),

  /** 自愈写骨架：fresh 读取 → 三锁写 → 冲突时拉盘上真值重试一次（两条写路径共用） */
  writeUnitWithHeal: async (
    unitId: UnitId | string,
    build: (u: WorkUnit) => WorkUnit,
  ): Promise<void> => {
    const apply = async (): Promise<void> => {
      const u = get().units.find((x) => x.id === unitId);
      if (u === undefined) return;
      // 三锁全带（Sidebar guardsOf 同款）：部分更新会带着 store 缓存的 agentsMd/soulMd
      // 正文走 putBot，只锁 revision 的话，期间 VS Code 里改过的文件会被静默覆盖。
      await get().updateUnit(build(u), {
        ifRevision: u.revision,
        ifAgentsMdHash: u.agentsMdMeta?.hash,
        ifSoulMdHash: u.soulMdMeta?.hash,
      });
    };
    try {
      await apply();
    } catch (err: unknown) {
      // 冲突自愈（2026-10-23 修「点了又弹回」）：store 的锁基线可能落后于盘上
      // （他端 putBot / 长开窗口的旧快照 / applyPutResult 不刷文件 meta）。小字段的
      // 高频写冲突时拉一次盘上真值、用新基线重试一次。
      const code = (err as { code?: string }).code;
      if (code !== BOT_CONFLICT) throw err;
      await get().reloadUnit(unitId as UnitId);
      await apply();
    }
  },

  patchUnitContext: async (unitId, patch) => {
    try {
      await get().writeUnitWithHeal(
        unitId,
        (u) => ({ ...u, contextManifest: { ...normalizeContextManifest(u.contextManifest), ...patch } } as WorkUnit),
      );
    } catch (err: unknown) {
      get().pushNotice(
        "注入开关未写入",
        err instanceof Error && err.message !== "" ? err.message : "bot.json 已被外部修改，重新打开设置页后再试",
        { level: "warn" },
      );
      throw err;
    }
  },

  putUnitFields: async (unitId, fields, opts) => {
    try {
      await get().writeUnitWithHeal(unitId, (u) => ({ ...u, ...fields } as WorkUnit));
    } catch (err: unknown) {
      if (opts?.silent === true) throw err;
      get().pushNotice(
        "设置未写入",
        err instanceof Error && err.message !== "" ? err.message : "bot.json 已被外部修改，重新打开后再试",
        { level: "warn" },
      );
      throw err;
    }
  },

  turnContextConfig: {
    mode: "bot_default",
    persistForSession: false,
  },

  turnContextByUnit: {},

  setTurnContextConfig: (patch) => {
    const next = typeof patch === "function" ? patch(get().turnContextConfig) : { ...get().turnContextConfig, ...patch };
    writeTurnConfig(set, get, next);
  },

  resetTurnContextConfig: () => {
    writeTurnConfig(set, get, DEFAULT_TURN_CONFIG);
  },

  pushNotice: (title, text, options) => {
    set((s) => ({
      timeline: [
        ...s.timeline,
        {
          id: ++seq,
          event: {
            type: "system.notice",
            sessionId: s.activeSessionId ?? asSessionId("sys"),
            title,
            text,
            level: options?.level ?? "info",
            meta: options?.meta,
          },
          at: Date.now(),
        },
      ],
    }));
  },

  setLoopParam: (runtimeId, patch) => {
    set((s) => {
      const loopParams = { ...s.loopParams, [runtimeId]: { ...s.loopParams[runtimeId], ...patch } };
      try { localStorage.setItem(LOOP_PARAMS_KEY, JSON.stringify(loopParams)); } catch { /* 私有模式写不进就算了 */ }
      return { loopParams };
    });
  },

  runtimePrefs: {} as Readonly<Record<string, RuntimePref>>,
  automations: [],
  automationNotice: null,
  // 启动时不预置：空 map 由 bootstrap 在合并 bot 定义后拉一次。
  // ⚠ 必须是**稳定引用**，selector 会逐个组件地读它（见 Sidebar 的 UnitRow），
  // 换新对象会让所有订阅者重渲染。
  channelIdentity: {},

  setAutomationNotice: (automationNotice) => set({ automationNotice }),

  refreshAutomations: async () => {
    const { fetchAutomations, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      const list = await fetchAutomations(defaultDaemonEndpoint());
      set({ automations: list });
    } catch (err: unknown) {
      // daemon 没起是正常态：空着 + 控制台留痕，不打断用户正在看的页面
      console.info("[workbench] 自动化列表拉取失败", err instanceof Error ? err.message : err);
    }
  },

  toggleAutomation: async (id) => {
    const current = get().automations.find((a) => a.id === id);
    if (current === undefined) return;
    // 乐观翻转 + 失败回滚：开关的即时反馈重要，但「显示开了、daemon 没开」更糟
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    }));
    const { setAutomationEnabled, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await setAutomationEnabled(Number(id), !current.enabled, defaultDaemonEndpoint());
    } catch (err: unknown) {
      set((s) => ({
        automations: s.automations.map((a) => (a.id === id ? { ...a, enabled: current.enabled } : a)),
        automationNotice: {
          kind: "error",
          text: `开关没生效：${err instanceof Error ? err.message : String(err)}`,
        },
      }));
    }
  },

  createAutomationAction: async (input) => {
    const { createAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await createAutomation(input, defaultDaemonEndpoint());
      await get().refreshAutomations();
      return true;
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `创建失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
  },

  updateAutomationAction: async (id, patch) => {
    const { updateAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await updateAutomation(Number(id), patch, defaultDaemonEndpoint());
      await get().refreshAutomations();
      return true;
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `保存失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
  },

  deleteAutomationAction: async (id: string) => {
    const { deleteAutomation, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await deleteAutomation(Number(id), defaultDaemonEndpoint());
      await get().refreshAutomations();
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `删除失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  },

  runAutomationNowAction: async (id) => {
    // 运行前提示（不拦）：定时任务配的模型可能已经下线了。
    // 不拦是因为模型**临时**不可用不该让人连「手动跑一次」都做不了，
    // 但必须说一声 —— 否则用户点了没反应、或者跑起来才发现用的是别的东西。
    // 注意警告文本要**并进**成功消息里：先 set 再被「已派发」覆盖等于没提示。
    const now = get().automations.find((a) => String(a.id) === String(id));
    // 判定必须走 isModelAvailable（复审 P1）：只看「配没配模型」会让每一条配了模型
    // 的任务在手动运行时都吃到假错误，还会把「已派发」的成功提示整个顶掉。
    // runtimeId 存的是裸执行器名，判定口径要补 daemon: 前缀。
    const stale =
      now !== undefined && now.model !== null && now.model !== "" &&
      !isModelAvailable(get(), `daemon:${now.runtimeId}`, now.model)
        ? `注意：${now.name} 配的模型 ${now.model} 已不在 ${now.runtimeId} 的可选清单里（多半下线了），仍按它派发。`
        : null;
    const { runAutomationNow, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      await runAutomationNow(Number(id), defaultDaemonEndpoint());
      set({
        automationNotice: { kind: stale === null ? "info" : "error", text: stale ?? "已派发，正在起新会话" },
      });
      // 稍等片刻再刷，让「最近运行」立刻出现这条
      setTimeout(() => void get().refreshAutomations(), 1500);
    } catch (err: unknown) {
      set({
        automationNotice: {
          kind: "error",
          text: `立即运行失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  },

  setUnitOrder: (unitOrder) => {
    set({ unitOrder });
  },

  selectUnit: (activeUnitId) => {
    // 切单元 = 切对话视图：时间线跟着换（ADR 0012 后时间线不再随开新段清空，
    // 单元边界成了唯一的显式清空点之一）。分叉意图指向旧单元的段，一并作废
    // （零持久化，用户在新单元里重新发起即可）。输入历史同口径清空 ——
    // 历史属于这场对话（终端换 shell），不该带进另一个 bot 的输入框。
    // busy 必须跟着复位：它是「活跃会话在跑」的镜像，活跃会话都被切走了还
    // 挂 true 的话，后续 session.status 事件找不到活跃会话、永远没人清它 ——
    // openSession 门禁从此锁死，被切走的运行中对话也回不去（底栏条目点的
    // 就是这条路）。运行状态本身由任务栏（useTaskbar）继续跟踪。
    // 临时注入配置按 bot 记忆：切回来恢复这个 bot 上次的覆盖态（不重置回跟随预设）
    const restoredTurn = get().turnContextByUnit[String(activeUnitId)] ?? DEFAULT_TURN_CONFIG;
    set({
      activeUnitId,
      activeSessionId: null,
      timeline: [],
      pendingFork: null,
      inputHistory: [],
      busy: false,
      turnContextConfig: restoredTurn,
    });
    try {
      localStorage.setItem("agent-workbench:active-unit", activeUnitId);
    } catch {}
    // 新会话的默认执行器跟随 bot 主绑定：activeRuntimeId 是全局游标，此前切 bot
    // 不动它——bot 指定了主执行器时，在它下面新建对话页默认却停在全局值（多半
    // 是 zcode），第一条消息就发错执行器。绑定可用就带过去（连模型提示一起）；
    // 没绑定的 bot（总管等）保持全局值。门禁沿用 idle-only 判定（本轮进行中不切）。
    const s = get();
    const unit = s.units.find((u) => u.id === activeUnitId);
    const binding = unit?.bindings.find((b) => b.primary) ?? unit?.bindings[0];
    const rid =
      binding !== undefined && binding.runtimeId !== ""
        ? (s.runtimes.find((r) => r.id === binding.runtimeId)?.id ??
          s.runtimes.find((r) => r.id === `daemon:${binding.runtimeId}`)?.id ??
          null)
        : null;
    if (rid !== null && rid !== s.activeRuntimeId && !runtimeSwitchBlocked(s)) {
      const entry = s.runtimes.find((r) => r.id === rid);
      const hint = binding?.modelHint;
      const picked = entry !== undefined && hint !== undefined && canRuntimeUse(entry.models, hint) ? hint : undefined;
      set((st) => {
        const nextModel = picked ?? st.runtimeModels[rid] ?? entry?.defaultModel ?? null;
        return nextModel === null
          ? { activeRuntimeId: rid }
          : { activeRuntimeId: rid, runtimeModels: { ...st.runtimeModels, [rid]: nextModel } };
      });
    }
  },

  refreshUnits: async () => {
    try {
      const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const defs = (await listBotDefinitions(defaultDaemonEndpoint())) as WorkUnit[];
      const valid = defs.filter(
        (d) =>
          typeof d.id === "string" &&
          typeof d.rootPath === "string" &&
          typeof d.name === "string" &&
          Array.isArray(d.bindings) &&
          (d.kind === "bot" || d.kind === "project"),
      );
      if (valid.length > 0) {
        const curActive = get().activeUnitId;
        const defaultActive = valid.some((u) => u.id === curActive && u.id !== "")
          ? curActive
          : (valid.find((u) => u.id === "steward")?.id ?? valid[0]?.id ?? asUnitId(""));
        set({ units: valid, activeUnitId: defaultActive });
        // 右侧面板 GC（对齐 ZCode subagent tab 的同步回收）：daemon 侧已消失的
        // bot，它的历史 tab 没有新的归属，直接回收；激活被回收时面板自愈聚焦
        useSidePane.getState().releaseUnits(valid.map((u) => u.id));
        void get().refreshChannelIdentity();
      }
    } catch (err: unknown) {
      console.warn("[workbench] 刷新 Agent 列表失败", err);
    }
  },

  addUnit: async (u, opts) => {
    // busy 复位同 selectUnit：活跃会话被顶掉后没人会再清它（见那边注释）
    set((s) => ({
      units: [...s.units, u],
      activeUnitId: u.id,
      activeSessionId: null,
      timeline: [],
      busy: false,
    }));
    // WP-5 写穿：落盘 <rootPath>/.agent-workbench/bot.json 与 <rootPath>/AGENTS.md。
    // 这里**不吞异常**——目录不存在（root_not_found）时侧栏会多一个刷新即逝的幽灵 bot，
    // 调用方（新建对话框）需要把这句话摆到用户面前。daemon 没起时也照抛。
    // createRoot（自动安置，ADR 0011）：新建流的唯一必填交互是文件夹，预填的默认位置
    // 本来就不存在，由 daemon 落笔时幂等建出。新建＝新建＋认领单轨后恒开启——
    // 指向已存在的文件夹时 daemon 只在缺失时才创建，认领路径不受影响；
    // AGENTS.md 留空的提交也不会覆盖既有文件（putBot 的空正文分支）。
    const { putBotDefinition, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const r = await putBotDefinition(u, defaultDaemonEndpoint(), {}, { createRoot: opts?.createRoot === true });
    applyPutResult(set, get, u.id, r);
    // 新建时就配了渠道的话，当场把「这是哪个飞书机器人」认出来——
    // 用户在对话框里点完「接上飞书」就该看到它长什么样，而不是关了窗口再去找
    const profiles = feishuProfilesOf(u);
    if (profiles.length > 0) void get().refreshChannelIdentity(profiles);
  },

  // 改已有单元：state 里按 id 替换 + 同样写穿 bot.json。
  // addUnit 只管新建，bot 设置页改完 AGENTS.md / 换执行器都走这里。
  // 刻意不新建条目也不切 activeUnitId —— 编辑一个后台单元不该把用户拽走。
  //
  // 与 addUnit 的区别：**await 并把冲突抛回调用方**。bot 设置页必须知道"盘上已被改过"，
  // 否则用户在 VS Code 改完 AGENTS.md、在设置页看到旧的、点保存就静默覆盖——那是数据丢失。
  updateUnit: async (u, guards) => {
    // 先记下原值：写盘失败（版本冲突 / daemon 不可达）必须**回滚**。
    // 以前是「先写 store 再写盘、失败不回滚」—— 侧栏已经显示新名字、
    // 头部已经显示新 AGENTS.md，而对话框说「这次没有写入」：
    // 界面和 bot.json 分叉到下次刷新，而且下一次基于 `units` 的保存会把
    // 这份没落盘的值一起推上去。
    const prev = get().units.find((x) => x.id === u.id);
    set((s) => ({ units: s.units.map((x) => (x.id === u.id ? u : x)) }));
    try {
      const { putBotDefinition, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const r = await putBotDefinition(u, defaultDaemonEndpoint(), guards ?? {});
      applyPutResult(set, get, u.id, r);
      // 渠道可能被改过（换了 profile / 刚启用 / 刚停用），侧栏头像要跟着变
      const profiles = feishuProfilesOf(u);
      if (profiles.length > 0) void get().refreshChannelIdentity(profiles);
    } catch (err: unknown) {
      if (prev !== undefined) {
        set((s) => ({ units: s.units.map((x) => (x.id === u.id ? prev : x)) }));
      }
      throw err;
    }
  },

  // 认「哪个 profile 是哪个飞书机器人」。后端成功缓存 10 分钟，所以这里可以放心地在
  // 保存后和启动时各调一次，不会变成 spawn 风暴。
  refreshChannelIdentity: async (profiles) => {
    const { fetchChannelIdentity, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    try {
      const next = await fetchChannelIdentity(profiles, defaultDaemonEndpoint());
      set((s) => ({ channelIdentity: { ...s.channelIdentity, ...next } }));
    } catch (err: unknown) {
      // 认不出来是常态（daemon 没起 / lark-cli 不在 PATH / profile 写错）。
      // 界面回落通用图标即可，不该弹一个红框打断用户正在做的事。
      console.info("[workbench] 机器人身份拉取失败（界面回落通用渠道图标）", err instanceof Error ? err.message : err);
    }
  },

  // 重新从盘上拉一个单元。bot.list 每次重扫盘（无缓存），所以这就是"用户在 VS Code
  // 改完 AGENTS.md 后刷新"的那一下。合并进 units 同 id 条目并回传，供设置页预填。
  reloadUnit: async (id) => {
    const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const defs = await listBotDefinitions(defaultDaemonEndpoint());
    const fresh = defs.find((d) => d.id === id);
    if (fresh === undefined) return null;
    set((s) => ({ units: s.units.map((x) => (x.id === id ? { ...x, ...fresh } : x)) }));
    return { ...(get().units.find((x) => x.id === id) ?? fresh) };
  },

  unregisterUnit: async (id) => {
    const { unregisterBotRpc, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    await unregisterBotRpc(id, defaultDaemonEndpoint());
    set((s) => {
      const remaining = s.units.filter((u) => u.id !== id);
      const activeUnitId = s.activeUnitId === id ? (remaining[0]?.id ?? ("" as UnitId)) : s.activeUnitId;
      return {
        units: remaining,
        activeUnitId,
        ...(s.activeUnitId === id ? { activeSessionId: null, timeline: [], busy: false } : {}),
      };
    });
  },

  initWorkspace: async (rootPath) => {
    const { initWorkspaceRpc, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    return initWorkspaceRpc(rootPath, defaultDaemonEndpoint());
  },

  selectSession: (activeSessionId) => set({ activeSessionId }),

  handoffOnSwitch: false,
  setHandoffOnSwitch: (on) => set({ handoffOnSwitch: on }),

  pendingFork: null,
  // revision（编辑重发）顺带把锚点原文回填草稿 —— Composer 对非空 draft 会自动聚焦
  startFork: (intent) =>
    set((s) => ({
      pendingFork: intent,
      ...(intent.kind === "revision" && intent.anchorText !== undefined ? { draft: intent.anchorText } : {}),
    })),
  cancelFork: () => set({ pendingFork: null }),

  editAndResend: async (input) => {
    // revision 意图 + 立即发送：run 的 fork 分支会带着意图直接开 revision 段
    set({
      pendingFork: {
        ofSessionId: input.ofSessionId,
        anchorMessageId: input.anchorMessageId,
        kind: "revision",
      },
    });
    await get().run(input.text);
  },

  selectRuntime: (activeRuntimeId) => {
    const s = get();
    // 切换门禁（见 runtimeSwitchBlocked，底栏上线后只剩「等回答」半边）：
    // 对话在等裁决/等输入时切换，待决问题会脱离现场。同执行器的重复选择
    // 不是切换，不受门禁。
    const prevId = s.activeRuntimeId;
    if (activeRuntimeId !== prevId && runtimeSwitchBlocked(s)) {
      get().pushNotice(
        "当前对话在等你回答",
        "它处于待裁决 / 待输入状态 —— 先处理完再切换执行器，切换会把待决问题脱离现场。",
        { level: "warn" },
      );
      return false;
    }
    // 换执行器时保证模型组合合法。
    // runtimeModels 是按执行器存的，所以理论上不会串；
    // 但工作单元的 modelHint、注册表热更新都可能引入非法值，这里兜住。
    const entry = get().runtimes.find((r) => r.id === activeRuntimeId);
    if (!entry) {
      set({ activeRuntimeId });
      return true;
    }
    const cur = get().runtimeModels[activeRuntimeId];
    const nextModel = canRuntimeUse(entry.models, cur) ? undefined : entry.defaultModel;
    set(
      nextModel === undefined
        ? { activeRuntimeId }
        : {
            activeRuntimeId,
            runtimeModels: { ...get().runtimeModels, [activeRuntimeId]: entry.defaultModel },
          },
    );
    // 切换反馈：活跃会话存在时，下一条消息将是同一对话的新段 —— 把边界说清楚
    //（替换掉旧文案「切换只影响下一条消息」的误导：它低估了后果）。
    // 分叉叙事并列（ADR 0013）：回到某一轮换方向走「从此处分叉」，不是切换。
    if (activeRuntimeId !== prevId) {
      const active = s.activeSessionId !== null ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined;
      if (active !== undefined) {
        const forkPending = get().pendingFork !== null;
        get().pushNotice(
          `已切换到 ${entry.presentation.displayName}`,
          forkPending
            ? "分叉意图保持有效：下一条消息将在所选轮边界开启分叉段（新执行器，带只读前缀）。"
            : "下一条消息将开启新对话段（新执行器不带上一段的记忆）；上一段保留在时间线上，可随时回看。想回到某一轮换个方向：悬停那条消息点「从此处分叉」。",
        );
      }
    }
    return true;
  },

  openSession: async (input) => {
    // 门禁只剩「等回答」半边（见 runtimeSwitchBlocked）：运行中的对话可以随时
    // 被打开的会话顶掉 —— 它继续在 daemon 里跑，底栏条目跟踪着，随时切回
    if (runtimeSwitchBlocked(get())) {
      get().pushNotice("当前对话在等你回答", "它处于待裁决 / 待输入状态 —— 先在对话里处理完，再打开别的会话。", { level: "warn" });
      return;
    }
    const unit = get().units.find((u) => u.id === input.unitId);
    if (unit === undefined) {
      get().pushNotice("找不到所属 bot", `会话 ${input.sessionId} 所属的单元不在列表里。`, { level: "warn" });
      return;
    }
    // 执行器可能已不在注册表（daemon 下线了它 / 注册部分失败）：兜住再提示，
    // 否则 HistoryPane/Sidebar 的 void 调用变成静默 unhandled rejection（review P2）
    let adapter: RuntimeAdapter;
    try {
      adapter = await runtimeRegistry.getOrCreate(asRuntimeId(`daemon:${input.runtimeId}`) as never);
    } catch (err: unknown) {
      get().pushNotice("这个执行器当前不可用", err instanceof Error ? err.message : String(err), { level: "warn" });
      return;
    }
    // 事件泵必须在 resume 之前挂上：resume 后 daemon 推的任何事件都要能进时间线
    consumeEvents(adapter);

    // ① 尝试接回：live 会话直接返回；死会话凭 cli_ref reattach；都没有则抛（no_cli_ref）
    let session: Session | undefined;
    let historyOnly = false;
    try {
      session = await adapter.resumeSession(input.sessionId);
    } catch {
      // ② 仅历史：从台账拉这行（拿 status/stats/conversationId 等元数据）
      historyOnly = true;
      try {
        const listed = await adapter.listSessions(unit);
        session = listed.find((s) => s.id === input.sessionId);
      } catch {
        session = undefined;
      }
    }
    if (session === undefined) {
      get().pushNotice("打不开这个会话", "daemon 台账里没有它，或执行器已不可用。", { level: "warn" });
      return;
    }
    if (historyOnly) {
      session = {
        ...session,
        status: session.status === "running" ? "failed" : session.status,
        live: false,
        resumable: false,
      };
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId: input.unitId } }));
      }
    }

    // ③ 谱系聚合回放（review P1 + ADR 0013 树化）：目标段沿 fork_of_session 上溯
    // 得到 fork 祖先链（链上每段按其子段记录的 fork_at_seq 截断），兄弟分支排除；
    // 主线普通段（执行器切换，无 fork 血缘）全保留 —— 对话的线性脊柱不变，
    // 分叉是挂在脊柱上的树枝。已知近似（P1 记录在 docs/18）：普通段没有
    // parent 链接，若兄弟分支后续又做了执行器切换，那段会两边都出现；
    // 精确树要等段级 parent 落库（P3+）。回放条目统一本地序号重编 id ——
    // 各段 seq 独立计数，直接拼会撞 React key。
    const lineageRoot = session.conversationId ?? String(session.id);
    let lineageRows: readonly DaemonSessionRow[] = [];
    const forkBounds = new Map<string, number>();
    try {
      const { fetchSessions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const all = await fetchSessions(defaultDaemonEndpoint());
      const findSeg = (id: string): DaemonSessionRow | undefined => all.find((s) => s.id === id);
      const inLineage = all.filter((s) => (s.conversationId ?? s.id) === lineageRoot);
      // fork 祖先链：target → fork 父 → …（环与断链都安全止步）
      const chain: DaemonSessionRow[] = [];
      const seen = new Set<string>();
      let cursor = findSeg(String(session.id));
      while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.unshift(cursor);
        cursor = cursor.forkOf != null ? findSeg(cursor.forkOf) : undefined;
      }
      for (let i = 0; i < chain.length; i++) {
        const bound = chain[i + 1]?.forkAtSeq;
        if (typeof bound === "number") forkBounds.set(chain[i]!.id, bound);
      }
      lineageRows = inLineage
        // fork 段只保留本链上的（兄弟分支排除）；普通段全保留
        .filter((s) => s.forkOf == null || seen.has(s.id))
        .sort((a, b) => a.startedAt - b.startedAt);
    } catch {
      // 台账拉不到（daemon 忙/不可达）：下面按本段兜底（与升级前行为一致）
      lineageRows = [];
    }
    // 兜底：目标段必须可见（台账缺行 / 拉取失败时至少回放它自己）
    if (!lineageRows.some((s) => s.id === String(session.id))) {
      lineageRows = [
        ...lineageRows,
        {
          id: String(session.id),
          unitId: String(session.unitId),
          runtimeId: String(session.runtimeId).replace(/^daemon:/, ""),
          conversationId: session.conversationId ?? null,
          forkOf: session.forkOf ?? null,
          forkAtSeq: session.forkAtSeq ?? null,
          forkKind: session.forkKind ?? null,
          status: session.status,
          startedAt: session.startedAt,
        },
      ];
    }
    const rebuilt: { id: number; event: RuntimeEvent; at: number }[] = [];
    for (const seg of lineageRows) {
      const bound = forkBounds.get(seg.id);
      try {
        const replay = adapter.eventsSince !== undefined ? await adapter.eventsSince(asSessionId(seg.id)) : [];
        for (const r of replay) {
          // fork 祖先段截断：只保留 seq ≤ 子段 fork_at_seq 的前缀
          if (bound !== undefined && r.seq > bound) continue;
          rebuilt.push({ id: ++seq, event: r.event, at: r.at });
        }
      } catch (err: unknown) {
        console.warn("[workbench] 该段账本回放失败（跳过）", seg.id, err instanceof Error ? err.message : err);
      }
    }

    // ④ 落位。顺序要紧（review P0）：selectRuntime 必须在大 set **之前** ——
    // 先 set busy/activeSessionId 再切执行器，会被自家门禁按「本轮进行中」拦下，
    // activeRuntimeId 留在旧执行器上，续聊判定从此错位。selectUnit 先清
    // activeSessionId（门禁的会话半边恒 false）、busy 尚未置位 → 切换必成。
    get().selectUnit(input.unitId);
    get().selectRuntime(String(adapter.id));
    // 队列 / usage 从回放重建：主段先种上 resume 返回的权威快照（live 会话
    // 当下的队列态），回放里更早的 steer.queue / usage 事件按序覆盖
    const queues: Record<string, { items: readonly SteerQueueItem[]; paused: boolean }> = {
      [String(session.id)]: { items: session.steerQueue ?? [], paused: session.steerPaused ?? false },
    };
    const usages: Record<string, UsageSnapshot> = {};
    // 输入历史随视图切换整段重建（终端换 shell 同款）：本段账本里的用户消息
    // 按时间升序进来，连续去重。fullPrompt（含附件块）也照收 —— 那是当时的原话。
    const history: string[] = [];
    for (const r of rebuilt) {
      const e = r.event;
      if (!("sessionId" in e)) continue;
      if (e.type === "steer.queue") queues[String(e.sessionId)] = { items: e.items, paused: e.paused };
      else if (e.type === "usage") {
        usages[String(e.sessionId)] = {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
          model: e.model,
          at: r.at,
        };
      } else if (e.type === "message.delta" && e.role === "user") {
        const t = e.text.trim();
        if (t !== "" && history[history.length - 1] !== t) history.push(t);
      }
    }
    set((s) => {
      // 谱系内全部段进 sessions[]：divider 的执行器名/readiness 都从这里查
      const segSessions: Session[] = lineageRows.map((row) => ({
        id: asSessionId(row.id),
        unitId: input.unitId,
        runtimeId: asRuntimeId(`daemon:${row.runtimeId}`) as never,
        title: row.title ?? "",
        status: mapTurnStatus(row.status),
        startedAt: row.startedAt,
        ephemeral: false,
        live: row.live,
        resumable: row.resumable,
        conversationId: row.conversationId ?? undefined,
        // fork 血缘（ADR 0013）：Timeline 的 fork 标记行据此区分「分叉拼接」
        // 与「执行器切换」两种段边界
        forkOf: row.forkOf ?? undefined,
        forkAtSeq: row.forkAtSeq ?? undefined,
        forkKind: row.forkKind ?? undefined,
        stats: { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      }));
      let sessions = s.sessions.slice();
      for (const seg of [...segSessions, session!]) {
        const i = sessions.findIndex((x) => x.id === seg.id);
        // 主段（点击打开的）用完整对象覆盖；其余段仅补缺
        if (i >= 0) sessions = sessions.map((x, j) => (j === i && seg.id === session!.id ? session! : x));
        else sessions = [...sessions, seg];
      }
      return {
        timeline: rebuilt,
        busy: session!.status === "running" && session!.live === true,
        sessions,
        activeSessionId: session!.id,
        // 打开的是另一条对话的视图：指向旧视图的分叉意图作废（零持久化）
        pendingFork: null,
        steerQueues: queues,
        usageBySession: usages,
        inputHistory: history,
      };
    });
    markSessionViewed(session!.id);
    if (historyOnly) {
      get().pushNotice(
        "已打开历史对话（只读段）",
        "这个会话接不回执行器了 —— 时间线可回看；发新消息将在同一对话线开新段。",
      );
    }
  },

  selectModel: (model) =>
    set((s) => {
      const entry = s.runtimes.find((r) => r.id === s.activeRuntimeId);
      if (!entry) return {};
      // 按**有效清单**校验，不是按声明清单 ——
      // 用户在设置里藏掉的模型，选择器里不该还能选到（那是个不一致）
      const visible = visibleModelsFor(s, s.activeRuntimeId);
      if (!visible.some((m) => m.id === model)) return {};
      return { runtimeModels: { ...s.runtimeModels, [s.activeRuntimeId]: model } };
    }),

  setModelPrefs: (runtimeId, next) =>
    set((s) => {
      const map = { ...s.modelPrefs, [runtimeId]: next };
      persistPrefs(map);
      return { modelPrefs: map, modelPrefsVersion: s.modelPrefsVersion + 1 };
    }),

  applyModelPrefs: (runtimeId, steps) =>
    set((s) => {
      const cur = prefsOf(s.modelPrefs, runtimeId);
      // 每步都过一遍归一：像「全藏」这种动作可能触发「至少留一个」的兜底，
      // 不归一的话内存里就留下一个「藏光了」的非法状态。
      let next = cur;
      for (const step of steps) next = normalizePrefs(step(next), declaredOf(s, runtimeId));
      const map = { ...s.modelPrefs, [runtimeId]: next };
      persistPrefs(map);
      return { modelPrefs: map, modelPrefsVersion: s.modelPrefsVersion + 1 };
    }),

  setRuntimePref: (id, patch) =>
    set((s) => {
      const base: RuntimePref = s.runtimePrefs[id] ?? { enabled: true };
      return { runtimePrefs: { ...s.runtimePrefs, [id]: { ...base, ...patch } } };
    }),

  cancelRun: () => {
    const { activeSessionId, activeRuntimeId } = get();
    set({ busy: false });
    if (activeSessionId !== null) {
      void runtimeRegistry
        .getOrCreate(activeRuntimeId as never)
        .then((a: RuntimeAdapter) => a.cancel(activeSessionId))
        .catch((err: unknown) => console.warn("[workbench] cancel failed", err instanceof Error ? err.message : err));
    }
  },

  // ---- steer 待发送队列操作（活跃会话的排队消息管理）----
  // 统一走「会话所属执行器」拿适配器 —— 队列是会话的，不是当前执行器的。
  sendQueuedNow: async (id) => {
    const { activeSessionId, sessions } = get();
    if (activeSessionId === null) return;
    const seg = sessions.find((x) => x.id === activeSessionId);
    if (seg === undefined) return;
    try {
      const adapter = await runtimeRegistry.getOrCreate(seg.runtimeId as never);
      if (adapter.sendQueuedNow === undefined) throw new Error("当前执行器不支持队列管理");
      await adapter.sendQueuedNow(activeSessionId, id);
    } catch (err: unknown) {
      get().pushNotice("没能立刻发送", err instanceof Error ? err.message : String(err), { level: "warn" });
    }
  },

  removeQueuedSend: async (id) => {
    const { activeSessionId, sessions } = get();
    if (activeSessionId === null) return;
    const seg = sessions.find((x) => x.id === activeSessionId);
    if (seg === undefined) return;
    try {
      const adapter = await runtimeRegistry.getOrCreate(seg.runtimeId as never);
      if (adapter.removeQueuedSend === undefined) throw new Error("当前执行器不支持队列管理");
      await adapter.removeQueuedSend(activeSessionId, id);
    } catch (err: unknown) {
      get().pushNotice("没能删除这条排队消息", err instanceof Error ? err.message : String(err), { level: "warn" });
    }
  },

  editQueuedSend: async (id) => {
    const { activeSessionId, sessions, steerQueues, draft } = get();
    if (activeSessionId === null) return;
    const item = (steerQueues[String(activeSessionId)]?.items ?? []).find((i) => i.id === id);
    if (item === undefined) return;
    // 输入框还有没发的东西：不覆盖（ZCode 同款冲突守卫）—— 排队消息留在队列里不丢
    if (draft.trim() !== "") {
      get().pushNotice(
        "输入框里还有未发送的内容",
        "先处理输入框的草稿，再编辑这条排队消息 —— 它会一直在队列里等。",
        { level: "warn" },
      );
      return;
    }
    const seg = sessions.find((x) => x.id === activeSessionId);
    if (seg === undefined) return;
    try {
      const adapter = await runtimeRegistry.getOrCreate(seg.runtimeId as never);
      if (adapter.removeQueuedSend === undefined) throw new Error("当前执行器不支持队列管理");
      // 先删权威面、成功后才回填草稿（对齐 ZCode「ACK 后还原 composer」次序）
      await adapter.removeQueuedSend(activeSessionId, id);
      set({ draft: item.text });
    } catch (err: unknown) {
      get().pushNotice("没能取回这条排队消息", err instanceof Error ? err.message : String(err), { level: "warn" });
    }
  },

  resumeQueuedSends: async () => {
    const { activeSessionId, sessions } = get();
    if (activeSessionId === null) return;
    const seg = sessions.find((x) => x.id === activeSessionId);
    if (seg === undefined) return;
    try {
      const adapter = await runtimeRegistry.getOrCreate(seg.runtimeId as never);
      if (adapter.resumeQueuedSends === undefined) throw new Error("当前执行器不支持队列管理");
      await adapter.resumeQueuedSends(activeSessionId);
    } catch (err: unknown) {
      get().pushNotice("没能恢复队列", err instanceof Error ? err.message : String(err), { level: "warn" });
    }
  },

  resolvePermission: (requestId, decision) => {
    const { sessions, timeline, activeSessionId } = get();

    // 裁决必须回到**发起这条请求的那条会话**。
    // 时间线里每条 permission.requested 自带 sessionId，这是唯一正确的归属来源
    //（daemon 按会话严格匹配 requestId，发错会话那条 tool call 永远等不到放行）。
    let ownerId: SessionId | null = null;
    for (const t of timeline) {
      if (t.event.type === "permission.requested" && t.event.requestId === requestId) {
        ownerId = t.event.sessionId;
        break;
      }
    }
    const session = sessions.find((s) => s.id === (ownerId ?? activeSessionId ?? sessions.at(-1)?.id));
    if (!session) return;

    // 先落本地裁决，UI 立刻放行，不等网络往返
    set((s) => ({
      permissionDecisions: { ...s.permissionDecisions, [requestId]: decision },
    }));

    void runtimeRegistry
      .getOrCreate(session.runtimeId as never)
      .then((a: RuntimeAdapter) => a.resolvePermission(session.id, requestId, decision))
      // 拒绝必须可见：适配器取不到时 UI 已把请求标成「已裁决」——
      // 人以为放行了，实际那一轮还挂着。
      .catch((err: unknown) => {
        get().pushNotice("授权没有送达执行器", err instanceof Error ? err.message : String(err), { level: "warn" });
      });
  },

  /**
   * 发一条消息 —— T3 语义：**活跃会话仍开着就同会话续聊**（agent loop 保持
   * 上下文，工具记得前文），只有首条消息 / 上个会话已结束 / 换了执行器才
   * startSession 开新段。时间线跨段连续（ADR 0012）：开新段不清空，段边界由
   * 渲染层合成 divider；清空只发生在单元切换。
   */
  run: async (prompt, opts) => {
    const { activeUnitId, activeRuntimeId, runtimeModels, activeSessionId } = get();
    const unit = get().units.find((u) => u.id === activeUnitId);
    if (!unit) return;
    // 输入历史（终端 ↑↓ 语义）：提交即入史 —— 无论走哪个分支、成没成功
    //（终端也是回车即入史，失败的命令也在里面）
    pushInputHistory(prompt);

    // 起会话 / 发送失败时的统一收尾。**必须有**：这两处 await 都没有 catch 的话，
    // RPC 一 reject（daemon 没起、CLI 拉不起来）busy 就永远停在 true ——
    // composer 一直显示「停止」，时间线一直显示「正在思考与执行…」。
    const fail = (err: unknown): void => {
      set({ busy: false });
      get().pushNotice("这一轮没能发出去", err instanceof Error ? err.message : String(err), { level: "warn" });
    };

    let adapter: RuntimeAdapter;
    try {
      adapter = await runtimeRegistry.getOrCreate(activeRuntimeId as never);
    } catch (err: unknown) {
      fail(err);
      return;
    }
    consumeEvents(adapter);

    // agent loop 参数：每执行器各记一份；mode 未单独设置时跟随权限档位（ask→build 等）
    const loopState = get().loopParams[activeRuntimeId] ?? {};
    const pmToMode = (pm: PermissionMode): LoopParams["mode"] =>
      pm === "ask" ? "build" : pm === "acceptEdits" ? "edit" : pm === "plan" ? "plan" : "yolo";
    const loop: LoopParams = {
      mode: loopState.mode ?? pmToMode(get().permissionMode),
      ...(loopState.reasoningLevel ? { reasoningLevel: loopState.reasoningLevel } : {}),
      ...(loopState.contextLength ? { contextLength: loopState.contextLength } : {}),
    };

    // 模型回落：用户所选 → 工作单元 modelHint → 该 CLI 当前有效清单的第一个。
    //
    // 两类「不在有效清单里」要分开，它们对用户是完全不同的两件事：
    //
    // ① 用户在设置里**主动藏掉**的 —— 这是他明确表达过的意图，该排除，沿用旧行为；
    // ② **失效模型**（执行器不再提供的）—— 这不是用户的选择，是模型下线了。
    //    这里绝不能静默换成 visible[0]：用户以为在用 opus，实际跑的是列表第一个
    //    （codex 实测就是 $10/$50 的旗舰档 gpt-6-astra）。照他选的用，界面上
    //    由 ModelSelect / RuntimePicker 标「不可用」，换不换由他决定。
    const s = get();
    const visible = visibleModelsFor(s, activeRuntimeId);
    const hint = unit.bindings.find((b) => b.runtimeId === activeRuntimeId)?.modelHint;
    const picked = runtimeModels[activeRuntimeId];
    const retired = new Set(s.runtimes.find((r) => r.id === activeRuntimeId)?.retiredModels.map((m) => m.id));
    const usable = (id: ModelId | null | undefined): boolean => {
      if (id === null || id === undefined) return false;
      if (visible.some((m) => m.id === id)) return true;
      // 失效但用户没主动藏过 → 尊重他的选择，不偷换
      return retired.has(id) && !isHiddenByUser(s, activeRuntimeId, id);
    };
    const model: ModelId = usable(picked)
      ? (picked as ModelId)
      : usable(hint ? asModelId(hint) : null)
        ? (asModelId(hint!) as ModelId)
        : (visible[0]?.id ?? asModelId(""));

    const attachments = opts?.attachments;
    // 附件内联上移（docs/21 P4a）：附件都带本地路径时把组装交给 daemon
    // （session.start/send 的 attachments 参数——GUI 与 CLI 同一条路）；
    // 混有浏览器附件（无路径）时仍本地内联兜底，adapter 边界按同一谓词决定是否过线。
    const allPaths =
      attachments !== undefined &&
      attachments.length > 0 &&
      attachments.every((a) => typeof a.localPath === "string" && a.localPath !== "");
    let fullPrompt = prompt;
    if (attachments && attachments.length > 0 && !allPaths) {
      const parts: string[] = [];
      for (const att of attachments) {
        if (att.category === "image") {
          parts.push(`[图片附件: ${att.name}${att.localPath ? ` (本地路径: ${att.localPath})` : ""}]`);
        } else if (att.textContent) {
          parts.push(`\n--- 附件文件: ${att.name} ---\n${att.textContent}\n---`);
        } else {
          parts.push(`[附件文件: ${att.name}${att.localPath ? ` (本地路径: ${att.localPath})` : ""}]`);
        }
      }
      fullPrompt = prompt.trim() ? `${prompt}\n\n${parts.join("\n")}` : parts.join("\n");
    }

    const pushUserBubble = (sessionId: SessionId): number => {
      const itemId = ++seq;
      // 回显登记（ADR 0012 review 修复）：daemon 会把用户轮 delta 广播回来，
      // 本地已渲染的这条登记进窗口，回显到达时消费掉 —— 只滤自己的回声，
      // 渠道/其他端发起的用户轮不会被误杀（见 consumeEvents 的过滤）；
      // 消费时会把 daemon 真实 messageId 回填进来（fork 锚点用，ADR 0013）
      registerEcho(sessionId, prompt, itemId);
      set((s) => ({
        timeline: [
          ...s.timeline,
          {
            id: itemId,
            event: {
              type: "message.delta",
              sessionId,
              messageId: `u${++seq}`,
              role: "user" as const,
              text: prompt,
              attachments,
            } as const,
            at: Date.now(),
          },
        ],
      }));
      return itemId;
    };

    // 对话分叉（ADR 0013 + docs/18 §〇）：分叉意图存在 → 下一次发送一定开新段。
    // 绕过续聊判定与 retention（分叉语义就是「回到锚点边界重来」，不该被接回旧段）。
    // HANDOFF 不单独传 —— daemon 对 fork 自动取分叉父段为交接源并带 seq 上界。
    // 失败保留意图（用户可重试或取消）；成功清意图。
    const forkIntent = get().pendingFork;
    if (forkIntent !== null && opts?.worktree === undefined) {
      set({ busy: true });
      const source = get().sessions.find((s) => s.id === forkIntent.ofSessionId);
      let session: Awaited<ReturnType<RuntimeAdapter["startSession"]>>;
      try {
        session = await adapter.startSession({
          unit,
          prompt: fullPrompt,
          model,
          // 谱系照常继承自源段（分叉不换谱系 —— 一棵树一个 conversation_id，ADR 决议）
          conversationId: source !== undefined ? (source.conversationId ?? String(source.id)) : undefined,
          fork: {
            ofSessionId: forkIntent.ofSessionId,
            anchorMessageId: forkIntent.anchorMessageId,
            kind: forkIntent.kind,
          },
          loop,
          // ADR 0014：注入清单权威在 bot.json（daemon 自读）；前端只在 /mem 这类
          // 显式覆盖时才传 memoryOptions，不再有全局 scopes 真相源
          memoryOptions: opts?.memoryOptions,
          attachments,
        });
      } catch (err: unknown) {
        fail(err);
        return;
      }

      // ZCode 同款（onSessionCreated）：fork 落定即**切进新分支自己的会话视图**，
      // 不再往旧时间线后面追加 —— 视图 = 父段只读前缀（seq ≤ fork_at_seq，从
      // 账本回放；父段已 idle 无账本竞态）+ 新段（startSession 期间泵已实时
      // 入账的本段事件，保住其 id 不重编）。旧分支在分叉点之后的内容从本视图
      // 排除（revision 被替换的那轮随之消失），历史弹窗/侧栏可回看原分支。
      // 新段的用户气泡走 daemon 广播的真实 user-N 事件（不经本地合成，也就
      // 不需要回显登记）——泵稍滞后气泡会晚几十毫秒出现，可接受。
      const prefix: { id: number; event: RuntimeEvent; at: number }[] = [];
      if (
        typeof session.forkOf === "string" &&
        typeof session.forkAtSeq === "number" &&
        adapter.eventsSince !== undefined
      ) {
        try {
          const replay = await adapter.eventsSince(asSessionId(session.forkOf));
          for (const r of replay) {
            if (r.seq > (session.forkAtSeq ?? 0)) continue;
            prefix.push({ id: ++seq, event: r.event, at: r.at });
          }
        } catch (err: unknown) {
          console.warn("[workbench] 分叉父段前缀回放失败（只看新段）", err instanceof Error ? err.message : err);
        }
      }
      set((s) => {
        const fresh = s.timeline.filter(
          (t) => "sessionId" in t.event && String(t.event.sessionId) === String(session.id),
        );
        // busy/状态由新段已到达的事件推导，不信 startSession 的返回快照：权限被
        // 规则秒放行时整轮可能在前缀回放的 await 期间就落定（泵已把
        // session.ended 的 busy:false 与 sessions[].status:"done" 回写完），这里
        // 再写 busy:true / status:"running" 会把复位覆盖掉，按钮永远禁用（实测竞态）。
        const turnSettled = fresh.some((t) => t.event.type === "session.ended");
        const settledSession = turnSettled ? { ...session, status: "done" as const, endedAt: Date.now() } : session;
        return {
          timeline: [...prefix, ...fresh],
          busy: !turnSettled,
          sessions: [...s.sessions.filter((x) => x.id !== session.id), settledSession],
          activeSessionId: session.id,
          pendingFork: null,
        };
      });
      markSessionViewed(session.id);
      return;
    }

    // 续聊：活跃会话开着（未 done/failed）且属于当前执行器。
    // 工作树会话例外：它永远是新开的（daemon 按 path+branch ensure 工作树）。
    // live === false（ADR 0012 仅历史段）也不续聊 —— daemon 侧 impl 已死，
    // session.send 必抛 session_not_live，直接走同谱系开新段。
    const active = activeSessionId !== null ? get().sessions.find((s) => s.id === activeSessionId) : undefined;
    if (
      opts?.worktree === undefined &&
      active !== undefined &&
      active.live !== false &&
      active.runtimeId === activeRuntimeId &&
      active.status !== "done" &&
      active.status !== "failed"
    ) {
      set({ busy: true });
      markSessionViewed(active.id);
      // 用户气泡不再本地乐观合成：轮空闲时 daemon 立刻回显 message.delta(user)，
      // 排队时（本端 busy / 其他端正跑着轮）daemon 发 steer.queued + 快照 ——
      // 队列卡片接管「待发送」展示，轮落定 boundary 后才转成正式气泡。
      // 本地合成的旧路径在排队场景会把「排队中」伪装成「已发送」（正是本功能要修的）。
      const restoreDraft = (): void => set({ draft: prompt.trim() !== "" ? prompt : fullPrompt });
      const currentTurnConfig = get().turnContextConfig;
      const turnManifest = resolveEffectiveTurnManifest(currentTurnConfig, unit?.contextManifest, false);
      const contextInject = turnManifest !== null ? { manifest: turnManifest } : undefined;
      try {
        await adapter.sendMessage({
          sessionId: active.id,
          text: fullPrompt,
          attachments,
          loop: {
            ...(loop.reasoningLevel ? { reasoningLevel: loop.reasoningLevel } : {}),
          },
          contextInject,
        });
        if (currentTurnConfig.persistForSession !== true) {
          writeTurnConfig(set, get, { mode: "off", persistForSession: false });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        restoreDraft();
        if (msg.includes("session_not_live") || msg.includes("not live")) {
          // live 字段陈旧（daemon 换代杀掉了 impl，前端快照不知道）：标记死段，
          // 下一条消息自然走同谱系开新段（与续聊判定注释宣称的行为对齐，review P2）
          set((s) => ({
            sessions: s.sessions.map((x) => (x.id === active.id ? { ...x, live: false } : x)),
            busy: false,
          }));
          get().pushNotice("这段对话已不在运行中", "已标记为只读段 —— 再发一次将在同一对话线开新段。", { level: "warn" });
        } else {
          // 发送失败（含队列满 send_queue_full）：消息还给输入框，不打字重打一遍
          fail(err);
        }
      }
      return;
    }

    // 新段（ADR 0012）：时间线**不再清空** —— 同一对话跨执行器段的投影，
    // 段边界由渲染层按 sessionId 变化合成 divider。清空只发生在单元切换
    // （selectUnit/addUnit）。工作树会话是显式的新隔离对话，不延续谱系。
    set({ busy: true });

    // 「切回来还在」（ADR 0012 per-executor retention）：同谱系里若已有
    // 该执行器的段且可接回（live / cli_ref 可恢复且未终结），续接那段而非新开。
    // 查 daemon 台账（session.list 带谱系与 readiness），不用前端 sessions ——
    // 刷新后它是空的，且谱系事实只归 daemon。
    const lineageId = active !== undefined ? (active.conversationId ?? String(active.id)) : null;
    if (lineageId !== null && opts?.worktree === undefined) {
      const bareTarget = String(activeRuntimeId).replace(/^daemon:/, "");
      let target: { id: string } | undefined;
      try {
        const { fetchSessions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
        const all = await fetchSessions(defaultDaemonEndpoint());
        target = all.find(
          (s) =>
            (s.conversationId ?? s.id) === lineageId &&
            s.runtimeId === bareTarget &&
            // 已终结（done/failed）的段即使 impl 还活着也不续 —— 会话已收口，
            // 新消息应当开新段（谱系延续），而不是往死会话里塞
            s.status !== "done" && s.status !== "failed" &&
            (s.live === true || s.resumable === true),
        );
      } catch {
        // 台账拉不到（daemon 忙/不可达）：按新段走，不在这里报错 ——
        // 真正的连接错误由随后的 startSession 统一上报
        target = undefined;
      }
      if (target !== undefined) {
        // 若目标段正跑着轮（别的端续上了它）：session.send 会按 T3 steer 排队，无需特判。
        // 同续聊分支：不本地合成气泡，daemon 回显 / 队列卡片接管展示。
        try {
          const resumed = await adapter.resumeSession(asSessionId(target.id));
          const normalized: Session = { ...resumed, runtimeId: adapter.id as never };
          set((s) => ({
            busy: true,
            sessions: s.sessions.some((x) => x.id === normalized.id)
              ? s.sessions.map((x) => (x.id === normalized.id ? normalized : x))
              : [...s.sessions, normalized],
            activeSessionId: normalized.id,
          }));
          markSessionViewed(normalized.id);
          const currentTurnConfig = get().turnContextConfig;
          const turnManifest = resolveEffectiveTurnManifest(currentTurnConfig, unit?.contextManifest, false);
          const contextInject = turnManifest !== null ? { manifest: turnManifest } : undefined;
          await adapter.sendMessage({
            sessionId: normalized.id,
            text: fullPrompt,
            attachments,
            loop: {
              ...(loop.reasoningLevel ? { reasoningLevel: loop.reasoningLevel } : {}),
            },
            contextInject,
          });
          if (currentTurnConfig.persistForSession !== true) {
            writeTurnConfig(set, get, { mode: "off", persistForSession: false });
          }
          return;
        } catch (err: unknown) {
          // 续接失败显式回落新段（不静默）；消息文本还给输入框
          set({ draft: prompt.trim() !== "" ? prompt : fullPrompt });
          get().pushNotice("旧段接不回去，改为开新段", err instanceof Error ? err.message : String(err), { level: "warn" });
        }
      }
    }

    const currentTurnConfig = get().turnContextConfig;
    const turnManifest = resolveEffectiveTurnManifest(currentTurnConfig, unit?.contextManifest, true);
    let contextManifestOverride: ContextManifest | undefined = undefined;
    if (currentTurnConfig.mode === "off" || turnManifest === null) {
      contextManifestOverride = { ...LEGACY_CONTEXT_MANIFEST, firstTurnInject: false };
    } else if (currentTurnConfig.mode === "custom") {
      contextManifestOverride = { ...turnManifest, firstTurnInject: true };
    }

    let session: Awaited<ReturnType<RuntimeAdapter["startSession"]>>;
    try {
      session = await adapter.startSession({
        unit,
        prompt: fullPrompt,
        model,
        // ADR 0012 谱系延续：上一段存在（含已 done/failed —— 对话线不因段终结而断）
        // 就把它的谱系 id 传给新段；worktree 分支显式开新谱系
        conversationId:
          opts?.worktree === undefined && active !== undefined
            ? (active.conversationId ?? active.id)
            : undefined,
        // ADR 0012 携带上文切换（opt-in）：把上一段的只读转录交给新执行器
        handoff:
          get().handoffOnSwitch && opts?.worktree === undefined && active !== undefined
            ? { fromSessionId: active.id }
            : undefined,
        // 仅源代码管理面板显式传入：在此工作树开新会话（ADR 0008）
        worktree: opts?.worktree,
        loop,
        // ADR 0014：注入清单权威在 bot.json（daemon 自读），前端不再传全局 scopes
        memoryOptions: opts?.memoryOptions,
        attachments,
        contextManifestOverride,
      });
      if (currentTurnConfig.persistForSession !== true) {
        writeTurnConfig(set, get, { mode: "off", persistForSession: false });
      }
    } catch (err: unknown) {
      fail(err);
      return;
    }

    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }));

    // 用户消息是时间线的第一行（ZCode：右对齐的用户气泡）。
    pushUserBubble(session.id);
    markSessionViewed(session.id);
  },

  /**
   * 重新探测执行器 —— 探测**连接状态**，顺带把模型清单也带回来。
   *
   * 为什么必须顺带：daemon 侧好几个 adapter 的 `probe()` 里会 `void this.syncModels()`
   * （codex / grok / opencode / pi），也就是用户按这一下，daemon 的模型清单**确实变了**。
   * 但以前前端这里只 `setState(probe.state)`，从不取回模型 —— 用户看到的就是
   * 「我明明点了刷新，界面纹丝不动」。
   *
   * 所以探完必须再走一次 syncModelsAll：两条路最终收敛到同一份清单，
   * 用户按哪个按钮都不再是「白按」。
   */
  probeAll: async () => {
    for (const entry of get().runtimes) {
      void runtimeRegistry
        .getOrCreate(entry.id)
        .then((adapter) => adapter.probe())
        .then((probe) => runtimeRegistry.setState(entry.id, probe.state))
        .catch(() => undefined);
    }
    await Promise.resolve();
    await get().syncModelsAll();
  },

  /**
   * 重新探测模型清单 —— 与 probeAll **完全独立**的一条路。
   *
   * 原先模型刷新寄生在执行器探测里（daemon 的 probe 顺带调 syncModels），
   * 刷新结果只留在 daemon 进程内存里回不到界面，于是「订阅里新出了模型」永远看不见。
   * 现在一次 RPC 同时拿回报告和刷新后的完整清单，就地更新注册表，界面立刻变。
   *
   * 零用量：daemon 侧只跑只读列清单命令或读本地目录文件。
   */
  syncModelsAll: async () => {
    if (get().syncingModels) return;
    set({ syncingModels: true });
    try {
      const { syncDaemonModels } = await import("../adapters/daemon/client.ts");
      const { report, adapters } = await syncDaemonModels();
      const byId = new Map(adapters.map((a) => [a.id, a]));
      const cachedById = new Map(report.map((r) => [r.runtimeId, r.cachedAt]));
      const changed: string[] = [];
      const retired: string[] = [];
      for (const entry of runtimeRegistry.list()) {
        const bare = entry.id.replace(/^daemon:/, "");
        const fresh = byId.get(bare) ?? byId.get(entry.id);
        if (fresh === undefined) continue;
        // daemon 侧模型 id 是裸 string，注册表要的是带品牌的 ModelId —— 在这里归一，
        // 别让类型品牌泄漏成「每个调用点各写一遍 asModelId」
        const raw = fresh.models.map((m) => ({ ...m, id: asModelId(m.id) }));
        // cachedAt 决定这一轮能不能动失效模型：有值 = daemon 没能真探到，
        // 沿用的是上次的清单，此时隐藏/退役一律不生效（否则一次网络抖动
        // 就会让用户可选的模型凭空消失）。
        const cachedAt = fresh.modelsCachedAt ?? cachedById.get(fresh.id) ?? cachedById.get(bare);
        const hadRetired = entry.retiredModels.length;
        if (runtimeRegistry.updateModels(entry.id, raw, fresh.modelsDiscoverable !== false, cachedAt)) {
          changed.push(fresh.displayName);
        }
        const nowRetired = runtimeRegistry.get(entry.id)?.retiredModels.length ?? 0;
        if (nowRetired > hadRetired) retired.push(fresh.displayName);
      }
      set({
        modelSync: { at: Date.now(), report: [...report] },
      });
      // 已选模型的悬空校验交给 runtimeRegistry.subscribe —— updateModels 内部会 emit，
      // 那里统一处理「选中的模型已不在新清单里」的回落，这里不再重复一份逻辑。
      console.info(
        `[workbench] 模型清单已刷新：${report.filter((r) => r.source === "live").length}/${report.length} 家来自实时探测` +
          (changed.length > 0 ? `，更新：${changed.join("、")}` : "，清单无变化") +
          (retired.length > 0 ? `，检测到失效模型：${retired.join("、")}` : ""),
      );
    } catch (err: unknown) {
      console.info("[workbench] 模型刷新失败（执行器不可达？）", err instanceof Error ? err.message : err);
      set({ modelSync: { at: Date.now(), report: [], error: err instanceof Error ? err.message : String(err) } });
    } finally {
      set({ syncingModels: false });
    }
  },

}));


/** 已挂事件消费循环的适配器 —— 每个 CLI 一条，进程内不重复挂（多挂会分抢单队列） */
const consumerAttached = new WeakSet<RuntimeAdapter>();

/**
 * 本端待回声窗口（ADR 0012 review 修复）：pushUserBubble 本地合成时登记，
 * daemon 的用户轮回显到达时消费一条。只滤**自己的回声**——渠道/其他端发起的
 * 用户轮（askBot 续聊、断线期间的 IM 消息回放）照常渲染，不会被全局过滤吞掉。
 * 匹配用「同会话 + 文本相等或前缀（附件拼进 fullPrompt 的场景）」。
 */
const pendingEcho: Array<{ sessionId: string; text: string; at: number; itemId: number }> = [];

function registerEcho(sessionId: SessionId, text: string, itemId: number): void {
  pendingEcho.push({ sessionId: String(sessionId), text, at: Date.now(), itemId });
  while (pendingEcho.length > 8) pendingEcho.shift();
  const cutoff = Date.now() - 30_000;
  while (pendingEcho.length > 0 && (pendingEcho[0]?.at ?? Infinity) < cutoff) pendingEcho.shift();
}

function consumeEcho(event: RuntimeEvent): boolean {
  if (event.type !== "message.delta") return false;
  const idx = pendingEcho.findIndex(
    (p) =>
      p.sessionId === String(event.sessionId) &&
      (event.text === p.text || (p.text !== "" && event.text.startsWith(`${p.text}\n`))),
  );
  if (idx < 0) return false;
  const entry = pendingEcho[idx]!;
  pendingEcho.splice(idx, 1);
  // 回声不是白丢：把 daemon 侧的真实 messageId 回填给本地气泡 —— 分叉锚点
  // （ADR 0013）要拿它去账本定位轮边界，本地合成的 `u${seq}` 假 id 查不到。
  useWorkbench.setState((s) => ({
    timeline: s.timeline.map((t) =>
      t.id === entry.itemId && t.event.type === "message.delta"
        ? { ...t, event: { ...t.event, messageId: event.messageId } }
        : t,
    ),
  }));
  return true;
}

/** 输入历史上限（终端 shell 的 HISTSIZE 同位） */
const INPUT_HISTORY_CAP = 200;

/** 追加一条输入历史：空串不入史、连续重复去重、超限掐头 */
function pushInputHistory(text: string): void {
  const t = text.trim();
  if (t === "") return;
  useWorkbench.setState((s) => {
    if (s.inputHistory[s.inputHistory.length - 1] === t) return {};
    const next = [...s.inputHistory, t];
    if (next.length > INPUT_HISTORY_CAP) next.splice(0, next.length - INPUT_HISTORY_CAP);
    return { inputHistory: next };
  });
}

/** 归一化 turn 完成态 → 契约 SessionStatus */
function mapTurnStatus(raw: string): SessionStatus {
  if (raw.startsWith("failed")) return "failed";
  if (raw === "idle" || raw === "running" || raw === "done" || raw === "awaiting_permission" || raw === "awaiting_input") return raw;
  return "running";
}

/**
 * 执行器/会话切换门禁（ADR 0012 原 idle-only；底栏任务栏上线后放宽）：
 * 只拦「对话在等你回答」（awaiting_permission / awaiting_input）—— 那是当前
 * 视图里挂着的问题，切走会把待决问题藏起来（底栏琥珀灯会提醒，但对话内的
 * 裁决弹层/输入请求只有回到现场才能处理）。运行中不再拦：会话在 daemon 侧
 * 继续跑，底栏条目跟踪它的状态，openSession 谱系回放随时可切回。
 * RuntimePicker 与 ⌘K 两处入口共用这一份判定。
 */
export function runtimeSwitchBlocked(s: { activeSessionId: SessionId | null; sessions: readonly { id: SessionId; status: SessionStatus }[] }): boolean {
  const active = s.activeSessionId !== null ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined;
  return active !== undefined && (active.status === "awaiting_permission" || active.status === "awaiting_input");
}

/** 归一化事件流消费循环 —— UI 唯一的数据入口。每适配器挂一次，跨轮次常驻。 */
function consumeEvents(adapter: RuntimeAdapter): void {
  if (consumerAttached.has(adapter)) return;
  consumerAttached.add(adapter);
  void (async () => {
    for await (const event of adapter.events()) {
      // 用户轮回显：只丢「本端刚发的那条」（回声窗口匹配）——本地 pushUserBubble
      // 已渲染且带附件 chips。窗口不匹配的用户轮（渠道发起、断线期间其他端的
      // 消息经 resync 补拉）照常渲染，不再全局丢弃（review P1）。
      if (event.type === "message.delta" && event.role === "user" && consumeEcho(event)) continue;
      useWorkbench.setState((s) => {
        // 谱系过滤（底栏任务栏的配套）：时间线只收「活跃视图」的事件。规则：
        // 台账已认识、又不是活跃会话的 → 丢弃（被切走的运行中对话不再把事件
        // 灌进新视图 —— 它的流由任务栏 useTaskbar 跟踪，回来时 openSession 的
        // 谱系回放整段重建，不丢数据）；台账不认识的 → 收（run() 的 fork/续聊
        // 开新段流程在 startSession 的 await 期间就要靠泵实时入账，那时
        // activeSessionId 还没翻过去，fork 落位的 fresh 过滤依赖这些行已在）。
        if ("sessionId" in event) {
          const sid = String(event.sessionId);
          const isActive = s.activeSessionId !== null && String(s.activeSessionId) === sid;
          if (!isActive && s.sessions.some((x) => String(x.id) === sid)) return {};
        }
        return { timeline: [...s.timeline, { id: ++seq, event, at: Date.now() }] };
      });
      // 会话生命周期回写：status 变化 / ended → sessions[].status + busy
      if (event.type === "session.status") {
        const status = mapTurnStatus(event.status);
        useWorkbench.setState((s) => ({
          sessions: s.sessions.map((x) => (x.id === event.sessionId ? { ...x, status } : x)),
          // busy 镜像活跃会话的 running，双向都要写：此前只写 false，队列自动
          // 出队 / 其他端起的新轮在跑时界面显示空闲、发送键还能再按
          ...(s.activeSessionId === event.sessionId ? { busy: status === "running" } : {}),
        }));
      }
      if (event.type === "session.ended") {
        useWorkbench.setState((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === event.sessionId ? { ...x, status: event.reason === "error" ? ("failed" as const) : ("done" as const), endedAt: Date.now() } : x,
          ),
          // 同上：后台会话终结不该把活跃对话的 busy 误清
          ...(s.activeSessionId === event.sessionId ? { busy: false } : {}),
        }));
      }
      if (event.type === "permission.resolved") {
        useWorkbench.setState((s) => ({
          permissionDecisions: {
            ...s.permissionDecisions,
            [event.requestId]: event.decision,
          },
        }));
      }
      // message.completed 只复位**活跃会话**的 busy —— 无条件复位会被后台
      // （自动化/其他渠道）会话的消息完成事件把正在跑的对话误清成空闲
      if (event.type === "message.completed") {
        useWorkbench.setState((s) => (s.activeSessionId === event.sessionId ? { busy: false } : {}));
      }
      // steer 队列权威快照：队列 UI 的唯一数据源（免增量对账）
      if (event.type === "steer.queue") {
        useWorkbench.setState((s) => ({
          steerQueues: {
            ...s.steerQueues,
            [String(event.sessionId)]: { items: event.items, paused: event.paused },
          },
        }));
      }
      if (event.type === "steer.undelivered") {
        useWorkbench.setState((s) => ({
          steerQueues: {
            ...s.steerQueues,
            [String(event.sessionId)]: { items: [], paused: false },
          },
        }));
        // 文本如实带出来：这是把消息还给用户的唯一渠道（队列清了，草稿没了）
        const brief = event.inputs
          .map((t) => {
            const flat = t.replace(/\s+/g, " ").trim();
            return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
          })
          .join(" ／ ");
        useWorkbench.getState().pushNotice(
          "有排队消息没能投递",
          `会话已结束，${event.inputs.length} 条待发送消息未发出：${brief}。可复制回输入框重发。`,
          { level: "warn" },
        );
      }
      // usage = 上下文容量徽标数据面（只记最近一次，不累计 —— 每轮 input 都含全部历史）
      if (event.type === "usage") {
        useWorkbench.setState((s) => ({
          usageBySession: {
            ...s.usageBySession,
            [String(event.sessionId)]: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
              ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
              model: event.model,
              at: Date.now(),
            },
          },
        }));
      }
      if (event.type === "deliverable") {
        useWorkbench.setState((s) => ({
          deliverables: [
            {
              id: `d${seq}`,
              unitId: event.unitId,
              sessionId: event.sessionId,
              title: event.title,
              kind: event.kind,
              path: event.path,
              url: event.url,
              createdAt: Date.now(),
            },
            ...s.deliverables,
          ],
        }));
      }
    }
  })();
}

// 镜像注册表状态到 store。
// 注意：订阅回调里只做「读状态 → 写 store」，绝不能在里面再触发注册表变更，
// 否则会自触发成死循环。探测因此放在下面的独立一次性任务里。
runtimeRegistry.subscribe((runtimes) => {
  // 给还没选过模型的执行器补上它的默认模型。
  // 缺了这一步，用户第一次打开模型下拉会看到「未选模型」，
  // 而模型在 StartSessionRequest 里是必填的 —— 就成了个死路。
  //
  // ⚠ 已选模型的悬空**不再就地改回默认**（原先会）。
  // 以前这里 `else if (!r.models.some(...)) patch[r.id] = r.defaultModel`，
  // 于是模型被下线时，用户以为自己在用 opus，实际已经悄悄跑成列表第一个
  // （codex 实测就是旗舰档 gpt-6-astra，$10/$50 per MTok）。
  // 模型下线不是用户的错，不该在他不知情时换掉他正在用的东西：
  // 现在保持选中，交给 UI 标「不可用」，由他决定换不换。
  // 判据用 visibleModelsFor 而不是 r.models —— 用户自己添加的自定义模型
  // 不在 r.models 里，但它可选，不该被判成失效。
  const state = useWorkbench.getState();
  const cur = state.runtimeModels;
  const patch: Record<string, ModelId> = {};
  for (const r of runtimes) {
    if (cur[r.id] === undefined) patch[r.id] = r.defaultModel;
  }
  if (Object.keys(patch).length > 0) {
    useWorkbench.setState((s) => ({ runtimeModels: { ...s.runtimeModels, ...patch } }));
  }
  useWorkbench.setState({ runtimes });
});

// 一次性探测所有运行时的连接状态（各自独立 await，互不阻塞）
void (async () => {
  for (const entry of runtimeRegistry.list()) {
    void runtimeRegistry
      .getOrCreate(entry.id)
      .then((adapter) => adapter.probe())
      .then((probe) => runtimeRegistry.setState(entry.id, probe.state))
      .catch((err: unknown) =>
        runtimeRegistry.setState(entry.id, {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }
})();

export const selectActiveUnit = (s: WorkbenchState): WorkUnit | undefined =>
  s.units.find((u) => u.id === s.activeUnitId);

export const selectActiveRuntime = (s: WorkbenchState): RuntimeEntry | undefined =>
  s.runtimes.find((r) => r.id === s.activeRuntimeId);

/**
 * 用户是否**主动**把这个模型从选择器里藏了。
 *
 * 与「模型失效」是两回事，必须分开判：藏是明确意图，该尊重；失效是模型下线，
 * 不是用户的选择，不该因此偷换他正在用的模型。见 send() 里的回落注释。
 */
export function isHiddenByUser(
  s: WorkbenchState,
  runtimeId: string,
  modelId: string,
): boolean {
  return prefsOf(s.modelPrefs, runtimeId).hiddenModels.includes(asModelId(modelId));
}

/**
 * 某个模型 id 在该执行器当前**是否还可选**。
 *
 * 四个下拉框（设置页 / 待办 / 定时任务 / 提议横幅）共用这一个判据，
 * 免得各写一套又漂移 —— 只要有一个地方没接上，「隐藏失效模型」就漏了。
 *
 * 判据走 visibleModelsFor 而非 runtime.models：用户自己添加的自定义模型
 * 不在执行器申报清单里，但它照样可选，不该被判成失效。
 */
export function isModelAvailable(
  s: WorkbenchState,
  runtimeId: string,
  modelId: string | null | undefined,
): boolean {
  if (modelId === null || modelId === undefined || modelId === "") return false;
  return visibleModelsFor(s, runtimeId).some((m) => m.id === modelId);
}

/**
 * 取模型的展示 spec —— 当前清单里没有就退到失效留档，再没有才查本地目录。
 *
 * 失效留档这一步不能省：动态发现的新模型不在本地目录里，只查目录会返回
 * undefined，UI 上就只剩一个空气 id，用户完全不知道自己在选什么。
 */
export function modelSpecFor(
  runtime: RuntimeEntry | undefined,
  modelId: ModelId | null | undefined,
): ModelSpec | undefined {
  if (runtime === undefined || modelId === null || modelId === undefined) return undefined;
  return (
    runtime.models.find((m) => m.id === modelId) ??
    runtime.retiredModels.find((m) => m.id === modelId) ??
    modelById(modelId)
  );
}

/** 当前执行器 + 当前模型。composer 与能力展示都读它 */
export const selectActivePair = (
  s: WorkbenchState,
): {
  readonly runtime?: RuntimeEntry;
  readonly model?: ModelSpec;
  readonly modelId: ModelId | null;
  /** false = 用户选的模型已经失效。UI 必须标出来，绝不能静默换掉。 */
  readonly modelAvailable: boolean;
} => {
  const runtime = s.runtimes.find((r) => r.id === s.activeRuntimeId);
  const visible = runtime ? visibleModelsFor(s, s.activeRuntimeId) : [];
  const raw = s.runtimeModels[s.activeRuntimeId] ?? runtime?.defaultModel ?? null;
  // 保持用户选的那个 —— 失效也保持（原先在这里静默回落到 visible[0]，
  // 于是模型一被下线，用户以为在用 opus，实际悄悄跑的是列表第一个）。
  // 只有「压根没选过」才退到清单第一个。
  const modelId = raw ?? (visible[0]?.id ?? null);
  return {
    runtime,
    model: modelSpecFor(runtime, modelId),
    modelId,
    modelAvailable: isModelAvailable(s, s.activeRuntimeId, modelId),
  };
};

/** 某个 CLI 的有效模型清单。⚠ 返回引用稳定的数组（见 visibleModelsFor 的注释） */
export const selectVisibleModels =
  (runtimeId: string) =>
  (s: WorkbenchState): readonly ModelSpec[] =>
    visibleModelsFor(s, runtimeId);

/**
 * 当前工作单元下的会话列表，按最近更新倒序。
 * ⚠️ 返回新数组，必须配 useShallow。
 */
export const selectUnitSessions = (s: WorkbenchState): readonly Session[] =>
  s.sessions
    .filter((x) => x.unitId === s.activeUnitId)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);

export type { SessionId };

/** 当前工作单元的自动化，bot视图下最关心的一组 */
export const selectUnitAutomations = (s: WorkbenchState): readonly Automation[] =>
  s.automations.filter((a) => a.unitId === s.activeUnitId);

// 注册执行器 bootstrap —— 必须在 store 创建之后（要校正 activeRuntimeId）：
// 优先本地 daemon（真实执行），不可达时回退 mock（纯 UI 原型，daemon 没起是正常态）。
//
// ⚠ 必须重试：`pnpm dev` 下 vite 0.5s 就绪而 daemon 还要再起一会儿，页面先开就
// 撞上竞态；单次尝试失败会让执行器列表永远空着（「没有已注册的执行器」），
// 用户只能手动刷新。重试让竞态自愈。
//
// ⚠ 间隔必须**短间隔起步、指数退避**，不能是固定 3s。去掉 daemon 启动预热之后，
// 冷启动的 db→listening 实测只有 37ms，tsx 进程本身几百毫秒也就起来了 ——
// 也就是说「页面已加载但 daemon 还没监听」这个窗口通常不到一秒。固定 3s 会让用户
// 盯着一个空的执行器列表白等整整一轮，而实际差距可能只有 200ms。
// 封顶仍留 3s：daemon 真没起（被占用/崩溃）时，长间隔避免无谓重试风暴，
// 总时长仍在两分钟内自愈。
//
// ⚠ 快速退避段（前 40 次，约两分钟）耗尽后**不永久放弃**：转入封顶间隔的
// 慢速重试一直试下去。放弃的话「只起前端」的用户后来起了 daemon 也要手动刷新
// 才接入（注册表空转）；慢速重试让「连上即自动接入」成立，代价只是后台每 3s
// 一次失败连接尝试（对未监听端口是一次立刻失败的 fetch，可忽略）。
const RETRY_DELAYS_MS = [150, 300, 600, 1200, 3000] as const;
const FAST_ATTEMPTS = 40;
void (async () => {
  const { listDaemonExecutors } = await import("../adapters/daemon/client.ts");
  const { createDaemonFactory } = await import("../adapters/daemon/adapter.ts");
  const { defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");

  let infos: Awaited<ReturnType<typeof listDaemonExecutors>> | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      const list = await listDaemonExecutors(defaultDaemonEndpoint());
      if (list.length > 0) {
        infos = list;
        break;
      }
      // daemon 已监听但清单为空：注册在 listen 前同步完成，理论不可达——按失败重试
      throw new Error("daemon 无可用执行器");
    } catch (err: unknown) {
      if (attempt === 1) {
        console.info("[workbench] daemon 未就绪，按退避节奏重试（pnpm dev 下 daemon 比 vite 慢是常态）", err instanceof Error ? err.message : err);
      }
      if (attempt === FAST_ATTEMPTS) {
        console.info("[workbench] 本地 daemon 不可达 —— 转入慢速重试，连上即自动接入（无需刷新页面）", err instanceof Error ? err.message : err);
        // 界面跟着翻：启动遮罩早已收起，底栏挂「daemon 未连接」徽标（不挡操作）
        useWorkbench.setState({ daemonStatus: "offline" });
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!));
    }
  }
  if (infos === null) return;
  try {
    const factories = infos.map((info) => createDaemonFactory(info, defaultDaemonEndpoint()));
    runtimeRegistry.registerAll(factories);
    // 登记各家能否动态发现模型：没实现的执行器，模型按钮对它无效 —— 界面要照实标，
    // 否则用户对着一个从不变的列表反复按刷新，还以为是自己没刷新对
    for (const info of infos) {
      runtimeRegistry.markModelDiscovery(asRuntimeId(`daemon:${info.id}`), info.modelsDiscoverable !== false);
    }
    runtimeRegistry.setState(factories[0]!.id, { status: "stopped" });
    useWorkbench.setState({ activeRuntimeId: factories[0]!.id, daemonStatus: "connected" });
    console.info(`[workbench] 已连接本地 daemon：${infos.map((i) => i.id).join(", ")}`);
    // 哪些模型本地元数据目录没收 —— **说出来**。
    // 原来的坑：查不到就静默丢弃，models 空了 → defaultModel 为 null → 整个
    // 执行器从列表里消失，控制台一个错都没有。现在降级显示（价格显示为未知），
    // 必须留痕，否则「加了个执行器但界面看不到」只能靠猜。
    //
    // 判据用 vendor === "custom" 而非文案：scaffoldModel 造的占位一律 vendor=custom，
    // 用户自己添加的自定义模型也是。绑死中文字符串的话，下次改文案这里就静默失配。
    //
    // 放在这里而不是 subscribe 里：registerAll 每注册一个就 emit 一次，
    // 在回调里打会把同一条消息刷 8 遍。
    const unlisted = runtimeRegistry
      .list()
      .flatMap((r) => r.models.filter((m) => m.vendor === "custom" && m.source === "").map((m) => `${r.presentation.displayName}/${m.id}`));
    if (unlisted.length > 0) {
      console.info(
        `[workbench] ${unlisted.length} 个模型本地目录没收录，已降级显示（价格/窗口为未知）：${unlisted.join("、")}` +
          ` —— 补进 core/models.ts 的 MODELS 就能拿到价格与档位`,
      );
    }
    // WP-5：daemon 可达时合并落盘 bot 定义（bot.json 是家，store 只是运行态视图）
    try {
      const { listBotDefinitions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const defs = (await listBotDefinitions(defaultDaemonEndpoint())) as WorkUnit[];
      // 评审 P2：bot.json 手可编辑——缺 bindings/kind 的半成品合并进来会把
      // 绑定/渠道渲染搞出 TypeError，最小必填面守卫不合格即跳过
      const valid = defs.filter(
        (d) =>
          typeof d.id === "string" &&
          typeof d.rootPath === "string" &&
          typeof d.name === "string" &&
          Array.isArray(d.bindings) &&
          (d.kind === "bot" || d.kind === "project"),
      );
      const skipped = defs.length - valid.length;
      if (valid.length > 0) {
        const current = useWorkbench.getState().units;
        const merged = [...current.filter((u) => !valid.some((d) => d.id === u.id)), ...valid];
        const curActive = useWorkbench.getState().activeUnitId;
        const defaultActive = merged.some((u) => u.id === curActive && u.id !== "")
          ? curActive
          : (merged.find((u) => u.id === "steward")?.id ?? merged[0]?.id ?? asUnitId(""));
        useWorkbench.setState({ units: merged, activeUnitId: defaultActive });
        // 启动恢复的活跃 bot 若有主绑定执行器，跟着对齐（selectUnit 的口径；
        // 此时时间线/会话都还是初始空值，顺带的清空没有副作用）
        useWorkbench.getState().selectUnit(defaultActive);
        console.info(`[workbench] 已合并 ${valid.length} 个落盘 bot 定义${skipped > 0 ? `（跳过 ${skipped} 个不合格定义）` : ""}`);
        // 认出「哪个 bot 接的是哪个飞书机器人」。不传 profiles = 问 daemon 盘上所有
        // 已启用的飞书账号，它按 profile 去重，三个 bot 绑同一个机器人也只 spawn 一次。
        void useWorkbench.getState().refreshChannelIdentity();
      }
    } catch (err: unknown) {
      console.info("[workbench] 落盘 bot 定义首次拉取失败（daemon 未就绪？），退避重试", err instanceof Error ? err.message : err);
      // 启动竞态自愈：daemon 起得比前端慢时这里第一次拉不到，而桌面端没有别的
      // 重新拉全量的入口 —— 空列表会一直挂到手动刷新。有界退避重试拉回
      //（refreshUnits 与上面的合并同一套最小必填面守卫，成功即装填 units）。
      // 注册表真空（用户真删光了）时重试 6 次后安静放弃，不算错误。
      const retryBootMerge = (attempt: number): void => {
        if (attempt > 6 || useWorkbench.getState().units.length > 0) return;
        void useWorkbench
          .getState()
          .refreshUnits()
          .finally(() => setTimeout(() => retryBootMerge(attempt + 1), 1500 * attempt));
      };
      setTimeout(() => retryBootMerge(1), 1500);
    }
    // 自动化（Phase 5 v2）：daemon 可达时拉全量列表，页面打开即有数据
    void useWorkbench.getState().refreshAutomations();
  } catch (err: unknown) {
    // 走到这里说明连接已成功但注册/后续装配失败——与「daemon 不可达」不同源
    console.error("[workbench] 执行器注册失败（daemon 连接是好的，查 registerAll 装配链）", err instanceof Error ? err.message : err);
  }
})();
