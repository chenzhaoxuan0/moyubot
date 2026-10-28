import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "../../cn.ts";

export function ReasoningShimmerBlock({
  text,
  busy,
  startedAt,
}: {
  text: string;
  busy: boolean;
  startedAt?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const timerStartRef = useRef(startedAt || Date.now());

  // 运行中持续更新秒表
  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      setElapsedSec(Math.round((Date.now() - timerStartRef.current) / 100) / 10);
    }, 100);
    return () => clearInterval(interval);
  }, [busy]);

  // 提取当前正在思考的段落首句作为微光流动摘要 (借鉴 DeepSeek ReasoningRow)
  const streamingSummary = useMemo(() => {
    if (!busy || !text) return "";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    // 剔除 markdown 强调符
    return lastLine.replace(/\*\*/g, "").replace(/^[-*#>]+\s*/, "").slice(0, 90);
  }, [busy, text]);

  const wordCount = text.length;

  return (
    <div className="my-1.5 overflow-hidden rounded-input border border-line/70 bg-rail/15">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption hover:bg-line-soft/40 cursor-pointer transition select-none"
      >
        <Sparkles size={13} className={cn("shrink-0 text-teal", busy && "animate-pulse")} />
        <span className={cn("font-medium shrink-0", busy ? "text-teal" : "text-graphite")}>
          {busy ? "深度思考中" : "已深度思考"}
        </span>

        {/* 动态微光流动摘要（思考中）或静态字数统计（完成） */}
        {busy && streamingSummary ? (
          <span className="min-w-0 flex-1 truncate font-sans text-caption animate-text-shimmer">
            {streamingSummary}…
          </span>
        ) : (
          <span className="font-mono text-ash text-[11px]">
            {wordCount > 0 && `(${wordCount} 字)`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {(busy || elapsedSec > 0) && (
            <span className="font-mono text-[10px] text-ash">
              {elapsedSec > 0 ? `${elapsedSec}s` : ""}
            </span>
          )}

          {expanded ? (
            <ChevronDown size={12} className="text-ash transition group-hover:text-ink" />
          ) : (
            <ChevronRight size={12} className="text-ash transition group-hover:text-ink" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line/50 bg-rail/30 p-3 max-h-96 overflow-y-auto font-mono text-[12px] leading-[1.65] text-graphite whitespace-pre-wrap select-text">
          {text}
        </div>
      )}
    </div>
  );
}
