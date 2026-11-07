import { Minimize2 } from "lucide-react";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { TerminalSplitTree } from "./TerminalSplitTree.tsx";
import { TerminalPaneSlot } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { NewSessionPage } from "./NewSessionPage.tsx";

/**
 * 会话画布容器（docs/32 组栈模型）—— 纯容器，无任何工具栏。
 *
 * 顶栏分三步退役（2026-11）：① 标签随组栈回格子（GroupPanel）；② 新建入口归
 * 格子标签尾（GroupCreateBar）；③ 拆分 / 最大化 / 清屏 / 重启 / 新对话 / 历史
 * 等动作并入各格组标签条右端 —— 本行整体撤掉，画布纵向空间全给内容。
 * 归拢弹出窗口进了 GroupCreateBar 的「选择▾」菜单（罕见动作不占条内空间）。
 *
 * 最大化态不渲染格子条，还原入口收在这里：内容区右上角的浮动小钮。
 */
export function TerminalPanel() {
  const panes = useTerminalStore((s) => s.panes);
  const groups = useTerminalStore((s) => s.groups);
  const layout = useTerminalStore((s) => s.layout);
  const maximizedPaneId = useTerminalStore((s) => s.maximizedPaneId);

  const groupCount = Object.keys(groups).length;
  const maximizedPane = maximizedPaneId !== null ? panes[maximizedPaneId] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* 画布内容区：无格 = 新建会话页；最大化 = 单标签全幅；否则 = 组栈分屏树 */}
      {groupCount === 0 ? (
        <NewSessionPage />
      ) : maximizedPane !== undefined ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {maximizedPane.kind === "chat" ? (
            <ChatPaneSlot key={maximizedPane.id} paneKey={maximizedPane.id} />
          ) : (
            <TerminalPaneSlot key={maximizedPane.id} pane={maximizedPane} />
          )}
          {/* 还原分屏：最大化态没有格子条（按钮都在条上），右上角浮动小钮兜底 */}
          <button
            type="button"
            onClick={() => useTerminalStore.getState().toggleMaximize()}
            title="还原分屏"
            aria-label="还原分屏"
            className="absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md bg-card/80 text-ash shadow-sm backdrop-blur transition hover:bg-card hover:text-ink"
          >
            <Minimize2 size={12} />
          </button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <TerminalSplitTree node={layout} />
        </div>
      )}
    </div>
  );
}
