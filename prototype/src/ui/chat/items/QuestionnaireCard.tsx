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
  const pipeRegex = /([A-Za-z0-9])\s*[·\.:、\-]\s*([^|\n]+)/g;
  const lines = text.trim().split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (line.includes("|") && /[A-D0-9]\s*[·\.:、\-]/.test(line)) {
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
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const prev = lines[j]?.trim();
          if (
            prev &&
            (prev.includes("选") ||
              prev.includes("问") ||
              prev.includes("？") ||
              prev.includes("?") ||
              prev.includes("：") ||
              prev.includes(":"))
          ) {
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
      break;
    } else if (
      multilineOptions.length === 0 &&
      (line.includes("选") || line.includes("？") || line.includes("?"))
    ) {
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
 * 问卷决策选项卡片 —— 对齐 ZCode V4InteractionDialogs 与用户交互标准：
 * - 纯净选项卡片（A / B / C / D 徽标单选）
 * - 完整支持：结构化工具调用（ask_question / AskUserQuestion）与对话文本智能识别
 * - 「在这里输入…」补充输入框
 * - 唯一底栏动作：「提交」（无跳过，不替用户做决定）
 * - 支持 A/B/C/D 快捷选单、上下方向键导航与 Enter 快捷提交
 */
export function QuestionnaireCard(): ReactElement | null {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const run = useWorkbench((s) => s.run);

  // 查找最后一条 assistant 消息（聚合完整文本）或问卷工具调用
  const detectedQuestionnaire = useMemo<ParsedQuestionnaire | null>(() => {
    if (busy || timeline.length === 0) return null;

    // 检查是否最后一条 assistant 之后已经有新的 user 消息了
    let assistantMessageId: string | null = null;
    let assistantCompletedText: string | null = null;
    let foundSubsequentUser = false;
    let toolAskQuestion: ParsedQuestionnaire | null = null;

    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (!item) continue;
      const ev = item.event;

      if (ev.type === "message.delta" && ev.role === "user") {
        if (!assistantMessageId && !toolAskQuestion) {
          foundSubsequentUser = true;
          break;
        }
      }

      // 1. 支持结构化工具调用（对齐 ZCode Elicitation / AskUserQuestion / ask_question）
      if (ev.type === "tool.started" && !assistantMessageId) {
        const tn = ev.toolName.toLowerCase();
        if (tn === "ask_question" || tn === "askuserquestion" || tn === "questionnaire" || tn === "ask_user") {
          const inp = ev.input as Record<string, unknown> | undefined;
          if (inp) {
            const rawOpts = (Array.isArray(inp.options) ? inp.options : Array.isArray((inp.questions as any)?.[0]?.options) ? (inp.questions as any)[0].options : []) as unknown[];
            if (rawOpts.length >= 2) {
              const options: QuestionnaireOption[] = rawOpts.map((opt, idx) => {
                const key = String.fromCharCode(65 + idx);
                const text = typeof opt === "string" ? opt : String((opt as any)?.label ?? (opt as any)?.value ?? (opt as any)?.text ?? "");
                return {
                  key,
                  label: `${key} · ${text}`,
                  fullText: `${key} · ${text}`,
                };
              });
              const qTitle = String(inp.question ?? inp.header ?? inp.message ?? (inp.questions as any)?.[0]?.question ?? "请点选你想要的那一项。");
              toolAskQuestion = {
                question: qTitle,
                options,
                rawText: `tool_${ev.callId}`,
              };
              break;
            }
          }
        }
      }

      // 2. 查找 assistant 消息
      if (ev.type === "message.completed") {
        assistantMessageId = ev.messageId;
        assistantCompletedText = ev.text;
        break;
      }
      if (ev.type === "message.delta" && ev.role === "assistant") {
        assistantMessageId = ev.messageId;
        break;
      }
    }

    if (foundSubsequentUser) return null;
    if (toolAskQuestion) return toolAskQuestion;
    if (!assistantMessageId) return null;

    // 拼装完整文本
    let fullText = assistantCompletedText ?? "";
    if (!fullText) {
      const chunks: string[] = [];
      for (const t of timeline) {
        if (t.event.type === "message.delta" && t.event.role === "assistant" && t.event.messageId === assistantMessageId) {
          chunks.push(t.event.text);
        }
      }
      fullText = chunks.join("");
    }

    if (!fullText) return null;
    return parseQuestionnaireOptions(fullText);
  }, [timeline, busy]);

  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 当遇到新的选项集时，重置选中态
  useEffect(() => {
    if (detectedQuestionnaire && detectedQuestionnaire.rawText !== dismissedFor) {
      setSelectedKey(null);
      setCustomInput("");
    }
  }, [detectedQuestionnaire, dismissedFor]);

  // 全局快捷键监听（对齐 ZCode：支持 A/B/C/D、方向键选择与 Enter 提交）
  useEffect(() => {
    if (!detectedQuestionnaire || dismissedFor === detectedQuestionnaire.rawText) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement === inputRef.current) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
        return;
      }

      if (e.key === "Escape") {
        setDismissedFor(detectedQuestionnaire.rawText);
        return;
      }

      const key = e.key.toUpperCase();
      const matched = detectedQuestionnaire.options.find((o) => o.key === key);
      if (matched) {
        e.preventDefault();
        setSelectedKey(matched.key);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const opts = detectedQuestionnaire.options;
        const currIdx = opts.findIndex((o) => o.key === selectedKey);
        if (e.key === "ArrowDown") {
          const nextIdx = currIdx < opts.length - 1 ? currIdx + 1 : 0;
          setSelectedKey(opts[nextIdx]!.key);
        } else {
          const prevIdx = currIdx > 0 ? currIdx - 1 : opts.length - 1;
          setSelectedKey(opts[prevIdx]!.key);
        }
      } else if (e.key === "Enter" && (selectedKey !== null || customInput.trim() !== "")) {
        e.preventDefault();
        handleSubmit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detectedQuestionnaire, dismissedFor, selectedKey, customInput]);

  if (!detectedQuestionnaire || dismissedFor === detectedQuestionnaire.rawText) return null;

  const handleSubmit = () => {
    const selectedOption = detectedQuestionnaire.options.find((o) => o.key === selectedKey);
    let finalPayload = "";

    if (selectedOption && customInput.trim()) {
      finalPayload = `${selectedOption.fullText}\n补充说明：${customInput.trim()}`;
    } else if (selectedOption) {
      finalPayload = selectedOption.fullText;
    } else if (customInput.trim()) {
      finalPayload = customInput.trim();
    }

    if (!finalPayload) return;

    setDismissedFor(detectedQuestionnaire.rawText);
    void run(finalPayload);
  };

  const canSubmit = selectedKey !== null || customInput.trim() !== "";

  return (
    <aside
      className="mx-4 my-2 overflow-hidden rounded-2xl border border-line-soft bg-surface/98 dark:bg-rail/98 backdrop-blur-xl shadow-2xl transition-all duration-200"
      aria-label="决策选项卡"
    >
      {/* 头部标题与关闭按钮 */}
      <div className="flex items-center justify-between border-b border-line-soft/60 px-5 py-3">
        <h3 className="text-body-md font-semibold text-ink select-none">
          {detectedQuestionnaire.question}
        </h3>
        <button
          type="button"
          onClick={() => setDismissedFor(detectedQuestionnaire.rawText)}
          className="rounded-full p-1 text-ash hover:bg-line-soft hover:text-ink transition cursor-pointer"
          title="关闭选单（直接在输入框自由回复）"
        >
          <X size={18} />
        </button>
      </div>

      {/* 选项列表 */}
      <div className="space-y-2 p-4">
        {detectedQuestionnaire.options.map((option) => {
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
