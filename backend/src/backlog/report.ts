/**
 * 执行器 Report 协议（docs/33 §2.1）—— 结算时从会话末条 assistant 消息解析
 * 结构化自报，对齐 dsh-superagent 原型 orchestrator_report 工具的 schema：
 *
 *   {"report":{"state":"ready|blocked|failed|dropped|handback","summary":"…","human_action":null|"给用户的一个具体问题"}}
 *
 * moyubot 走**注入约定**而非工具注入（13 家执行器零适配）：dispatch 把约定拼在
 * prompt 尾部，执行器在末条回复里以 JSON 代码块输出，结算时解析。解析失败 =
 * 没有 report，按现状路径结算（不惩罚不重试）。
 */

import type { RunOutcome } from "../../../prototype/src/core/backlog.ts";

/**
 * report 终态枚举（五个）：docs/33 §2.1 原设计的 progress 瞬态未启用（report 只在
 * 结算时解析一次，没有过程态）；limit / refusal 不在自报里 —— 无 report 时由
 * inferOutcome 从 stopReason 推断，与这五值同落 run 行的 outcome 列（RunOutcome）。
 */
export type ReportState = "ready" | "blocked" | "failed" | "dropped" | "handback";

export interface ExecutionReport {
  readonly state: ReportState;
  readonly summary: string;
  /** blocked 时给人的一个具体问题（attention 的数据源） */
  readonly humanAction: string | null;
}

/** 拼在任务 prompt 尾部的输出约定（appendPrompt 之后） */
export const REPORT_PROMPT_SUFFIX = [
  "",
  "【完成时必须自报】本轮结束时，在你的最后一条回复末尾单独输出一个 JSON 代码块（```json 包裹），格式：",
  '{"report":{"state":"...","summary":"...","human_action":null}}',
  'state 取值：ready=已完成待验收；blocked=需要用户回答 human_action 里的问题才能继续；failed=做不成（summary 说原因）；dropped=发现这事无需处理；handback=这个请求超出本任务范围、应交回重新分类。',
  "summary 一句话说清结果或产出位置（≤120 字）。human_action 只有 blocked 时非空：写给用户的一个具体问题。",
  "没有这个代码块，系统只能按「进程退出」猜测你的结果。",
].join("\n");

/** 从一段回复文本里解析末个 report 块；无/坏 JSON → null（按无 report 结算） */
export function parseExecutionReport(text: string): ExecutionReport | null {
  if (text === "") return null;
  // 1. 优先找 ```json 代码块（从后往前——末条回复可能有多个块）
  const blocks = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)];
  for (const m of blocks.reverse()) {
    const r = tryParse(m[1] ?? "");
    if (r !== null) return r;
  }
  // 2. 兜底：行内 {"report":…}（有的执行器不吃代码块语法）
  return tryParse(text);
}

function tryParse(chunk: string): ExecutionReport | null {
  const idx = chunk.lastIndexOf('{"report"');
  if (idx === -1) return null;
  try {
    const v = JSON.parse(chunk.slice(idx)) as { report?: { state?: unknown; summary?: unknown; human_action?: unknown } };
    const r = v.report;
    if (r === null || typeof r !== "object") return null;
    const state = r.state;
    if (state !== "ready" && state !== "blocked" && state !== "failed" && state !== "dropped" && state !== "handback") return null;
    const summary = typeof r.summary === "string" ? r.summary.trim().slice(0, 200) : "";
    const humanAction = typeof r.human_action === "string" && r.human_action.trim() !== "" ? r.human_action.trim().slice(0, 1000) : null;
    return { state, summary, humanAction };
  } catch {
    return null;
  }
}

/**
 * stopReason 保守推断（docs/33 §2.1：limit/refusal 不再混入 failed）——
 * 无 report 时从结算 detail 文本里识别两类预算型终态，其余维持 done/failed 二分。
 */
export function inferOutcome(status: "done" | "failed", detail: string | null): RunOutcome {
  if (status === "done") return "ready";
  const d = (detail ?? "").toLowerCase();
  if (d.includes("max_turns") || d.includes("max turns") || d.includes("max_budget") || d.includes("max budget") || d.includes("context window") || d.includes("contextwindow")) {
    return "limit";
  }
  if (d.includes("refus")) return "refusal";
  return "failed";
}
