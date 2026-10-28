import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronDown, ChevronUp, PenLine, X } from "lucide-react";
import { useWorkbench } from "../../../store/useWorkbench.ts";
import { useShell } from "../../../store/useShell.ts";
import { useIsMobile } from "../../mobile/useIsMobile.ts";
import { cn } from "../../cn.ts";
import type { RuntimeEvent } from "../../../core/events.ts";

// 纯逻辑（类型/解析/检测）抽到 questionnaireDetect.ts —— 无 React 依赖、可独立单测；
// 此处 re-export 维持既有导入路径（Composer/Sidebar 从本文件导入）
export { parseStructuredQuestionnaireJson, parseQuestionnaireOptions, detectQuestionnaireFromTimeline } from "./questionnaireDetect.ts";
export type { QuestionnaireOption, QuestionnaireStep, ParsedQuestionnaire } from "./questionnaireDetect.ts";
import type { ParsedQuestionnaire, QuestionnaireStep } from "./questionnaireDetect.ts";

interface StepAnswerState {
  readonly selectedKeys: Set<string>;
  readonly customInput: string;
  readonly isInputSelected: boolean;
}

/**
 * 决策输入面板（对齐 MiniMax Code 官方形态）：
 * - 嵌入在底部输入框（Composer）的原位，不霸占中间聊天区的高度
 * - 高度自适应选项行数，紧凑精致
 * - 支持单选题（圆形徽标 rounded-full）与多选题（圆角矩形徽标 rounded-md）
 * - 支持多步骤/多题切换（^ 2/ 共 3 步 v）
 * - 精确层级：最外层卡片无发光，最内层输入框无外框，仅中间输入条呈现主题色边框
 */
export function QuestionnaireComposer({
  questionnaire,
  onDismiss,
}: {
  readonly questionnaire: ParsedQuestionnaire;
  readonly onDismiss: () => void;
}): ReactElement {
  const { isMobile } = useIsMobile();
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const run = useWorkbench((s) => s.run);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const setDraft = useWorkbench((s) => s.setDraft);

  const steps = questionnaire.steps.length > 0 ? questionnaire.steps : [
    {
      id: "step_0",
      question: questionnaire.question,
      header: questionnaire.header,
      description: questionnaire.description,
      options: questionnaire.options,
      isMultiSelect: questionnaire.selectionMode === "multiple",
    },
  ];

  const totalSteps = steps.length;
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  // 记录每个步骤的已选和输入状态
  const [stepAnswers, setStepAnswers] = useState<Record<number, StepAnswerState>>({});
  const [isInputFocused, setIsInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentStep = steps[currentStepIndex] ?? steps[0]!;
  const currentAnswer: StepAnswerState = stepAnswers[currentStepIndex] ?? {
    selectedKeys: new Set<string>(),
    customInput: "",
    isInputSelected: false,
  };

  const isInputActive =
    currentAnswer.isInputSelected ||
    isInputFocused ||
    currentAnswer.customInput.trim() !== "";

  // 激活自定义输入
  const activateCustomInput = () => {
    setStepAnswers((prev) => {
      const prevStep = prev[currentStepIndex];
      return {
        ...prev,
        [currentStepIndex]: {
          // 单选模式下互斥清空已选选项；多选模式下允许同时勾选 ABCD 并输入“其他”
          selectedKeys: currentStep.isMultiSelect
            ? (prevStep?.selectedKeys ?? new Set<string>())
            : new Set<string>(),
          customInput: prevStep?.customInput ?? "",
          isInputSelected: true,
        },
      };
    });
    setIsInputFocused(true);
    inputRef.current?.focus();
  };

  // 清空并取消选择“其他”
  const clearCustomInput = () => {
    setStepAnswers((prev) => ({
      ...prev,
      [currentStepIndex]: {
        selectedKeys: prev[currentStepIndex]?.selectedKeys ?? new Set<string>(),
        customInput: "",
        isInputSelected: false,
      },
    }));
    setIsInputFocused(false);
    if (document.activeElement === inputRef.current) {
      inputRef.current?.blur();
    }
  };

  // 切换（Toggle）自定义输入激活态
  const toggleCustomInput = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isInputActive) {
      clearCustomInput();
    } else {
      activateCustomInput();
    }
  };

  // 失焦时的智能收起：若无内容输入，则熄灭高亮，避免空输入框一直亮着
  const handleInputBlur = () => {
    setIsInputFocused(false);
    if (!currentAnswer.customInput.trim()) {
      setStepAnswers((prev) => ({
        ...prev,
        [currentStepIndex]: {
          selectedKeys: prev[currentStepIndex]?.selectedKeys ?? new Set<string>(),
          customInput: "",
          isInputSelected: false,
        },
      }));
    }
  };

  // 选择选项：单选互斥，多选增减（多选时保留已输入的“其他”内容；若为空则取消亮起）
  const selectOption = (key: string) => {
    const nextKeys = new Set(currentAnswer.selectedKeys);
    if (currentStep.isMultiSelect) {
      if (nextKeys.has(key)) {
        nextKeys.delete(key);
      } else {
        nextKeys.add(key);
      }
    } else {
      nextKeys.clear();
      nextKeys.add(key);
    }

    setStepAnswers((prev) => {
      const prevStep = prev[currentStepIndex];
      const hasCustomText = Boolean(prevStep?.customInput.trim());
      return {
        ...prev,
        [currentStepIndex]: {
          selectedKeys: nextKeys,
          // 单选模式下清空自定义输入；多选模式下：若有输入文本则保留，若无文本则自动取消高亮
          customInput: currentStep.isMultiSelect ? (prevStep?.customInput ?? "") : "",
          isInputSelected: currentStep.isMultiSelect ? hasCustomText : false,
        },
      };
    });
    setIsInputFocused(false);
  };

  const handleInputChange = (val: string) => {
    setStepAnswers((prev) => {
      const prevStep = prev[currentStepIndex];
      return {
        ...prev,
        [currentStepIndex]: {
          // 单选模式下输入清空选项；多选模式下选项与自定义输入共存
          selectedKeys: currentStep.isMultiSelect
            ? (prevStep?.selectedKeys ?? new Set<string>())
            : new Set<string>(),
          customInput: val,
          isInputSelected: Boolean(val.trim()),
        },
      };
    });
  };

  const canGoPrev = currentStepIndex > 0;
  const canGoNext = currentStepIndex < totalSteps - 1;
  const hasCurrentAnswer =
    currentAnswer.selectedKeys.size > 0 || currentAnswer.customInput.trim() !== "";
  // 是否存在任何可提交内容：任一步骤已记录选项或非空自定义输入（含当前步骤）
  const hasAnyAnswer = Object.values(stepAnswers).some(
    (ans) => ans.selectedKeys.size > 0 || ans.customInput.trim() !== "",
  );

  // 键盘快捷键监听：A/B/C/D、方向键选择与 Enter 提交
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName ?? "").toLowerCase();
      const inInput = activeTag === "input" || activeTag === "textarea";

      const keyUpper = e.key.toUpperCase();
      const matched = currentStep.options.find((o) => o.key.toUpperCase() === keyUpper);
      if (matched && !inInput) {
        e.preventDefault();
        selectOption(matched.key);
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (inInput) return;
        e.preventDefault();
        const opts = currentStep.options;
        const keysArr = Array.from(currentAnswer.selectedKeys);
        const lastSelected = keysArr[keysArr.length - 1];
        const currentIdx = opts.findIndex((o) => o.key === lastSelected);
        if (e.key === "ArrowDown") {
          const nextIdx = currentIdx < opts.length - 1 ? currentIdx + 1 : 0;
          selectOption(opts[nextIdx]!.key);
        } else {
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : opts.length - 1;
          selectOption(opts[prevIdx]!.key);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter 仅用于推进或提交，绝不用作跳过：无内容时按键不做任何事
        if (canGoNext && hasCurrentAnswer) {
          setCurrentStepIndex((i) => i + 1);
        } else if (!canGoNext && hasAnyAnswer) {
          handleSubmit();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (isInputActive) {
          clearCustomInput();
        } else {
          handleClose();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentStep, currentAnswer, canGoNext, hasCurrentAnswer, hasAnyAnswer, isInputActive]);

  const handleSubmit = () => {
    const payloads: string[] = [];

    steps.forEach((step, idx) => {
      const ans = stepAnswers[idx];
      if (!ans) return;

      const stepParts: string[] = [];
      if (ans.selectedKeys.size > 0) {
        const selectedOptions = step.options.filter((o) => ans.selectedKeys.has(o.key));
        if (selectedOptions.length > 0) {
          stepParts.push(selectedOptions.map((o) => o.fullText).join("\n"));
        }
      }
      if (ans.customInput.trim()) {
        const customText = ans.customInput.trim();
        stepParts.push(ans.selectedKeys.size > 0 ? `其他: ${customText}` : customText);
      }

      if (stepParts.length > 0) {
        if (totalSteps > 1) {
          payloads.push(`【第 ${idx + 1} 题: ${step.question}】\n` + stepParts.join("\n"));
        } else {
          payloads.push(stepParts.join("\n"));
        }
      }
    });

    let finalPayload = payloads.join("\n\n").trim();
    if (!finalPayload) {
      const parts: string[] = [];
      if (currentAnswer.selectedKeys.size > 0) {
        const selected = currentStep.options.filter((o) => currentAnswer.selectedKeys.has(o.key));
        if (selected.length > 0) {
          parts.push(selected.map((o) => o.fullText).join("\n"));
        }
      }
      if (currentAnswer.customInput.trim()) {
        const customText = currentAnswer.customInput.trim();
        parts.push(currentAnswer.selectedKeys.size > 0 ? `其他: ${customText}` : customText);
      }
      finalPayload = parts.join("\n").trim();
    }

    if (!finalPayload) return;

    if (activeSessionId) {
      useWorkbench.getState().pushUserBubble(activeSessionId, finalPayload);
    }

    setStepAnswers({});
    setIsInputFocused(false);
    onDismiss();
    void run(finalPayload);
  };

  // 跳过：发送字面量"跳过"，保持旧跳过语义（仅按钮触发，Enter 不触发）
  const handleSkip = () => {
    if (activeSessionId) {
      useWorkbench.getState().pushUserBubble(activeSessionId, "跳过");
    }
    setStepAnswers({});
    setIsInputFocused(false);
    onDismiss();
    void run("跳过");
  };

  const handleClose = () => {
    if (currentAnswer.customInput.trim()) {
      setDraft(currentAnswer.customInput.trim());
    }
    onDismiss();
  };

  const handleNextStep = () => {
    if (canGoNext) {
      setCurrentStepIndex((i) => i + 1);
    } else {
      handleSubmit();
    }
  };

  return (
    <div className="shrink-0">
      <div
        style={{ maxWidth: chatColumnWidth }}
        className={cn("mx-auto w-full", isMobile ? "px-3 pb-2 pt-1" : "px-3 pb-4 pt-2 @min-[560px]:px-8")}
      >
        {/* 1. 最外层大容器：常规 border-line，不加任何主题色发光外框（对齐图 2） */}
        <div className="relative rounded-2xl border border-line bg-canvas/98 shadow-2xl backdrop-blur-xl overflow-hidden transition-all duration-200">
          {/* 顶栏：标题、上下题切换（对齐图 1）与关闭按钮 */}
          <div className="flex items-center justify-between border-b border-line-soft/60 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              {(currentStep.header || questionnaire.title) && (
                <div className="text-[10px] font-semibold uppercase tracking-wider text-teal">
                  {currentStep.header || questionnaire.title}
                </div>
              )}
              <h3 className="text-body-sm font-semibold text-ink select-none leading-snug truncate">
                {currentStep.question}
              </h3>
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {/* 多步翻题器（图 1 形式：^ 2/ 共 3 步 v） */}
              {totalSteps > 1 && (
                <div className="flex items-center gap-1 text-xs text-ash bg-line-soft/60 rounded-lg px-2 py-1">
                  <button
                    type="button"
                    disabled={!canGoPrev}
                    onClick={() => setCurrentStepIndex((i) => Math.max(0, i - 1))}
                    className="rounded p-0.5 hover:bg-line hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent transition cursor-pointer"
                    title="上一题"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <span className="font-mono text-[11px] select-none text-graphite px-0.5">
                    {currentStepIndex + 1}/ 共 {totalSteps} 步
                  </span>
                  <button
                    type="button"
                    disabled={!canGoNext}
                    onClick={() => setCurrentStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
                    className="rounded p-0.5 hover:bg-line hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent transition cursor-pointer"
                    title="下一题"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleClose}
                className="rounded-full p-1 text-ash hover:bg-line-soft hover:text-ink transition cursor-pointer"
                title="关闭选单（在输入框自由回复）"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* 选项列表（自适应撑开） */}
          <div className="space-y-1.5 p-3">
            {currentStep.options.map((option) => {
              const isSelected = currentAnswer.selectedKeys.has(option.key);
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => selectOption(option.key)}
                  className={cn(
                    "group flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-all duration-150 cursor-pointer select-none",
                    isSelected
                      ? "border-teal/60 bg-teal-tint text-teal ring-1 ring-teal/30 shadow-sm"
                      : "border-line-soft/80 bg-rail/40 text-ink hover:border-teal/40 hover:bg-line-soft/50",
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {/* 单选为圆形 rounded-full，多选为圆角矩形 rounded-md（对齐图 3 用户要求） */}
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center font-mono text-xs font-bold transition-all",
                        currentStep.isMultiSelect ? "rounded-md" : "rounded-full",
                        isSelected
                          ? "bg-teal text-on-accent shadow-subtle"
                          : "bg-line-soft text-graphite group-hover:bg-line group-hover:text-ink",
                      )}
                    >
                      {option.key}
                    </span>
                    <span className="text-body-sm font-medium leading-relaxed truncate">
                      {option.label}
                    </span>
                  </div>
                  {option.recommended && (
                    <span className="inline-flex items-center rounded-full bg-line-soft px-2 py-0.5 text-[10px] font-medium text-graphite shrink-0">
                      推荐
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 底部输入框与提交/下一题/跳过按钮 */}
          <div className="border-t border-line-soft/60 bg-rail/30 px-3 py-2">
            <div className="flex items-center gap-2">
              {/* 2. 中间层输入框条：仅此层在激活时呈现主题色边框（对齐图 2） */}
              <div
                onMouseDown={(e) => {
                  if (e.target !== inputRef.current) {
                    activateCustomInput();
                  }
                }}
                className={cn(
                  "relative flex flex-1 items-center rounded-xl border px-3 py-1.5 transition-all duration-150 cursor-text",
                  isInputActive
                    ? "border-teal/60 bg-teal-tint text-teal ring-1 ring-teal/30 shadow-sm"
                    : "border-line-soft/80 bg-rail/40 hover:border-teal/40 hover:bg-line-soft/50",
                )}
              >
                {/* 笔图标：点击支持 Toggle 激活 / 取消 */}
                <button
                  type="button"
                  onClick={toggleCustomInput}
                  className="mr-2 shrink-0 p-0.5 rounded text-ash hover:text-ink transition cursor-pointer"
                  title={isInputActive ? "点击取消选择其他" : "选择其他并输入"}
                >
                  <PenLine
                    size={14}
                    className={cn("transition-colors", isInputActive ? "text-teal" : "text-ash")}
                  />
                </button>

                {/* 3. 最里层 input：绝对无任何外框与阴影，杜绝内外发光重叠（对齐图 2） */}
                <input
                  ref={inputRef}
                  type="text"
                  value={currentAnswer.customInput}
                  onFocus={activateCustomInput}
                  onBlur={handleInputBlur}
                  onChange={(e) => handleInputChange(e.target.value)}
                  placeholder="在这里输入..."
                  className="w-full bg-transparent text-body-sm text-ink outline-none border-none ring-0 shadow-none focus:outline-none focus:border-none focus:ring-0 focus:shadow-none placeholder:text-ash/70"
                  style={{ outline: "none", boxShadow: "none", border: "none" }}
                />

                {/* 取消选择其他 / 清空按钮 */}
                {isInputActive && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      clearCustomInput();
                    }}
                    className="ml-1 p-0.5 rounded-full text-ash hover:text-ink hover:bg-line-soft transition cursor-pointer shrink-0"
                    title="取消选择其他 / 清空输入"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              {/* 跳过：始终可用，仅按钮触发（发送"跳过"） */}
              <button
                type="button"
                onClick={handleSkip}
                className="rounded-xl px-4 py-1.5 text-xs font-semibold bg-line-soft text-ash hover:bg-line hover:text-ink transition cursor-pointer select-none shrink-0"
              >
                跳过
              </button>
              {canGoNext && hasCurrentAnswer ? (
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="rounded-xl px-4 py-1.5 text-xs font-semibold bg-teal text-on-accent shadow-sm hover:brightness-110 active:scale-95 transition cursor-pointer select-none shrink-0"
                >
                  下一题
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!hasAnyAnswer}
                  className={cn(
                    "rounded-xl px-4 py-1.5 text-xs font-semibold transition select-none shrink-0",
                    hasAnyAnswer
                      ? "bg-teal text-on-accent shadow-sm hover:brightness-110 active:scale-95 cursor-pointer"
                      : "bg-line-soft text-ash cursor-not-allowed",
                  )}
                >
                  提交
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

