import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Wrench } from "lucide-react";
import type { ToolExecutionData } from "../types.ts";

export function GenericToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const brief = data.title || formatGenericInputBrief(data.input);

  const copyPayload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = data.output || (typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2));
    if (!textToCopy) return;
    void navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="overflow-hidden rounded-input border border-line bg-card shadow-xs">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-line-soft/50 cursor-pointer transition select-none"
      >
        <Wrench size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">{data.toolName}</span>

        {brief && <span className="min-w-0 max-w-[420px] truncate font-mono text-caption text-ash">{brief}</span>}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {data.durationMs !== undefined && data.durationMs > 0 && (
            <span className="font-mono text-[10px] text-ash">
              {data.durationMs < 1000 ? `${data.durationMs}ms` : `${(data.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}

          {data.completed ? (
            data.ok !== false ? (
              <span className="flex items-center gap-1 text-[11px] text-gain">
                <Check size={12} />
                <span>完成</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-loss">
                <AlertTriangle size={12} />
                <span>失败</span>
              </span>
            )
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span>执行中</span>
            </span>
          )}

          <button
            type="button"
            onClick={copyPayload}
            title={copied ? "已复制" : "复制结果"}
            className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink cursor-pointer"
          >
            {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
          </button>

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line/60 bg-rail/30 p-3 text-caption font-mono space-y-2 select-text">
          {data.input !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1 font-sans">输入参数</p>
              <pre className="max-h-40 overflow-auto rounded bg-card p-2 text-ink border border-line/50 leading-relaxed">
                <code>{typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2)}</code>
              </pre>
            </div>
          )}

          {data.output !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1 font-sans">执行结果</p>
              <pre className="max-h-60 overflow-auto rounded bg-card p-2 text-graphite border border-line/50 leading-relaxed whitespace-pre-wrap">
                <code>{data.output}</code>
              </pre>
            </div>
          )}

          {data.error && (
            <div>
              <p className="text-loss text-[10px] mb-1 font-sans">异常错误</p>
              <pre className="max-h-40 overflow-auto rounded bg-loss/10 p-2 text-loss border border-loss/20 leading-relaxed whitespace-pre-wrap">
                <code>{data.error}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatGenericInputBrief(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input.slice(0, 60);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const v = o.id ?? o.name ?? o.query ?? o.prompt ?? o.path ?? o.url;
    if (typeof v === "string") return v.slice(0, 60);
  }
  return "";
}
