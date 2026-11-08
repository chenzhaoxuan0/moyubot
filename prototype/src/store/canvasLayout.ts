import {
  useTerminalStore,
  allPaneIds,
  collectGroupIds,
  newBranchId,
  newGroupId,
  type GroupLayoutNode,
  type PaneGroup,
  type CanvasPane,
} from "./useTerminalStore.ts";
import { useChatPanes } from "./useChatPanes.ts";
import { useCanvasPopouts, type PopoutEntry } from "./useCanvasPopouts.ts";

/** 布局尾部追加一个组叶子（无布局则以它为根）—— 文档外的组与重挂找回的终端共用 */
function appendGroupLeaf(layout: GroupLayoutNode | null, gid: string): GroupLayoutNode {
  return layout === null
    ? { type: "group", groupId: gid }
    : { type: "split", id: newBranchId(), direction: "horizontal", first: layout, second: { type: "group", groupId: gid }, ratio: 0.5 };
}

/**
 * 画布布局持久化（docs/32 组栈模型，v2 文档）——「哪些格、格怎么分、格内
 * 哪些标签、激活什么」落 localStorage，F5 后在终端重挂完成时整树重建：
 *
 * - 终端标签按 id（daemon terminalId 跨刷新稳定）匹配重挂产物；匹配不上
 *   的从组里剔除。
 * - 对话标签按身份（unitId + 当前段 id）重建注册表记录；运行时 paneKey 是
 *   会话内瞬态 id，序列化层把它映射成稳定 id（`chat:${unitId}:${sid|draft}`），
 *   恢复时再映射回新 paneKey（草稿按同 unit 递增序号区分多开）。
 * - 「未选 bot」窗格（unitId=""）不持久化；草稿正文不持久化（身份回、文本丢）。
 * - v1 文档（docs/31 叶子=窗格模型）不迁移：读到 v1 键直接忽略，回落
 *   reattach 平铺 + 路由回放，一次性损失布局排列。
 * - 写节奏：400ms 去抖 + **beforeunload 补写**（A5，对齐 orca checkpoint 口径，
 *   补上去抖尾巴）。
 */

const LAYOUT_KEY = "agent-workbench:canvas-layout-v2";

type SnapNode =
  | { t: "grp"; g: string }
  | { t: "split"; d: "h" | "v"; r?: number; f: SnapNode; s: SnapNode };

interface GroupSnap {
  id: string;
  tabs: string[]; // 稳定 id 序（终端 = 原生 id；对话 = chat: 映射 id）
  active: string | null;
}

interface CanvasLayoutDoc {
  v: 2;
  panes: ReadonlyArray<Record<string, unknown> & { id: string; kind: "terminal" | "chat" }>;
  groups: ReadonlyArray<GroupSnap>;
  layout: SnapNode | null;
  activeGroupId: string | null;
  /** 弹出窗口快照（F5 时不把已弹出终端重挂成标签，防两处 xterm 抢同一 PTY） */
  popouts: ReadonlyArray<Omit<PopoutEntry, "win">>;
}

/** 比例容差：|r-0.5| ≤ 0.005 序列化省略（对齐 orca SPLIT_RATIO_TOLERANCE） */
const RATIO_TOLERANCE = 0.005;

/** 对话窗格的稳定序列化 id */
function chatStableId(unitId: string, sessionId: string | null, draftSeq: number): string {
  return sessionId !== null
    ? `chat:${unitId}:${sessionId}`
    : `chat:${unitId}:draft-${draftSeq}`;
}

function readDoc(): CanvasLayoutDoc | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CanvasLayoutDoc;
    if (parsed?.v !== 2 || !Array.isArray(parsed.groups)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDoc(doc: CanvasLayoutDoc): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(doc));
  } catch {
    /* 隐私模式等：本次会话内布局照常，只是不落盘 */
  }
}

/** 恢复中的标志：persist 在恢复完成前不该写盘 */
let restoring = false;

/** 序列化当前画布（供去抖持久化与 beforeunload 共用） */
function snapshot(): CanvasLayoutDoc {
  const st = useTerminalStore.getState();
  const chatPanes = useChatPanes.getState().panes;
  const draftSeqByUnit = new Map<string, number>();
  const stableOf = (pane: CanvasPane): string => {
    if (pane.kind === "terminal") return pane.id;
    const record = chatPanes[pane.id];
    if (record === undefined || record.unitId === "") return `chat:__dropped__:${pane.id}`;
    if (record.sessionId !== null) return chatStableId(record.unitId, record.sessionId, 0);
    const seq = (draftSeqByUnit.get(record.unitId) ?? 0) + 1;
    draftSeqByUnit.set(record.unitId, seq);
    return chatStableId(record.unitId, null, seq);
  };
  const serNode = (node: GroupLayoutNode | null): SnapNode | null => {
    if (node === null) return null;
    if (node.type === "group") return { t: "grp", g: node.groupId };
    const f = serNode(node.first);
    const s = serNode(node.second);
    if (f === null || s === null) return null;
    const r = node.ratio ?? 0.5;
    return { t: "split", d: node.direction === "horizontal" ? "h" : "v", ...(Math.abs(r - 0.5) > RATIO_TOLERANCE ? { r } : {}), f, s };
  };
  const ids = new Set(allPaneIds(st.groups));
  const panes = Object.values(st.panes)
    .filter((p) => ids.has(p.id))
    .map((p) => ({ ...p }) as Record<string, unknown> & { id: string; kind: "terminal" | "chat" });
  return {
    v: 2,
    panes,
    groups: Object.values(st.groups).map((g) => ({
      id: g.id,
      tabs: g.tabOrder.map((id) => stableOf(st.panes[id]!)).filter((sid) => !sid.startsWith("chat:__dropped__:")),
      active: g.activePaneId !== null ? stableOf(st.panes[g.activePaneId]!) : null,
    })),
    layout: serNode(st.layout),
    activeGroupId: st.activeGroupId,
    popouts: useCanvasPopouts.getState().entries.map(({ win: _win, ...rest }) => rest),
  };
}

/**
 * F5 / 重启后的整树重建。返回是否恢复了任何东西（false = 盘上无文档或全部
 * 失效，调用方保持 reattach 的平铺现状即可）。
 */
export function restoreCanvasLayout(): boolean {
  const doc = readDoc();
  if (doc === null || doc.groups.length === 0) return false;
  const term = useTerminalStore.getState();
  const liveTerminals = new Set(
    Object.values(term.panes)
      .filter((p) => p.kind === "terminal")
      .map((p) => p.id),
  );

  restoring = true;
  try {
    // ① 对话标签：按稳定 id 反解身份 → 注册表重建（paneKey 全新）
    const paneIdByStable = new Map<string, string>();
    const revivedPanes: Record<string, CanvasPane> = {};
    for (const snapPane of doc.panes) {
      if (snapPane.kind !== "chat") continue;
      const m = /^chat:(.+):(draft-\d+|.+)$/.exec(snapPane.id);
      if (m === null) continue;
      const unitId = m[1]!;
      const tail = m[2]!;
      const isDraft = tail.startsWith("draft-");
      const sessionId = isDraft ? null : tail;
      const paneKey = useChatPanes.getState().restoreRecord(unitId, sessionId);
      if (paneKey === null) continue;
      paneIdByStable.set(snapPane.id, paneKey);
      revivedPanes[paneKey] = { id: paneKey, kind: "chat", title: "对话" };
    }

    // ② 组与标签：稳定 id → 运行时 pane id（终端须在重挂产物里；对话用①的新 key）。
    //    净化：同一标签只保留首个归属组——a61c404 修复前的拖拽 bug 会把同一
    //    标签写进多个组，存量脏文档不清洗的话同一对话格渲染两份，看起来像
    //    「一条消息发了两条」（组内重复 id 同样只留首个）
    const seenPaneIds = new Set<string>();
    const dedupePush = (paneId: string, target: string[], paneMap: Record<string, CanvasPane>, pane: CanvasPane): void => {
      if (seenPaneIds.has(paneId)) return;
      seenPaneIds.add(paneId);
      target.push(paneId);
      paneMap[paneId] = pane;
    };
    const groups: Record<string, PaneGroup> = {};
    const panes: Record<string, CanvasPane> = {};
    for (const gs of doc.groups) {
      const tabOrder: string[] = [];
      for (const sid of gs.tabs) {
        if (sid.startsWith("chat:")) {
          const paneKey = paneIdByStable.get(sid);
          if (paneKey === undefined) continue;
          dedupePush(paneKey, tabOrder, panes, revivedPanes[paneKey]!);
          continue;
        }
        if (!liveTerminals.has(sid)) continue;
        dedupePush(sid, tabOrder, panes, term.panes[sid]!);
      }
      if (tabOrder.length === 0) continue;
      let active =
        gs.active !== null
          ? gs.active.startsWith("chat:")
            ? (paneIdByStable.get(gs.active) ?? null)
            : tabOrder.includes(gs.active)
              ? gs.active
              : null
          : null;
      if (active === null || !tabOrder.includes(active)) active = tabOrder[tabOrder.length - 1]!;
      groups[gs.id] = { id: gs.id, tabOrder, activePaneId: active, recentPaneIds: [...tabOrder] };
    }
    if (Object.keys(groups).length === 0) {
      try {
        window.localStorage.removeItem(LAYOUT_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }

    // ③ 布局树：按组 id 重建；文档外的新组（重挂兜底追加）拼到尾部
    const reviveNode = (snap: SnapNode | null): GroupLayoutNode | null => {
      if (snap === null) return null;
      if (snap.t === "grp") return groups[snap.g] !== undefined ? { type: "group", groupId: snap.g } : null;
      const f = reviveNode(snap.f);
      const s = reviveNode(snap.s);
      if (f === null || s === null) return null;
      return {
        type: "split",
        id: newBranchId(),
        direction: snap.d === "h" ? "horizontal" : "vertical",
        first: f,
        second: s,
        ...(snap.r !== undefined ? { ratio: snap.r } : {}),
      };
    };
    let layout = reviveNode(doc.layout);
    const docGroups = layout !== null ? collectGroupIds(layout) : [];
    for (const gid of Object.keys(groups)) {
      if (docGroups.includes(gid)) continue;
      layout = appendGroupLeaf(layout, gid);
    }
    if (layout !== null && layout.type === "group") layout = null;

    // ④ 重挂找回但不在文档里的终端（持久化之后新造的）：追加平铺组，不丢；
    //    例外：正弹在独立窗口里的终端不认领（防两处 xterm 抢同一 PTY）
    const covered = new Set(allPaneIds(groups));
    const poppedTerminals = new Set((doc.popouts ?? []).filter((p) => p.kind === "terminal").map((p) => p.terminalId ?? ""));
    const extra = [...liveTerminals].filter((id) => !covered.has(id) && !poppedTerminals.has(id));
    if (extra.length > 0) {
      const gid = newGroupId();
      groups[gid] = { id: gid, tabOrder: extra, activePaneId: extra[extra.length - 1] ?? null, recentPaneIds: [...extra] };
      for (const id of extra) panes[id] = term.panes[id]!;
      layout = appendGroupLeaf(layout, gid);
    }
    if ((doc.popouts ?? []).length > 0) {
      useCanvasPopouts.setState({
        entries: (doc.popouts ?? []).map((p) => ({ ...p, win: null })) as readonly PopoutEntry[],
      });
    }

    const activeGroupId = groups[doc.activeGroupId ?? ""] !== undefined ? (doc.activeGroupId as string) : Object.keys(groups)[0]!;
    const activeGroup = groups[activeGroupId]!;

    useTerminalStore.setState({
      panes,
      groups,
      layout,
      activeGroupId,
      activePaneId: activeGroup.activePaneId,
      maximizedPaneId: null,
    });
    return true;
  } finally {
    restoring = false;
  }
}

/** 画布/注册表/弹窗台账任一变化 → 去抖落盘；beforeunload 补写尾巴（A5） */
export function installCanvasLayoutPersist(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (restoring) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (restoring) return;
      writeDoc(snapshot());
    }, 400);
  };
  // A5：beforeunload 同步补写——去抖窗口内的最后一批变更不丢
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!restoring) writeDoc(snapshot());
  };
  window.addEventListener("beforeunload", flush);
  const un1 = useTerminalStore.subscribe(persist);
  const un2 = useChatPanes.subscribe(persist);
  const un3 = useCanvasPopouts.subscribe(persist);
  return () => {
    window.removeEventListener("beforeunload", flush);
    if (timer !== null) clearTimeout(timer);
    un1();
    un2();
    un3();
  };
}
