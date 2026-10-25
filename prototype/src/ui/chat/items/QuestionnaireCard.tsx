import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { PenLine, X } from "lucide-react";
import { useWorkbench } from "../../../store/useWorkbench.ts";
import { cn } from "../../cn.ts";

export interface QuestionnaireOption {
  readonly key: string;
  readonly label: string;
  readonly fullText: string;
}

export interface ParsedQuestionnaire {
  readonly question: string;
  readonly options: readonly QuestionnaireOption[];
  readonly rawText: string;
}

/**
 * 启发式提取文本中的问卷/选项卡内容：
 * 1. 行内管道分隔：A · xxx | B · xxx | C · xxx
 * 2. 换行字母列表：A. xxx \n B. xxx \n C. xxx 或 A · xxx \n B · xxx
 * 3. 换行数字列表：1. xxx \n 2. xxx (当数量 >= 2 时)
 */
export function parseQuestionnaireOptions(text: string): ParsedQuestionnaire | null {
  if (!text || typeof text !== "string") return null;

  // 1. 尝试行内管道分隔（如截图中的：A · 重发心跳提议横幅 | B · 清理 mock_tool 放行规则 | C · ...）
  const pipeRegex = /([A-Za-z0-9])\s*[·\.:、]\s*([^|\n]+)/g;
  const lines = text.trim().split(/\r?\n/);
  
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (line.includes("|") && /[A-D]\s*[·\.:、]/.test(line)) {
      const matches = Array.from(line.matchAll(pipeRegex));
      if (matches.length >= 2) {
        const options: QuestionnaireOption[] = matches.map((m) => {
          const key = m[1]?.toUpperCase() ?? "";
          const content = m[2]?.trim() ?? "";
          return {
            key,
            label: `${key} · ${content}`,
            fullText: `${key} · ${content}`,
          };
        });
        // 向上寻找提问句（如：请选择... / 确定...）
        let question = "请点选你想要的那一项。";
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const prev = lines[j]?.trim();
          if (prev && (prev.includes("选") || prev.includes("问") || prev.includes("？") || prev.includes("?") || prev.includes("：") || prev.includes(":"))) {
            question = prev.replace(/^#+\s*/, "").replace(/[：:]$/, "。");
            break;
          }
        }
        return { question, options, rawText: line };
      }
    }
  }

  // 2. 尝试多行列表（连续的 A. xxx / B. xxx 或 1. xxx / 2. xxx）
  const multilineOptions: QuestionnaireOption[] = [];
  let foundQuestion = "请点选你想要的那一项。";
  let optionStartIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    const listMatch = line.match(/^[-*]?\s*([A-Za-z0-9])[·\.:、\)]\s*(.+)$/);
    if (listMatch) {
      if (optionStartIndex === -1) optionStartIndex = i;
      const key = listMatch[1]?.toUpperCase() ?? "";
      const content = listMatch[2]?.trim() ?? "";
      multilineOptions.push({
        key,
        label: `${key} · ${content}`,
        fullText: `${key} · ${content}`,
      });
    } else if (multilineOptions.length >= 2 && line === "") {
      // 连续选项结束
      break;
    } else if (multilineOptions.length === 0 && (line.includes("选") || line.includes("？") || line.includes("?"))) {
      foundQuestion = line.replace(/^#+\s*/, "").replace(/[：:]$/, "。");
    }
  }

  if (multilineOptions.length >= 2 && multilineOptions.length <= 8) {
    return {
      question: foundQuestion,
      options: multilineOptions,
      rawText: multilineOptions.map((o) => o.label).join("\n"),
    };
  }

  return null;
}

/**
 * 问卷决策选项卡片 —— 对齐用户截图交互标准：
 * - 纯净选项卡片（A / B / C / D 徽标单选）
 * - 「在这里输入…」补充输入框
 * - 唯一底栏动作：「提交」（无跳过，不替用户做决定）
 * - 支持 A/B/C/D 快捷选单与 Enter 快捷提交
 */
export function QuestionnaireCard(): ReactElement | null {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const run = useWorkbench((s) => s.run);

  // 查找最后一条 assistant 消息
  const lastAssistantMsg = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item && item.event.type === "message.delta" && item.event.role === "assistant") {
        return item.event.text;
      }
    }
    return null;
  }, [timeline]);

  // 是否在最后一条 assistant 消息之后已经有新的 user 消息发出了
  const hasSubsequentUserMsg = useMemo(() => {
    let assistantFound = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item && item.event.type === "message.delta") {
        if (item.event.role === "user" && !assistantFound) {
          return true; // 后面已经有 user 发送了
        }
        if (item.event.role === "assistant") {
          assistantFound = true;
        }
      }
    }
    return false;
  }, [timeline]);

  const parsed = useMemo(() => {
    if (!lastAssistantMsg || hasSubsequentUserMsg || busy) return null;
    return parseQuestionnaireOptions(lastAssistantMsg);
  }, [lastAssistantMsg, hasSubsequentUserMsg, busy]);

  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 当遇到新的选项集时，重置选中与关闭状态
  useEffect(() => {
    if (parsed && parsed.rawText !== dismissedFor) {
      setSelectedKey(null);
      setCustomInput("");
    }
  }, [parsed, dismissedFor]);

  // 全局快捷键监听（A/B/C/D 选单，Enter 提交）
  useEffect(() => {
    if (!parsed || dismissedFor === parsed.rawText) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // 如果焦点在输入框内，只处理 Enter 提交
      if (document.activeElement === inputRef.current) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
        return;
      }

      if (e.key === "Escape") {
        setDismissedFor(parsed.rawText);
        return;
      }

      const key = e.key.toUpperCase();
      const matched = parsed.options.find((o) => o.key === key);
      if (matched) {
        e.preventDefault();
        setSelectedKey(matched.key);
      } else if (e.key === "Enter" && selectedKey !== null) {
        e.preventDefault();
        handleSubmit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [parsed, dismissedFor, selectedKey, customInput]);

  if (!parsed || dismissedFor === parsed.rawText) return null;

  const handleSubmit = () => {
    const selectedOption = parsed.options.find((o) => o.key === selectedKey);
    let finalPayload = "";

    if (selectedOption && customInput.trim()) {
      finalPayload = `${selectedOption.fullText}\n补充说明：${customInput.trim()}`;
    } else if (selectedOption) {
      finalPayload = selectedOption.fullText;
    } else if (customInput.trim()) {
      finalPayload = customInput.trim();
    }

    if (!finalPayload) return;

    setDismissedFor(parsed.rawText);
    void run(finalPayload);
  };

  const canSubmit = selectedKey !== null || customInput.trim() !== "";

  return (
    <aside
      className="mx-4 my-2 overflow-hidden rounded-2xl border border-line-soft bg-surface/95 backdrop-blur-xl shadow-2xl transition-all duration-200"
      aria-label="决策选项"
    >
      {/* 头部标题与关闭按钮 */}
      <div className="flex items-center justify-between border-b border-line-soft/60 px-5 py-3">
        <h3 className="text-body-md font-semibold text-ink select-none">
          {parsed.question}
        </h3>
        <button
          type="button"
          onClick={() => setDismissedFor(parsed.rawText)}
          className="rounded-full p-1 text-ash hover:bg-line-soft hover:text-ink transition cursor-pointer"
          title="关闭选单（直接在输入框自由回复）"
        >
          <X size={18} />
        </button>
      </div>

      {/* 选项列表 */}
      <div className="space-y-2 p-4">
        {parsed.options.map((option) => {
          const isSelected = selectedKey === option.key;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => setSelectedKey(option.key)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-150 cursor-pointer select-none",
                isSelected
                  ? "border-teal/60 bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-1 ring-teal/30 shadow-sm"
                  : "border-line-soft bg-rail/60 text-ink hover:border-teal/40 hover:bg-line-soft/50",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-caption font-bold transition-colors",
                  isSelected
                    ? "bg-teal text-white shadow-subtle"
                    : "bg-line-soft text-graphite group-hover:bg-line group-hover:text-ink",
                )}
              >
                {option.key}
              </span>
              <span className="min-w-0 flex-1 text-body-sm font-medium leading-relaxed">
                {option.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* 底部补充输入框与提交区（严格无跳过按钮） */}
      <div className="border-t border-line-soft/60 bg-rail/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative flex flex-1 items-center rounded-xl border border-line-soft bg-surface px-3 py-2 shadow-inner focus-within:border-teal/60 focus-within:ring-1 focus-within:ring-teal/30">
            <PenLine size={16} className="mr-2 text-ash shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="在这里输入补充内容或自定义要求…"
              className="w-full bg-transparent text-body-sm text-ink placeholder:text-ash/60 focus:outline-none"
            />
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className={cn(
              "flex h-10 items-center justify-center rounded-xl px-6 text-body-sm font-medium text-white transition-all duration-150 select-none shadow-sm cursor-pointer",
              canSubmit
                ? "bg-teal hover:bg-teal-600 active:scale-[0.98]"
                : "bg-ash/40 text-white/60 cursor-not-allowed opacity-50",
            )}
          >
            提交
          </button>
        </div>
      </div>
    </aside>
  );
}
