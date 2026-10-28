import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Layers, ShieldCheck } from "lucide-react";
import { cn } from "../../cn.ts";

export interface ContextPartInfo {
  scope: string;
  sourcePath?: string;
  chars: number;
}

export function ContextInjectionCard({
  parts,
  totalChars,
}: {
  parts: readonly ContextPartInfo[];
  totalChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!parts || parts.length === 0) return null;

  const total = totalChars ?? parts.reduce((sum, p) => sum + p.chars, 0);

  return (
    <div className="my-1.5 rounded-btn transition-colors hover:bg-line-soft/40 text-caption">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ash hover:text-graphite cursor-pointer transition select-none"
      >
        <Layers size={12} className="text-teal shrink-0" />
        <span className="font-medium text-graphite">上下文资产注入</span>
        <span className="font-mono text-[10px] text-ash">
          ({parts.map((p) => p.scope.toUpperCase()).join(" · ")})
        </span>
        <span className="ml-auto font-mono text-[10px] text-ash">{total} 字符</span>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </div>

      {expanded && (
        <div className="px-3 pb-1.5 pt-0.5 space-y-1.5 font-mono text-[11px]">
          {parts.map((part, idx) => (
            <div key={idx} className="flex items-center justify-between text-graphite px-1">
              <span className="flex items-center gap-1.5">
                {part.scope === "standing" ? (
                  <ShieldCheck size={11} className="text-graphite" />
                ) : (
                  <BookOpen size={11} className="text-ash" />
                )}
                <span className="font-semibold text-ink uppercase">{part.scope}</span>
                {part.sourcePath && (
                  <span className="text-[10px] text-ash truncate max-w-[260px]">
                    · {part.sourcePath}
                  </span>
                )}
              </span>
              <span className="text-ash text-[10px]">{part.chars} 字符</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
