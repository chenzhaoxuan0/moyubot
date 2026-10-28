import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolExecutionData } from "../types.ts";
import { toolBrief } from "./brief.ts";

export function GenericToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);

  const brief = toolBrief(data);

  return (
    <div className="rounded-btn transition-colors hover:bg-line-soft/40">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-1.5 py-1.5 text-left cursor-pointer transition select-none"
      >
        <Wrench size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">{data.toolName}</span>

        {brief && <span className="min-w-0 max-w-[420px] truncate font-mono text-body-sm text-ash">{brief}</span>}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {data.completed ? (
            data.ok !== false ? (
              <span className="flex items-center gap-1.5 text-[11px] text-ash">
                <Check size={12} className="text-gain" />
                <span>完成</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-ash">
                <AlertTriangle size={12} className="text-loss" />
                <span>失败</span>
              </span>
            )
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span className="animate-text-shimmer font-medium">执行中</span>
            </span>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </div>

      {expanded && (
        <div className="px-1.5 pb-1.5 pt-0.5 text-[12px] leading-[1.65] font-mono space-y-2 select-text">
          {data.input !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1 font-sans">输入参数</p>
              <pre className="max-h-40 overflow-auto text-ink leading-relaxed">
                <code>{typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2)}</code>
              </pre>
            </div>
          )}

          {data.output !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1 font-sans">执行结果</p>
              <pre className="max-h-60 overflow-auto text-graphite leading-relaxed whitespace-pre-wrap">
                <code>{data.output}</code>
              </pre>
            </div>
          )}

          {data.error && (
            <div>
              <p className="text-loss text-[10px] mb-1 font-sans">异常错误</p>
              <pre className="max-h-40 overflow-auto text-loss leading-relaxed whitespace-pre-wrap">
                <code>{data.error}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

