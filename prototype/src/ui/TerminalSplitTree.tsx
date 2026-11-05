import React, { useCallback, useRef } from "react";
import {
  useTerminalStore,
  type LayoutNode,
  type SplitDirection,
} from "../store/useTerminalStore.ts";
import { TerminalPaneSlot } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { cn } from "./cn.ts";

/** 可拖拽的分屏分割线 */
function Splitter({
  direction,
  onDrag,
}: {
  direction: SplitDirection;
  onDrag: (deltaPct: number) => void;
}) {
  const isHoriz = direction === "horizontal";
  const startPosRef = useRef<number>(0);
  const containerDimRef = useRef<number>(1);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const splitterEl = e.currentTarget as HTMLElement;
      const parentEl = splitterEl.parentElement;
      if (!parentEl) return;

      const rect = parentEl.getBoundingClientRect();
      startPosRef.current = isHoriz ? e.clientX : e.clientY;
      containerDimRef.current = isHoriz ? rect.width : rect.height;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const curPos = isHoriz ? moveEvent.clientX : moveEvent.clientY;
        const deltaPx = curPos - startPosRef.current;
        const deltaPct = deltaPx / containerDimRef.current;
        startPosRef.current = curPos;
        onDrag(deltaPct);
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [isHoriz, onDrag],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        "relative shrink-0 select-none z-10 transition-colors group/splitter",
        isHoriz
          ? "w-[4px] cursor-col-resize hover:bg-teal bg-line/40 -mx-[1px]"
          : "h-[4px] cursor-row-resize hover:bg-teal bg-line/40 -my-[1px]",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 transition-opacity opacity-0 group-hover/splitter:opacity-100 bg-teal",
          isHoriz ? "w-1" : "h-1",
        )}
      />
    </div>
  );
}

export function TerminalSplitTree({
  node,
  totalPanesInGroup,
}: {
  node: LayoutNode;
  totalPanesInGroup: number;
}) {
  const instances = useTerminalStore((s) => s.instances);
  const setBranchRatio = useTerminalStore((s) => s.setBranchRatio);

  if (node.type === "leaf") {
    const inst = instances.find((i) => i.id === node.instanceId);
    if (!inst) return null;
    return (
      <TerminalPaneSlot
        key={node.instanceId}
        inst={inst}
        totalPanesInGroup={totalPanesInGroup}
      />
    );
  }

  // 对话窗格（docs/31）：注册表里已删的窗格（竞态关闭）不渲染
  if (node.type === "chatLeaf") {
    return <ChatPaneSlot key={node.paneKey} paneKey={node.paneKey} totalPanesInGroup={totalPanesInGroup} />;
  }

  // 分支节点：横向（左右）或纵向（上下）拆分
  const isHoriz = node.direction === "horizontal";
  const ratio = node.ratio;

  const handleDrag = (deltaPct: number) => {
    const nextRatio = Math.max(0.08, Math.min(0.92, ratio + deltaPct));
    setBranchRatio(node.id, nextRatio);
  };

  const leafKeyOf = (n: LayoutNode): string =>
    n.type === "leaf" ? n.instanceId : n.type === "chatLeaf" ? n.paneKey : n.id;

  return (
    <div
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 overflow-hidden",
        isHoriz ? "flex-row" : "flex-col",
      )}
    >
      {/* 第一个子窗格 */}
      <div
        style={{ flex: `${ratio} 1 0%`, minWidth: 0, minHeight: 0 }}
        className="relative h-full w-full overflow-hidden"
      >
        <TerminalSplitTree
          key={leafKeyOf(node.first)}
          node={node.first}
          totalPanesInGroup={totalPanesInGroup}
        />
      </div>

      {/* 自由拖拽调整比例的分割线 */}
      <Splitter direction={node.direction} onDrag={handleDrag} />

      {/* 第二个子窗格 */}
      <div
        style={{ flex: `${1 - ratio} 1 0%`, minWidth: 0, minHeight: 0 }}
        className="relative h-full w-full overflow-hidden"
      >
        <TerminalSplitTree
          key={leafKeyOf(node.second)}
          node={node.second}
          totalPanesInGroup={totalPanesInGroup}
        />
      </div>
    </div>
  );
}
