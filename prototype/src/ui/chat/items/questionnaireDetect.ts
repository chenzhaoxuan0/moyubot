/** 问卷/决策卡的纯逻辑层（类型 + 解析器 + 时间线检测）——无 React 依赖，可独立测试 */
import type { RuntimeEvent } from "../../../core/events.ts";

export interface QuestionnaireOption {
  readonly key: string;
  readonly label: string;
  readonly fullText: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface QuestionnaireStep {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly description?: string;
  readonly options: readonly QuestionnaireOption[];
  readonly isMultiSelect: boolean;
}

export interface ParsedQuestionnaire {
  readonly steps: readonly QuestionnaireStep[];
  readonly title?: string;
  readonly rawText: string;
  // 兼容单步快捷属性
  readonly question: string;
  readonly header?: string;
  readonly description?: string;
  readonly options: readonly QuestionnaireOption[];
  readonly selectionMode?: "single" | "multiple";
}

function checkIsMultiSelect(
  raw: Record<string, unknown> | null | undefined,
  questionText = "",
  headerText = "",
): boolean {
  if (
    raw?.is_multi_select === true ||
    raw?.isMultiSelect === true ||
    raw?.multiSelect === true ||
    raw?.multi_select === true ||
    raw?.multiple === true ||
    raw?.allow_multiple === true ||
    raw?.allowMultipleSelections === true ||
    raw?.selectionMode === "multiple" ||
    raw?.type === "multiselect"
  ) {
    return true;
  }
  const combined = `${questionText} ${headerText}`;
  return /(多选|可多选|哪些|多选题|select all|multiple choice)/i.test(combined);
}

/**
 * 结构化问卷 / 决策卡 JSON 解析（全面支持多题 steps/questions 与多选题）
 */
export function parseStructuredQuestionnaireJson(raw: unknown): ParsedQuestionnaire | null {
  let obj: Record<string, unknown> | null = raw as Record<string, unknown> | null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // 提取 markdown 中的 ```json 代码块
      const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        try {
          obj = JSON.parse(codeBlockMatch[1]!);
        } catch {
          obj = null;
        }
      } else {
        // 提取被大括号包裹的 questionnaire 对象
        const jsonMatch = trimmed.match(/\{[\s\S]*"mode"\s*:\s*"questionnaire"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            obj = JSON.parse(jsonMatch[0]);
          } catch {
            obj = null;
          }
        }
      }
    }
  }

  if (!obj || typeof obj !== "object") return null;

  // 深入一层解包常见包装器 arguments / input / params
  if (obj.arguments && typeof obj.arguments === "object") obj = obj.arguments as Record<string, unknown>;
  else if (obj.input && typeof obj.input === "object") obj = obj.input as Record<string, unknown>;
  else if (obj.params && typeof obj.params === "object") obj = obj.params as Record<string, unknown>;

  const isQuestionnaire =
    obj.mode === "questionnaire" ||
    (Array.isArray(obj.steps) && obj.steps.length > 0 && (Array.isArray(obj.steps[0]?.options) || Array.isArray(obj.steps[0]?.choices) || obj.steps[0]?.question)) ||
    // hermes clarify 用 choices 承载选项（源码 tools/clarify_tool.py）
    (Array.isArray(obj.questions) && obj.questions.length > 0 && (Array.isArray(obj.questions[0]?.options) || Array.isArray(obj.questions[0]?.choices)));

  if (!isQuestionnaire) return null;

  let rawStepsList: Record<string, unknown>[] = [];
  if (Array.isArray(obj.steps) && obj.steps.length > 0) {
    rawStepsList = obj.steps;
  } else if (Array.isArray(obj.questions) && obj.questions.length > 0) {
    rawStepsList = obj.questions;
  } else {
    rawStepsList = [obj];
  }

  const parsedSteps: QuestionnaireStep[] = [];
  for (let idx = 0; idx < rawStepsList.length; idx++) {
    const rawStep = rawStepsList[idx];
    if (!rawStep || typeof rawStep !== "object") continue;

    const question = String(rawStep.question || rawStep.header || rawStep.title || obj.title || `问题 ${idx + 1}`);
    const header =
      rawStep.header && rawStep.header !== question
        ? String(rawStep.header)
        : idx === 0 && obj.title && obj.title !== question
          ? String(obj.title)
          : undefined;
    const description = rawStep.description ? String(rawStep.description) : undefined;
    const rawOptions: unknown[] = Array.isArray(rawStep.options) ? rawStep.options : Array.isArray(rawStep.choices) ? rawStep.choices : [];

    if (rawOptions.length < 2) continue;

    const options: QuestionnaireOption[] = rawOptions.map((opt, oIdx) => {
      if (typeof opt === "string") {
        const key = String.fromCharCode(65 + oIdx);
        const label = opt.trim();
        const recommended = label.includes("推荐") || label.includes("(推荐)") || label.includes("（推荐）");
        const cleanLabel = label.replace(/[（(]推荐[）)]/g, "").trim();
        const fullText = /^[A-Za-z0-9]\s*[—·\.:、\-]/.test(cleanLabel) ? cleanLabel : `${key} · ${cleanLabel}`;
        return { key, label: cleanLabel, fullText, recommended };
      }
      const rec = opt as Record<string, unknown>;
      const rawId = rec.id !== undefined ? String(rec.id).trim() : String.fromCharCode(65 + oIdx);
      const key = rawId.length === 1 ? rawId.toUpperCase() : String.fromCharCode(65 + oIdx);
      const label = String(rec.label || rec.text || rec.title || rec.display || rec.value || `选项 ${key}`);
      const desc = rec.description ? String(rec.description) : undefined;
      const recommended = rec.recommended === true || label.includes("推荐");
      const cleanLabel = label.replace(/[（(]推荐[）)]/g, "").trim();
      const fullText = /^[A-Za-z0-9]\s*[—·\.:、\-]/.test(label) ? label : `${key} · ${cleanLabel}`;

      return {
        key,
        label: cleanLabel,
        description: desc,
        recommended,
        fullText,
      };
    });

    const isMultiSelect = checkIsMultiSelect(rawStep, question, header);

    parsedSteps.push({
      id: String(rawStep.id || idx),
      question,
      header,
      description,
      options,
      isMultiSelect,
    });
  }

  if (parsedSteps.length === 0) return null;

  const firstStep = parsedSteps[0]!;
  return {
    steps: parsedSteps,
    title: obj.title ? String(obj.title) : undefined,
    rawText: typeof raw === "string" ? raw : JSON.stringify(raw),
    question: firstStep.question,
    header: firstStep.header,
    description: firstStep.description,
    options: firstStep.options,
    selectionMode: firstStep.isMultiSelect ? "multiple" : "single",
  };
}

/**
 * 启发式提取文本中的问卷/选项卡内容：
 * 0. 优先尝试解析结构化 mode: "questionnaire" JSON
 * 1. 行内管道分隔：A · xxx | B · xxx | C · xxx
 * 2. 换行字母列表：A. xxx \n B. xxx \n C. xxx
 * 3. 换行数字列表：1. xxx \n 2. xxx (当数量 >= 2 时)
 */
export function parseQuestionnaireOptions(text: string): ParsedQuestionnaire | null {
  if (!text || typeof text !== "string") return null;

  // 0. 优先识别真实 questionnaire JSON
  const structured = parseStructuredQuestionnaireJson(text);
  if (structured) return structured;

  // 1. 尝试行内管道分隔
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
        const isMulti = checkIsMultiSelect(null, question);
        const step: QuestionnaireStep = {
          id: "step_0",
          question,
          options,
          isMultiSelect: isMulti,
        };
        return {
          steps: [step],
          question,
          options,
          rawText: line,
          selectionMode: isMulti ? "multiple" : "single",
        };
      }
    }
  }

  // 2. 换行列表匹配（如 A. xxx 或 1. xxx）
  const multilineOptions: QuestionnaireOption[] = [];
  const listRegex = /^(?:[#*>\s-]*)\s*([A-Da-d0-9])\s*[·\.:、\-]\s*(.+)$/;
  let foundQuestion = "请选择一项，我会按你的选择直接执行。";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const match = line.match(listRegex);
    if (match) {
      const key = match[1]!.toUpperCase();
      const content = match[2]!.trim();
      const recommended = content.includes("推荐") || content.includes("（推荐）") || content.includes("(推荐)");
      const cleanLabel = content.replace(/[（(]推荐[）)]/g, "").trim();
      multilineOptions.push({
        key,
        label: `${key} · ${cleanLabel}`,
        fullText: `${key} · ${content}`,
        recommended,
      });
    } else if (
      multilineOptions.length === 0 &&
      line.length < 80 &&
      (line.includes("选") || line.includes("？") || line.includes("?"))
    ) {
      foundQuestion = line.replace(/^#+\s*/, "").replace(/[：:]$/, "。");
    }
  }

  if (multilineOptions.length >= 2 && multilineOptions.length <= 8) {
    const isMulti = checkIsMultiSelect(null, foundQuestion);
    const step: QuestionnaireStep = {
      id: "step_0",
      question: foundQuestion,
      options: multilineOptions,
      isMultiSelect: isMulti,
    };
    return {
      steps: [step],
      question: foundQuestion,
      options: multilineOptions,
      rawText: multilineOptions.map((o) => o.label).join("\n"),
      selectionMode: isMulti ? "multiple" : "single",
    };
  }

  return null;
}

/**
 * 从当前时间线中精准反查最后一次未响应的问卷/决策卡
 */
export function detectQuestionnaireFromTimeline(
  timeline: readonly { id: number | string; event: RuntimeEvent; at: number }[],
): ParsedQuestionnaire | null {
  if (!timeline || timeline.length === 0) return null;

  // —— 各家执行器的问卷协议（源码调研 2026-10，详见仓库对照）：
  // · mcode ask_user：立即返回，待决 = result「is waiting for the local user」，
  //   已答 = result 注入 <questionnaire-response>（不走用户消息）
  // · dsh ask_user_question（timed）：超时返回 {"pending":true,"callId":...}，
  //   答案晚到（user-question-reply 用户消息）
  // · 其余（claude/zcode/kimi AskUserQuestion、grok ask_user_question、
  //   codex request_user_input、opencode question、hermes clarify、openclaw
  //   ask_user、pi question/questionnaire）：挂起式，存储上「有 call 无 result」，
  //   已答 result 文案含「User has answered / User selected / "answers" /
  //   "status": "answered」等；grok 取消时合成「cancelled」文案
  // 另有存量口径：旧投影对每个条目落 started+completed 且 output 恒为空串——
  // 空 output 的待决只能靠「其后没有任何消息」判定。
  const completedOutputs = new Map<string, string>();
  for (const t of timeline) {
    if (t.event.type === "tool.completed") completedOutputs.set(String(t.event.callId), String(t.event.output ?? ""));
  }
  // 尾部消息下标（用户输入/助手输出；工具发起/completed 不算——挂起式执行器
  // 的 pending 问题尾部就是工具，旧投影的 waiting-result 也是工具形态）
  let lastMessageIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const et = timeline[i]!.event.type;
    if (et === "message.delta" || et === "message.completed") {
      lastMessageIdx = i;
      break;
    }
  }
  /** 这个问卷 callId 是否仍在待决（协议口径见块注释） */
  const isPending = (callId: string, startedIdx: number): boolean => {
    const out = completedOutputs.get(callId);
    if (out === undefined) return true;
    // 待决正向标记：mcode waiting 文案 / dsh timed 的 pending JSON
    if (out.includes("is waiting for the local user")) return true;
    if (out.includes('"pending":true') || out.includes('"pending": true')) return true;
    // 已答/失效负向标记：mcode 注入答案与压制文案，各家 answered 文案与结构化答案
    if (
      out.includes("<questionnaire-response>") ||
      out.includes("Question not asked") ||
      out.includes("user has answered") ||
      out.includes("User has answered") ||
      out.includes("User selected") ||
      out.includes("user selected") ||
      out.includes('"status": "answered"') ||
      out.includes('"status":"answered"') ||
      out.includes('"answers"') ||
      out.includes("cancelled")
    ) return false;
    if (out !== "") return false;
    // 空结果（旧投影形态，output 恒空）：其后没有再出现任何消息即待决——
    // 旧投影把 waiting-result 也落成了 started（工具形态不算消息），所以
    // 判「消息」而非「尾部活动」
    return startedIdx > lastMessageIdx;
  };

  let assistantMessageId: string | null = null;
  let assistantCompletedText: string | null = null;
  let toolAskQuestion: ParsedQuestionnaire | null = null;

  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (!item) continue;
    const ev = item.event;

    // 如果后方已存在用户回复，说明当前问卷已作答或过时，不再展示
    if (ev.type === "message.delta" && ev.role === "user") {
      if (!toolAskQuestion && !assistantCompletedText && !assistantMessageId) {
        return null;
      }
    }

    // 1. 优先提取结构化工具调用（ask_user / questionnaire / ask_question / askUserQuestion）
    if (ev.type === "tool.started" && !toolAskQuestion) {
      const pending = isPending(String(ev.callId), i);
      const parsedTool = parseStructuredQuestionnaireJson(ev.input);
      if (parsedTool) {
        // 倒序扫到的第一张问卷就是最后一张：它非待决 → 整个会话没有待决问卷
        if (!pending) return null;
        toolAskQuestion = {
          ...parsedTool,
          rawText: `tool_${ev.callId}`,
        };
        break;
      }

      const tn = ev.toolName.toLowerCase().replace(/[\s_\-]+/g, "");
      if (tn === "exitplanmode") {
        if (!pending) return null;
        let inp: unknown = ev.input;
        if (typeof inp === "string") {
          try { inp = JSON.parse(inp); } catch { /* ignore */ }
        }
        const inpObj = inp as Record<string, unknown> | null | undefined;
        const planText: unknown =
          typeof inp === "string"
            ? inp
            : (inpObj?.plan ?? inpObj?.summary ?? inpObj?.description ?? "模型已起草实施方案，请审阅批准。");
        const exitPlanStep: QuestionnaireStep = {
          id: "exit_plan",
          header: "📋 计划审批 (Plan Approval)",
          question: `方案规划已就绪，是否批准退出计划模式并开始实施？\n${typeof planText === "string" ? planText.slice(0, 200) : ""}`,
          options: [
            {
              key: "A",
              label: "A · 批准并开始实施代码变更 (Approve & Implement)",
              fullText: "批准实施计划。请退出只读计划模式，开始按步骤修改代码并执行测试。",
              recommended: true,
            },
            {
              key: "B",
              label: "B · 退出计划模式 (Exit Plan Mode)",
              fullText: "已审阅计划，请退出计划模式。",
            },
          ],
          isMultiSelect: false,
        };
        toolAskQuestion = {
          steps: [exitPlanStep],
          header: exitPlanStep.header,
          question: exitPlanStep.question,
          options: exitPlanStep.options,
          rawText: `tool_${ev.callId}`,
          selectionMode: "single",
        };
        break;
      }

      if (
        tn === "askuser" || tn === "askquestion" || tn === "askuserquestion" || tn === "questionnaire" ||
        // 各家执行器的同义工具（源码调研 2026-10）：opencode/pi 的 question、
        // hermes 的 clarify、codex 的 request_user_input（含 async 变体）
        tn === "question" || tn === "clarify" || tn === "requestuserinput" || tn === "requestuserinputasync"
      ) {
        if (!pending) return null;
        let inp: unknown = ev.input;
        if (typeof inp === "string") {
          try {
            inp = JSON.parse(inp);
          } catch {
            /* ignore */
          }
        }
        if (inp && typeof inp === "object") {
          const parsedInp = parseStructuredQuestionnaireJson(inp);
          if (parsedInp) {
            toolAskQuestion = {
              ...parsedInp,
              rawText: `tool_${ev.callId}`,
            };
            break;
          }
        }
      }
    }

    // 2. 收集最后一条 assistant 消息（作为纯文本兜底识别）
    if (ev.type === "message.completed" && !assistantCompletedText) {
      assistantCompletedText = ev.text;
    }
    if (ev.type === "message.delta" && ev.role === "assistant" && !assistantMessageId) {
      assistantMessageId = ev.messageId;
    }
  }

  if (toolAskQuestion) return toolAskQuestion;
  if (!assistantMessageId && !assistantCompletedText) return null;

  // 文本兜底的时效判定：最后一条助手消息之后若还有任何工具/用户活动（问卷的
  // 结果条目、新一轮输入……），这段「像选项的编号文本」早已被回应过——
  // 历史会话的最终回复常带编号列表，不能凭形状就弹成选项卡
  let lastActivityType = "";
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i]!.event;
    if (
      ev.type === "message.completed" ||
      ev.type === "tool.started" ||
      ev.type === "tool.completed" ||
      (ev.type === "message.delta" && ev.role === "user")
    ) {
      lastActivityType = ev.type === "message.delta" ? "user" : ev.type;
      break;
    }
  }
  if (lastActivityType !== "message.completed") return null;

  // 拼装完整文本并尝试文本识别
  let fullText = assistantCompletedText ?? "";
  if (!fullText && assistantMessageId) {
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
}
