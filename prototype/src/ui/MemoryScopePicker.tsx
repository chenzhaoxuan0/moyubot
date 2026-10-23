import { useEffect, useRef, useState } from "react";
import { Brain, Calendar, CheckSquare, Square } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { normalizeContextManifest } from "../core/units.ts";
import { useMemoryPanel } from "../store/useMemoryPanel.ts";
import { cn } from "./cn.ts";

/**
 * 记忆注入快捷开关（ADR 0014 改造）：改的是**当前 bot** 的 contextManifest
 * （写穿 bot.json），不再是全局前端态。完整矩阵（SOUL / USER / AGENTS 三态 /
 * STANDING / 预设）在右栏 Context 面板，这里只留 Composer 触手可及的两柱。
 */
export function MemoryScopePicker({ compact }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const unit = useWorkbench(selectActiveUnit);
  const patchUnitContext = useWorkbench((s) => s.patchUnitContext);
  const memory = useMemoryPanel((s) => s.memory);

  const manifest = normalizeContextManifest(unit?.contextManifest);
  const hasSemantic = manifest.memorySemantic === true;
  const hasDaily = manifest.memoryDaily === true;

  const draft = useWorkbench((s) => s.draft);

  useEffect(() => {
    if (draft.startsWith("/")) {
      setOpen(false);
    }
  }, [draft]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [open]);

  const toggle = (key: "memorySemantic" | "memoryDaily") => {
    if (unit === undefined) return;
    // 快捷开关不弹确认：失败由 patchUnitContext 统一推通知
    void patchUnitContext(unit.id, { [key]: !(manifest[key] === true) }).catch(() => {});
  };

  const label =
    hasSemantic && hasDaily
      ? "长期 + 今日精炼"
      : hasSemantic
        ? "长期事实"
        : hasDaily
          ? "当日精炼"
          : "未注入";

  const isEnabled = hasSemantic || hasDaily;

  return (
    <div className="relative inline-block shrink-0" ref={containerRef}>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`记忆注入配置 (${label}) · 已写入该 bot 的注入清单`}
          className={cn(
            "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition",
            isEnabled
              ? "border-teal/40 bg-teal-tint text-teal"
              : "border-line/60 bg-line-soft/40 text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          <Brain size={15} />
          {isEnabled && (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-teal" />
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title="选择这个 bot 开新会话时注入的记忆（写入 bot.json 的注入清单，渠道会话同样生效）"
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition border font-medium select-none whitespace-nowrap",
            isEnabled
              ? "border-teal/30 bg-teal-tint text-teal hover:border-teal/50"
              : "border-line text-graphite hover:text-ink hover:border-line-soft bg-canvas/60",
          )}
        >
          <Brain size={13} className={cn(isEnabled ? "text-teal" : "text-graphite")} />
          <span className="font-mono text-[11px] tracking-tight whitespace-nowrap">{label}</span>
        </button>
      )}

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-canvas p-3 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between pb-2 border-b border-line-soft">
            <div
              className="flex items-center gap-1.5 text-xs font-semibold text-ink"
              title="开关写入 bot.json 的注入清单——工作台、渠道、定时会话同一份（ADR 0014）。两柱独立，不影响 SOUL / USER / AGENTS.md（在右栏 Context 面板管理）。"
            >
              <Brain size={14} className="text-teal" />
              <span>记忆注入（这个 bot）</span>
            </div>
            <span className="text-[10px] text-graphite font-mono">contextManifest</span>
          </div>

          <div className="mt-2.5 space-y-2">
            {/* 1. 语义记忆 (MEMORY.md) */}
            <div
              onClick={() => toggle("memorySemantic")}
              className={cn(
                "group flex cursor-pointer items-start gap-2.5 rounded-lg border p-2 transition",
                hasSemantic
                  ? "border-teal/40 bg-teal-tint/40 text-ink"
                  : "border-line-soft hover:border-line hover:bg-line-soft text-graphite",
              )}
            >
              <div className="mt-0.5 shrink-0 text-teal">
                {hasSemantic ? <CheckSquare size={15} /> : <Square size={15} className="text-graphite" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">长期事实 (MEMORY.md)</span>
                  {memory && memory.chars > 0 && (
                    <span className="font-mono text-[10px] text-graphite">
                      {memory.chars}/{memory.limit} 字
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-graphite leading-normal mt-0.5">
                  沉淀在项目根目录，由 bot 遵照上限直接维护，保证项目级关键事实不遗忘。
                </p>
              </div>
            </div>

            {/* 2. 当日会话精炼 (daily/*.md) */}
            <div
              onClick={() => toggle("memoryDaily")}
              className={cn(
                "group flex cursor-pointer items-start gap-2.5 rounded-lg border p-2 transition",
                hasDaily
                  ? "border-teal/40 bg-teal-tint/40 text-ink"
                  : "border-line-soft hover:border-line hover:bg-line-soft text-graphite",
              )}
            >
              <div className="mt-0.5 shrink-0 text-teal">
                {hasDaily ? <CheckSquare size={15} /> : <Square size={15} className="text-graphite" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">当日会话精炼 (daily/*.md)</span>
                  <span className="flex items-center gap-1 font-mono text-[10px] text-teal">
                    <Calendar size={10} />
                    <span>按日分片</span>
                  </span>
                </div>
                <p className="text-[11px] text-graphite leading-normal mt-0.5">
                  每日由总管任务自动提取并总结当天的关键结论与踩坑，作为只读参考注入。
                </p>
              </div>
            </div>
          </div>

          {/* 快捷预设 = 写开关的宏（ADR 0014 D7）：不持久化预设名，只落显式开关 */}
          <div className="mt-3 pt-2.5 border-t border-line-soft flex items-center justify-between">
            <span className="text-[10px] text-graphite">快捷预设:</span>
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => void patchUnitContext(unit?.id ?? "", { memorySemantic: true, memoryDaily: true }).catch(() => {})}
                className="rounded px-1.5 py-0.5 text-xs text-teal hover:bg-teal-tint transition"
              >
                双注入
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => void patchUnitContext(unit?.id ?? "", { memorySemantic: true, memoryDaily: false }).catch(() => {})}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                仅长期
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => void patchUnitContext(unit?.id ?? "", { memorySemantic: false, memoryDaily: true }).catch(() => {})}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                仅今日
              </button>
              <span className="text-line-soft">·</span>
              <button
                type="button"
                onClick={() => void patchUnitContext(unit?.id ?? "", { memorySemantic: false, memoryDaily: false }).catch(() => {})}
                className="rounded px-1.5 py-0.5 text-xs text-graphite hover:text-ink hover:bg-line-soft transition"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
