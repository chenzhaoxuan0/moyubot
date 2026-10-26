import { create } from "zustand";
import * as sidePane from "../core/sidePaneTabs.ts";
import type { UnitId } from "../core/units.ts";
import { useShell } from "./useShell.ts";

/**
 * 右侧标签面板的 shell 状态 —— tabs/activeTabId 的领域规则全部在
 * core/sidePaneTabs.ts（纯函数），这里只做三件事：
 *
 * 1. 持有状态并转译成 action（openTab 永远顺带展开面板）；
 * 2. 切 bot 的作用域联动（handleUnitChange：归档上个 bot 的聚焦记忆 → 解析新 scope）；
 * 3. 宽度持久化（与 useShell 的侧栏宽度同一套 localStorage 模式）。
 *
 * 刻意**不做** tabs 跨刷新持久化：数据都在 daemon，tab 只是壳；刷新后右侧栏
 * 从空开始（ZCode 的 side pane 记忆同为 renderer 内存级）。
 */

/**
 * 显式打开动作顺带把「该 bot 上次聚焦」记忆写成新 tab。不写的话，跨 bot 打开
 * （通知跳转 / 总览重开 / CommandCenter 先 selectUnit 后 openTab）会在渲染提交后
 * 被 handleUnitChange 的记忆解析抢走 —— resolveScopeOnUnitChange 的优先级是
 * 记忆 > 当前 activeTabId，目标 bot 旧记忆指向另一个还开着的 tab 时，用户打开
 * X 面板却聚焦 Y。把记忆写成「用户刚刚显式要的」，显式意图永远赢。
 */
function focusMemoryFor(
  lastActiveTabByUnit: Readonly<Record<string, string>>,
  ownerUnitId: UnitId | null,
  tabId: string,
): Record<string, string> {
  if (ownerUnitId === null) return { ...lastActiveTabByUnit };
  return { ...lastActiveTabByUnit, [String(ownerUnitId)]: tabId };
}

/** 打开动作顺带清掉「最近关闭」里的同 id 记录 —— 否则总览弹层里同 id 双行 */
function dropClosed(list: readonly sidePane.SidePaneTab[], tabId: string): sidePane.SidePaneTab[] {
  return list.filter((t) => t.id !== tabId);
}

function withoutUnread(unread: Readonly<Record<string, true>>, tabId: string): Record<string, true> {
  const next: Record<string, true> = { ...unread };
  delete next[tabId];
  return next;
}

/**
 * v5（2026-10-27）：264 实测后用户定稿 300 —— 即本项目最初的默认宽。键位随之
 * 升一位做一次性重置，清掉复测期间可能拖出的存量值。读档时顺带清掉 v1-v4 残键。
 * v2 起盘上的宽度只来自用户拖拽落定（程序性 resize 不落盘，见 SidePanePanel 的
 * onResize 与 commitPaneWidth）—— 读到什么信什么。
 */
const WIDTH_KEY = "agent-workbench:sidepane-width-px.v5";
const WIDTH_KEY_STALE = [
  "agent-workbench:sidepane-width-px.v4",
  "agent-workbench:sidepane-width-px.v3",
  "agent-workbench:sidepane-width-px.v2",
  "agent-workbench:sidepane-width-px",
] as const;
/**
 * 默认宽 = 300（2026-10-27 用户定稿：264 偏窄、300 合适；面板是按需查看的侧写
 * 列，300px 下功能主页与历史列表均可读）。最窄即默认宽：tab 条是 overflow-x-auto
 * 的横向滚动条，窄了只是标签条内滚动。
 */
const SIDE_PANE_DEFAULT = 300;
const SIDE_PANE_MIN = 300;
/** 「最近关闭」上限（ZCode recentClosedSidePaneTabs 同款）：够后悔，不无限堆 */
const RECENTLY_CLOSED_MAX = 8;

/** 关闭记录去重 + 置顶 + 截断：被关的排最前（最新），同 id 的旧记录吃掉 */
function recordClosed(prev: readonly sidePane.SidePaneTab[], closed: readonly sidePane.SidePaneTab[]): sidePane.SidePaneTab[] {
  if (closed.length === 0) return prev as sidePane.SidePaneTab[];
  const ids = new Set(closed.map((t) => t.id));
  return [...closed, ...prev.filter((t) => !ids.has(t.id))].slice(0, RECENTLY_CLOSED_MAX);
}

/** 从「关前 → 关后」两个状态算出被关掉的 tab（三条关闭路径共用的口径） */
function closedTabsOf(before: readonly sidePane.SidePaneTab[], after: readonly sidePane.SidePaneTab[]): sidePane.SidePaneTab[] {
  const afterIds = new Set(after.map((t) => t.id));
  return before.filter((t) => !afterIds.has(t.id));
}

/** 关最后一个可见 tab = 收起面板：可见集合从非空变为空才算数 */
function shouldCollapseOnClose(
  before: { tabs: readonly sidePane.SidePaneTab[]; scopeUnitId: UnitId | null },
  afterTabs: readonly sidePane.SidePaneTab[],
): boolean {
  const hadVisible = sidePane.visibleTabsForUnit(before.tabs, before.scopeUnitId).length > 0;
  const hasVisibleAfter = sidePane.visibleTabsForUnit(afterTabs, before.scopeUnitId).length > 0;
  return hadVisible && !hasVisibleAfter;
}

/** 四个 open* 动作（history/live/plan/diff）共用的收尾：展开面板 + 写聚焦记忆 +
 *  清「最近关闭」同 id 记录（「点了就能看到」的切主视图在各自 action 里） */
function openUnitTabSet(
  s: SidePaneStore,
  opened: sidePane.SidePaneState,
  tabId: string,
  ownerUnitId: UnitId,
): Partial<SidePaneStore> {
  return {
    ...opened,
    collapsed: false,
    lastActiveTabByUnit: focusMemoryFor(s.lastActiveTabByUnit, ownerUnitId, tabId),
    recentlyClosed: dropClosed(s.recentlyClosed, tabId),
  };
}

/** 三条关闭路径（closeTab/closeOtherTabs/closeVisibleTabs）共用的收尾：契约结果 →
 *  记录被关 tab → 清它们的未读点 → 最后一条可见 tab 被关掉时收起面板 */
function settleClose(s: SidePaneStore, next: sidePane.SidePaneState): Partial<SidePaneStore> {
  const closed = closedTabsOf(s.tabs, next.tabs);
  if (closed.length === 0) return next;
  const unreadTabIds = { ...s.unreadTabIds };
  for (const t of closed) delete unreadTabIds[t.id];
  return {
    tabs: next.tabs,
    activeTabId: next.activeTabId,
    collapsed: shouldCollapseOnClose(s, next.tabs) ? true : s.collapsed,
    recentlyClosed: recordClosed(s.recentlyClosed, closed),
    unreadTabIds,
  };
}

function readWidth(): number {
  if (typeof window === "undefined") return SIDE_PANE_DEFAULT;
  try {
    // v3 起干净起步：v1/v2 残键一律清掉（它们的值都早于这次默认宽减半的决定）
    for (const k of WIDTH_KEY_STALE) window.localStorage.removeItem(k);
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (raw === null) return SIDE_PANE_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(SIDE_PANE_MIN, Math.round(n)) : SIDE_PANE_DEFAULT;
  } catch {
    return SIDE_PANE_DEFAULT;
  }
}

function persistWidth(w: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

interface SidePaneStore extends sidePane.SidePaneState {
  /** 面板收起（用户开关；无可见 tab 时也会被强制置 true） */
  collapsed: boolean;
  /** 当前作用域 bot。null = 还没有任何 bot 被激活过（应用首帧） */
  scopeUnitId: UnitId | null;
  /** 每个 bot 最后聚焦的 tab —— 切回时恢复现场（不持久化，会话内有效） */
  lastActiveTabByUnit: Record<string, string>;
  /** 最近关闭的 tab（最新在前，≤8，不持久化）—— 总览弹层「最近关闭」组的数据源 */
  recentlyClosed: sidePane.SidePaneTab[];
  /** 有未读事件的 tab（只有 live tab 会 bump）：tab id → true。聚焦/关闭即清 */
  unreadTabIds: Record<string, true>;
  paneWidth: number;

  /** 打开（或复用）一个 bot 的历史 tab，并展开面板 */
  openTab: (request: sidePane.OpenHistoryTabRequest) => void;
  /** 打开（或复用）一个会话的实时监控 tab，并展开面板 */
  openLiveSession: (request: sidePane.OpenLiveTabRequest) => void;
  /** 打开（或复用）当前 bot 的计划 / 变更审查 tab，并展开面板 */
  openPlan: (request: sidePane.OpenUnitTabRequest) => void;
  openDiff: (request: sidePane.OpenUnitTabRequest) => void;
  /** 打开（或复用）上下文清单 tab（ADR 0014），并展开面板 */
  openContext: (request: sidePane.OpenUnitTabRequest) => void;
  /** 打开（或复用）通知中心 tab（workspace 级单例），并展开面板 */
  openNotifications: () => void;
  /** 打开（或复用）新建 bot tab（workspace 级单例，2026-10-23 归拢自弹窗），并展开面板 */
  openNewBot: () => void;
  /** 打开（或复用）git 提交图 tab（按 bot，2026-10-23 归拢自 GitGraphDialog 弹窗） */
  openGitGraph: (request: sidePane.OpenUnitTabRequest & { rootPath: string; branchName: string | null }) => void;
  closeTab: (tabId: string) => void;
  /** tab 右键：关闭除该 tab 外的可见 tab（其它 bot 的隐藏 tab 保活） */
  closeOtherTabs: (tabId: string) => void;
  /** tab 右键：关闭当前视角全部可见 tab */
  closeVisibleTabs: () => void;
  activateTab: (tabId: string) => void;
  /** 「激活并看它」的组合入口（快捷键用）：切回 chat + 展开面板 + 激活（清未读） */
  expandAndActivate: (tabId: string) => void;
  /** 拖拽排序落定：挪到当前 scope 可见子集的第 toVisibleIndex 位 */
  moveTab: (tabId: string, toVisibleIndex: number) => void;
  /** 重开一条最近关闭的 tab（缺省取最新一条）；跨 bot 的切换单元留给 UI 层 */
  reopenClosedTab: (tab?: sidePane.SidePaneTab) => void;
  /** live tab 在非激活态收到事件时打未读点（只做圆点不计数） */
  bumpUnread: (tabId: string) => void;
  /** 面板可见且聚焦 = 正在看，未读点熄灭（clear-on-shown 路径用） */
  clearUnread: (tabId: string) => void;
  toggleCollapsed: () => void;
  /** 拖拽中实时跟随（只写内存不落盘） */
  setPaneWidth: (w: number) => void;
  /** 分隔条拖拽落定时落盘 —— 宽度持久化只认用户手势这一个入口 */
  commitPaneWidth: () => void;

  /**
   * 头部开合钮（面板收起后的唯一重开入口，ZCode「收起即归零 + 头部状态感知
   * 开关」同款约定）：正占位 → 收起让位；其余一律展开 —— 有可见 tab 就回到
   * tab 内容，一个 tab 都没有就落功能主页（SidePaneHome 里点选要开的功能，
   * 不再硬开历史 tab）。「占位」口径统一走 sidePane.sidePaneOccupies。
   */
  toggleFromHeader: () => void;

  /**
   * 切 bot 联动：WorkspaceShell 订阅 useWorkbench.activeUnitId 后调用。
   * 切走前把当前聚焦归档到上个 bot 的记忆里，再解析新 scope 的聚焦态 ——
   * 开合偏好不动：展开着就保持展开（无 tab 落功能主页），收起着就保持收起。
   */
  handleUnitChange: (unitId: UnitId) => void;
  /** bot 注销回收（daemon 侧 bot 定义消失）：清掉无主 tab 并自愈聚焦 */
  releaseUnits: (validUnitIds: readonly UnitId[]) => void;
}

export const useSidePane = create<SidePaneStore>((set, get) => ({
  tabs: [],
  activeTabId: "",
  collapsed: true,
  scopeUnitId: null,
  lastActiveTabByUnit: {},
  recentlyClosed: [],
  unreadTabIds: {},
  paneWidth: readWidth(),

  openTab: (request) =>
    set((s) => {
      // 面板只在 chat 主视图展开（全局页不属于任何 bot，见 SidePanePanel 的门控）。
      // 所有 openTab 调用点都是「我现在要看」的语境 —— 这里统一切回 chat，
      // 保持弹窗时代「点了就能看到」的语义（ZCode handleSelectTaskInChat 先
      // showChatMainView 再开面板，同一条规则）
      useShell.getState().setMainView("chat");
      return openUnitTabSet(s, sidePane.openHistoryTab(s, request), sidePane.historyTabId(request.unitId), request.unitId);
    }),

  openLiveSession: (request) =>
    set((s) => {
      useShell.getState().setMainView("chat");
      const tabId = sidePane.liveTabId(request.sessionId);
      return {
        ...openUnitTabSet(s, sidePane.openLiveTab(s, request), tabId, request.unitId),
        // 复用已有 live tab 聚焦时顺带清未读点 —— 否则从通知/主页跳过来，
        // 看完切走后旧点又亮回来
        unreadTabIds: withoutUnread(s.unreadTabIds, tabId),
      };
    }),

  openPlan: (request) =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return openUnitTabSet(s, sidePane.openPlanTab(s, request), sidePane.planTabId(request.unitId), request.unitId);
    }),

  openDiff: (request) =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return openUnitTabSet(s, sidePane.openDiffTab(s, request), sidePane.diffTabId(request.unitId), request.unitId);
    }),

  /** 打开（或复用）上下文清单 tab（ADR 0014），并展开面板 */
  openContext: (request) =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return openUnitTabSet(s, sidePane.openContextTab(s, request), sidePane.contextTabId(request.unitId), request.unitId);
    }),

  openNotifications: () =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return {
        ...sidePane.openNotificationsTab(s),
        collapsed: false,
        recentlyClosed: dropClosed(s.recentlyClosed, sidePane.notifyTabId),
      };
    }),

  openNewBot: () =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return {
        ...sidePane.openNewBotTab(s),
        collapsed: false,
        recentlyClosed: dropClosed(s.recentlyClosed, sidePane.NEW_BOT_TAB_ID),
      };
    }),

  openGitGraph: (request) =>
    set((s) => {
      useShell.getState().setMainView("chat");
      return openUnitTabSet(s, sidePane.openGitGraphTab(s, request), sidePane.gitGraphTabId(request.unitId), request.unitId);
    }),

  /** 三条关闭路径共用收尾（settleClose），口径注释在此：
   *  关掉当前视角最后一个**可见** tab 时顺带收起面板 —— 回退功能主页会让
   *  「关闭」的预期落空（用户点 X 是想让它消失，不是想看功能页）；
   *  功能主页只在用户主动展开面板时出现（toggleFromHeader）。
   *  判据是「可见集合从非空变空」而不是「关后为空」：面板停在功能主页时，
   *  从 ⌄ 总览关掉一条别的 bot 的隐藏 tab 不该把整个面板收走。 */
  closeTab: (tabId) =>
    set((s) => settleClose(s, sidePane.closeTab(s, tabId, s.scopeUnitId))),

  closeOtherTabs: (tabId) =>
    set((s) => settleClose(s, sidePane.closeOtherTabs(s, tabId, s.scopeUnitId))),

  closeVisibleTabs: () =>
    set((s) => settleClose(s, sidePane.closeVisibleTabs(s, s.scopeUnitId))),

  activateTab: (tabId) =>
    set((s) => {
      const next = sidePane.activateTab(s, tabId);
      if (s.unreadTabIds[tabId] === undefined) return next;
      const unreadTabIds = { ...s.unreadTabIds };
      delete unreadTabIds[tabId];
      return { ...next, unreadTabIds };
    }),

  moveTab: (tabId, toVisibleIndex) =>
    set((s) => sidePane.moveTab(s, tabId, toVisibleIndex, s.scopeUnitId)),

  /** 快捷键的组合入口 —— 与 openTab 系同一条「点了就能看到」规则，但不动
   *  recentlyClosed/聚焦记忆（激活的是已开的 tab）。scope 还没建立（null）时
   *  面板不占位，无动作 —— 不做无效状态写入。 */
  expandAndActivate: (tabId) => {
    if (get().scopeUnitId === null) return;
    useShell.getState().setMainView("chat");
    set({ collapsed: false });
    get().activateTab(tabId);
  },

  reopenClosedTab: (tab) =>
    set((s) => {
      const target = tab ?? s.recentlyClosed[0];
      if (target === undefined) return s;
      useShell.getState().setMainView("chat");
      return {
        ...sidePane.insertTab(s, target),
        collapsed: false,
        recentlyClosed: s.recentlyClosed.filter((t) => t.id !== target.id),
        lastActiveTabByUnit: focusMemoryFor(
          s.lastActiveTabByUnit,
          sidePane.isUnitTab(target) ? target.ownerUnitId : null,
          target.id,
        ),
      };
    }),

  bumpUnread: (tabId) => {
    // tab 已关闭/被回收的不打点（在途帧晚到会留下无人清扫的死键）
    if (!get().tabs.some((t) => t.id === tabId)) return;
    set((s) =>
      s.unreadTabIds[tabId] === undefined ? { unreadTabIds: { ...s.unreadTabIds, [tabId]: true } } : s,
    );
  },

  /** 面板可见且聚焦某 tab = 用户正在看它，未读点熄灭（SidePanePanel 的
   *  clear-on-shown 效应调用；覆盖「收起期间积累、展开不走 activateTab」的路径） */
  clearUnread: (tabId) =>
    set((s) => {
      if (s.unreadTabIds[tabId] === undefined) return s;
      return { unreadTabIds: withoutUnread(s.unreadTabIds, tabId) };
    }),

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),

  toggleFromHeader: () => {
    const s = get();
    // 正占位 → 收起让位；其余一律走「展开」。判据用 sidePaneOccupies 与头部按钮
    // 态、列渲染同源 —— 否则停在全局页时按钮亮着「已展开」，点一下只翻 collapsed，
    // 画面不动，得再点一次才展开。
    const occupying = sidePane.sidePaneOccupies(
      s.scopeUnitId,
      s.collapsed,
      useShell.getState().mainView === "chat",
    );
    if (occupying) {
      set({ collapsed: true });
      return;
    }
    // 展开：有可见 tab 回 tab 内容；没有则落功能主页（面板里点选要开的功能）
    useShell.getState().setMainView("chat");
    set({ collapsed: false });
  },

  setPaneWidth: (paneWidth) => {
    const clamped = Math.max(SIDE_PANE_MIN, Math.round(paneWidth));
    set({ paneWidth: clamped });
  },

  commitPaneWidth: () => {
    persistWidth(get().paneWidth);
  },

  handleUnitChange: (unitId) => {
    const s = get();
    if (s.scopeUnitId !== null && String(s.scopeUnitId) === String(unitId)) return;
    // 归档上个 bot 的聚焦记忆。CommandCenter 流（先 selectUnit 后 openTab）里
    // openTab 可能已把 activeTabId 改成新 bot 的 tab —— 无妨：解析只认可见集合，
    // 一条指向别人 tab 的过期记忆永远不会中奖（见 resolveScopeOnUnitChange 的兜底链）。
    const lastActiveTabByUnit = { ...s.lastActiveTabByUnit };
    if (s.scopeUnitId !== null && s.activeTabId !== "") {
      lastActiveTabByUnit[String(s.scopeUnitId)] = s.activeTabId;
    }
    const res = sidePane.resolveScopeOnUnitChange(
      { tabs: s.tabs, activeTabId: s.activeTabId },
      unitId,
      lastActiveTabByUnit,
    );
    set({
      scopeUnitId: unitId,
      lastActiveTabByUnit,
      activeTabId: res.activeTabId,
      // 开合偏好不动：展开着无 tab 的 bot → 面板落功能主页（列渲染见 SidePaneColumn）。
      // 对称原则 —— 手动收起的偏好不该被切换动作翻掉，手动展开的同样不该。
      collapsed: s.collapsed,
    });
  },

  releaseUnits: (validUnitIds) =>
    set((s) => {
      const next = sidePane.releaseUnits({ tabs: s.tabs, activeTabId: s.activeTabId }, validUnitIds);
      if (next.tabs === s.tabs && next.activeTabId === s.activeTabId) {
        // 无回收发生：返回同一引用，zustand 对 Object.is 相等不通知订阅者
        return s;
      }
      let activeTabId = next.activeTabId;
      // 聚焦被回收（或自愈出空串）时按当前 scope 重解析；开合不动 ——
      // 空聚焦的面板落功能主页，不为它收起
      if (activeTabId === "" && s.scopeUnitId !== null) {
        const res = sidePane.resolveScopeOnUnitChange(next, s.scopeUnitId, s.lastActiveTabByUnit);
        activeTabId = res.activeTabId;
      }
      // 回收的 tab 清未读点；「最近关闭」里死 bot 的记录一并清 —— 否则总览里
      // 点它会 selectUnit 一个不存在的单元、插回一个任何视角看不见的幽灵 tab
      const valid = new Set(validUnitIds.map(String));
      const closed = closedTabsOf(s.tabs, next.tabs);
      let unreadTabIds = s.unreadTabIds;
      if (closed.length > 0) {
        unreadTabIds = { ...s.unreadTabIds };
        for (const t of closed) delete unreadTabIds[t.id];
      }
      return {
        tabs: next.tabs,
        activeTabId,
        collapsed: s.collapsed,
        unreadTabIds,
        recentlyClosed: s.recentlyClosed.filter(
          (t) => !sidePane.isUnitTab(t) || valid.has(String(t.ownerUnitId)),
        ),
      };
    }),
}));

export { SIDE_PANE_MIN };
