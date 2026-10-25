import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Code2, Copy, FileCode, FolderOpen } from "lucide-react";
import { openInEditor } from "../../../adapters/daemon/client.ts";
import { cn } from "../../cn.ts";
import type { ToolExecutionData } from "../types.ts";

export function FileDiffToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const { filePath, additions, deletions, diffLines } = parseDiffPayload(data);

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;
    void navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const openCode = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) void openInEditor({ path: filePath, editorId: "vscode" });
  };

  const openFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      const parent = filePath.replace(/[\\/][^\\/]*$/, "") || filePath;
      void openInEditor({ path: parent, editorId: "explorer" });
    }
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
        <FileCode size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink truncate max-w-[420px]" title={filePath}>
          {filePath || data.title || "文件编辑"}
        </span>

        {(additions > 0 || deletions > 0) && (
          <span className="font-mono text-[11px] tnum flex items-center gap-1.5 ml-1">
            {additions > 0 && <span className="text-gain">+{additions}</span>}
            {deletions > 0 && <span className="text-loss">−{deletions}</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {filePath && (
            <>
              <button
                type="button"
                onClick={openCode}
                title="用 VS Code 打开"
                className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink cursor-pointer"
              >
                <Code2 size={12} />
              </button>
              <button
                type="button"
                onClick={openFolder}
                title="在资源管理器中定位"
                className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink cursor-pointer"
              >
                <FolderOpen size={12} />
              </button>
              <button
                type="button"
                onClick={copyPath}
                title={copied ? "已复制路径" : "复制文件路径"}
                className="rounded p-1 text-ash hover:bg-line-soft hover:text-ink cursor-pointer"
              >
                {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
              </button>
            </>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line/60 bg-rail/30 p-2.5 font-mono text-caption">
          {diffLines.length > 0 ? (
            <div className="max-h-72 overflow-auto rounded border border-line/50 bg-card p-2 leading-relaxed select-text space-y-0.5">
              {diffLines.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "flex items-start px-1.5 py-0.5 rounded-xs",
                    line.type === "add" && "bg-gain/10 text-gain font-medium",
                    line.type === "del" && "bg-loss/10 text-loss font-medium",
                    line.type === "ctx" && "text-graphite",
                  )}
                >
                  <span className="w-5 shrink-0 text-right mr-2 select-none text-[10px] text-ash/80">
                    {line.prefix}
                  </span>
                  <pre className="font-mono text-body-sm whitespace-pre-wrap break-all flex-1">
                    <code>{line.text}</code>
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <pre className="max-h-60 overflow-auto rounded border border-line/50 bg-card p-2 text-graphite whitespace-pre-wrap">
              <code>{data.output || JSON.stringify(data.input, null, 2)}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface ParsedDiffLine {
  type: "add" | "del" | "ctx";
  prefix: string;
  text: string;
}

function parseDiffPayload(data: ToolExecutionData): {
  filePath: string;
  additions: number;
  deletions: number;
  diffLines: ParsedDiffLine[];
} {
  let filePath = "";
  let additions = 0;
  let deletions = 0;
  const diffLines: ParsedDiffLine[] = [];

  const inputObj = typeof data.input === "object" && data.input !== null ? (data.input as Record<string, unknown>) : null;

  if (inputObj) {
    if (typeof inputObj.TargetFile === "string") filePath = inputObj.TargetFile;
    else if (typeof inputObj.path === "string") filePath = inputObj.path;

    // replace_file_content 专用解析
    if (typeof inputObj.TargetContent === "string" && typeof inputObj.ReplacementContent === "string") {
      const targetLines = inputObj.TargetContent.split("\n");
      const replLines = inputObj.ReplacementContent.split("\n");

      deletions += targetLines.length;
      additions += replLines.length;

      for (const l of targetLines) {
        diffLines.push({ type: "del", prefix: "-", text: l });
      }
      for (const l of replLines) {
        diffLines.push({ type: "add", prefix: "+", text: l });
      }
    }
  }

  // 如果没有从输入中解析出 diffLines，尝试解析输出中的统一 diff (git diff / patch)
  if (diffLines.length === 0 && data.output) {
    const rawLines = data.output.split("\n");
    for (const line of rawLines) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        diffLines.push({ type: "ctx", prefix: " ", text: line });
      } else if (line.startsWith("+")) {
        additions++;
        diffLines.push({ type: "add", prefix: "+", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        deletions++;
        diffLines.push({ type: "del", prefix: "-", text: line.slice(1) });
      }
    }
  }

  return { filePath, additions, deletions, diffLines };
}
