import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../cn.ts";
import type { GroupedItem } from "../types.ts";
import { toolBrief } from "./brief.ts";

/**
 * 连续同类工具调用的合并行（Codex 二级展开形态）：
 * 折叠态 = 动词 + 数量 + **内联关键信息**（前几个参数直接可见，不用点开就知道
 * 读/改了哪些对象）；展开态 = 逐条明细（每条仍是可独立展开输出的工具行）。
 * 展开态按合并组记忆（虚拟卸载重挂后保持用户的选择）。
 */
const mergedRunOpenStates = new Map<string, boolean>();

export function MergedToolRun({
  entries,
  renderEntry,
}: {
  /** 连续同 toolName 的工具条目（≥2） */
  entries: readonly GroupedItem[];
  /** 单条渲染器（沿用 SingleItemRow，保持逐条行的一切行为） */
  renderEntry: (item: GroupedItem) => React.ReactNode;
}) {
  const first = entries[0]!;
  const stateKey = `m:${String(first.id)}`;
  const [open, setOpen] = useState(() => mergedRunOpenStates.get(stateKey) ?? false);
  const toggle = (): void => {
    const next = !open;
    mergedRunOpenStates.set(stateKey, next);
    setOpen(next);
  };

  const toolName = String(first.data?.toolName ?? "tool");
  const briefs = entries
    .map((e) => toolBrief(e.data as never, 40))
    .filter((s) => s.length > 0);
  // 内联关键信息：前 3 个 + 「+N」；不占满整行（truncate 兜底）
  const inlineCount = 3;
  const shown = briefs.slice(0, inlineCount);
  const rest = briefs.length - shown.length;

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex w-full cursor-pointer items-center gap-2 rounded-btn px-1.5 py-1 text-left text-caption transition select-none hover:bg-line-soft/40"
      >
        <span
          className={cn(
            "shrink-0 font-medium",
            entries.some((e) => e.data?.completed !== true) ? "text-teal" : "text-graphite",
          )}
        >
          {toolName}
        </span>
        <span className="shrink-0 font-mono text-ash">×{entries.length}</span>
        {shown.length > 0 && (
          <span className="min-w-0 flex-1 truncate font-mono text-ash pr-2">
            {shown.join(" · ")}
            {rest > 0 && ` · +${rest}`}
          </span>
        )}
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-ash transition-transform", open && "rotate-90")}
        />
      </button>

      {open && (
        <div className="mt-0.5 space-y-1 border-l border-line/50 pl-2.5">
          {entries.map((e) => renderEntry(e))}
        </div>
      )}
    </div>
  );
}
