import { create } from "zustand";
import type { RuntimeEvent } from "../core/events.ts";
import { appendInputHistory, asSessionId, asUnitId } from "../core/units.ts";
import { invalidateSessionViews, useWorkbench, type TimelineItem } from "./useWorkbench.ts";
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
 * - 重新聚焦 = snapshot 旧窗格 → **快照直通**：快照本就是新鲜的（失焦拍照 +
 *   泵实时追加），同步提升为全局视图即可，零 RPC、切换当帧即 live（orca
 *   「缓存直用」同款，docs/31 §九 修订）；谱系元数据后台去抖补齐。没有可
 *   直通的快照（F5 后未聚焦过 / 执行器下线）才回落 selectUnit/openSession
 *   权威重建（谱系回放），restoring 期间先渲染快照防闪 → 回落全局。
 *   关窗格不杀会话（对话没有进程可杀，历史永远可回）。
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
  /**
   * 执行器 id（侧栏历史行打开时带入 / 失焦快照时从 sessions[] 补）：快照直通的
   * 门禁与冷启动回放的 runtimeIdOfSession 提示都靠它，缺了就得多一次台账往返
   */
  runtimeId?: string;
  /** 非焦点窗格的渲染数据：失焦快照 + 泵实时追加 */
  timeline: readonly TimelineItem[];
  busy: boolean;
  draft: string;
  /** 失焦时的输入历史（快照直通时原样归还；后台期间没有本窗格的输入，不会过期） */
  inputHistory: readonly string[];
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
function makeRecord(unitId: string, sessionId: string | null, runtimeId?: string): ChatPaneRecord {
  return {
    paneKey: nextPaneKey(),
    unitId,
    sessionId,
    lineageId: sessionId !== null ? (lineageOfSession(sessionId) ?? sessionId) : null,
    knownSessionIds: sessionId !== null ? new Set([sessionId]) : new Set(),
    ...(runtimeId !== undefined && runtimeId !== "" ? { runtimeId } : {}),
    timeline: [],
    busy: false,
    draft: "",
    inputHistory: [],
    restoring: false,
  };
}

/** 快照时间线的本地序号（负数段，与全局 seq 空间天然隔离不撞 key） */
let routeSeq = 0;

/**
 * 每窗格的冷启动回放代次：同一窗格回放在途时又被聚焦（不耐烦再点一次），旧回放
 * 已被视图令牌作废、不会落位，但它的收尾仍会跑 —— 不比代次就会清掉新回放的
 * restoring，窗格提前转 live 渲染全局里别人的会话。
 */
const restoreGen = new Map<string, number>();

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
    const record = makeRecord(input.unitId, sid, input.runtimeId);
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
    restoreGen.delete(paneKey);
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
      // 输入历史同步补一笔（review P2）：后台期间的队列自动投递 / 渠道发起的用户轮
      // 只进时间线不进 inputHistory 的话，快照直通归还的 ↑ 召回会缺这几句
      //（openSession 路径从账本重建不缺）。规则单源：core 的 appendInputHistory
      const inputHistory =
        event.type === "message.delta" && event.role === "user" ? appendInputHistory(p.inputHistory, event.text) : p.inputHistory;
      return {
        panes: {
          ...s.panes,
          [pane.paneKey]: {
            ...p,
            timeline,
            busy,
            inputHistory,
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
    // ⓪ 新的视图意图：先作废所有在途的冷启动回放（早退/未选 bot 草稿分支不经
    // openSession 等令牌入口，不作废的话旧回放落位会盖掉刚点回的窗格）
    invalidateSessionViews();
    // ① 旧焦点窗格拍照入注册表（全局态此刻还属于它；它自己回放在途时除外，见 snapshotFromGlobal）
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
    /** 置本窗格回放标记（窗格已被关掉则不动）—— 下面四个落位分支共用 */
    const setRestoring = (restoring: boolean): void =>
      set((s) => (s.panes[paneKey] ? { panes: { ...s.panes, [paneKey]: { ...s.panes[paneKey]!, restoring } } } : {}));

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
      setRestoring(false);
      return;
    }
    // ②' 有段窗格的草稿同样随窗格归还（review P2）：此前切窗格不清不还，A 的未发送
    // 文字会留在 B 的输入框里（此时发出去就进错会话）。旧窗格的草稿刚在 ① 拍走，
    // 这里覆盖安全；直通与冷启动回放两条落位路径都不写 draft，这处写入即终值。
    // 例外：同窗格重复点击（③ 早退）且不在回放中 —— 窗格正持有全局链路，输入框里
    // 就是它此刻的草稿，还旧快照等于把正在打的字冲掉
    if (prevKey !== paneKey || pane.restoring) useWorkbench.setState({ draft: pane.draft });
    // ③ 有段：全局已指向它（路由回放/重复点击）就不重放
    const wb = useWorkbench.getState();
    if (String(wb.activeSessionId ?? "") === targetSid) {
      setRestoring(false);
      return;
    }
    // ③' 快照直通（orca「缓存直用」）：快照对应的正是目标段且非空 —— 失焦拍照
    // + 泵实时追加，本就是新鲜的 —— 同步提升为全局视图，零 RPC、当帧即 live。
    // 窗格内切到**别的段**（sessionOverride ≠ 窗格段）时快照不是它的，不能直通。
    // 门禁不过（单元已删 / 执行器下线）回落 ④；谱系元数据后台去抖补齐
    if (targetSid === pane.sessionId && pane.timeline.length > 0) {
      const adopted = wb.adoptPaneSnapshot({
        unitId: pane.unitId,
        sessionId: targetSid,
        runtimeId: pane.runtimeId,
        timeline: pane.timeline,
        busy: pane.busy,
        inputHistory: pane.inputHistory,
      });
      if (adopted) {
        if (pane.restoring) setRestoring(false);
        wb.refreshSessionMetadata(targetSid, pane.unitId);
        return;
      }
    }
    // ④ 冷启动回放（F5 后未聚焦过 / 直通门禁不过）：openSession 权威重建
    setRestoring(true);
    // runtimeId 提示只在目标段就是窗格自己的段时可信（窗格内切段时提示属于别段）；
    // 有提示就省掉 runtimeIdOfSession 兜底的那次全量台账往返
    const runtimeHint = targetSid === pane.sessionId ? pane.runtimeId : undefined;
    const gen = (restoreGen.get(paneKey) ?? 0) + 1;
    restoreGen.set(paneKey, gen);
    void (async () => {
      const runtimeId = await runtimeIdOfSession(targetSid, runtimeHint);
      // 被同窗格更新的回放顶替：收尾归新回放（见 restoreGen）
      if (restoreGen.get(paneKey) !== gen) return;
      if (runtimeId === null) {
        // 不清 restoring（review P1，存量）：全局还属于别的窗格，清了这里会转 live
        // 渲染别人的会话、输入框能打字发进去。保持快照态，警示条说明原因
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
      // 回放期间焦点又走了：快照已由新 focus 链拍照，这里只清自己的在途标记。
      // 被同窗格更新的回放顶替时不清 —— 新回放还在途，清了窗格会提前转 live、
      // 渲染全局里别人的会话（此时打字会发进别人的会话）。
      // 回放失败（执行器下线/台账缺行，openSession 内部有各自的早退+警示）同样
      // 不清：全局从未落到目标段，清了同样转 live 渲染别人的会话（review P1，存量）
      set((s) => {
        const p = s.panes[paneKey];
        if (p === undefined || get().focusedChatKey !== paneKey || restoreGen.get(paneKey) !== gen) return {};
        if (String(useWorkbench.getState().activeSessionId ?? "") !== targetSid) return {};
        return { panes: { ...s.panes, [paneKey]: { ...p, restoring: false } } };
      });
    })();
  },

  snapshotFromGlobal: (paneKey) => {
    const wb = useWorkbench.getState();
    set((s) => {
      const pane = s.panes[paneKey];
      if (pane === undefined) return {};
      // 冷启动回放在途（restoring）：全局此刻还属于上一个窗格，拍下来会把别人的
      // 会话身份与时间线盖进本窗格。只清在途标记、保留本窗格原有快照 —— 在途的
      // 回放已被新焦点链作废（focus ⓪），不会再落位。
      // 「未选 bot」窗格同口径（review P3，存量）：它聚焦时不切单元，全局还属于
      // 上一个窗格，认领会把别人的会话写进它的 sessionId（之后聚焦被当成那个
      // 会话的窗格）。保持草稿身份，选完 bot 自然成草稿对话
      if (pane.restoring || pane.unitId === "") {
        return { panes: { ...s.panes, [paneKey]: { ...pane, restoring: false } } };
      }
      const sid = wb.activeSessionId !== null ? String(wb.activeSessionId) : pane.sessionId;
      // 执行器以该段台账行为准：窗格内换执行器续聊会开新段，打开时带入的 id 已过期
      const row = sid !== null ? wb.sessions.find((x) => String(x.id) === sid) : undefined;
      const runtimeId = row !== undefined ? String(row.runtimeId) : pane.runtimeId;
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
            ...(runtimeId !== undefined ? { runtimeId } : {}),
            timeline: wb.timeline,
            busy: wb.busy,
            draft: wb.draft,
            inputHistory: wb.inputHistory,
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
      // 执行器跟着新段走（换执行器续聊开的段）：台账行未到就取当前执行器——新段
      // 正是用它开的。快照直通/冷启动回放的执行器提示都读这一位
      const segRow = wb.sessions.find((x) => String(x.id) === sid);
      const runtimeId = segRow !== undefined ? String(segRow.runtimeId) : wb.activeRuntimeId;
      useChatPanes.setState((s) => ({
        panes: {
          ...s.panes,
          [key]: { ...pane, sessionId: sid, lineageId: lineage, knownSessionIds: known, runtimeId },
        },
      }));
    }
  });

  return () => {
    void unsubCanvas.then((un) => un());
    unsubWorkbench();
  };
}
