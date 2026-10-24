import { useCallback, useRef } from "react";
import { BackgroundGuardianBadge, SessionLightLegendBadge, WorkPhaseBadge } from "./StatusIndicators.tsx";
import { Taskbar } from "./taskbar/Taskbar.tsx";
import { STATUSBAR_MIN, useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { sidePaneOccupies } from "../core/sidePaneTabs.ts";
import { cn } from "./cn.ts";

/**
 * 全局底栏 —— 状态显示类功能的专席，横贯窗口底部。
 *
 * 高度恒定（不随有无任务变化）：默认最薄一档 28px（原状态栏高度），任务 chip
 * 以单行紧凑形态放下；在意高度的用户可以拖上缘手柄拉高 —— 拉高后 chip 展开
 * 「正在干什么」细节行（高度档位见 TaskChip），双击手柄复位默认。持久化在
 * useShell.statusBarHeight。
 *
 * 分区镜像上方三列（宽度同源、拖拽跟手）：
 * - 左下角（侧栏正下方）：
 *   1. 会话指示灯说明（底栏第 1 位入口，详述会话灯含义与右键操作）
 *   2. 工作状态（纯文字展示）
 *   3. 后台守护在线（纯文字展示）
 * - 中段（主对话列正下方）：任务栏折叠区（「正在播放」chips）；
 * - 右段（右侧面板正下方）：留空对齐。
 * 侧栏收起时左下角由徽标自然占住（min-width: fit-content）—— 角是徽标的，
 * 任何布局下都在。弹层朝上开（popoverUp）且左锚定（徽标在窗口左缘）。
 */
export function GlobalStatusBar() {
  const height = useShell((s) => s.statusBarHeight);
  const locked = useShell((s) => s.statusBarLocked);
  const setStatusBarHeight = useShell((s) => s.setStatusBarHeight);
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const sidebarWidth = useShell((s) => s.sidebarWidth);
  const mainView = useShell((s) => s.mainView);
  const paneCollapsed = useSidePane((s) => s.collapsed);
  const paneWidth = useSidePane((s) => s.paneWidth);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const paneOpen = sidePaneOccupies(scopeUnitId, paneCollapsed, mainView === "chat");
  const leftZone = sidebarCollapsed ? 0 : sidebarWidth;
  const rightZone = paneOpen ? paneWidth : 0;

  // 拖上缘调高（ChatTerminalDock 同款 pointer 手法）：向上拖增高，拖动中只改
  // 内存（跟手不刷 localStorage），松手那次调用才落盘
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { startY: e.clientY, startH: useShell.getState().statusBarHeight };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setStatusBarHeight(drag.startH + (drag.startY - e.clientY), { persist: false });
    },
    [setStatusBarHeight],
  );
  const onDragEnd = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current !== null) setStatusBarHeight(useShell.getState().statusBarHeight);
      dragRef.current = null;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    [setStatusBarHeight],
  );

  return (
    <footer
      aria-label="全局状态栏"
      className="relative flex shrink-0 items-stretch border-t border-line/60 bg-rail"
      style={{ height }}
    >
      {/* 上缘拖拽热区：贴住顶边的细条，悬停亮起；双击复位最薄档。
          锁定（默认，设置页开关）时不渲染 —— 高度固定，不给拖拽暗示 */}
      {!locked && (
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={() => setStatusBarHeight(STATUSBAR_MIN)}
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-teal/30"
          role="separator"
          aria-label="拖拽调整底栏高度（双击复位）"
          title="拖拽调整底栏高度：拉高可看到任务详情行（双击复位最薄）"
        />
      )}

      {/* 左下角：最左侧第 1 位展示会话灯说明，随后是工作状态和后台守护（纯文字，无彩灯） */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-2.5"
        style={{ width: leftZone, minWidth: "fit-content" }}
      >
        <SessionLightLegendBadge popoverUp align="left" />
        <span className="h-3 w-px bg-line/60" />
        <WorkPhaseBadge popoverUp align="left" />
        <span className="h-3 w-px bg-line/60" />
        <BackgroundGuardianBadge popoverUp align="left" />
      </div>
      {/* 折叠区：主对话列正下方（Taskbar 常驻挂载——空栏也要在，
          全局事件订阅活着，后台任务才能进榜） */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center overflow-hidden px-3",
          leftZone > 0 && "border-l border-line/40",
        )}
      >
        <Taskbar />
      </div>
      {/* 右侧面板正下方：留空对齐（竖直方向上与面板列同宽） */}
      <div aria-hidden className="shrink-0" style={{ width: rightZone }} />
    </footer>
  );
}
