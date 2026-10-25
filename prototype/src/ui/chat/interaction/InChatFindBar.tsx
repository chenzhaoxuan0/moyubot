import { useEffect, useState, useRef, useCallback } from "react";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { cn } from "../../cn.ts";

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
  const matchesRef = useRef<HTMLElement[]>([]);

  // 清除之前的高亮标记
  const clearHighlights = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const marks = container.querySelectorAll("mark[data-chat-find-match]");
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    });
    matchesRef.current = [];
    setMatchCount(0);
    setCurrentIndex(0);
  }, [containerRef]);

  // 高亮当前匹配项
  const highlightMatches = useCallback((searchStr: string) => {
    clearHighlights();
    const container = containerRef.current;
    if (!container || !searchStr.trim()) return;

    const query = searchStr.trim().toLowerCase();
    const matches: HTMLElement[] = [];

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

    const nodesToReplace: Text[] = [];
    while (walker.nextNode()) {
      nodesToReplace.push(walker.currentNode as Text);
    }

    for (const textNode of nodesToReplace) {
      const parent = textNode.parentNode;
      if (!parent) continue;
      const text = textNode.textContent || "";
      const lower = text.toLowerCase();
      let lastIdx = 0;
      let idx = lower.indexOf(query, lastIdx);

      const frag = document.createDocumentFragment();
      while (idx !== -1) {
        if (idx > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        }
        const mark = document.createElement("mark");
        mark.setAttribute("data-chat-find-match", "true");
        mark.className = "bg-amber-300 text-ink rounded-xs px-0.5";
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        matches.push(mark);

        lastIdx = idx + query.length;
        idx = lower.indexOf(query, lastIdx);
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      parent.replaceChild(frag, textNode);
    }

    matchesRef.current = matches;
    setMatchCount(matches.length);
    if (matches.length > 0) {
      setCurrentIndex(1);
      scrollToMatch(0, matches);
    }
  }, [clearHighlights, containerRef]);

  const scrollToMatch = (index: number, list = matchesRef.current) => {
    if (!list || list.length === 0) return;
    const target = list[index];
    if (target) {
      // 样式聚焦
      list.forEach((m, i) => {
        if (i === index) {
          m.className = "bg-teal text-canvas font-bold rounded-xs px-0.5 ring-2 ring-teal shadow-xs";
        } else {
          m.className = "bg-amber-300 text-ink rounded-xs px-0.5";
        }
      });
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

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
