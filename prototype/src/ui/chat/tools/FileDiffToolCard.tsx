import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Code2, Copy, FileCode, FolderOpen } from "lucide-react";
import { openInEditor } from "../../../adapters/daemon/client.ts";
import { cn } from "../../cn.ts";
import { highlightCode, type CodeTokenLines } from "../../shikiHighlighter.ts";
import { useAppearance } from "../../../store/useAppearance.ts";
import type { ToolExecutionData } from "../types.ts";

export function FileDiffToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const appearance = useAppearance((s) => s.resolvedAppearance);

  const { filePath, additions, deletions, diffLines } = useMemo(() => parseDiffPayload(data), [data]);

  // 高亮输入体：旧侧 = del+ctx 行，新侧 = add+ctx 行（整块喂给 shiki，
  // 保住跨行语法上下文，也把每行的 token 下标随行号一起回填）
  const { oldCode, newCode } = useMemo(() => buildHighlightSources(diffLines), [diffLines]);

  const lang = useMemo(() => langOfPath(filePath), [filePath]);

  // shiki 异步高亮：就绪前渲染纯文本（与 MarkdownContent.CodeBody 同一套降级）。
  // highlightCode 内部带 token 缓存，流式期间重复扫描同一段代码走缓存。
  const [tokens, setTokens] = useState<{ old: CodeTokenLines | null; new: CodeTokenLines | null } | null>(
    null,
  );

  useEffect(() => {
    if (!expanded || !lang || (!oldCode && !newCode)) {
      setTokens(null);
      return;
    }
    let alive = true;
    setTokens(null); // 输入变化时旧 token 立即失效，防止与行错位
    void Promise.all([
      oldCode ? highlightCode(oldCode, lang, appearance) : Promise.resolve(null),
      newCode ? highlightCode(newCode, lang, appearance) : Promise.resolve(null),
    ]).then(([oldTokens, newTokens]) => {
      if (alive) setTokens({ old: oldTokens, new: newTokens });
    });
    return () => {
      alive = false;
    };
  }, [expanded, lang, oldCode, newCode, appearance]);

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
              {diffLines.map((line, idx) => {
                // del 行吃旧侧 token，add/ctx 行吃新侧 token（meta 行无下标 → 纯文本）
                const lineTokens =
                  tokens !== null
                    ? line.type === "del"
                      ? tokens.old?.[line.oldIdx ?? -1]
                      : tokens.new?.[line.newIdx ?? -1]
                    : undefined;
                const hasTokens = lineTokens !== undefined && lineTokens.length > 0;
                return (
                  <div
                    key={idx}
                    className={cn(
                      "flex items-start px-1.5 py-0.5 rounded-xs",
                      line.type === "add" && "bg-gain/10 font-medium",
                      line.type === "del" && "bg-loss/10 font-medium",
                      // token 未就绪时保留原有整行着色；就绪后让位给语法色
                      !hasTokens && line.type === "add" && "text-gain",
                      !hasTokens && line.type === "del" && "text-loss",
                      !hasTokens && line.type === "ctx" && "text-graphite",
                    )}
                  >
                    <span className="w-6 shrink-0 select-none text-right text-[10px] tnum text-ash/70">
                      {line.oldLine ?? ""}
                    </span>
                    <span className="w-6 shrink-0 select-none text-right text-[10px] tnum text-ash/70 mr-1.5">
                      {line.newLine ?? ""}
                    </span>
                    <span className="w-3 shrink-0 select-none text-[10px] text-ash/80">
                      {line.prefix}
                    </span>
                    <pre className="font-mono text-body-sm whitespace-pre-wrap break-all flex-1">
                      <code>
                        {hasTokens
                          ? lineTokens.map((t, j) => (
                              <span key={j} style={t.color === undefined ? undefined : { color: t.color }}>
                                {t.content}
                              </span>
                            ))
                          : line.text}
                      </code>
                    </pre>
                  </div>
                );
              })}
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
  /** 旧文件行号（del/ctx 行有；文件头等 meta 行没有） */
  oldLine?: number;
  /** 新文件行号（add/ctx 行有） */
  newLine?: number;
  /** 该行在高亮输入体中的 0 基下标（buildHighlightSources 回填，用于取 token） */
  oldIdx?: number;
  newIdx?: number;
}

/** 扩展名 → shiki 语言标签（复用 chat 代码块同一套高亮管线的语言名） */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  xml: "xml",
  svg: "xml",
};

function langOfPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "";
}

/** 统一 diff hunk 头：@@ -oldStart[,count] +newStart[,count] @@ */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

    // replace_file_content 专用解析。
    // 注意：该 payload 不携带任何行号信息，只能按顺序编号（非真实文件行号）。
    if (typeof inputObj.TargetContent === "string" && typeof inputObj.ReplacementContent === "string") {
      const targetLines = inputObj.TargetContent.split("\n");
      const replLines = inputObj.ReplacementContent.split("\n");

      deletions += targetLines.length;
      additions += replLines.length;

      targetLines.forEach((l, i) => {
        diffLines.push({ type: "del", prefix: "-", text: l, oldLine: i + 1 });
      });
      replLines.forEach((l, i) => {
        diffLines.push({ type: "add", prefix: "+", text: l, newLine: i + 1 });
      });
    }
  }

  // 如果没有从输入中解析出 diffLines，尝试解析输出中的统一 diff (git diff / patch)。
  // 行号来自 @@ hunk 头：del/ctx 推进旧文件行号，add/ctx 推进新文件行号。
  if (diffLines.length === 0 && data.output) {
    const rawLines = data.output.split("\n");
    let oldNo = 0;
    let newNo = 0;
    for (const line of rawLines) {
      const hunk = HUNK_HEADER_RE.exec(line);
      if (hunk) {
        oldNo = parseInt(hunk[1]!, 10);
        newNo = parseInt(hunk[2]!, 10);
        diffLines.push({ type: "ctx", prefix: " ", text: line });
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        diffLines.push({ type: "ctx", prefix: " ", text: line });
      } else if (line.startsWith("+")) {
        additions++;
        diffLines.push({ type: "add", prefix: "+", text: line.slice(1), newLine: newNo });
        newNo++;
      } else if (line.startsWith("-")) {
        deletions++;
        diffLines.push({ type: "del", prefix: "-", text: line.slice(1), oldLine: oldNo });
        oldNo++;
      } else if (line.startsWith(" ")) {
        // 上下文行：参与两侧行号推进（否则后续行号会错位）
        diffLines.push({ type: "ctx", prefix: " ", text: line.slice(1), oldLine: oldNo, newLine: newNo });
        oldNo++;
        newNo++;
      }
      // 空行与 "\ No newline at end of file" 等尾注：不展示也不计数
    }
  }

  return { filePath, additions, deletions, diffLines };
}

/**
 * 组装两份高亮输入体并回填 token 下标：
 * 旧侧 = del+ctx（有 oldLine 的行），新侧 = add+ctx（有 newLine 的行）。
 * meta 行（+++/---/@@）没有行号，不进输入体，渲染时保持纯文本。
 */
function buildHighlightSources(diffLines: ParsedDiffLine[]): { oldCode: string; newCode: string } {
  const oldParts: string[] = [];
  const newParts: string[] = [];
  for (const line of diffLines) {
    if ((line.type === "del" || line.type === "ctx") && line.oldLine !== undefined) {
      line.oldIdx = oldParts.length;
      oldParts.push(line.text);
    }
    if ((line.type === "add" || line.type === "ctx") && line.newLine !== undefined) {
      line.newIdx = newParts.length;
      newParts.push(line.text);
    }
  }
  return { oldCode: oldParts.join("\n"), newCode: newParts.join("\n") };
}
