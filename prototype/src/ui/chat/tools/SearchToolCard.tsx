import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Globe, Search } from "lucide-react";
import type { ToolExecutionData } from "../types.ts";

export function SearchToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);

  const query = extractSearchQuery(data.input) || data.title;
  const results = parseSearchResults(data.output);

  return (
    <div className="overflow-hidden rounded-input border border-line bg-card shadow-xs">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-line-soft/50 cursor-pointer transition select-none"
      >
        <Search size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">联网检索</span>

        {query && (
          <span className="min-w-0 max-w-[420px] truncate font-mono text-caption text-ash">
            "{query}"
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {data.completed ? (
            <span className="text-[11px] text-gain">
              {results.length > 0 ? `${results.length} 条结果` : "已完成"}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span>搜索中</span>
            </span>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line/60 bg-rail/20 p-3 text-caption space-y-2.5 select-text">
          {results.length > 0 ? (
            <div className="space-y-2">
              {results.map((res, idx) => (
                <div key={idx} className="rounded-card border border-line/50 bg-card p-2.5 shadow-2xs">
                  <div className="flex items-center gap-1.5 text-caption font-medium">
                    <Globe size={11} className="text-ash shrink-0" />
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-teal hover:underline truncate flex-1 font-mono flex items-center gap-1"
                    >
                      <span>{res.title || res.url}</span>
                      <ExternalLink size={10} className="shrink-0 opacity-70" />
                    </a>
                  </div>
                  {res.snippet && (
                    <p className="mt-1 text-body-sm text-graphite line-clamp-3 leading-relaxed">
                      {res.snippet}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <pre className="max-h-60 overflow-auto rounded border border-line/50 bg-card p-2 text-graphite whitespace-pre-wrap font-mono">
              <code>{data.output || "无返回结果"}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

function extractSearchQuery(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const q = o.query ?? o.Query ?? o.q;
    if (typeof q === "string") return q;
  }
  return "";
}

function parseSearchResults(rawOutput?: string): SearchItem[] {
  if (!rawOutput) return [];
  const results: SearchItem[] = [];

  // 1. 尝试以 JSON 解析
  try {
    const parsed = JSON.parse(rawOutput);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "object" && item !== null) {
          results.push({
            title: String(item.title || item.name || ""),
            url: String(item.url || item.link || ""),
            snippet: String(item.snippet || item.content || item.summary || ""),
          });
        }
      }
      if (results.length > 0) return results;
    }
  } catch {
    // 非纯 JSON，解析文本格式（如 formatRows 输出）
  }

  // 2. 文本解析：按标题/链接/摘要块匹配
  const blocks = rawOutput.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      let title = "";
      let url = "";
      const snippetLines: string[] = [];

      for (const line of lines) {
        if (/^https?:\/\//i.test(line)) {
          url = line;
        } else if (!title && !line.startsWith("来源:") && !line.startsWith("Date:")) {
          title = line.replace(/^[#\d.-]+\s*/, "");
        } else {
          snippetLines.push(line);
        }
      }

      if (url || title) {
        results.push({
          title: title || url,
          url: url || "#",
          snippet: snippetLines.join(" "),
        });
      }
    }
  }

  return results.slice(0, 8);
}
