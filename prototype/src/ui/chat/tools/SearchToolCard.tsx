import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Globe, Search } from "lucide-react";
import type { ToolExecutionData } from "../types.ts";

export function SearchToolCard({ data }: { data: ToolExecutionData }) {
  const [expanded, setExpanded] = useState(false);

  const query = extractSearchQuery(data.input) || data.title;
  const results = parseSearchResults(data.output);

  return (
    <div className="rounded-btn transition-colors hover:bg-line-soft/40">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-1.5 py-1.5 text-left cursor-pointer transition select-none"
      >
        <Search size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">联网检索</span>

        {query && (
          <span className="min-w-0 max-w-[420px] truncate font-mono text-body-sm text-ash">
            "{query}"
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {data.completed ? (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
              <span className="h-1.5 w-1.5 rounded-full bg-gain" />
              <span>{results.length > 0 ? `${results.length} 条结果` : "已完成"}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-ash">
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
              {results.map((res, idx) => {
                const rawHost = hostOf(res.url);
                // 域名：优先 payload 给的字段，否则从 URL 提取（去掉 www. 前缀）
                const domain = res.domain || rawHost.replace(/^www\./, "");
                // favicon：优先 payload 给的地址，否则按主机名现取（DuckDuckGo 图标服务）
                const faviconSrc =
                  res.favicon || (rawHost ? `https://icons.duckduckgo.com/ip3/${rawHost}.ico` : "");
                return (
                  <div key={idx} className="rounded-card border border-line/50 bg-card p-2.5 shadow-2xs">
                    <div className="flex items-center gap-1.5 text-caption font-medium">
                      {/* key 随 src 变化：流式更新换结果时重置错误回退态 */}
                      <ResultFavicon key={faviconSrc} src={faviconSrc} />
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
                    {domain && (
                      <div className="mt-1 truncate font-mono text-[11px] text-ash">{domain}</div>
                    )}
                    {res.snippet && (
                      <p className="mt-1 text-body-sm text-graphite line-clamp-3 leading-relaxed">
                        {res.snippet}
                      </p>
                    )}
                  </div>
                );
              })}
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

/** 结果 favicon：加载失败（无图 / 断网 / 域名无图标）时回退到 Globe 图标 */
function ResultFavicon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return <Globe size={11} className="shrink-0 text-ash" aria-hidden />;
  }
  return (
    <img
      src={src}
      alt=""
      width={12}
      height={12}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-3 w-3 shrink-0 rounded-xs"
    />
  );
}

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  /** payload 自带的 favicon 地址（可选，缺失时按主机名现取） */
  favicon?: string;
  /** payload 自带的域名（可选，缺失时从 URL 提取） */
  domain?: string;
}

/** 从 URL 提取主机名；非 http(s) / 解析失败返回空串 */
function hostOf(url: string): string {
  if (!/^https?:\/\//i.test(url)) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
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
          const favicon = item.favicon ?? item.icon ?? item.favicon_url ?? item.faviconUrl;
          const domain = item.domain ?? item.host ?? item.site_name ?? item.source;
          results.push({
            title: String(item.title || item.name || ""),
            url: String(item.url || item.link || ""),
            snippet: String(item.snippet || item.content || item.summary || ""),
            favicon: typeof favicon === "string" && favicon ? favicon : undefined,
            domain: typeof domain === "string" && domain ? domain : undefined,
          });
        }
      }
      if (results.length > 0) return results;
    }
  } catch {
    // 非纯 JSON，解析文本格式（如 formatRows 输出）
  }

  // 2. 文本解析：按标题/链接/摘要块匹配（此格式无 favicon/域名字段，渲染时从 URL 推导）
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
