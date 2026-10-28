import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import {
  CHAT_DOCK_UNIT_ID,
  terminalSessionRegistry,
} from "../store/TerminalSessionManager.ts";
import {
  CHAT_DOCK_MIN_HEIGHT,
  chatTerminalProfile,
  formatChatTerminalTabTitle,
  useChatTerminal,
  type ChatTerminalTab,
} from "../store/useChatTerminal.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useChatAccentStyle } from "./useChatAccentStyle.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { MobileVirtualKeyBar } from "./mobile/MobileVirtualKeyBar.tsx";
import { cn } from "./cn.ts";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";
import { useTerminalContextMenu } from "./terminalContextMenu.ts";

/**
 * 对话页小终端 —— Composer 下方带标签页的快捷终端（Composer 工具栏按钮唤起）。
 *
 * 布局与语义对齐 ZCode 的 Terminal.tsx：标题行「终端 + Shell 名」+ 可滚动标签
 * （标题 = 工作区目录名，第 2 个起带最小编号）+「+」新建 +「×」收面板；
 * 关末签 = 收面板保活，PTY 自退 = 移标签（末签自退连面板一起收）。
 * 与 TUI 终端页互相隔离（daemon 侧 unitId 标记）；收面板不杀任何 PTY。
 */
export function ChatTerminalDock() {
  const { isMobile } = useIsMobile();
  const open = useChatTerminal((s) => s.open);
  const height = useChatTerminal((s) => s.height);
  const setHeight = useChatTerminal((s) => s.setHeight);
  const profileId = useChatTerminal((s) => s.profileId);
  const restartSeq = useChatTerminal((s) => s.restartSeq);
  const tabs = useChatTerminal((s) => s.tabs);
  const activeTabId = useChatTerminal((s) => s.activeTabId);
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  // 终端右键：复制（xterm canvas 选区）/ 粘贴 —— 原生文本菜单对终端无效
  const { menu: ctxMenu, onContextMenu: onTerminalContextMenu, closeMenu } =
    useTerminalContextMenu(activeTabId ?? tabs[0]?.id);
  // tab 右键三件套的菜单 state（与终端右键共用 QuickContextMenu 渲染位）
  const [tabMenu, setTabMenu] = useState<QuickMenuState | null>(null);

  const profile = chatTerminalProfile(profileId);
  const mountRef = useRef<HTMLDivElement>(null);
  /** 当前 attach 在容器里的会话 id（切标签时给前一个 detach） */
  const attachedIdRef = useRef<string | null>(null);
  /** F5 认领到的输出回放（getOrCreate 时消费一次） */
  const scrollbackRef = useRef<Map<string, string>>(new Map());
  /**
   * F5 校正（terminal.list 往返）进行中标记：期间 attach effect 绝不能抢先建会话 ——
   * 旧 id 的 PTY 可能还活着，抢先 terminal.create 同 id 会在 daemon 起第二个进程。
   * 校正完成后 bump reclaimSeq 让 attach effect 重跑补挂载。
   */
  const reclaimPendingRef = useRef(false);
  const [reclaimSeq, setReclaimSeq] = useState(0);
  // 本 bot 对话强调色：终端画布色从自身 DOM 所在子树解析（TerminalSessionManager
  // 的 applyTheme scope 机制），accent 变了要重应用一次主题让画布跟上
  const chatAccentStyle = useChatAccentStyle();

  /** 当前工作区目录名（新标签标题主体） */
  const cwdLeaf = useCallback((): string => {
    const { units, activeUnitId } = useWorkbench.getState();
    const root = units.find((u) => u.id === activeUnitId)?.rootPath ?? "";
    const leaf = root.split(/[\\/]+/).filter(Boolean).pop();
    return leaf || "终端";
  }, []);

  const ensureSession = useCallback(
    (tab: ChatTerminalTab, opts?: { attachScrollback?: string }) => {
      const existing = terminalSessionRegistry.get(tab.id);
      if (existing) return existing;
      return terminalSessionRegistry.getOrCreate({
        terminalId: tab.id,
        shell: chatTerminalProfile(useChatTerminal.getState().profileId).shell,
        // cwd 只在「新建 PTY」那一刻有意义；getState 直取，换 bot 不重建已活着的终端
        cwd: useWorkbench.getState().units.find((u) => u.id === useWorkbench.getState().activeUnitId)?.rootPath ?? "",
        unitId: CHAT_DOCK_UNIT_ID,
        attachScrollback: opts?.attachScrollback,
        onExit: () => {
          // PTY 自身退出是会话生命周期终点：同步删标签（末签自退连面板一起收）
          useChatTerminal.getState().removeExitedTab(tab.id);
        },
      });
    },
    [],
  );

  // 面板展开 / 换 Shell（restartSeq）→ 校正标签与会话；收起 → 全部 detach（保活）
  useEffect(() => {
    if (!open) {
      const id = attachedIdRef.current;
      if (id) terminalSessionRegistry.get(id)?.detach();
      attachedIdRef.current = null;
      return;
    }
    // 同步过程不取消防抖：中途收起面板时，会话留在 registry 保活（与收面板语义一致），
    // attach effect 的 open=false 分支不会把它挂到任何容器
    void (async () => {
      reclaimPendingRef.current = true;
      try {
        // 1. F5 校正：registry 里没有的标签查 terminal.list —— 活着的认领回放，
        //    已死的就地换新 id（kill 异步往返期间 list 里可能还有将死的 PTY，
        //    所以这里以 list 实测为准，而不是盲目当重挂）
        const state0 = useChatTerminal.getState();
        const missing = state0.tabs.filter((t) => !terminalSessionRegistry.get(t.id));
        if (missing.length > 0) {
          const aliveScrollback = new Map<string, string>();
          let listed = false;
          try {
            const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
            const list = await DaemonClient.get(defaultDaemonEndpoint()).rpc<
              Array<{ terminalId: string; unitId?: string; scrollback?: string }>
            >("terminal.list", null, 8000);
            listed = true;
            for (const row of list) {
              if (row.unitId !== CHAT_DOCK_UNIT_ID) continue;
              aliveScrollback.set(row.terminalId, row.scrollback ?? "");
            }
          } catch {
            // list 失败 ≠ 全部死了：daemon 慢/WS 抖动时旧 PTY 很可能都活着，
            // 换新 id 会把一整排 PTY 孤儿化。保留原 id 走建会话路径 ——
            // daemon 侧 create 对活 id 幂等返回，真死的条目自然新建。
          }
          if (listed) {
            const deadIds = missing.filter((m) => !aliveScrollback.has(m.id)).map((m) => m.id);
            if (deadIds.length > 0) useChatTerminal.getState().replaceDeadTabs(deadIds);
            for (const [id, sb] of aliveScrollback) scrollbackRef.current.set(id, sb);
          }
        }

        // 2. 换 Shell 后标签被清空 → 懒建第 1 个
        if (useChatTerminal.getState().tabs.length === 0) {
          useChatTerminal.getState().addTab(cwdLeaf());
        }

        // 3. 为所有标签建会话（ZCode forceMount 同款：非激活标签也常驻 PTY）
        for (const t of useChatTerminal.getState().tabs) {
          ensureSession(t, { attachScrollback: scrollbackRef.current.get(t.id) });
          scrollbackRef.current.delete(t.id);
        }
      } finally {
        reclaimPendingRef.current = false;
        setReclaimSeq((n) => n + 1);
      }
    })();
  }, [open, restartSeq, cwdLeaf, ensureSession]);

  // 激活标签切换 → 换挂载（前一个 detach 保活），无会话的新标签就地建
  const tabsKey = tabs.map((t) => t.id).join("|");
  useEffect(() => {
    if (!open) return;
    const container = mountRef.current;
    if (!container) return;
    const activeId = useChatTerminal.getState().activeTabId ?? tabs[0]?.id ?? null;
    if (attachedIdRef.current && attachedIdRef.current !== activeId) {
      terminalSessionRegistry.get(attachedIdRef.current)?.detach();
    }
    attachedIdRef.current = activeId;
    if (!activeId) return;
    // F5 校正往返期间不得抢先建会话：会以旧 id create 撞上 daemon 里还活着的 PTY。
    // 校正完成（reclaimSeq 变化）后本 effect 重跑补挂载。
    if (reclaimPendingRef.current) return;
    const tab = tabs.find((t) => t.id === activeId);
    const session = tab ? ensureSession(tab) : null;
    session?.attachTo(container);
    session?.focus();
  }, [open, tabsKey, activeTabId, tabs, ensureSession, reclaimSeq]);

  // 主题切换跟随（registry.updateAllThemes 只刷挂载中的画布，这里补 detach 态口径）；
  // 强调色变化（切 bot / 改 themeAccent）也要重应用 —— applyTheme 会按终端自身
  // DOM 所在子树重新解析 --color-teal* 系变量
  useEffect(() => {
    for (const t of tabs) terminalSessionRegistry.get(t.id)?.applyTheme(resolvedTheme === "dark");
  }, [resolvedTheme, tabs, chatAccentStyle]);

  // 顶部拖拽改高度（移动端固定 40vh，不出拖拽手柄）
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback((e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, startH: useChatTerminal.getState().height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setHeight(drag.startH + (drag.startY - e.clientY));
    },
    [setHeight],
  );
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!open) return null;

  const dockHeight = isMobile
    ? Math.min(320, Math.max(CHAT_DOCK_MIN_HEIGHT, Math.round(window.innerHeight * 0.4)))
    : height;
  const activeProfile = chatTerminalProfile(useChatTerminal.getState().profileId);

  return (
    <div
      className="shrink-0 flex flex-col rounded-t-xl border border-b-0 border-line bg-card shadow-subtle overflow-hidden"
      style={{ height: `${dockHeight}px` }}
      aria-label="对话终端"
    >
      {/* 顶部拖拽手柄（桌面端）：贴住上缘的细热区 */}
      {!isMobile && (
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className="h-1.5 shrink-0 cursor-row-resize bg-line-soft/60 hover:bg-teal/40 transition-colors touch-none"
          title="拖拽调整高度"
        />
      )}

      {/* 标题行（ZCode Terminal.tsx 同款节奏）：终端 + Shell 名 | 标签 | + | × */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft bg-rail/70 pl-3 pr-1.5 select-none">
        <div className="flex shrink-0 items-center gap-2 min-w-0">
          <SquareTerminal size={13} className="shrink-0 text-teal" />
          <span className="text-xs font-semibold text-ink">终端</span>
          <span className="shrink-0 text-[11px] text-graphite">{activeProfile.name}</span>
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto flex items-center gap-1 py-1">
          {tabs.map((tab) => {
            const isActive = tab.id === (activeTabId ?? tabs[0]?.id);
            const title = formatChatTerminalTabTitle(tab);
            return (
              <div
                key={tab.id}
                onClick={() => useChatTerminal.getState().setActiveTab(tab.id)}
                onContextMenu={(e) => {
                  // tab 右键三件套（ZCode SidePaneTabTrigger 同款）
                  setTabMenu(
                    quickMenuFromEvent(e, [
                      { label: "关闭", icon: X, onSelect: () => useChatTerminal.getState().closeTab(tab.id) },
                      {
                        label: "关闭其它",
                        icon: X,
                        disabled: tabs.filter((t) => t.id !== tab.id).length === 0,
                        onSelect: () => useChatTerminal.getState().closeOtherTabs(tab.id),
                      },
                      {
                        label: "关闭全部",
                        icon: X,
                        disabled: tabs.length === 0,
                        onSelect: () => useChatTerminal.getState().closeAllTabs(),
                      },
                    ]),
                  );
                }}
                className={cn(
                  "group relative inline-flex h-7 w-auto max-w-36 min-w-0 flex-none shrink-0 cursor-default items-center gap-1 overflow-hidden whitespace-nowrap rounded-lg pl-2 pr-1 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-line-soft text-ink shadow-xs"
                    : "text-graphite hover:bg-line-soft/60 hover:text-ink",
                )}
                title={title}
              >
                <span className="min-w-0 flex-1 overflow-hidden truncate">{title}</span>
                <button
                  type="button"
                  aria-label={`关闭终端 ${title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useChatTerminal.getState().closeTab(tab.id);
                  }}
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded text-ash hover:bg-line hover:text-loss transition",
                    !isActive && "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => useChatTerminal.getState().addTab(cwdLeaf())}
            aria-label="新建终端"
            title="新建终端"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={() => useChatTerminal.getState().setOpen(false)}
            aria-label="收起对话终端"
            title="收起面板（全部终端进程保留，再开瞬达）"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ash hover:bg-rose-500/15 hover:text-loss active:scale-90 transition"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* xterm 挂载点：激活标签的 TerminalSession 常驻 DOM 直接 append 进来 */}
      <div
        ref={mountRef}
        onContextMenu={onTerminalContextMenu}
        className="min-h-0 flex-1 overflow-hidden relative"
      />
      <QuickContextMenu menu={ctxMenu ?? tabMenu} onClose={() => { closeMenu(); setTabMenu(null); }} />

      {/* 移动端专属虚拟辅助按键栏（形式参照 Termux） */}
      {isMobile && <MobileVirtualKeyBar target="chat" />}
    </div>
  );
}

/** Composer 工具栏里的唤起开关 —— 面板开着时常亮 */
export function ChatTerminalToggleButton() {
  const open = useChatTerminal((s) => s.open);
  const toggle = useChatTerminal((s) => s.toggle);
  const { isMobile } = useIsMobile();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="对话终端"
      aria-pressed={open}
      title="对话终端 —— 在对话输入框下方唤起终端（Shell 在设置 → 终端里选）"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 active:scale-95 transition",
        "h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8",
        open ? "bg-teal-tint text-teal ring-1 ring-teal/30" : "text-graphite hover:text-teal hover:bg-line-soft",
      )}
    >
      <SquareTerminal size={isMobile ? 13 : 15} />
    </button>
  );
}
