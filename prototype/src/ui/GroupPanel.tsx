import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { X, Plus, MessageSquarePlus, Maximize2, ExternalLink } from "lucide-react";
import { useTerminalStore, type DropZone, type CanvasPane } from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useCanvasDnd } from "../store/canvasDnd.ts";
import { useCanvasPopouts } from "../store/useCanvasPopouts.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { TerminalPaneSlot, ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";
import { cn } from "./cn.ts";

/** 悬停焦点预览的时长阈值（B，docs/32 §四.4） */
const HOVER_FOCUS_PREVIEW_MS = 300;

/**
 * 分屏格 = 标签组（docs/32 组栈模型）—— 每个格子自带标签条；窗格（终端/
 * 对话）是组栈里的标签，**全部常驻挂载**（A1：仅激活标签可见，display:none +
 * inert 切换，切标签零 remount、xterm/对话状态零迁移）。
 *
 * 拖拽语义（§四）：拖标签经组标签条 = 插入指示（组内重排 / 跨组移动，条上
 * 永不产生分屏）；落到 body 走五向吸附（中央 80% 内圈 = 入栈并激活，四边 =
 * 分出新组）；悬停 ≥300ms 该格获得焦点预览。关标签按 MRU 恢复（A2，store
 * 内 nextActiveAfterClose）。非焦点格内容 dim（A3）。
 */
export function GroupPanel({ groupId }: { groupId: string }) {
  const group = useTerminalStore((s) => s.groups[groupId]);
  const panes = useTerminalStore((s) => s.panes);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const chatPanes = useChatPanes((s) => s.panes);
  const units = useWorkbench((s) => s.units);
  const draggingPaneId = useCanvasDnd((s) => s.draggingPaneId);

  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const [tabMenu, setTabMenu] = useState<QuickMenuState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFocused = activeGroupId === groupId;

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  /** chat 标签显示名：bot 名 · 对话（响应式：注册表/units 变化即刷） */
  const paneTitle = useCallback(
    (pane: CanvasPane): string => {
      if (pane.kind !== "chat") return pane.title;
      const record = chatPanes[pane.id];
      if (record === undefined || record.unitId === "") return "新对话";
      const unitName = units.find((u) => u.id === record.unitId)?.name;
      return `${unitName ?? "对话"} · 对话`;
    },
    [chatPanes, units],
  );

  /* ---- 五向 zone 几何（对齐 orca tab-drop-zone.ts 口径） ---- */
  const resolveZone = useCallback((e: DragEvent<HTMLElement>): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(1, rect.width);
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    // 中央 80% 内圈 = 入栈（center merge zone）
    if (x > 0.1 && x < 0.9 && y > 0.1 && y < 0.9) return "center";
    // 左右各 1/3 宽 = 水平分屏；中 1/3 按上下半 = 垂直分屏
    if (x < 1 / 3) return "left";
    if (x > 2 / 3) return "right";
    return y < 0.5 ? "top" : "bottom";
  }, []);

  const onBodyDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (draggingPaneId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const z = resolveZone(e);
      if (z !== zone) setZone(z);
      // 悬停焦点预览（B）：停在同一格 ≥300ms → 该格成为焦点格（看清落点
      // 上下文）；取消拖拽无需回滚——组激活本身无害
      if (!isFocused && hoverTimer.current === null) {
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          useTerminalStore.getState().setActiveGroup(groupId);
        }, HOVER_FOCUS_PREVIEW_MS);
      }
    },
    [draggingPaneId, groupId, isFocused, resolveZone, zone],
  );

  const clearHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const onBodyDragLeave = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setZone(null);
      clearHover();
    },
    [clearHover],
  );

  const onBodyDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dragId = useCanvasDnd.getState().draggingPaneId;
      setZone(null);
      clearHover();
      if (dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      useCanvasDnd.getState().endDrag();
      useTerminalStore.getState().dropPaneOnGroup(dragId, groupId, resolveZone(e));
    },
    [clearHover, groupId, resolveZone],
  );

  /** 标签条 onDrop（插入重排/跨组移动）——条与标签共用 */
  const onStripDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dragId = useCanvasDnd.getState().draggingPaneId;
      setDropIndex(null);
      if (dragId === null || dropIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      useCanvasDnd.getState().endDrag();
      useTerminalStore.getState().movePaneToGroup(dragId, groupId, dropIndex);
    },
    [dropIndex, groupId],
  );

  if (group === undefined) return null;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas transition-opacity",
        isFocused ? "opacity-100" : "opacity-75", // A3：非焦点格 dim
      )}
      onPointerDown={() => {
        if (!isFocused) useTerminalStore.getState().setActiveGroup(groupId);
      }}
    >
      {/* 组标签条 —— 本格的标签栈；拖拽插入指示在这里，永不产生分屏 */}
      <div
        className="flex h-8 shrink-0 select-none items-stretch gap-0.5 border-b border-line/40 bg-rail px-1"
        onDragOver={(e) => {
          const dragId = useCanvasDnd.getState().draggingPaneId;
          if (dragId === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={onStripDrop}
      >
        {group.tabOrder.map((paneId, i) => {
          const pane = panes[paneId];
          if (pane === undefined) return null;
          const isActive = group.activePaneId === paneId;
          const isDragging = draggingPaneId === paneId;
          const title = paneTitle(pane);
          return (
            <div key={paneId} className="flex shrink-0 items-stretch">
              {dropIndex === i && <div className="my-1.5 w-0.5 shrink-0 rounded-full bg-teal shadow-sm" />}
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", paneId);
                  useCanvasDnd.getState().startDrag(paneId);
                }}
                onDragEnd={() => {
                  useCanvasDnd.getState().endDrag();
                  setDropIndex(null);
                }}
                onDragOver={(e) => {
                  const dragId = useCanvasDnd.getState().draggingPaneId;
                  if (dragId === null || dragId === paneId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropIndex(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
                }}
                onDrop={onStripDrop}
                onClick={() => useTerminalStore.getState().activatePane(paneId)}
                onAuxClick={(e) => {
                  // 中键关闭（浏览器标签习惯）
                  if (e.button === 1) useTerminalStore.getState().closePane(paneId);
                }}
                onContextMenu={(e) =>
                  setTabMenu(
                    quickMenuFromEvent(e, [
                      {
                        label: "关闭",
                        icon: X,
                        onSelect: () => useTerminalStore.getState().closePane(paneId),
                      },
                      {
                        label: "关闭其它（本格）",
                        icon: X,
                        disabled: group.tabOrder.length <= 1,
                        onSelect: () => useTerminalStore.getState().closeOtherPanes(paneId),
                      },
                      {
                        label: "关闭整格",
                        icon: X,
                        onSelect: () => useTerminalStore.getState().closeGroup(groupId),
                      },
                      {
                        label: "弹出为独立窗口",
                        icon: ExternalLink,
                        onSelect: () => useCanvasPopouts.getState().popoutPane(paneId),
                      },
                    ]),
                  )
                }
                title={title}
                className={cn(
                  "group/tab relative m-0.5 flex min-w-0 max-w-[190px] cursor-pointer select-none items-center gap-1.5 rounded px-2 font-mono text-caption transition",
                  isActive
                    ? "bg-canvas text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-line-soft hover:text-ink",
                  isDragging && "opacity-40",
                )}
              >
                {pane.kind === "chat" ? (
                  <MessageSquarePlus size={12} className="shrink-0 text-teal" />
                ) : (
                  <ShellOrAgentIcon icon={pane.icon ?? "pwsh"} />
                )}
                <span className="truncate">{title}</span>
                {paneId.startsWith("autoterm_") && (
                  <span
                    title="派发终端 —— 经过派发系统，会记入该 bot 的历史会话"
                    className="shrink-0 rounded bg-violet-500/15 px-1 py-0.2 text-[9px] font-semibold text-violet-400 font-sans"
                  >
                    派发
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    useTerminalStore.getState().closePane(paneId);
                  }}
                  title={pane.kind === "chat" ? "关闭标签（不杀会话，历史可回）" : "关闭标签（杀终端进程）"}
                  aria-label={`关闭标签 ${title}`}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded p-0.5 text-ash transition",
                    "hover:bg-line-soft hover:text-rose-400",
                    isActive ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-80",
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          );
        })}
        {/* 拖到条尾的插入指示 */}
        {dropIndex === group.tabOrder.length && (
          <div className="my-1.5 w-0.5 shrink-0 self-center rounded-full bg-teal shadow-sm" />
        )}

        {/* 条尾 ＋：组内新建（小菜单） */}
        <GroupCreateButton />

        <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-0.5">
          {/* 窗格级最大化（双 kind 通用）：当前激活标签整幅显示 */}
          <button
            type="button"
            onClick={() => {
              const paneId = group.activePaneId;
              if (paneId !== null) useTerminalStore.getState().toggleMaximize(paneId);
            }}
            title="最大化当前标签（整格全幅显示）"
            className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
          >
            <Maximize2 size={11} />
          </button>
        </div>
      </div>

      {/* 窗格层：全部标签常驻挂载（A1），仅激活可见；五向吸附落点也在这一层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
      >
        {group.tabOrder.map((paneId) => {
          const pane = panes[paneId];
          if (pane === undefined) return null;
          const visible = group.activePaneId === paneId;
          return (
            <div
              key={paneId}
              className={cn("absolute inset-0 flex-col", visible ? "flex" : "hidden")}
              // inert：隐藏窗格不参与焦点与无障碍树（对齐 orca display:none+inert）
              {...(visible ? {} : { inert: true })}
              aria-hidden={!visible}
            >
              {pane.kind === "chat" ? (
                <ChatPaneSlot paneKey={paneId} />
              ) : (
                <TerminalPaneSlot pane={pane} />
              )}
            </div>
          );
        })}

        {/* 五向吸附高亮：center=整框内圈（入栈），四边=半幅（分新组） */}
        {draggingPaneId !== null && zone !== null && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {zone === "center" ? (
              <div className="absolute inset-[10%] rounded-panel bg-teal/10 ring-2 ring-teal/50 ring-inset" />
            ) : (
              <div
                className={cn(
                  "absolute bg-teal/15 ring-2 ring-teal/60 ring-inset transition-all duration-75",
                  zone === "left" && "inset-y-0 left-0 w-1/2",
                  zone === "right" && "inset-y-0 right-0 w-1/2",
                  zone === "top" && "inset-x-0 top-0 h-1/2",
                  zone === "bottom" && "inset-x-0 bottom-0 h-1/2",
                )}
              />
            )}
          </div>
        )}
      </div>
      <QuickContextMenu menu={tabMenu} onClose={() => setTabMenu(null)} />
    </div>
  );
}

/* ------------------------------------------------------------- 组内新建 */

/** 条尾「＋」：本格新建（对话 / 系统终端；Agent TUI 派发在顶部「＋」菜单） */
function GroupCreateButton() {
  const [open, setOpen] = useState(false);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  return (
    <div className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="本格新建标签：对话 / 系统终端（Agent TUI 派发在顶部「＋」菜单）"
        className="flex h-6 w-6 items-center justify-center rounded text-ash hover:bg-line-soft hover:text-teal transition"
      >
        <Plus size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 min-w-[190px] rounded-panel border border-line bg-card p-1 shadow-2xl">
            <button
              onClick={() => {
                setOpen(false);
                const chat = useChatPanes.getState();
                if (unit !== undefined) {
                  chat.openChatPane({ unitId: unit.id, sessionId: null });
                  return;
                }
                // 无 bot：开「未选 bot」草稿（窗格内嵌选择器）
                useTerminalStore.getState().createChatTab(chat.createDraftRecord());
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-caption font-mono text-ink hover:bg-teal-tint hover:text-teal transition"
            >
              <MessageSquarePlus size={12} className="text-teal" />
              {unit ? `对话 · ${unit.name}` : "对话（先选 bot）"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                useTerminalStore.getState().createTab({ cwd: unit?.rootPath });
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-caption font-mono text-ink hover:bg-teal-tint hover:text-teal transition"
            >
              <ShellOrAgentIcon icon="pwsh" />
              系统终端 (PowerShell 7)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
