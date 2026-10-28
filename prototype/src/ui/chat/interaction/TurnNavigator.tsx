import { useEffect, useState } from "react";
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
  const [activeTurn, setActiveTurn] = useState<number>(() => anchors[0]?.turnIndex ?? 1);
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);

  // 视口滚动时感知当前正在浏览哪一轮（通过 requestAnimationFrame 节流，避免滚动重排掉帧）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || anchors.length === 0) return;

    let rafId: number | null = null;

    const updateActiveTurn = () => {
      const containerTop = container.getBoundingClientRect().top;
      let currentTurn = anchors[0]?.turnIndex ?? 1;
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]!;
        const el = container.querySelector(`[data-turn-id="${a.userMessageId}"]`);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top - containerTop <= 220) {
            currentTurn = a.turnIndex;
          }
        }
      }
      setActiveTurn(currentTurn);
      rafId = null;
    };

    const onScroll = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(updateActiveTurn);
      }
    };

    updateActiveTurn();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [anchors, containerRef]);

  // 轮次少于 2 轮时不显示大纲，保持界面极致极简
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
      className="hidden @min-[768px]:flex fixed right-2.5 top-1/2 -translate-y-1/2 z-20 flex-col items-end py-1 select-none pointer-events-auto opacity-40 hover:opacity-100 transition-opacity duration-150"
    >
      <div className="flex flex-col gap-0.5 items-end py-0.5">
        {anchors.map((a) => {
          const isHovered = hoveredTurn === a.turnIndex;
          const label = `Q${a.turnIndex}`;

          // Codex 波浪形态（GPU 硬件加速 scaleX + origin-right，无重排掉帧）：
          // 悬停横线最长，相邻线根据距离呈现高斯波浪平滑衰减
          const dist = hoveredTurn === null ? null : Math.abs(a.turnIndex - hoveredTurn);
          const isActive = a.turnIndex === activeTurn;

          let scaleX = 0.32;
          let opacity = 0.35;
          let bgClass = "bg-ash";

          if (dist === null) {
            if (isActive) {
              scaleX = 0.64;
              opacity = 0.95;
              bgClass = "bg-teal";
            } else {
              scaleX = 0.32;
              opacity = 0.35;
              bgClass = "bg-ash";
            }
          } else if (dist === 0) {
            scaleX = 1.0;
            opacity = 1;
            bgClass = "bg-ink dark:bg-white shadow-xs";
          } else if (dist === 1) {
            scaleX = 0.72;
            opacity = 0.75;
            bgClass = "bg-graphite";
          } else if (dist === 2) {
            scaleX = 0.5;
            opacity = 0.5;
            bgClass = "bg-ash";
          } else if (dist === 3) {
            scaleX = 0.35;
            opacity = 0.3;
            bgClass = "bg-ash";
          } else {
            scaleX = 0.25;
            opacity = 0.2;
            bgClass = "bg-ash";
          }

          return (
            <div
              key={a.userMessageId}
              className="relative flex items-center justify-end"
              onMouseEnter={() => setHoveredTurn(a.turnIndex)}
              onMouseLeave={() => setHoveredTurn(null)}
            >
              {/* 悬停展开的详情内容气泡：完全非透明实底 bg-canvas，清晰支持 6 行正文纵览 */}
              {isHovered && (
                <div className="absolute right-full mr-3 top-1/2 -translate-y-1/2 w-[340px] max-w-[calc(100vw-5rem)] p-3.5 rounded-card bg-canvas border border-line shadow-2xl text-left z-40 pointer-events-none animate-in fade-in zoom-in-95 duration-100 select-text">
                  <div className="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-line">
                    <span className="font-mono text-[11px] font-bold text-teal">{label}</span>
                    <div className="flex items-center gap-2 text-[10px] text-graphite font-mono">
                      {a.toolCount !== undefined && a.toolCount > 0 && (
                        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-graphite font-medium">
                          {a.toolCount} 工具
                        </span>
                      )}
                      {a.at && (
                        <span>
                          {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 提问正文（支持 6 行左右内容，快速纵览前序发生） */}
                  <div className="font-sans text-body-sm text-ink leading-relaxed break-words whitespace-pre-wrap line-clamp-6">
                    {a.queryText || a.queryPreview || "空提问"}
                  </div>

                  {/* 助手回复摘要 */}
                  {a.assistantSummary && (
                    <div className="mt-2.5 pt-2 border-t border-line text-[11px] text-graphite leading-relaxed line-clamp-3">
                      <span className="text-ink font-medium mr-1">答复:</span>
                      <span>{a.assistantSummary}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 渐变横线按钮（固定宽度 + transform: scaleX 硬件加速无缝渲染） */}
              <button
                type="button"
                onClick={() => scrollToTurn(a)}
                aria-label={`跳转到第 ${a.turnIndex} 轮提问`}
                className="group flex items-center justify-end h-3.5 w-8 pr-0.5 cursor-pointer"
              >
                <span
                  style={{
                    transform: `scaleX(${scaleX})`,
                    opacity,
                  }}
                  className={cn(
                    "w-7 h-[2px] rounded-full origin-right transition-transform duration-100 ease-out will-change-transform",
                    bgClass,
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
