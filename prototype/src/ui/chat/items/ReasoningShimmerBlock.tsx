import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "../../cn.ts";

export function ReasoningShimmerBlock({
  text,
  busy,
  startedAt,
  endedAt,
}: {
  text: string;
  busy: boolean;
  startedAt?: number;
  /** 回放态的结束时间（末次 delta）——历史思考块也能显示"思考了 N 秒" */
  endedAt?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(() =>
    !busy && startedAt && endedAt && endedAt > startedAt ? Math.round((endedAt - startedAt) / 100) / 10 : 0,
  );
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

  /* Codex 形态（"Thought for Ns" 行）：不是卡片，是一行可折叠的轻量披露行 ——
     无边框无底色，灰字小号；展开的思考正文走左侧细线缩进，不另起一张卡。 */
  return (
    <div className="my-1.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2 -ml-1 rounded-btn px-1 py-1 text-left text-caption hover:bg-line-soft/40 cursor-pointer transition select-none"
      >
        <Sparkles size={13} className={cn("shrink-0", busy ? "animate-pulse text-teal" : "text-ash")} />
        <span className={cn("font-medium shrink-0", busy ? "text-teal" : "text-graphite")}>
          {busy ? "深度思考中" : elapsedSec > 0 ? `思考了 ${Math.round(elapsedSec)} 秒` : "思考过程"}
        </span>

        {/* 动态微光流动摘要（思考中）或静态字数统计（完成） */}
        {busy && streamingSummary ? (
          <span className="min-w-0 flex-1 truncate font-sans text-caption animate-text-shimmer">
            {streamingSummary}…
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {busy && elapsedSec > 0 && (
            <span className="font-mono text-[10px] text-ash">{`${elapsedSec}s`}</span>
          )}

          {expanded ? (
            <ChevronDown size={12} className="text-ash transition group-hover:text-ink" />
          ) : (
            <ChevronRight size={12} className="text-ash transition group-hover:text-ink" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-1 ml-[13px] border-l border-line/70 pl-3 max-h-96 overflow-y-auto font-mono text-[12px] leading-[1.65] text-graphite whitespace-pre-wrap select-text">
          {text}
        </div>
      )}
    </div>
  );
}
