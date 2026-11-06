import { create } from "zustand";
import type { RuntimeEvent } from "../core/events.ts";
import { asSessionId, asUnitId } from "../core/units.ts";
import { useWorkbench, type TimelineItem } from "./useWorkbench.ts";
import { useShell } from "./useShell.ts";

/**
 * chat 窗格注册表（docs/31 会话画布）—— 结构化对话作为画布的一种窗格。
 *
 * 架构口径（一期「单活 + 快照注册表」）：
 * - 全局 `useWorkbench.activeUnitId/activeSessionId/timeline` 的语义降级为
 *   「焦点 chat 窗格的会话」镜像 —— 发送/续聊/审批/openSession 全链路零改动，
 *   永远只作用于焦点窗格；
 * - 非焦点 chat 窗格渲染本注册表里的快照时间线：失焦那一刻从全局拍照，
 *   之后由事件泵把「已切走的运行中会话」事件实时追加进来（consumeEvents
 *   原本丢弃这些事件，现在转投到这里）——分屏并排时后台窗格照常滚动；
 * - 重新聚焦 = snapshot 旧窗格 → selectUnit/openSession 权威重建（谱系回放）
 *   → restoring 期间先渲染快照防闪 → 回落全局。关窗格不杀会话（对话没有
 *   进程可杀，历史永远可回）。
 *
 * 窗格身份（docs/31 §四）：paneKey 永不变（map 主键）；用户感知的「一个会话」
 * = 一条会话线（conversationId），knownSessionIds 收录该线到过的所有段 id，
 * 「找窗格」按段 id 精确匹配、按会话线兜底匹配。
 */

export interface ChatPaneRecord {
  readonly paneKey: string;
  unitId: string;
  /** 当前段 id；null = 草稿（首发前没有会话） */
  sessionId: string | null;
  /** 会话线 id（conversationId ?? sessionId）；草稿为 null */
  lineageId: string | null;
  /** 本线已知段 id 集（找窗格与事件路由的匹配面） */
  knownSessionIds: ReadonlySet<string>;
  /** 非焦点窗格的渲染数据：失焦快照 + 泵实时追加 */
  timeline: readonly TimelineItem[];
  busy: boolean;
  draft: string;
  /** 聚焦恢复中（openSession 在途）：先渲染快照，防全局清空闪一下 */
  restoring: boolean;
}

interface ChatPaneInput {
  unitId: string;
  /** 点历史行/路由/前台拉起带段 id；bot 级打开（新对话/侧栏点 bot）不带的 */
  sessionId?: string | null;
  runtimeId?: string;
}

interface ChatPanesState {
  panes: Readonly<Record<string, ChatPaneRecord>>;
  /** 焦点 chat 窗格（null = 焦点在终端窗格 / 空态）。镜像画布 store 的游标 */
  focusedChatKey: string | null;

  /** 幂等开窗格：按段/会话线找到就聚焦（带段 id 时窗格内切到那段），没有就开新标签 */
  openChatPane: (input: ChatPaneInput) => void;
  /** bot 级聚焦：该 bot 已有窗格就聚焦它，没有就开草稿窗格 */
  openUnitChatPane: (unitId: string) => void;
  /** 画布游标变化的外部入口（订阅侧调用）：换焦点 + 快照/恢复 */
  handleCanvasFocusChange: (nextPaneKey: string | null) => void;
  /** 草稿窗格选 bot（嵌入选择器） */
  choosePaneUnit: (paneKey: string, unitId: string) => void;
  /** 窗格被关闭（标签/窗格 ×）：删记录不杀会话；关的是焦点窗格则游标归空 */
  handlePaneClosed: (paneKey: string) => void;
  /** 事件泵转投：已切走的运行中会话事件 → 对应非焦点窗格的快照时间线 */
  routeEvent: (event: RuntimeEvent) => void;
  /**
   * 布局恢复（docs/31 二期 canvasLayout）：按持久化的身份建一条窗格记录，
   * 返回 paneKey 给布局树落位（不聚焦、不 openSession；聚焦时走焦点链重建）。
   * 返回 null = unit 已不存在（bot 被删），调用方应丢弃该叶子。
   */
  restoreRecord: (unitId: string, sessionId: string | null) => string | null;
  /**
   * 建一个「未选 bot」的草稿窗格记录（unitId=""），返回 paneKey 交给画布落位
   * （splitPane chatPaneKey）。窗格本体渲染内嵌 bot 选择器，选完即成草稿对话。
   */
  createDraftRecord: () => string;

  /* 内部动作（不进公共消费面） */
  focus: (paneKey: string | null, sessionOverride: string | null | undefined) => void;
  snapshotFromGlobal: (paneKey: string) => void;
}

function nextPaneKey(): string {
  return `chatp_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/** 窗格记录工厂（openChatPane / restoreRecord / createDraftRecord 三入口共用） */
function makeRecord(unitId: string, sessionId: string | null): ChatPaneRecord {
  return {
    paneKey: nextPaneKey(),
    unitId,
    sessionId,
    lineageId: sessionId !== null ? (lineageOfSession(sessionId) ?? sessionId) : null,
    knownSessionIds: sessionId !== null ? new Set([sessionId]) : new Set(),
    timeline: [],
    busy: false,
    draft: "",
    restoring: false,
  };
}

/** 快照时间线的本地序号（负数段，与全局 seq 空间天然隔离不撞 key） */
let routeSeq = 0;

/** 由段 id 查会话线：sessions[] 里 openSession 回放时已聚了整线（含 conversationId） */
function lineageOfSession(sessionId: string): string | null {
  const row = useWorkbench
    .getState()
    .sessions.find((s) => String(s.id) === sessionId);
  return row?.conversationId != null ? String(row.conversationId) : null;
}

/**
 * openSession 的 runtimeId 落点：入参 → sessions[] → daemon 台账（尽力而为）。
 * 单源导出：focus 链 / sessionRoute 回放 / PopoutShell 三方共用（review Duplicated Code）。
 */
export async function runtimeIdOfSession(sessionId: string, hint?: string): Promise<string | null> {
  if (hint && hint !== "") return hint.replace(/^daemon:/, "");
  const row = useWorkbench.getState().sessions.find((s) => String(s.id) === sessionId);
  if (row) return String(row.runtimeId).replace(/^daemon:/, "");
  try {
    const { fetchSessions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
    const rows = await fetchSessions(defaultDaemonEndpoint());
    return rows.find((r) => String(r.id) === sessionId)?.runtimeId ?? null;
  } catch {
    return null;
  }
}

/** 按段 id / 会话线找窗格（docs/31 §四幂等口径） */
export function resolvePaneForSession(
  sessionId: string,
  unitId?: string,
): ChatPaneRecord | undefined {
  const { panes } = useChatPanes.getState();
  for (const pane of Object.values(panes)) {
    if (pane.knownSessionIds.has(sessionId)) return pane;
  }
  const lineage = lineageOfSession(sessionId);
  if (lineage !== null) {
    for (const pane of Object.values(panes)) {
      if (pane.lineageId === lineage && (unitId === undefined || pane.unitId === unitId)) return pane;
    }
  }
  return undefined;
}

export const useChatPanes = create<ChatPanesState>((set, get) => ({
  panes: {},
  focusedChatKey: null,

  openChatPane: (input) => {
    const sid = input.sessionId ?? null;
    const existing = sid !== null ? resolvePaneForSession(sid, input.unitId) : undefined;
    if (existing) {
      get().focus(existing.paneKey, sid);
      return;
    }
    const record = makeRecord(input.unitId, sid);
    set((s) => ({ panes: { ...s.panes, [record.paneKey]: record } }));
    // 画布开标签：createChatTab 会把游标翻到新窗格 → 订阅链（installChatPaneSync）
    // 触发 focus 恢复。标签标题在挂载侧按 unit 名校正。
    void import("./useTerminalStore.ts").then(({ useTerminalStore }) => {
      useTerminalStore.getState().createChatTab(record.paneKey);
    });
  },

  openUnitChatPane: (unitId) => {
    const panes = Object.values(get().panes).filter((p) => p.unitId === unitId);
    if (panes.length > 0) {
      get().focus(panes[0]!.paneKey, panes[0]!.sessionId);
      return;
    }
    get().openChatPane({ unitId, sessionId: null });
  },

  handleCanvasFocusChange: (nextPaneKey) => {
    if (nextPaneKey === get().focusedChatKey) return;
    get().focus(nextPaneKey, null);
  },

  choosePaneUnit: (paneKey, unitId) => {
    set((s) => {
      const pane = s.panes[paneKey];
      if (pane === undefined) return {};
      return { panes: { ...s.panes, [paneKey]: { ...pane, unitId } } };
    });
    // 选定 bot 的草稿窗格立即按它落位（selectUnit 带执行器/turnContext 跟随）
    if (get().focusedChatKey === paneKey) {
      useWorkbench.getState().selectUnit(asUnitId(unitId));
      useShell.getState().setMainView("chat");
    }
  },

  handlePaneClosed: (paneKey) => {
    set((s) => {
      if (s.panes[paneKey] === undefined) return {};
      const next = { ...s.panes };
      delete next[paneKey];
      return { panes: next, focusedChatKey: s.focusedChatKey === paneKey ? null : s.focusedChatKey };
    });
  },

  routeEvent: (event) => {
    if (!("sessionId" in event)) return;
    const sid = String((event as { sessionId: unknown }).sessionId);
    const pane = resolvePaneForSession(sid);
    if (pane === undefined) return;
    // 焦点窗格由全局链路渲染（consumeEvents 落全局 timeline），不重复入账
    if (get().focusedChatKey === pane.paneKey) return;
    set((s) => {
      const p = s.panes[pane.paneKey];
      if (p === undefined) return {};
      const timeline = [...p.timeline, { id: --routeSeq, event, at: Date.now() }];
      let busy = p.busy;
      if (event.type === "session.status") busy = event.status === "running";
      if (event.type === "session.ended") busy = false;
      if (event.type === "message.completed") busy = false;
      return {
        panes: {
          ...s.panes,
          [pane.paneKey]: {
            ...p,
            timeline,
            busy,
            knownSessionIds: p.knownSessionIds.has(sid)
              ? p.knownSessionIds
              : new Set([...p.knownSessionIds, sid]),
          },
        },
      };
    });
  },

  restoreRecord: (unitId, sessionId) => {
    // bot 已不存在（被删/换机）：叶子丢弃，不造指向空单元的窗格
    if (!useWorkbench.getState().units.some((u) => u.id === unitId)) return null;
    const record = makeRecord(unitId, sessionId);
    set((s) => ({ panes: { ...s.panes, [record.paneKey]: record } }));
    return record.paneKey;
  },

  createDraftRecord: () => {
    const record = makeRecord("", null);
    set((s) => ({ panes: { ...s.panes, [record.paneKey]: record } }));
    return record.paneKey;
  },

  focus: (paneKey, sessionOverride) => {
    const prevKey = get().focusedChatKey;
    // ① 旧焦点窗格拍照入注册表（全局态此刻还属于它）
    if (prevKey !== null && prevKey !== paneKey) get().snapshotFromGlobal(prevKey);
    set({ focusedChatKey: paneKey });
    useShell.getState().setMainView("chat");
    if (paneKey === null) return;
    // ①' 反向推画布游标（review P0）：focus 也从注册表侧发起（侧栏历史行 /
    // 任务 chip / hash 回放命中**后台格**的窗格），必须把它激活到前台
    // —— 只换全局数据不切标签的话，可见窗格会渲染别人会话的内容。
    // 幂等：focusedChatKey 已置位，画布订阅回打 handleCanvasFocusChange 时
    // 同值短路，不会递归。（docs/32：单轨 activePaneId）
    void import("./useTerminalStore.ts").then(({ useTerminalStore }) => {
      const st = useTerminalStore.getState();
      if (st.activePaneId !== paneKey) st.activatePane(paneKey);
    });
    const pane = get().panes[paneKey];
    if (pane === undefined) return;

    // ② 草稿窗格：selectUnit 落位（执行器绑定 / turnContext 跟随），草稿归还输入框。
    //    unitId 为空 = 拆分出的「未选 bot」窗格：只聚焦不切单元，窗格内渲染选择器
    // bug 修复（docs/32 §十）：targetSid 用 ?? 回落窗格自身会话——此前
    // `sessionOverride !== undefined` 把画布游标切换传来的 null 当成「强制草稿」，
    // 每次点回对话标签都走草稿分支 selectUnit 清空时间线，页面被重置成
    // 头像+问候+空输入框的初始态（并排对照全毁）。null 与 undefined 现在都
    // 意为「用窗格自己的 session」。
    const targetSid = sessionOverride ?? pane.sessionId;
    if (targetSid === null || targetSid === "") {
      if (pane.unitId !== "") useWorkbench.getState().selectUnit(asUnitId(pane.unitId));
      if (pane.unitId !== "" && pane.draft !== "") useWorkbench.setState({ draft: pane.draft });
      set((s) =>
        s.panes[paneKey]
          ? { panes: { ...s.panes, [paneKey]: { ...s.panes[paneKey]!, restoring: false } } }
          : {},
      );
      return;
    }
    // ③ 有段：全局已指向它（路由回放/重复点击）就不重放，否则 openSession 权威重建
    const wb = useWorkbench.getState();
    if (String(wb.activeSessionId ?? "") === targetSid) {
      set((s) =>
        s.panes[paneKey]
          ? { panes: { ...s.panes, [paneKey]: { ...s.panes[paneKey]!, restoring: false } } }
          : {},
      );
      return;
    }
    set((s) =>
      s.panes[paneKey]
        ? { panes: { ...s.panes, [paneKey]: { ...s.panes[paneKey]!, restoring: true } } }
        : {},
    );
    void (async () => {
      const runtimeId = await runtimeIdOfSession(targetSid);
      if (runtimeId === null) {
        set((s) =>
          s.panes[paneKey]
            ? { panes: { ...s.panes, [paneKey]: { ...s.panes[paneKey]!, restoring: false } } }
            : {},
        );
        useWorkbench
          .getState()
          .pushNotice("打不开这个对话窗格", `台账里查不到会话 ${targetSid} 的执行器。`, { level: "warn" });
        return;
      }
      const owner = useWorkbench.getState().units.find((u) => u.id === pane.unitId);
      await useWorkbench.getState().openSession({
        sessionId: asSessionId(targetSid),
        unitId: owner !== undefined ? asUnitId(pane.unitId) : wb.activeUnitId,
        runtimeId,
      });
      // 回放期间焦点又走了：快照已由新 focus 链拍照，这里只清自己的在途标记
      set((s) => {
        const p = s.panes[paneKey];
        if (p === undefined || get().focusedChatKey !== paneKey) return {};
        return { panes: { ...s.panes, [paneKey]: { ...p, restoring: false } } };
      });
    })();
  },

  snapshotFromGlobal: (paneKey) => {
    const wb = useWorkbench.getState();
    set((s) => {
      const pane = s.panes[paneKey];
      if (pane === undefined) return {};
      const sid = wb.activeSessionId !== null ? String(wb.activeSessionId) : pane.sessionId;
      return {
        panes: {
          ...s.panes,
          [paneKey]: {
            ...pane,
            restoring: false,
            sessionId: sid,
            lineageId: sid !== null ? (lineageOfSession(sid) ?? pane.lineageId ?? sid) : pane.lineageId,
            knownSessionIds:
              sid !== null && !pane.knownSessionIds.has(sid)
                ? new Set([...pane.knownSessionIds, sid])
                : pane.knownSessionIds,
            timeline: wb.timeline,
            busy: wb.busy,
            draft: wb.draft,
          },
        },
      };
    });
  },
}));

/* --------------------------------------------------------------- 安装器 */

/**
 * 焦点窗格同步器 —— 装在 WorkspaceShell（与 installSessionRoute 同款模式）：
 * 1. 订阅画布 store：activeChatPaneKey 游标变化 → 快照旧焦点 + 恢复新焦点；
 * 2. 订阅 useWorkbench：焦点窗格的段身份跟着全局走（草稿首发铸造新段、
 *    续聊换段都自动入账，knownSessionIds 随谱系扩容——后台事件的路由依赖它）。
 * 布局持久化（含窗格身份）由 store/canvasLayout.ts 负责，不在这里。
 */
export function installChatPaneSync(): () => void {
  const unsubCanvas = import("./useTerminalStore.ts").then(({ useTerminalStore }) => {
    // docs/32 焦点单轨：游标是 activePaneId（终端或对话皆可）；chat 侧只关心
    // 它指向**另一个对话窗格**的时刻。
    // 焦点移到终端窗格时**不交接**：全局对话链路（Timeline/Composer/审批）
    // 只会被另一个对话窗格争用，终端从不碰它——此前把终端焦点当作「对话失
    // 焦」降级成只读快照，分屏并排时对话格的输入框/空态头像随焦点消失、草稿
    // 一片空白（用户实测反馈）。现在对话格在终端聚焦期间保持 live。
    const chatKeyOf = (paneId: string | null): string | null => {
      if (paneId === null) return null;
      return useTerminalStore.getState().panes[paneId]?.kind === "chat" ? paneId : null;
    };
    let prev = chatKeyOf(useTerminalStore.getState().activePaneId);
    return useTerminalStore.subscribe((s) => {
      const cur = chatKeyOf(s.activePaneId);
      if (cur === null || cur === prev) return;
      prev = cur;
      useChatPanes.getState().handleCanvasFocusChange(cur);
    });
  });

  const unsubWorkbench = useWorkbench.subscribe(() => {
    const st = useChatPanes.getState();
    const key = st.focusedChatKey;
    if (key === null) return;
    const pane = st.panes[key];
    if (pane === undefined) return;
    const wb = useWorkbench.getState();
    const sid = wb.activeSessionId !== null ? String(wb.activeSessionId) : null;
    if (sid !== null && sid !== pane.sessionId) {
      // 新段落位（首发/续聊）：更新身份并吸收整线段 id
      const lineage = lineageOfSession(sid) ?? pane.lineageId ?? sid;
      const known = new Set(pane.knownSessionIds);
      known.add(sid);
      for (const row of wb.sessions) {
        const rowLineage = row.conversationId != null ? String(row.conversationId) : String(row.id);
        if (rowLineage === lineage) known.add(String(row.id));
      }
      useChatPanes.setState((s) => ({
        panes: { ...s.panes, [key]: { ...pane, sessionId: sid, lineageId: lineage, knownSessionIds: known } },
      }));
    }
  });

  return () => {
    void unsubCanvas.then((un) => un());
    unsubWorkbench();
  };
}
