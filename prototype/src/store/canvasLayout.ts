import {
  useTerminalStore,
  collectLeafIds,
  type LayoutNode,
  type TerminalTabGroup,
} from "./useTerminalStore.ts";
import { useChatPanes } from "./useChatPanes.ts";
import { useCanvasPopouts, type PopoutEntry } from "./useCanvasPopouts.ts";

/**
 * 画布布局持久化（docs/31 二期）—— 把「哪些标签、怎么分屏、焦点在哪」落
 * localStorage，重启 / F5 后在终端重挂（reattachFromDaemon）完成时整树重建：
 *
 * - 终端叶按 instanceId 匹配重挂产物（daemon 的 terminalId 跨刷新稳定）；
 *   匹配不上的叶子剪掉（PTY 已死），分支自动塌缩。
 * - 对话叶按身份（unitId + 当前段 id）重建窗格记录（paneKey 换新——它是
 *   会话内瞬态 id，不跨刷新）；「未选 bot」的窗格（unitId=""）不持久化。
 * - 重挂找回了持久化之后新造的终端（别的窗口/设备造的）：追加成平铺标签，
 *   不丢。
 * - 激活组恢复后若其首个窗格是 chat → focusChatPaneTab 走焦点链 openSession
 *   重建时间线（与 hash 路由回放天然收敛：openChatPane 幂等）。
 *
 * 时序：restoreCanvasLayout 必须在 reattachFromDaemon 完成后、
 * installCanvasLayoutPersist 订阅装上之前调用，否则会把重建中间态写回盘上。
 */

const LAYOUT_KEY = "agent-workbench:canvas-layout-v1";

type SnapNode =
  | { t: "term"; id: string }
  | { t: "chat"; unitId: string; sessionId: string | null }
  | { t: "br"; d: "h" | "v"; r: number; f: SnapNode; s: SnapNode };

interface CanvasLayoutDoc {
  v: 1;
  groups: ReadonlyArray<{ id: string; title?: string; layout: SnapNode }>;
  activeGroupId: string | null;
  /** 激活组当时聚焦的是不是 chat 窗格（paneKey 是会话内瞬态 id，只存方向不存值） */
  activeIsChat: boolean;
  /**
   * 弹出窗口快照（docs/31 三期）：F5 时弹窗还开着的话，重挂不得把已弹出的
   * 终端再认领成标签（两处 xterm 抢同一 PTY）。Window 引用跨不了刷新，恢复
   * 出的是无引用台账（归拢/关闭通告仍可用，轮询废掉）。
   */
  popouts: ReadonlyArray<{
    id: string;
    kind: "terminal" | "chat";
    terminalId?: string;
    unitId?: string;
    sessionId?: string | null;
    title: string;
  }>;
}

function serializeNode(node: LayoutNode): SnapNode | null {
  if (node.type === "leaf") return { t: "term", id: node.instanceId };
  if (node.type === "chatLeaf") {
    const pane = useChatPanes.getState().panes[node.paneKey];
    if (pane === undefined || pane.unitId === "") return null; // 已删/未选 bot 的窗格不存
    return { t: "chat", unitId: pane.unitId, sessionId: pane.sessionId };
  }
  const f = serializeNode(node.first);
  const s = serializeNode(node.second);
  if (f === null || s === null) return null;
  return { t: "br", d: node.direction === "horizontal" ? "h" : "v", r: node.ratio, f, s };
}

function readDoc(): CanvasLayoutDoc | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CanvasLayoutDoc;
    if (parsed?.v !== 1 || !Array.isArray(parsed.groups)) return null;
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

/** 恢复中的标志：persist 订阅在恢复完成前不该写盘（见安装器说明） */
let restoring = false;

/**
 * F5 / 重启后的布局重建。返回是否恢复了任何东西（false = 盘上无文档或全部
 * 失效，调用方保持 reattach 的平铺现状即可）。
 */
export function restoreCanvasLayout(): boolean {
  const doc = readDoc();
  if (doc === null || doc.groups.length === 0) return false;
  const term = useTerminalStore.getState();
  const liveTerminals = new Set(term.instances.map((i) => i.id));

  restoring = true;
  try {
    const rebuilt: TerminalTabGroup[] = [];
    const revive = (snap: SnapNode): LayoutNode | null => {
      if (snap.t === "term") {
        return liveTerminals.has(snap.id) ? { type: "leaf", instanceId: snap.id } : null;
      }
      if (snap.t === "chat") {
        const paneKey = useChatPanes.getState().restoreRecord(snap.unitId, snap.sessionId);
        return paneKey === null ? null : { type: "chatLeaf", paneKey };
      }
      const f = revive(snap.f);
      const s = revive(snap.s);
      if (f === null || s === null) return null;
      return { type: "branch", id: `br_${Math.random().toString(36).slice(2, 8)}`, direction: snap.d === "h" ? "horizontal" : "vertical", first: f, second: s, ratio: snap.r };
    };

    for (const g of doc.groups) {
      const layout = revive(g.layout);
      if (layout !== null) rebuilt.push({ id: g.id, title: g.title, rootLayout: layout });
    }

    // 重挂找回但不在文档里的终端（持久化之后新造的）：追加平铺标签，不丢。
    // 例外：正弹在独立窗口里的终端不认领（两处 xterm 会抢同一 PTY）——
    // 弹窗台账按快照恢复（无 Window 引用），它关闭时经 postMessage 重认领
    const covered = new Set(rebuilt.flatMap((g) => collectLeafIds(g.rootLayout)));
    const docPopouts = doc.popouts ?? [];
    const poppedTerminals = new Set(
      docPopouts.filter((p) => p.kind === "terminal").map((p) => p.terminalId ?? ""),
    );
    for (const inst of term.instances) {
      if (!covered.has(inst.id) && !poppedTerminals.has(inst.id)) {
        rebuilt.push({ id: `group_${inst.id}`, rootLayout: { type: "leaf", instanceId: inst.id } });
      }
    }
    if (docPopouts.length > 0) {
      useCanvasPopouts.setState({
        entries: docPopouts.map((p) => ({ ...p, win: null })) as readonly PopoutEntry[],
      });
    }

    if (rebuilt.length === 0) {
      // 全部失效（PTY 全死 + bot 全删）：清掉文档，保持 reattach 现状
      useTerminalStore.setState({ groups: [], activeGroupId: null, activeInstanceId: null, activeChatPaneKey: null });
      try {
        window.localStorage.removeItem(LAYOUT_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }

    const activeGroupId = rebuilt.some((g) => g.id === doc.activeGroupId)
      ? (doc.activeGroupId as string)
      : rebuilt[0]!.id;
    const activeGroup = rebuilt.find((g) => g.id === activeGroupId)!;

    useTerminalStore.setState({
      groups: rebuilt,
      activeGroupId,
      activeInstanceId: collectLeafIds(activeGroup.rootLayout)[0] ?? null,
      activeChatPaneKey: null,
      maximizedPaneId: null,
    });

    // 恢复时的焦点方向：当时聚焦的是 chat → 走焦点链把会话 openSession 回来；
    // 是终端 → 游标已指到首个终端叶，保持
    if (doc.activeIsChat) {
      const firstChatKey = chatKeyOf(activeGroup.rootLayout);
      if (firstChatKey !== null) useTerminalStore.getState().focusChatPaneTab(firstChatKey);
    }
    return true;
  } finally {
    restoring = false;
  }
}

function chatKeyOf(node: LayoutNode): string | null {
  if (node.type === "chatLeaf") return node.paneKey;
  if (node.type === "leaf") return null;
  return chatKeyOf(node.first) ?? chatKeyOf(node.second);
}

/** 画布/chat 注册表任一变化 → 去抖落盘。装在 restore 完成之后。 */
export function installCanvasLayoutPersist(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (restoring) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (restoring) return;
      const term = useTerminalStore.getState();
      const groups: { id: string; title?: string; layout: SnapNode }[] = [];
      for (const g of term.groups) {
        const layout = serializeNode(g.rootLayout);
        if (layout === null) continue;
        const entry: { id: string; title?: string; layout: SnapNode } = { id: g.id, layout };
        if (g.title !== undefined) entry.title = g.title;
        groups.push(entry);
      }
      writeDoc({
        v: 1,
        groups,
        activeGroupId: term.activeGroupId,
        activeIsChat: term.activeChatPaneKey !== null,
        popouts: useCanvasPopouts.getState().entries.map(({ win: _win, ...rest }) => rest),
      });
    }, 400);
  };
  const un1 = useTerminalStore.subscribe(persist);
  const un2 = useChatPanes.subscribe(persist);
  const un3 = useCanvasPopouts.subscribe(persist);
  return () => {
    if (timer !== null) clearTimeout(timer);
    un1();
    un2();
    un3();
  };
}
