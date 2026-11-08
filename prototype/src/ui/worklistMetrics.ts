import type { Automation } from "../core/automation.ts";
import { formatAbsoluteHuman } from "../core/automation.ts";
import type { BacklogConfig, BacklogItem, BacklogStateSnapshot, QuotaHeadroom } from "../core/backlog.ts";
import { isFailedRun } from "../core/backlog.ts";

/**
 * 时间轴工作区的共享度量（StatusBand 与 TimelineColumn 共用一份算术，
 * 不长两棵）。全部纯函数：输入来自 useBacklog / useWorkbench 的快照。
 */

/** 与引擎 AUTOPILOT_FAILURE_BACKOFF_MS 同口径：最近一次失败 10 分钟内退避 */
export const FAILURE_BACKOFF_MS = 10 * 60_000;

/** 状态过滤单源（TimelineColumn 的读档校验与 StatusBand 的 chips 都从这份派生）：
 *  六个可扫视的机器状态（done 不进带子——完成走「今日完成」计数） */
export const STATUS_FILTERS = ["executing", "awaiting_review", "awaiting_confirm", "blocked", "backoff", "sleeping"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export type SortMode = "time" | "queue";

export function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 今日完成：done 且最近一次运行在今天收口（比 updatedAt 准 —— 编辑也会动它） */
export function isTodayDone(i: BacklogItem, today0 = startOfToday()): boolean {
  return i.status === "done" && (i.lastRun?.finishedAt ?? 0) >= today0;
}

/** 失败退避中：ready + auto 且最近一次失败（isFailedRun 口径，含自报失败但进程
 *  done 的一路 —— 与引擎退避同源，否则前端带子会和台账对不上）在退避窗内 */
export function inBackoff(i: BacklogItem, now = Date.now()): boolean {
  return i.status === "ready" && i.auto && i.lastRun !== null && isFailedRun(i.lastRun.status, i.lastRun.outcome) && now - i.lastRun.startedAt < FAILURE_BACKOFF_MS;
}

export interface StatusCounts {
  executing: number;
  awaiting_review: number;
  awaiting_confirm: number;
  /** 受阻（docs/33 §2 结构化问人）：要人回答的，排在待确认同级 */
  blocked: number;
  backoff: number;
  sleeping: number;
}

export function statusCounts(items: readonly BacklogItem[]): StatusCounts {
  const c = { executing: 0, awaiting_review: 0, awaiting_confirm: 0, blocked: 0, backoff: 0, sleeping: 0 } satisfies StatusCounts;
  for (const i of items) {
    if (i.status === "executing") c.executing += 1;
    else if (i.status === "awaiting_review") c.awaiting_review += 1;
    else if (i.status === "awaiting_confirm") c.awaiting_confirm += 1;
    else if (i.status === "blocked") c.blocked += 1;
    else if (i.status === "sleeping") c.sleeping += 1;
    else if (inBackoff(i)) c.backoff += 1;
  }
  return c;
}

export function todayDoneCountOf(items: readonly BacklogItem[]): number {
  const today0 = startOfToday();
  return items.filter((i) => isTodayDone(i, today0)).length;
}

/** 队列头：autopilot 的挑法（items 已按 sortPos 序，done 沉底）——展示对齐引擎 */
export function queueHeadOf(items: readonly BacklogItem[]): BacklogItem | null {
  return items.find((i) => i.status === "ready" && i.auto && !inBackoff(i)) ?? null;
}

export function nextAutomationAtOf(automations: readonly Automation[]): number | null {
  const nexts = automations.filter((a) => a.enabled && typeof a.nextRunAt === "number").map((a) => a.nextRunAt as number);
  return nexts.length > 0 ? Math.min(...nexts) : null;
}

/**
 * 队列头为什么还没跑 —— 全部从快照现有字段推导（引擎的判定口径），零新增后端。
 * 返回 null = 说不出话（快照还没到），宁可不说也不编。余量轴不承诺 ETA：
 * 条件可验证，预测是撒谎（docs/30 双轴对照）。
 */
export function queuePrecondition(
  state: BacklogStateSnapshot | null,
  config: BacklogConfig | null,
  quotas: readonly QuotaHeadroom[],
  autopilotOn: boolean,
  allBackoff: boolean,
): string | null {
  if (!autopilotOn) return "闲时执行总开关已关 —— 队列静默（手动执行不受影响）";
  if (allBackoff) return "排队任务全部在失败退避中（10 分钟窗口）";
  if (state === null) return null;
  if (state.forceBusy) return "强制忙碌中 —— 不派发";
  if (state.phase === "beating") return "心跳评估中 —— autopilot 让路";
  if (state.phase === "awaiting_confirm") return "有提议挂起等确认";
  if (state.phase === "executing" || state.phase === "awaiting_review") return state.reason;
  if (state.phase === "busy") return state.reason;
  // idle：引擎没派只可能是余量门（或刚好在两拍之间）
  if (state.lastBeatOutcome === "autopilot:no-headroom") {
    const floor = config?.autopilot.headroomFloorPercent ?? 10;
    const resets = quotas.filter((q) => q.resetsAt !== null).map((q) => q.resetsAt as number);
    const nextReset = resets.length > 0 ? Math.min(...resets) : null;
    return `余量低于地板（${floor}%）${nextReset !== null ? ` · 最近重置 ${formatAbsoluteHuman(nextReset)}` : ""}`;
  }
  return "空闲 —— 等下一拍（20 秒内）";
}
