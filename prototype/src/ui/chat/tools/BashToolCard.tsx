import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { cn } from "../../cn.ts";
import type { ToolExecutionData } from "../types.ts";

export function BashToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);

  const command = extractCommand(data.input);
  const cwd = extractCwd(data.input) || data.cwd;
  const isRunning = !data.completed;
  const isFailed = data.completed && data.ok === false;

  return (
    <div className="rounded-btn transition-colors hover:bg-line-soft/40">
      {/* 头部摘要栏 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-1.5 py-1.5 text-left cursor-pointer transition select-none"
      >
        <Terminal size={13} className="shrink-0 text-teal" />
        <span className="text-body-sm font-medium text-ink">执行</span>

        {command && (
          <span className="min-w-0 max-w-[400px] truncate font-mono text-body-sm text-ash">
            $ {command}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {isRunning ? (
            <span className="flex items-center gap-1.5 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span className="animate-text-shimmer font-medium">运行中</span>
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
              <AlertTriangle size={12} className="text-loss" />
              <span>失败</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
              <Check size={12} className="text-gain" />
              <span>exit 0</span>
            </span>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </div>

      {/* 展开的输出明细 */}
      {expanded && (
        <div className="px-1.5 pb-1.5 pt-0.5 font-mono text-[12px] leading-[1.65] space-y-2">
          {cwd && (
            <div className="text-[10px] text-ash truncate" title={`工作目录: ${cwd}`}>
              cwd: {cwd}
            </div>
          )}
          {command && (
            <div>
              <div className="text-[10px] text-ash mb-1">执行命令</div>
              <div className="text-ink overflow-x-auto whitespace-pre-wrap select-text">
                <span className="text-teal select-none">$ </span>
                {command}
              </div>
            </div>
          )}

          {data.output && (
            <div>
              <div className="text-[10px] text-ash mb-1">终端输出</div>
              <pre className="max-h-72 overflow-auto text-graphite select-text">
                <code>{data.output}</code>
              </pre>
            </div>
          )}

          {data.error && (
            <div>
              <div className="text-[10px] text-loss/80 mb-1">错误信息</div>
              <pre className="max-h-40 overflow-auto text-loss select-text">
                <code>{data.error}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function extractCommand(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const c = o.CommandLine ?? o.command ?? o.cmd;
    if (typeof c === "string") return c;
  }
  return "";
}

function extractCwd(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const c = o.Cwd ?? o.cwd;
  return typeof c === "string" ? c : "";
}
