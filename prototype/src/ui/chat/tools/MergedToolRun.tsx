import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../cn.ts";
import type { GroupedItem } from "../types.ts";
import { toolBrief } from "./brief.ts";
import { getToolPresentation } from "./ToolCardHost.tsx";

/**
 * 连续同类工具调用的合并行（Codex 二级展开形态）：
 * 折叠态 = 图标 + 加粗工具名 + ×数量 + 内联关键信息 + 右簇状态与对齐箭头；
 * 展开态 = 逐条明细（每条仍是可独立展开输出的工具行）。
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
  const { icon: ToolIcon, label: toolLabel, isBash } = getToolPresentation(toolName);

  const briefs = entries
    .map((e) => toolBrief(e.data as never, 40))
    .filter((s) => s.length > 0);
  // 内联关键信息：前 3 个 + 「+N」；不占满整行（truncate 兜底）
  const inlineCount = 3;
  const shown = briefs.slice(0, inlineCount);
  const rest = briefs.length - shown.length;

  // 聚合状态（与单条行同款右簇：状态 + 箭头，箭头因此天然对齐单条行）
  const running = entries.some((e) => e.data?.completed !== true);
  const failed = entries.some((e) => e.data?.completed === true && e.data?.ok === false);

  return (
    <div className="chat-tool-card rounded-btn transition-colors hover:bg-line-soft/40">
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => e.key === "Enter" && toggle()}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-1.5 py-1.5 text-left cursor-pointer transition select-none"
      >
        {/* 行内构成完全镜像单条工具行：图标 + 加粗工具名 + ×数量 + 详细信息 + 右簇 */}
        <ToolIcon size={13} className="shrink-0 text-teal" />
        <span className={cn("shrink-0 text-body-sm font-medium text-ink", !isBash && "font-mono")}>
          {toolLabel}
        </span>
        <span className="shrink-0 font-mono text-body-sm text-ash">×{entries.length}</span>
        {shown.length > 0 && (
          <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-ash">
            {shown.join(" · ")}
            {rest > 0 && ` · +${rest}`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {running ? (
            <span className="flex items-center gap-1.5 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span className="animate-text-shimmer font-medium">运行中</span>
            </span>
          ) : failed ? (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
              <AlertTriangle size={12} className="text-loss" />
              <span>含失败</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
              <Check size={12} className="text-gain" />
              <span>{isBash ? "exit 0" : "完成"}</span>
            </span>
          )}

          {open ? (
            <ChevronDown size={12} className="text-ash" />
          ) : (
            <ChevronRight size={12} className="text-ash" />
          )}
        </div>
      </div>

      {open && (
        <div className="mt-0.5 ml-[13px] space-y-1 border-l border-line/50 pl-2.5">
          {entries.map((e) => renderEntry(e))}
        </div>
      )}
    </div>
  );
}
