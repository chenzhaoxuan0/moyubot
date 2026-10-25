import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Terminal } from "lucide-react";
import { cn } from "../../cn.ts";
import type { ToolExecutionData } from "../types.ts";

export function BashToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const command = extractCommand(data.input);
  const cwd = extractCwd(data.input) || data.cwd;
  const isRunning = !data.completed;
  const isFailed = data.completed && data.ok === false;

  const copyCommand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!command) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="overflow-hidden rounded-input border border-line bg-[#13151a] text-slate-200 shadow-xs">
      {/* 头部摘要栏 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] cursor-pointer transition select-none"
      >
        <Terminal size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-[11px] font-semibold tracking-wide text-slate-300">终端命令</span>

        {command && (
          <span className="min-w-0 max-w-[400px] truncate font-mono text-[11px] text-slate-400">
            $ {command}
          </span>
        )}

        {cwd && (
          <span
            className="hidden sm:inline-block max-w-[140px] truncate rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
            title={`工作目录: ${cwd}`}
          >
            {cwd.replace(/^[a-zA-Z]:[/\\]/, "")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {data.durationMs !== undefined && data.durationMs > 0 && (
            <span className="font-mono text-[10px] text-slate-500">
              {data.durationMs < 1000 ? `${data.durationMs}ms` : `${(data.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}

          {isRunning ? (
            <span className="flex items-center gap-1 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span>运行中</span>
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1 text-[11px] text-loss">
              <AlertTriangle size={12} />
              <span>失败</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-gain">
              <Check size={12} />
              <span>完成</span>
            </span>
          )}

          {command && (
            <button
              type="button"
              onClick={copyCommand}
              title={copied ? "已复制命令" : "复制命令"}
              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200 cursor-pointer"
            >
              {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
            </button>
          )}

          {expanded ? <ChevronDown size={12} className="text-slate-400" /> : <ChevronRight size={12} className="text-slate-400" />}
        </div>
      </div>

      {/* 展开的输出明细 */}
      {expanded && (
        <div className="border-t border-white/[0.08] bg-[#0c0d10] p-3 font-mono text-caption space-y-2">
          {command && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">执行命令</div>
              <div className="rounded bg-black/40 border border-white/[0.06] p-2 text-slate-200 overflow-x-auto whitespace-pre-wrap select-text">
                <span className="text-teal select-none">$ </span>
                {command}
              </div>
            </div>
          )}

          {data.output && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">终端输出</div>
              <pre className="max-h-72 overflow-auto rounded bg-black/50 border border-white/[0.06] p-2.5 text-slate-300 leading-relaxed whitespace-pre-wrap select-text">
                <code>{data.output}</code>
              </pre>
            </div>
          )}

          {data.error && (
            <div>
              <div className="text-[10px] text-loss/80 mb-1">错误信息</div>
              <pre className="max-h-40 overflow-auto rounded bg-loss/10 border border-loss/20 p-2.5 text-loss leading-relaxed whitespace-pre-wrap select-text">
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
