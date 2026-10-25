import { useEffect, useState, useCallback, useRef } from "react";
import { Check, Copy, MessageSquareQuote } from "lucide-react";
import { useWorkbench } from "../../../store/useWorkbench.ts";

export function SelectionTooltip({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [copied, setCopied] = useState(false);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const checkSelection = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setCoords(null);
      setSelectedText("");
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 2) {
      setCoords(null);
      setSelectedText("");
      return;
    }

    const range = sel.getRangeAt(0);
    // 确认选区在对话视口内
    if (!container.contains(range.commonAncestorContainer)) {
      setCoords(null);
      setSelectedText("");
      return;
    }

    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // 相对容器定位
    const x = rect.left + rect.width / 2 - containerRect.left;
    const y = rect.top - containerRect.top - 38;

    setCoords({ x, y });
    setSelectedText(text);
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = () => {
      // 延后一帧以获取稳定的选区
      requestAnimationFrame(checkSelection);
    };

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setCoords(null);
        setSelectedText("");
      }
    };

    container.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);

    return () => {
      container.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [containerRef, checkSelection]);

  const quoteIntoComposer = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedText) return;

    const quoteBlock = selectedText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n") + "\n\n";

    // 更新草稿并聚焦输入框
    const state = useWorkbench.getState();
    const prev = state.draft || "";
    state.setDraft(`${quoteBlock}${prev}`);

    // 清空选区并关闭浮层
    window.getSelection()?.removeAllRanges();
    setCoords(null);

    // 触发全局聚焦输入框事件
    window.dispatchEvent(new CustomEvent("aw:focus-composer"));
  };

  const copyText = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedText) return;
    void navigator.clipboard.writeText(selectedText).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setCoords(null);
      }, 1000);
    });
  };

  if (!coords) return null;

  return (
    <div
      ref={tooltipRef}
      style={{
        left: `${coords.x}px`,
        top: `${coords.y}px`,
        transform: "translateX(-50%)",
      }}
      className="absolute z-30 flex items-center gap-1 rounded-full border border-line bg-card/95 px-2 py-1 shadow-lg backdrop-blur-md select-none animate-in fade-in zoom-in-95 duration-100"
    >
      <button
        type="button"
        onClick={quoteIntoComposer}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium text-graphite hover:bg-line-soft hover:text-ink cursor-pointer transition"
        title="引用到输入框进行追问"
      >
        <MessageSquareQuote size={12} className="text-teal" />
        <span>引用追问</span>
      </button>

      <span className="h-3 w-px bg-line" />

      <button
        type="button"
        onClick={copyText}
        className="flex items-center gap-1 rounded-full p-1 text-caption text-ash hover:bg-line-soft hover:text-ink cursor-pointer transition"
        title="复制选中文本"
      >
        {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
      </button>
    </div>
  );
}
