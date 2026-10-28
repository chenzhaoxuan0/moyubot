import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "../../cn.ts";

export function ReasoningShimmerBlock({
  text,
  active,
  startedAt,
  endedAt,
}: {
  text: string;
  /** 条目活跃度（评审 P2）：所在单元仍在运行且为本单元末条目时为 true ——
      不再吃全局 busy，历史思考块（哪怕被手动展开）不会在新一轮运行时诈尸 */
  active: boolean;
  startedAt?: number;
  /** 回放态的结束时间（末次 delta）——历史思考块也能显示"思考了 N 秒" */
  endedAt?: number;
}) {
  // 活跃（本条目正在流式思考）默认徐徐展开显示正在思考的内容；落定后自动折叠；
  // 用户手动点击展开/折叠则优先遵循用户意图
  const [userToggled, setUserToggled] = useState(false);
  const [manualExpanded, setManualExpanded] = useState(false);
  const expanded = userToggled ? manualExpanded : active;

  const toggleExpanded = (): void => {
    setUserToggled(true);
    setManualExpanded(!expanded);
  };

  const [elapsedSec, setElapsedSec] = useState(() =>
    !active && startedAt && endedAt && endedAt > startedAt ? Math.round((endedAt - startedAt) / 100) / 10 : 0,
  );
  const timerStartRef = useRef(startedAt || Date.now());

  // 活跃时才启动秒表（评审 P2）：全局 busy 会把所有历史思考块拉进 10Hz 重渲染
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      // /100 再 /10 = 秒（1 位小数），与上面落定态初始值的口径一致
      setElapsedSec(Math.round((Date.now() - timerStartRef.current) / 100) / 10);
    }, 100);
    return () => clearInterval(interval);
  }, [active]);

  // 提取当前正在思考的段落首句作为微光流动摘要 (借鉴 DeepSeek ReasoningRow)
  const streamingSummary = useMemo(() => {
    if (!active || !text) return "";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    // 剔除 markdown 强调符
    return lastLine.replace(/\*\*/g, "").replace(/^[-*#>]+\s*/, "").slice(0, 90);
  }, [active, text]);

  /* Codex 形态（"Thought for Ns" 行）：不是卡片，是一行可折叠的轻量披露行 ——
     无边框无底色，灰字小号；展开的思考正文走左侧细线缩进，不另起一张卡。
     内边距与所有工具行严格对齐（px-1.5 py-1.5），右侧 chevron 自然对齐。 */
  return (
    <div className="chat-tool-card my-1.5">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(e) => e.key === "Enter" && toggleExpanded()}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2 rounded-btn px-1.5 py-1.5 text-left text-caption hover:bg-line-soft/40 cursor-pointer transition select-none"
      >
        <Sparkles size={13} className={cn("shrink-0", active ? "animate-pulse text-teal" : "text-ash")} />
        <span className={cn("font-medium shrink-0", active ? "text-teal animate-text-shimmer" : "text-graphite")}>
          {active ? "深度思考中" : elapsedSec > 0 ? `思考了 ${Math.round(elapsedSec)} 秒` : "思考过程"}
        </span>

        {/* 动态微光流动摘要（折叠或思考中未展开时） */}
        {active && streamingSummary && !expanded ? (
          <span className="min-w-0 flex-1 truncate font-sans text-caption animate-text-shimmer">
            {streamingSummary}…
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {active && elapsedSec > 0 && (
            <span className="font-mono text-[10px] text-teal/80 animate-pulse">{`${elapsedSec}s`}</span>
          )}

          {expanded ? (
            <ChevronDown size={12} className="text-ash transition group-hover:text-ink" />
          ) : (
            <ChevronRight size={12} className="text-ash transition group-hover:text-ink" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-1 ml-[13px] border-l border-line/70 pl-3 max-h-96 overflow-y-auto font-mono text-[12px] leading-[1.65] text-ash whitespace-pre-wrap select-text">
          {text}
        </div>
      )}
    </div>
  );
}
