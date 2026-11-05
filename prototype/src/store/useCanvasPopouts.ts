import { create } from "zustand";
import { collectLeafIds, collectChatPaneKeys, useTerminalStore } from "./useTerminalStore.ts";
import { useChatPanes } from "./useChatPanes.ts";
import { useWorkbench } from "./useWorkbench.ts";

/**
 * 会话画布弹出窗口（docs/31 三期）—— 主窗口侧的台账与交接。
 *
 * 语义（与 PS 浮窗的本质差异如实落地）：xterm 不可跨窗口搬移，「弹出」=
 * 主窗口本地会话**释放不杀**（registry.release，PTY 留在 daemon）+ popout
 * 子窗口按 terminalId 重新认领（subscribe + scrollback 回放）；对话弹出 =
 * 摘窗格（不杀会话）+ popout 内 openSession 谱系重放。归拢 / popout 关闭 =
 * 反向：终端 readoptTerminal 重认领，对话 openChatPane 开回标签。
 *
 * 关闭侦测双保险：popout beforeunload → postMessage（awb:canvas-popout-closed，
 * 携带自身 URL，主窗口 F5 过后也能对上账）+ 每秒轮询 win.closed。
 */

export interface PopoutEntry {
  readonly id: string;
  readonly kind: "terminal" | "chat";
  readonly terminalId?: string;
  readonly unitId?: string;
  readonly sessionId?: string | null;
  readonly title: string;
  readonly win: Window | null;
}

interface CanvasPopoutsState {
  entries: readonly PopoutEntry[];

  /** 标签右键入口：解析组（仅支持单窗格组弹出），交接并开窗 */
  popoutTab: (groupId: string) => void;
  /** 弹出终端窗格（释放不杀） */
  popoutTerminal: (terminalId: string, title: string) => void;
  /** 弹出对话窗格（摘窗格不杀会话） */
  popoutChat: (unitId: string, sessionId: string | null, title: string) => void;
  /** 归拢一条：关窗 + 重认领回标签 */
  recall: (id: string) => void;
  /** 一键归拢全部 */
  recallAll: () => void;
  /** 消息/轮询的安装器（WorkspaceShell 装一次） */
  install: () => () => void;
}

function popoutUrl(entry: Omit<PopoutEntry, "win" | "title">): string {
  const po = encodeURIComponent(entry.id);
  return entry.kind === "terminal"
    ? `#/popout/t/${encodeURIComponent(entry.terminalId ?? "")}?po=${po}`
    : `#/popout/c/${encodeURIComponent(entry.unitId ?? "")}/${entry.sessionId == null ? "-" : encodeURIComponent(entry.sessionId)}?po=${po}`;
}

/** popout 路由的单源解析（PopoutShell 与本 store 的关闭通告对账共用） */
export function parsePopoutRoute(hash: string):
  | { kind: "terminal"; terminalId: string }
  | { kind: "chat"; unitId: string; sessionId: string | null }
  | null {
  let m = /^#\/popout\/t\/([^/?]+)/.exec(hash);
  if (m !== null) return { kind: "terminal", terminalId: decodeURIComponent(m[1]!) };
  m = /^#\/popout\/c\/([^/]+)\/([^/?]+)/.exec(hash);
  if (m !== null) {
    const sid = decodeURIComponent(m[2]!);
    return { kind: "chat", unitId: decodeURIComponent(m[1]!), sessionId: sid === "-" ? null : sid };
  }
  return null;
}

/** postMessage 载荷里带回的 URL → 重认领（主窗口 F5 后也能按 URL 对账） */
function readoptByUrl(rawUrl: string): void {
  const route = parsePopoutRoute(rawUrl.slice(rawUrl.indexOf("#")));
  if (route === null) return;
  if (route.kind === "terminal") {
    void useTerminalStore.getState().readoptTerminal(route.terminalId);
    return;
  }
  useChatPanes
    .getState()
    .openChatPane({ unitId: route.unitId, sessionId: route.sessionId });
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useCanvasPopouts = create<CanvasPopoutsState>((set, get) => {
  const ensurePoll = (): void => {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      const closed = get().entries.filter((e) => e.win !== null && e.win.closed);
      if (closed.length === 0) return;
      for (const e of closed) get().recall(e.id);
    }, 1200);
  };
  const stopPollIfIdle = (): void => {
    if (get().entries.length === 0 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const openWindow = (entry: Omit<PopoutEntry, "win">): void => {
    // 防重复弹出：同一窗格的弹窗已开着 → 聚焦它即可（第二个窗口重认领同一
    // PTY 会两处 xterm 抢同一画布；对话弹出双开倒无害，但统一聚焦最省心）
    const existing = get().entries.find((e) => e.id === entry.id);
    if (existing !== undefined) {
      try {
        existing.win?.focus();
      } catch {
        /* ignore */
      }
      return;
    }
    // window.open 出参（popup 特征串同时给尺寸）；弹窗拦截（null）时如实相告，
    // 交接已做完的终端/窗格当场归位，不留孤儿
    const win = window.open(popoutUrl(entry), `awb-popout-${entry.id}`, "popup=yes,width=1000,height=700");
    if (win === null) {
      useWorkbench.getState().pushNotice(
        "弹出窗口被拦截",
        "浏览器拦下了弹窗。允许本站弹窗后重试「弹出为独立窗口」。",
        { level: "warn" },
      );
      if (entry.kind === "terminal") void useTerminalStore.getState().readoptTerminal(entry.terminalId ?? "");
      else useChatPanes.getState().openChatPane({ unitId: entry.unitId ?? "", sessionId: entry.sessionId ?? null });
      return;
    }
    set((s) => ({ entries: [...s.entries.filter((e) => e.id !== entry.id), { ...entry, win }] }));
    ensurePoll();
  };

  return {
    entries: [],

    popoutTab: (groupId) => {
      const st = useTerminalStore.getState();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group) return;
      const terms = collectLeafIds(group.rootLayout);
      const chats = collectChatPaneKeys(group.rootLayout);
      if (terms.length + chats.length !== 1) {
        useWorkbench.getState().pushNotice(
          "暂不支持整组弹出",
          "这个标签里有分屏窗格 —— 目前弹出为单窗格窗口；先把窗格合并（关掉多余分屏）再弹出。",
          { level: "warn" },
        );
        return;
      }
      if (terms.length === 1) {
        const inst = st.instances.find((i) => i.id === terms[0]);
        get().popoutTerminal(terms[0]!, inst?.title ?? "终端");
        return;
      }
      const pane = useChatPanes.getState().panes[chats[0]!];
      if (pane === undefined) return;
      const unit = useWorkbench.getState().units.find((u) => u.id === pane.unitId);
      get().popoutChat(pane.unitId, pane.sessionId, unit ? `${unit.name} · 对话` : "对话");
    },

    popoutTerminal: (terminalId, title) => {
      // 交接：布局/实例表摘除 + 本地会话释放不杀（PTY 留 daemon 给 popout）
      useTerminalStore.getState().releaseTerminalToPopout(terminalId);
      openWindow({ id: `pop_${terminalId}`, kind: "terminal", terminalId, title });
    },

    popoutChat: (unitId, sessionId, title) => {
      // 摘窗格不杀会话：closeChatPane 走「删记录 + 摘叶子」的常规路径
      const pane = Object.values(useChatPanes.getState().panes).find(
        (p) => p.unitId === unitId && p.sessionId === sessionId,
      );
      if (pane !== undefined) useTerminalStore.getState().closeChatPane(pane.paneKey);
      openWindow({ id: `pop_c_${unitId}_${sessionId ?? "draft"}`, kind: "chat", unitId, sessionId, title });
    },

    recall: (id) => {
      const entry = get().entries.find((e) => e.id === id);
      set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
      stopPollIfIdle();
      if (entry === undefined) return;
      if (entry.kind === "terminal") {
        void useTerminalStore.getState().readoptTerminal(entry.terminalId ?? "");
      } else {
        useChatPanes.getState().openChatPane({ unitId: entry.unitId ?? "", sessionId: entry.sessionId ?? null });
      }
      try {
        entry.win?.close();
      } catch {
        /* 跨域/已关：忽略 */
      }
    },

    recallAll: () => {
      for (const e of get().entries) get().recall(e.id);
    },

    install: () => {
      // popout beforeunload 通告：按 URL 对账重认领（不依赖 entry 还在——主窗口
      // F5 后 entries 已清空，URL 里的事实源仍能找回终端/会话）
      const onMessage = (e: MessageEvent): void => {
        const data = e.data as { type?: string; url?: string } | null;
        if (data?.type !== "awb:canvas-popout-closed" || typeof data.url !== "string") return;
        const po = /[?&]po=([^&]+)/.exec(data.url.slice(data.url.indexOf("#")));
        const id = po !== null ? decodeURIComponent(po[1]!) : null;
        if (id !== null && get().entries.some((x) => x.id === id)) get().recall(id);
        else readoptByUrl(data.url);
      };
      window.addEventListener("message", onMessage);
      return () => {
        window.removeEventListener("message", onMessage);
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },
  };
});
