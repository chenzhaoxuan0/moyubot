import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  useTerminalStore,
  type GroupLayoutNode,
  type SplitDirection,
} from "../store/useTerminalStore.ts";
import { GroupPanel } from "./GroupPanel.tsx";
import { cn } from "./cn.ts";

/**
 * 组栈分屏树（docs/32）—— 叶子=标签组（GroupPanel 自带标签条），split 递归。
 *
 * Splitter 是**提交式**（A4，对齐 orca TabGroupSplitNodeTree）：拖动过程只写
 * 本组件的本地 ratio（React state 驱动 inline style，60fps 不触 store 不广播），
 * pointerup 才一次性 setSplitRatio 进 store（持久化随去抖落盘）。
 */
function Splitter({
  direction,
  initialRatio,
  onCommit,
}: {
  direction: SplitDirection;
  /** 进入拖动时的 store 真值（本地态从这里起步） */
  initialRatio: number;
  onCommit: (ratio: number) => void;
}) {
  const isHoriz = direction === "horizontal";
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** 拖动几何：本地 ratio（0.08~0.92 与 store 口径一致），不落 store */
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const parent = rootRef.current?.parentElement;
      if (parent === null || parent === undefined) return;
      const rect = parent.getBoundingClientRect();
      let ratio = initialRatio;
      setDragRatio(initialRatio);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent): void => {
        const pos = isHoriz ? ev.clientX : ev.clientY;
        const start = isHoriz ? rect.left : rect.top;
        const size = isHoriz ? rect.width : rect.height;
        ratio = Math.max(0.08, Math.min(0.92, (pos - start) / Math.max(1, size)));
        setDragRatio(ratio);
      };
      const onUp = (ev: PointerEvent): void => {
        (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDragRatio(null);
        onCommit(ratio);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [initialRatio, isHoriz, onCommit],
  );

  return (
    <div
      ref={rootRef}
      onPointerDown={handlePointerDown}
      className={cn(
        "group/splitter relative z-10 shrink-0 select-none bg-line/40 transition-colors",
        isHoriz ? "w-[4px] cursor-col-resize hover:bg-teal -mx-[1px]" : "h-[4px] cursor-row-resize hover:bg-teal -my-[1px]",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 bg-teal opacity-0 transition-opacity group-hover/splitter:opacity-100",
          isHoriz ? "w-1" : "h-1",
        )}
        style={dragRatio !== null ? { opacity: 0.9 } : undefined}
      />
    </div>
  );
}

export function TerminalSplitTree({ node }: { node: GroupLayoutNode | null }) {
  const setSplitRatio = useTerminalStore((s) => s.setSplitRatio);
  // 单组全幅约定（docs/32 §二）：组数 ≤1 时 layout 为 null——树为空但要渲染
  // 唯一的组，否则第一个标签创建后画布空白（表现为「新建无反应」的 bug）
  const soleGroup = useTerminalStore((s) =>
    node === null ? Object.values(s.groups)[0] : undefined,
  );

  if (node === null) {
    return soleGroup !== undefined ? (
      <GroupPanel key={soleGroup.id} groupId={soleGroup.id} />
    ) : null;
  }
  if (node.type === "group") {
    // 组叶：key=groupId —— 组在树里挪位置（拖拽分屏/合并）也不重挂，组内
    // 常驻挂载的 xterm/对话状态零迁移（A1 的另一半）
    return <GroupPanel key={node.groupId} groupId={node.groupId} />;
  }

  const isHoriz = node.direction === "horizontal";
  const ratio = node.ratio ?? 0.5;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 w-full overflow-hidden",
        isHoriz ? "flex-row" : "flex-col",
      )}
    >
      <div style={{ flexGrow: ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }} className="relative h-full w-full overflow-hidden">
        <TerminalSplitTree node={node.first} />
      </div>

      <Splitter
        direction={node.direction}
        initialRatio={ratio}
        onCommit={(r) => setSplitRatio(node.id, r)}
      />

      <div style={{ flexGrow: 1 - ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }} className="relative h-full w-full overflow-hidden">
        <TerminalSplitTree node={node.second} />
      </div>
    </div>
  );
}
