import { useEffect, useState, useRef, useCallback } from "react";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";

/**
 * 查找高亮走 CSS Custom Highlight API：只把匹配文本的 Range 注册进
 * CSS.highlights，不向 React 管理的 DOM 插 <mark>（旧实现 replaceChild
 * 与流式重渲染冲突，会触发 removeChild NotFoundError / 高亮丢失）。
 * 样式见 styles.css 的 ::highlight(inchat-find[-current]) 规则。
 * 不支持该 API 的环境降级为「无高亮，但计数/上下条跳转仍可用」。
 */
const FIND_HIGHLIGHT_ALL = "inchat-find";
const FIND_HIGHLIGHT_CURRENT = "inchat-find-current";

const HIGHLIGHT_API_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

/**
 * TS 5.9 的 lib.dom 只给 HighlightRegistry 生成了 forEach（maplike 成员未展开），
 * 运行时它就是标准的 set/delete/has 注册表 —— 这里取一个最小类型视图。
 */
type HighlightRegistryLike = {
  set(name: string, highlight: Highlight): unknown;
  delete(name: string): boolean;
};

function getHighlightRegistry(): HighlightRegistryLike | null {
  if (!HIGHLIGHT_API_SUPPORTED) return null;
  return (CSS as { highlights: HighlightRegistry }).highlights as unknown as HighlightRegistryLike;
}

/** 清空查找高亮注册表（每次重扫 / 关闭 / 卸载时调用），幂等且永不抛错 */
function clearFindHighlightRegistry() {
  getHighlightRegistry()?.delete(FIND_HIGHLIGHT_ALL);
  getHighlightRegistry()?.delete(FIND_HIGHLIGHT_CURRENT);
}

export function InChatFindBar({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matchesRef = useRef<Range[]>([]);

  // 定位当前匹配：单独的「当前项」高亮注册 + 平滑滚动到所在元素
  const scrollToMatch = (index: number, list: Range[] = matchesRef.current) => {
    if (!list || list.length === 0) return;
    const target = list[index];
    if (!target) return;
    try {
      getHighlightRegistry()?.set(FIND_HIGHLIGHT_CURRENT, new Highlight(target));
    } catch {
      // 陈旧 Range 等异常：降级为仅跳转不高亮
    }
    // Range 没有 scrollIntoView：借宿主文本节点的父元素定位；
    // 流式重渲染后 Range 可能已失效（parentElement 为 null），静默跳过
    const el = (target.startContainer as Text).parentElement;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // 清除之前的高亮（只清注册表，不碰 DOM）
  const clearHighlights = useCallback(() => {
    clearFindHighlightRegistry();
    matchesRef.current = [];
    setMatchCount(0);
    setCurrentIndex(0);
  }, []);

  // 扫描匹配：遍历文本节点建 Range，注册进 CSS.highlights
  const highlightMatches = useCallback(
    (searchStr: string) => {
      clearHighlights();
      const container = containerRef.current;
      if (!container || !searchStr.trim()) return;

      const query = searchStr.trim().toLowerCase();
      const ranges: Range[] = [];

      // 递归遍历可搜索的文本节点（避开 input, textarea, script）
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName.toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "script" || tag === "style") {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest("[data-find-ignore]")) {
              return NodeFilter.FILTER_REJECT;
            }
            if (node.textContent && node.textContent.toLowerCase().includes(query)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          },
        },
      );

      const textNodes: Text[] = [];
      while (walker.nextNode()) {
        textNodes.push(walker.currentNode as Text);
      }

      for (const textNode of textNodes) {
        const text = textNode.textContent ?? "";
        const lower = text.toLowerCase();
        let from = 0;
        let idx = lower.indexOf(query, from);
        while (idx !== -1) {
          try {
            const range = document.createRange();
            range.setStart(textNode, idx);
            range.setEnd(textNode, idx + query.length);
            ranges.push(range);
          } catch {
            // 节点在扫描间隙被流式渲染替换：放弃该节点剩余匹配，继续下一个
            break;
          }
          from = idx + query.length;
          idx = lower.indexOf(query, from);
        }
      }

      if (ranges.length === 0) return;

      try {
        getHighlightRegistry()?.set(FIND_HIGHLIGHT_ALL, new Highlight(...ranges));
      } catch {
        // 注册失败（含极端陈旧 Range）：降级为无高亮，计数与跳转仍可用
      }

      matchesRef.current = ranges;
      setMatchCount(ranges.length);
      if (ranges.length > 0) {
        setCurrentIndex(1);
        scrollToMatch(0, ranges);
      }
    },
    [clearHighlights, containerRef],
  );

  const handleNext = () => {
    if (matchCount === 0) return;
    const nextIdx = (currentIndex % matchCount) + 1;
    setCurrentIndex(nextIdx);
    scrollToMatch(nextIdx - 1);
  };

  const handlePrev = () => {
    if (matchCount === 0) return;
    const prevIdx = currentIndex <= 1 ? matchCount : currentIndex - 1;
    setCurrentIndex(prevIdx);
    scrollToMatch(prevIdx - 1);
  };

  const closeFind = useCallback(() => {
    setOpen(false);
    setKeyword("");
    clearHighlights();
  }, [clearHighlights]);

  // 全局快捷键监听 Ctrl+F / Cmd+F
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const target = e.target as HTMLElement | null;
        // 如果焦点已经在查找框内则不打断
        if (target && target === inputRef.current) return;

        // 如果在主输入框内，不强制夺取，但如果在视口内或全局按快捷键则呼出
        e.preventDefault();
        setOpen(true);
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 50);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        closeFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeFind]);

  // 关键词变化时重新检索
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      highlightMatches(keyword);
    }, 120);
    return () => clearTimeout(timer);
  }, [keyword, open, highlightMatches]);

  // 卸载时清空高亮注册表，避免残留 Range 泄漏到之后的实例
  useEffect(() => clearFindHighlightRegistry, []);

  if (!open) return null;

  return (
    <div
      data-find-ignore="true"
      className="fixed top-14 right-6 z-30 flex items-center gap-1.5 rounded-card bg-card/95 backdrop-blur-md border border-line shadow-lg px-2.5 py-1.5 animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <Search size={14} className="shrink-0 text-ash" />
      <input
        ref={inputRef}
        type="text"
        placeholder="查找对话内容…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) handlePrev();
            else handleNext();
          }
        }}
        className="w-40 sm:w-56 bg-transparent text-body-sm text-ink outline-none placeholder:text-ash font-mono"
      />

      <span className="shrink-0 font-mono text-[11px] text-ash px-1">
        {matchCount > 0 ? `${currentIndex}/${matchCount}` : keyword ? "无结果" : ""}
      </span>

      <div className="flex items-center gap-0.5 border-l border-line-soft pl-1">
        <button
          type="button"
          onClick={handlePrev}
          disabled={matchCount === 0}
          title="上一个 (Shift+Enter)"
          aria-label="上一个匹配项"
          className="flex h-6 w-6 items-center justify-center rounded-btn text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={matchCount === 0}
          title="下一个 (Enter)"
          aria-label="下一个匹配项"
          className="flex h-6 w-6 items-center justify-center rounded-btn text-graphite hover:bg-line-soft hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          onClick={closeFind}
          title="关闭 (Esc)"
          aria-label="关闭查找"
          className="flex h-6 w-6 items-center justify-center rounded-btn text-graphite hover:bg-line-soft hover:text-ink cursor-pointer ml-0.5"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
