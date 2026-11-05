import { useCallback, useState, type DragEvent } from "react";
import { useCanvasDnd } from "../store/canvasDnd.ts";
import { useTerminalStore, type DropZone } from "../store/useTerminalStore.ts";
import { cn } from "./cn.ts";

/**
 * 窗格吸附区（docs/31 二期 drag-to-split）—— 拖标签悬停在任意窗格上时，
 * 四角边缘显示吸附高亮（左/右 = 左右分屏，上/下 = 上下分屏；中央无动作）。
 * 放手 = 把拖动组的整棵布局子树嫁接到目标窗格该侧（dropTabOntoPane）。
 *
 * 判定用指针相对窗格的归一化坐标：边缘 30% 带内取对应方向，否则视为中央
 * （不 preventDefault，光标显示不可放置）。终端与对话窗格共用本 hook。
 */
export function usePaneDropZone(paneId: string): {
  dropHandlers: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  zoneOverlay: React.ReactNode;
} {
  const dragging = useCanvasDnd((s) => s.draggingGroupId);
  const [zone, setZone] = useState<DropZone | null>(null);

  const resolveZone = (e: DragEvent<HTMLElement>): DropZone | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(1, rect.width);
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    const EDGE = 0.3;
    // 先判垂直边（上下），再判水平（左右）—— 角部落到先命中的一侧，与用户
    // 预期「贴哪边就分到哪边」一致（按离边的距离取更近者）
    const dLeft = x, dRight = 1 - x, dTop = y, dBottom = 1 - y;
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min > EDGE) return null;
    if (min === dTop) return "top";
    if (min === dBottom) return "bottom";
    if (min === dLeft) return "left";
    return "right";
  };

  const onDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (dragging === null) return;
      const z = resolveZone(e);
      if (z === null) {
        if (zone !== null) setZone(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (z !== zone) setZone(z);
    },
    // zone 进依赖：resolveZone 不依赖外部状态，eslint 静态分析没辙但行为正确
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragging, zone],
  );

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    // 子元素间的 dragleave 会误触发：只有真的离开窗格（relatedTarget 不在内）才清
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setZone(null);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dragId = useCanvasDnd.getState().draggingGroupId;
      setZone(null);
      if (dragId === null) return;
      const z = resolveZone(e);
      if (z === null) return;
      e.preventDefault();
      useCanvasDnd.getState().endDrag();
      useTerminalStore.getState().dropTabOntoPane(dragId, paneId, z);
    },
    // resolveZone 是纯函数，依赖只有 paneId
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneId],
  );

  const zoneOverlay =
    dragging !== null && zone !== null ? (
      <div className="pointer-events-none absolute inset-0 z-20">
        <div
          className={cn(
            "absolute rounded-sm bg-teal/15 ring-2 ring-teal/60 ring-inset transition-all duration-75",
            zone === "left" && "inset-y-0 left-0 w-1/2",
            zone === "right" && "inset-y-0 right-0 w-1/2",
            zone === "top" && "inset-x-0 top-0 h-1/2",
            zone === "bottom" && "inset-x-0 bottom-0 h-1/2",
          )}
        />
      </div>
    ) : null;

  return { dropHandlers: { onDragOver, onDragLeave, onDrop }, zoneOverlay };
}
