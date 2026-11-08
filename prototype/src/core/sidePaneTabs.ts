/**
 * 右侧标签面板的领域契约 —— 纯函数，不碰 React / DOM / store。
 *
 * 形态照搬 ZCode 的 `packages/ui/src/lib/workspaceSidePane.ts`，按本产品的体量裁剪。
 * 上一版右栏（IDE 式 19-tab）死于「只切状态、没人渲染」，本版只服务真实入口。
 * unit 级 tab：历史会话（弹窗迁移）、会话实时监控（后台会话事件流跟随）、
 * 计划 / 任务进度（活跃会话的 plan 事件）、变更审查（工作目录改动面）、
 * bot 设置（原上下文清单）、git 提交图（原弹窗）。
 * workspace 级 tab（切 bot 不消失）：通知中心（daemon 事件聚合面）、新建 bot、
 * 源代码管理（分支 / 工作树 / 改动，内容跟随激活单元，2026-11-06 归拢自主视图）。
 *
 * 抄下来的三条关键设计，都不是样式问题而是行为问题：
 *
 * 1. **tab 有结构化身份**。id 由业务键拼出（`history:{unitId}`），同一身份重复
 *    打开只聚焦复用，不并排开两个；「多开」的语义因此是精确的 —— 不同身份才并排。
 * 2. **关掉激活 tab 时落到右邻**，不是左邻也不是第一个（ZCode 语义）。
 * 3. **tab 归属 bot（ownerUnitId）**。切 bot 时面板按当前 bot 过滤可见 tab，
 *    隐藏不销毁 —— A 的展开态/滚动位置在切回时原样恢复。
 */

import type { UnitId } from "./units.ts";

// ---------------------------------------------------------------------------
// Tab 类型
// ---------------------------------------------------------------------------

/** 一个 bot 的历史会话页（迁移自 HistoryDialog 弹窗） */
export interface HistorySidePaneTab {
  /** `history:{unitId}` —— 一个 bot 至多一个历史 tab，重复点击幂等聚焦 */
  id: string;
  type: "history";
  ownerUnitId: UnitId;
  /** 打开时冻结的展示名，仅作 tab 标题；重名/改名以 unitId 为准 */
  unitName: string;
  /** 侧栏子列表点进来时预展开的条目键。缺席 = 不落点（复用 tab 时会清掉旧落点） */
  focusKey?: string;
  openedAt: number;
}

/**
 * 会话实时监控页（ZCode bash-output / subagent-session 的对位）：跟随一个
 * 后台会话的事件流（自动化定时任务、待办长任务、IM 渠道发起的会话在跑的
 * 过程中就能看，不必等结束后翻历史）。数据面：DaemonClient 原始广播 +
 * session.events.since 补拉 —— 不走 RuntimeAdapter（适配器只投递本端发起
 * 的会话，后台会话进不了它的 #sessions 集）。
 */
export interface LiveSessionSidePaneTab {
  /** `live:{sessionId}` —— 一个会话至多一个监控 tab */
  id: string;
  type: "live";
  ownerUnitId: UnitId;
  /** 监控的目标会话（daemon 台账口径的 id 字符串） */
  sessionId: string;
  /** 裸执行器名（台账口径），仅展示用 */
  runtimeId: string;
  /** 打开时冻结的会话标题快照，仅作 tab 标题 */
  title: string;
  openedAt: number;
}

/**
 * 计划 / 任务进度页（ZCode plan-detail 的对位）：跟随当前 bot 活跃会话的
 * plan.proposed / plan.step.updated / plan.resolved 事件，把计划抽成常驻
 * 可视面 —— 一边让它干活一边在旁边看进度，不用滚动时间线。跟随目标由渲染
 * 层解析（活跃会话优先，无则落最近一条有 id 的历史会话），tab 本身只锚 unit。
 */
export interface PlanSidePaneTab {
  /** `plan:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "plan";
  ownerUnitId: UnitId;
  unitName: string;
  openedAt: number;
}

/**
 * 变更审查页（ZCode git 的对位）：当前 bot 工作目录的改动面（暂存 / 未暂存 /
 * 未跟踪 + 行内展开 diff），「对话在左、改动在右」。数据面复用 useGitChanges
 * 单槽 store（与提交对话框、源代码管理页同一份数据，三处口径必须一致）。
 */
export interface DiffSidePaneTab {
  /** `diff:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "diff";
  ownerUnitId: UnitId;
  unitName: string;
  openedAt: number;
}

/**
 * 通知中心页（workspace 级，本项目差异化能力 —— ZCode 只有声音/角标，没有
 * 通知面板）：聚合 daemon 的会话终态 / 权限请求 / 错误 / 系统通知 / 待办信号 /
 * git 变更节流。数据面在 store/useNotifications.ts；tab 本身是全工作台单例，
 * 不归属任何 bot（tabScope === "workspace"）。
 */
export interface NotificationsSidePaneTab {
  /** 固定 `notify:workspace` —— 全工作台至多一个通知 tab */
  id: string;
  type: "notify";
  openedAt: number;
}

/**
 * 上下文清单页（ADR 0014 / docs/20）：当前 bot 的注入矩阵——AGENTS.md 三态 +
 * SOUL / USER / 记忆各柱 / 预设 + SOUL.md 编辑器。「这个 bot 到底知道什么」的
 * 唯一管理面；Composer 的记忆选择器是它两根柱的快捷方式。
 */
export interface ContextSidePaneTab {
  /** `context:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "context";
  ownerUnitId: UnitId;
  unitName: string;
  openedAt: number;
}

/**
 * 新建 bot 页（2026-10-23 归拢自弹窗）：workspace 级单例——AddBotDialog 新建态的
 * 右栏宿主（编辑/设置早已是 context tab）。
 */
export interface NewBotSidePaneTab {
  id: "newbot";
  type: "newbot";
  openedAt: number;
}

/**
 * 源代码管理页（2026-11-06 归拢自主视图）：激活单元仓库的「仓库总管」——
 * 分支 / 工作树 / 改动（ADR 0008 / 0010）。workspace 级单例：内容跟随当前
 * 激活单元换仓（渲染层 selectActiveUnit，与主视图时代同一语义），tab 本身
 * 不归属任何 bot —— 切 bot 不换 tab，只换仓库。
 */
export interface SourceControlSidePaneTab {
  /** 固定 `scm:workspace` —— 全工作台至多一个 */
  id: string;
  type: "scm";
  openedAt: number;
}

/**
 * git 提交图页（2026-10-23 归拢自 GitGraphDialog 弹窗）：按 bot 一个，
 * rootPath/branchName 打开时冻结（重开刷新）。
 */
export interface GitGraphSidePaneTab {
  /** `gitgraph:{unitId}` —— 一个 bot 至多一个 */
  id: string;
  type: "gitgraph";
  ownerUnitId: UnitId;
  unitName: string;
  rootPath: string;
  branchName: string | null;
  openedAt: number;
}

export type SidePaneTab =
  | HistorySidePaneTab
  | LiveSessionSidePaneTab
  | PlanSidePaneTab
  | DiffSidePaneTab
  | NotificationsSidePaneTab
  | ContextSidePaneTab
  | NewBotSidePaneTab
  | GitGraphSidePaneTab
  | SourceControlSidePaneTab;

/**
 * tab 的作用域。unit 级归属某个 bot（切 bot 隐藏不销毁）；workspace 级属于整个
 * 工作台（任何 bot 视角下恒可见 —— ZCode 的 git / developer-tools 同款通道）。
 */
export type SidePaneTabScope = "unit" | "workspace";

/** workspace 级 tab 的 type 白名单单源（tabScope / isUnitTab / 窄类型都从这里派生）——
 *  新增 workspace 级 tab 只改这一处 */
const WORKSPACE_TAB_TYPES = ["notify", "newbot", "scm"] as const satisfies readonly SidePaneTab["type"][];
type WorkspaceTabType = (typeof WORKSPACE_TAB_TYPES)[number];

/** unit 级 tab 的窄类型（带 ownerUnitId）—— 类型守卫给 TS 收窄用，语义同 tabScope */
export type UnitScopedSidePaneTab = Exclude<SidePaneTab, { type: WorkspaceTabType }>;

export function isUnitTab(tab: SidePaneTab): tab is UnitScopedSidePaneTab {
  return !(WORKSPACE_TAB_TYPES as readonly string[]).includes(tab.type);
}

export function tabScope(tab: SidePaneTab): SidePaneTabScope {
  return isUnitTab(tab) ? "unit" : "workspace";
}

export interface SidePaneState {
  tabs: SidePaneTab[];
  /** 当前聚焦的 tab；空串 = 无聚焦（面板应收起） */
  activeTabId: string;
}

export const EMPTY_SIDE_PANE_STATE: SidePaneState = { tabs: [], activeTabId: "" };

export interface OpenHistoryTabRequest {
  unitId: UnitId;
  unitName: string;
  focusKey?: string;
}

export const historyTabId = (unitId: UnitId): string => `history:${unitId}`;
export const liveTabId = (sessionId: string): string => `live:${sessionId}`;
export const planTabId = (unitId: UnitId): string => `plan:${unitId}`;
export const diffTabId = (unitId: UnitId): string => `diff:${unitId}`;
export const contextTabId = (unitId: UnitId): string => `context:${unitId}`;
/** workspace 级单例：id 不含任何业务键 */
export const notifyTabId = "notify:workspace";

// ---------------------------------------------------------------------------
// 打开 / 关闭 / 激活
// ---------------------------------------------------------------------------

export interface OpenLiveTabRequest {
  unitId: UnitId;
  sessionId: string;
  runtimeId: string;
  title: string;
}

export interface OpenUnitTabRequest {
  unitId: UnitId;
  unitName: string;
}

/**
 * 打开（或复用）一个 bot 的历史 tab。
 *
 * 复用规则：命中同 id → 原位合并 meta 并聚焦。focusKey 是「落点」不是身份 ——
 * 请求带就落到它（侧栏再点另一条 → 已开的面板滚过去），不带就显式删键
 * （header 点开 = 不落点，与弹窗时代的「打开即无展开」语义一致）。
 * openedAt 每次刷新，UI 可据此做相对时间展示。
 */
export function openHistoryTab(
  state: SidePaneState,
  request: OpenHistoryTabRequest,
): SidePaneState {
  const id = historyTabId(request.unitId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && existing.type === "history") {
    const merged: HistorySidePaneTab = {
      ...existing,
      unitName: request.unitName,
      openedAt: Date.now(),
    };
    if (request.focusKey !== undefined) merged.focusKey = request.focusKey;
    else delete merged.focusKey;
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: HistorySidePaneTab = {
    id,
    type: "history",
    ownerUnitId: request.unitId,
    unitName: request.unitName,
    openedAt: Date.now(),
    ...(request.focusKey !== undefined ? { focusKey: request.focusKey } : {}),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/** 打开（或复用）一个会话的实时监控 tab：同会话幂等聚焦，meta 刷新 */
export function openLiveTab(state: SidePaneState, request: OpenLiveTabRequest): SidePaneState {
  const id = liveTabId(request.sessionId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && existing.type === "live") {
    const merged: LiveSessionSidePaneTab = { ...existing, title: request.title, runtimeId: request.runtimeId, openedAt: Date.now() };
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: LiveSessionSidePaneTab = {
    id,
    type: "live",
    ownerUnitId: request.unitId,
    sessionId: request.sessionId,
    runtimeId: request.runtimeId,
    title: request.title,
    openedAt: Date.now(),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/** 打开（或复用）计划 tab / 变更审查 tab：按 unit 幂等 */
export function openPlanTab(state: SidePaneState, request: OpenUnitTabRequest): SidePaneState {
  return openUnitTab(state, "plan", planTabId(request.unitId), request);
}

export function openDiffTab(state: SidePaneState, request: OpenUnitTabRequest): SidePaneState {
  return openUnitTab(state, "diff", diffTabId(request.unitId), request);
}

/** 打开（或复用）上下文清单 tab：按 unit 幂等（ADR 0014） */
export function openContextTab(state: SidePaneState, request: OpenUnitTabRequest): SidePaneState {
  return openUnitTab(state, "context", contextTabId(request.unitId), request);
}

/** 打开（或复用）新建 bot tab：workspace 级单例，幂等聚焦 */
export const NEW_BOT_TAB_ID = "newbot";
export function openNewBotTab(state: SidePaneState): SidePaneState {
  const existing = state.tabs.find((tab) => tab.id === NEW_BOT_TAB_ID);
  if (existing === undefined) {
    const tab: NewBotSidePaneTab = { id: NEW_BOT_TAB_ID, type: "newbot", openedAt: Date.now() };
    return { tabs: [...state.tabs, tab], activeTabId: NEW_BOT_TAB_ID };
  }
  return activateTab(state, NEW_BOT_TAB_ID);
}

export const gitGraphTabId = (unitId: UnitId): string => `gitgraph:${unitId}`;

/** 打开（或复用）git 提交图 tab：按 unit 幂等，重开时刷新 rootPath/branchName */
export function openGitGraphTab(
  state: SidePaneState,
  request: OpenUnitTabRequest & { rootPath: string; branchName: string | null },
): SidePaneState {
  const id = gitGraphTabId(request.unitId);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && existing.type === "gitgraph") {
    const merged: GitGraphSidePaneTab = {
      ...existing,
      unitName: request.unitName,
      rootPath: request.rootPath,
      branchName: request.branchName,
      openedAt: Date.now(),
    };
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: GitGraphSidePaneTab = {
    id,
    type: "gitgraph",
    ownerUnitId: request.unitId,
    unitName: request.unitName,
    rootPath: request.rootPath,
    branchName: request.branchName,
    openedAt: Date.now(),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/** 打开（或复用）通知中心 tab：workspace 级单例，幂等聚焦 */
export function openNotificationsTab(state: SidePaneState): SidePaneState {
  const existing = state.tabs.find((tab) => tab.id === notifyTabId);
  if (existing === undefined) {
    const tab: NotificationsSidePaneTab = { id: notifyTabId, type: "notify", openedAt: Date.now() };
    return { tabs: [...state.tabs, tab], activeTabId: notifyTabId };
  }
  return activateTab(state, notifyTabId);
}

/** 源代码管理 tab 的固定 id：workspace 级单例，id 不含任何业务键 */
export const scmTabId = "scm:workspace";

/** 打开（或复用）源代码管理 tab：workspace 级单例，幂等聚焦（内容跟随激活单元） */
export function openSourceControlTab(state: SidePaneState): SidePaneState {
  const existing = state.tabs.find((tab) => tab.id === scmTabId);
  if (existing === undefined) {
    const tab: SourceControlSidePaneTab = { id: scmTabId, type: "scm", openedAt: Date.now() };
    return { tabs: [...state.tabs, tab], activeTabId: scmTabId };
  }
  return activateTab(state, scmTabId);
}

/**
 * 尾插一个 tab 并聚焦（「最近关闭」重开的落点）。同 id 已存在只聚焦不并排 ——
 * 重开的 tab 可能与还开着的 tab 撞 id（关闭记录去重后理论上不会，防御一手）。
 */
export function insertTab(state: SidePaneState, tab: SidePaneTab): SidePaneState {
  if (state.tabs.some((t) => t.id === tab.id)) return activateTab(state, tab.id);
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

/**
 * 拖拽排序：把 tabId 挪到可见子集的第 toVisibleIndex 位。
 *
 * 只重排**当前 scope 可见**的 tab（拖拽发生在可见 tab 条上）；隐藏 tab 留在
 * 全量数组的原位（它们之间的相对顺序不变）—— 重建手法：按原数组走一遍，
 * 可见位依次取重排后的可见队列，隐藏位原样保留。scope 缺省 = 全量可见。
 */
export function moveTab(
  state: SidePaneState,
  tabId: string,
  toVisibleIndex: number,
  scopeUnitId?: UnitId | null,
): SidePaneState {
  if (!state.tabs.some((tab) => tab.id === tabId) || toVisibleIndex < 0) return state;
  const visible =
    scopeUnitId === undefined || scopeUnitId === null
      ? [...state.tabs]
      : [...visibleTabsForUnit(state.tabs, scopeUnitId)];
  const fromIndex = visible.findIndex((tab) => tab.id === tabId);
  if (fromIndex < 0) return state;
  const clamped = Math.min(toVisibleIndex, visible.length - 1);
  if (fromIndex === clamped) return state;
  const [moved] = visible.splice(fromIndex, 1);
  visible.splice(clamped, 0, moved!);
  const visibleIds = new Set(visible.map((tab) => tab.id));
  let cursor = 0;
  const tabs = state.tabs.map((tab) => (visibleIds.has(tab.id) ? visible[cursor++]! : tab));
  return { tabs, activeTabId: state.activeTabId };
}

function openUnitTab(
  state: SidePaneState,
  type: "plan" | "diff" | "context",
  id: string,
  request: OpenUnitTabRequest,
): SidePaneState {
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing !== undefined && (existing.type === "plan" || existing.type === "diff" || existing.type === "context")) {
    const merged = { ...existing, unitName: request.unitName, openedAt: Date.now() };
    return activateTab({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? merged : tab)) }, id);
  }
  const tab: PlanSidePaneTab | DiffSidePaneTab | ContextSidePaneTab = {
    id,
    type,
    ownerUnitId: request.unitId,
    unitName: request.unitName,
    openedAt: Date.now(),
  };
  return { tabs: [...state.tabs, tab], activeTabId: id };
}

/**
 * 关 tab。关的是激活 tab 时落到**右邻**（被关的是最后一个则落新的最后一个）；
 * 关非激活 tab 不动 activeTabId。清空后 activeTabId 归空串，面板自然收起。
 *
 * scopeUnitId（可选，useSidePane 传当前作用域）：右邻回落只在**该 scope 可见**
 * 的 tab 里挑 —— 关闭钮只画在可见 tab 上，但全量数组里的右邻可能归属别的 bot，
 * 落过去会「明明还开着可见 tab、面板却掉了主页」。缺省（undefined）保持全量
 * 右邻的旧语义（无 scope 的调用方）。
 */
export function closeTab(state: SidePaneState, tabId: string, scopeUnitId?: UnitId | null): SidePaneState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return { tabs, activeTabId: "" };
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  // scope 口径与 visibleTabsForUnit 一致：undefined = 无 scope 的调用方（全量
  // 右邻旧语义）；null / 具体 unit = 按该作用域的可见集回落（null只剩workspace级）
  const candidates = scopeUnitId === undefined ? tabs : visibleTabsForUnit(tabs, scopeUnitId);
  if (candidates.length === 0) return { tabs, activeTabId: "" };
  const candidateIds = new Set(candidates.map((tab) => tab.id));
  // 右邻：新数组里 closingIndex 位起第一个可见 tab；没有（后面全是别人的）则落最后一个可见 tab
  const fallback = tabs.slice(closingIndex).find((tab) => candidateIds.has(tab.id)) ?? candidates[candidates.length - 1]!;
  return { tabs, activeTabId: fallback.id };
}

export function activateTab(state: SidePaneState, tabId: string): SidePaneState {
  if (state.activeTabId === tabId || !state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

/**
 * 关闭「除 keepTabId 外的可见 tab」（ZCode closeOtherTabs 语义）：只动当前
 * 视角看得见的，其它 bot 的隐藏 tab 原样保活。keepTabId 保持激活。
 */
export function closeOtherTabs(
  state: SidePaneState,
  keepTabId: string,
  scopeUnitId?: UnitId | null,
): SidePaneState {
  if (!state.tabs.some((tab) => tab.id === keepTabId)) return state;
  const visible = scopeUnitId === undefined ? state.tabs : visibleTabsForUnit(state.tabs, scopeUnitId);
  const kill = new Set(visible.filter((tab) => tab.id !== keepTabId).map((tab) => tab.id));
  if (kill.size === 0) return state;
  return { tabs: state.tabs.filter((tab) => !kill.has(tab.id)), activeTabId: keepTabId };
}

/** 关闭当前视角的全部可见 tab（其它 bot 的隐藏 tab 保活）；全关后聚焦归空落功能主页 */
export function closeVisibleTabs(state: SidePaneState, scopeUnitId?: UnitId | null): SidePaneState {
  const visible = scopeUnitId === undefined ? state.tabs : visibleTabsForUnit(state.tabs, scopeUnitId);
  if (visible.length === 0) return state;
  const kill = new Set(visible.map((tab) => tab.id));
  const tabs = state.tabs.filter((tab) => !kill.has(tab.id));
  return { tabs, activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : "" };
}

// ---------------------------------------------------------------------------
// bot 作用域
// ---------------------------------------------------------------------------

/**
 * 当前视角可见的 tab：workspace 级恒可见（通知中心等不随 bot 切换），unit 级按
 * ownerUnitId 过滤。null 作用域（还没激活过任何 bot）只剩 workspace 级 ——
 * 面板此时本就不占位（sidePaneOccupies），这里只是保持「恒可见」语义自洽。
 */
export function visibleTabsForUnit(
  tabs: readonly SidePaneTab[],
  activeUnitId: UnitId | null,
): readonly SidePaneTab[] {
  if (activeUnitId === null) return tabs.filter((tab) => !isUnitTab(tab));
  return tabs.filter((tab) => !isUnitTab(tab) || String(tab.ownerUnitId) === String(activeUnitId));
}

/**
 * 面板当前是否**真在占位**：未收起 + 在 chat 主视图（+ 已激活过 bot）。
 *
 * 这是「占位」的唯一口径，三处共用，别各自抄一遍：
 * - `SidePaneColumn` 的 open —— 决定列渲染与窗口宽度插块；
 * - `WorkspaceHeader` 的开合钮态 —— 决定这颗钮显示展开还是收起；
 * - `toggleFromHeader` 的动作 —— 收起还是展开。
 *
 * **无可见 tab 也占位**：展开 = 功能主页（SidePaneHome）兜底，面板里直接点选
 * 要开的功能，而不是空壳或整列消失 —— 否则「展开」在零 tab 时是死点击。
 * scopeUnitId 为 null（还没激活过任何 bot）时无内容可列，不占位。
 */
export function sidePaneOccupies(
  scopeUnitId: UnitId | null,
  collapsed: boolean,
  mainViewIsChat: boolean,
): boolean {
  return !collapsed && mainViewIsChat && scopeUnitId !== null;
}

export interface SidePaneScopeResolution {
  visibleTabs: readonly SidePaneTab[];
  /** 解析后的聚焦 tab；空串 = 无可聚焦（面板落功能主页） */
  activeTabId: string;
}

/**
 * 切 bot 时解析面板状态（对齐 ZCode 的 resolveSidePaneScopeState）。
 *
 * 聚焦优先级：该 bot 上次聚焦的 tab（lastActiveTabByUnit 记忆）→ 沿用当前
 * activeTabId（若在新 scope 里可见）→ 最后一个可见 tab。
 *
 * 收起/展开不在解析职责内：无可见 tab 时聚焦归空串、面板落功能主页 ——
 * 用户的开合偏好（两个方向）都不该被切换动作翻掉。
 */
export function resolveScopeOnUnitChange(
  state: SidePaneState,
  activeUnitId: UnitId,
  lastActiveTabByUnit: Readonly<Record<string, string>>,
): SidePaneScopeResolution {
  const visibleTabs = visibleTabsForUnit(state.tabs, activeUnitId);
  if (visibleTabs.length === 0) {
    return { visibleTabs, activeTabId: "" };
  }
  const preferred = lastActiveTabByUnit[String(activeUnitId)];
  const next =
    (preferred !== undefined && visibleTabs.some((tab) => tab.id === preferred) ? preferred : undefined) ??
    (visibleTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : undefined) ??
    visibleTabs[visibleTabs.length - 1]!.id;
  return { visibleTabs, activeTabId: next };
}

/**
 * bot 注销回收（daemon 侧 bot 定义消失时）：清掉不再有主的 tab。workspace 级
 * tab 没有主人、也永不失主，跳过回收。不做任何「顺手迁移」—— 被回收 bot 的
 * tab 没有新的归属，直接删。
 */
export function releaseUnits(
  state: SidePaneState,
  validUnitIds: readonly UnitId[],
): SidePaneState {
  const valid = new Set(validUnitIds.map(String));
  const tabs = state.tabs.filter((tab) => !isUnitTab(tab) || valid.has(String(tab.ownerUnitId)));
  if (tabs.length === state.tabs.length) return state;
  if (tabs.some((tab) => tab.id === state.activeTabId)) return { tabs, activeTabId: state.activeTabId };
  return { tabs, activeTabId: "" };
}
