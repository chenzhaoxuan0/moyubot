import { useEffect, useState, useMemo } from "react";
import { MessageSquare, ArrowDown, ArrowUp } from "lucide-react";
import type { TurnNavAnchor } from "../types.ts";
import { cn } from "../../cn.ts";

export function TurnNavigator({
  anchors,
  containerRef,
  onNavigate,
}: {
  anchors: readonly TurnNavAnchor[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  onNavigate?: (turn: TurnNavAnchor) => void;
}) {
  const [activeTurn, setActiveTurn] = useState<number>(0);
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);

  // 轮次少于 2 轮时不显示大纲，保持界面清爽
  if (anchors.length < 2) return null;

  const scrollToTurn = (turn: TurnNavAnchor) => {
    if (onNavigate) {
      onNavigate(turn);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-turn-id="${turn.userMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-teal/50", "transition-all", "duration-500");
      setTimeout(() => {
        el.classList.remove("ring-2", "ring-teal/50");
      }, 1500);
    }
  };

  return (
    <nav
      aria-label="对话轮次导航"
      className="hidden @min-[768px]:flex fixed right-4 top-1/2 -translate-y-1/2 z-20 flex-col items-end gap-1.5 py-2 px-1 rounded-full bg-card/75 backdrop-blur-md border border-line/60 shadow-subtle opacity-25 hover:opacity-100 transition-opacity duration-200"
    >
      <div className="px-1.5 py-0.5 text-[9px] font-mono text-ash/80 uppercase select-none">
        Turns
      </div>
      <div className="flex flex-col gap-1.5 items-center">
        {anchors.map((a) => {
          const isHovered = hoveredTurn === a.turnIndex;
          const label = `Q${a.turnIndex}`;
          return (
            <div
              key={a.userMessageId}
              className="relative flex items-center justify-end"
              onMouseEnter={() => setHoveredTurn(a.turnIndex)}
              onMouseLeave={() => setHoveredTurn(null)}
            >
              {/* 悬停提问内容微型 Tooltip */}
              {isHovered && (
                <div className="absolute right-7 mr-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-card bg-popover/95 border border-line shadow-md text-caption text-ink whitespace-nowrap max-w-[260px] truncate animate-in fade-in zoom-in-95 duration-100 pointer-events-none z-30">
                  <span className="font-mono text-teal font-semibold">{label}:</span>
                  <span className="truncate">{a.queryPreview || "空提问"}</span>
                </div>
              )}

              <button
                type="button"
                onClick={() => scrollToTurn(a)}
                aria-label={`跳转到第 ${a.turnIndex} 轮提问`}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-mono transition-all cursor-pointer",
                  isHovered
                    ? "bg-teal text-canvas font-bold scale-110 shadow-xs"
                    : "text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {a.turnIndex}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
