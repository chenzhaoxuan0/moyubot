/**
 * 主管日报（docs/30）—— 只报「从未经过你手的」自动活动，无活动即沉默。
 *
 * 口径（多轮讨论定稿）：
 * - 手动起的事用户自己知道；心跳提议→用户确认的，确认那一刻也知道了 ——
 *   真正的黑箱只有无人值守的部分：backlog_runs trigger=autopilot +
 *   automation_runs trigger=schedule（含 quota_resume 续跑与提醒送达）。
 * - 「该跑而没跑」比「跑了什么」更需要人出手：misfire 跳过、重试多次被停用、
 *   autopilot 失败退避。
 * - 三节全空 = 整体沉默（不发 IM、不写通知行）—— 报告的噪音比沉默更伤，
 *   每天准点一条「今日无自动活动」会让主管变成垃圾邮件源。
 * - 每日一次（本地时区，配置时刻），幂等键先落盘再干活（对齐 maybeConsolidate）。
 *
 * 报告构造是纯函数（buildSupervisorReport / renderSupervisorReport）——
 * check:supervisor 直测；watcher 只管「到点没到点」。
 */

import type { Store } from "../store/db.ts";
import { isFailedRun } from "../../../prototype/src/core/backlog.ts";
import { log } from "../log.ts";

const TICK_MS = 60_000;
const CONFIG_KEY = "supervisor.config";
const LAST_DAY_KEY = "supervisor.lastDay";
const LAST_AT_KEY = "supervisor.lastAt";
/** 窗口固定回看 24h：与「每日一发」对齐，且不依赖上一发的确切时刻（错过几天的
 *  情况下窗口不会膨胀成黑洞 —— 上一发是三天前，报的仍是最近一天） */
const WINDOW_MS = 24 * 60 * 60_000;

export interface SupervisorConfig {
  readonly enabled: boolean;
  /** 每日几分发（分钟数，21*60 = 21:00） */
  readonly atMinutes: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = { enabled: true, atMinutes: 21 * 60 };

function clampMinutes(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SUPERVISOR_CONFIG.atMinutes;
  return Math.min(24 * 60, Math.max(0, n));
}

export function getSupervisorConfig(store: Store): SupervisorConfig {
  const raw = store.kvGet(CONFIG_KEY);
  if (raw === undefined) return DEFAULT_SUPERVISOR_CONFIG;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: r["enabled"] !== false,
      atMinutes: clampMinutes(r["atMinutes"]),
    };
  } catch {
    return DEFAULT_SUPERVISOR_CONFIG;
  }
}

export function setSupervisorConfig(store: Store, patch: unknown): SupervisorConfig {
  const prev = getSupervisorConfig(store);
  const p = (patch ?? {}) as Record<string, unknown>;
  const next: SupervisorConfig = {
    enabled: typeof p["enabled"] === "boolean" ? p["enabled"] : prev.enabled,
    atMinutes: p["atMinutes"] !== undefined ? clampMinutes(p["atMinutes"]) : prev.atMinutes,
  };
  store.kvSet(CONFIG_KEY, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------
// 报告构造（纯函数）
// ---------------------------------------------------------------------------

export interface SupervisorReport {
  readonly empty: boolean;
  readonly summary: { done: number; failed: number; skipped: number; stopped: number; blocked: number; dropped: number; handback: number };
  /** ① 自动执行（一行一条，docs/33 §2.2：带 run.summary 一句话结果） */
  readonly executed: readonly string[];
  /** ② 该跑而没跑（一行一条） */
  readonly missed: readonly string[];
  /** ③ 待回答（blocked，docs/33 §2：结构化问人后没人答的 —— 日报里追讨） */
  readonly blocked: readonly string[];
  /** 报告窗口 */
  readonly windowStart: number;
  readonly windowEnd: number;
}

function fmtHM(t: number): string {
  const d = new Date(t);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function clip(text: string | null | undefined, max = 80): string {
  const t = (text ?? "").replaceAll(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

const fmtDate = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function buildSupervisorReport(store: Store, windowStart: number, now = Date.now()): SupervisorReport {
  const executed: string[] = [];
  const missed: string[] = [];
  const blocked: string[] = [];
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let stopped = 0;
  let dropped = 0;
  let handback = 0;

  // ①a autopilot 待办运行（闲时托管 —— 未经过用户手的执行）。
  // 结果事实源（docs/33 §2.2）：outcome/summary 是执行器 report 的自报 ——
  // 例行完成只进日报（L1 静默）在这里补上「跑出了什么」；dropped 静默终态
  // 不计 done 也不打扰，只进 summary 计数。
  for (const r of store.listBacklogRunsSince(windowStart)) {
    const item = store.getBacklogItem(r.itemId);
    const title = item?.title ?? `已删任务 #${r.itemId}`;
    const oneLine = r.summary !== null && r.summary !== "" ? ` — ${clip(r.summary, 90)}` : "";
    if (r.status === "done" && (r.outcome === null || r.outcome === "ready")) {
      done += 1;
      executed.push(`${fmtHM(r.startedAt)} ✓ ${title}${oneLine}（${item?.unitName ?? "—"} / ${r.runtimeId === "" ? "—" : r.runtimeId} · 闲时托管）`);
    } else if (r.status === "done" && r.outcome === "dropped") {
      dropped += 1;
      executed.push(`${fmtHM(r.startedAt)} ⊘ ${title} — 执行器判定无需处理${oneLine}`);
    } else if (r.status === "done" && r.outcome === "blocked") {
      // 受阻已发过 L1；日报里若还挂着（没人答）在 ③ 追讨，这里不重复唱
      blocked.push(`「${title}」${r.summary !== null && r.summary !== "" ? ` — ${clip(r.summary, 90)}` : ""}`);
    } else if (r.status === "done" && isFailedRun(r.status, r.outcome)) {
      // 自报失败但进程正常结束（done + failed/limit/refusal）：同算失败 ——
      // 引擎退避 / retryOf 都吃 outcome（isFailedRun 单源），日报漏报会与台账对不上
      failed += 1;
      executed.push(`${fmtHM(r.startedAt)} ✗ ${title} — ${clip(r.summary ?? r.detail)}（执行器自报${r.outcome === "limit" ? "预算/轮数耗尽" : r.outcome === "refusal" ? "拒绝执行" : "失败"}，已回就绪，退避后闲时重试）`);
    } else if (r.status === "done" && r.outcome === "handback") {
      handback += 1;
      executed.push(`${fmtHM(r.startedAt)} ↩ ${title} — 执行器判定超出任务范围，已交回（摘除自动执行）${oneLine}`);
    } else if (r.status === "skipped") {
      skipped += 1;
      missed.push(`${fmtHM(r.startedAt)} ⊘ 「${title}」precheck 条件未过被跳过（${clip(r.detail, 60)}）`);
    } else if (r.status === "failed") {
      failed += 1;
      executed.push(`${fmtHM(r.startedAt)} ✗ ${title} — ${clip(r.summary ?? r.detail)}（${r.outcome === "limit" ? "预算/轮数耗尽" : r.outcome === "refusal" ? "执行器拒绝" : r.outcome === "ready" ? "report 判 ready 但进程异常退出" : "已回就绪，退避后闲时重试"}）`);
    }
    // running 里的不在日报里唱票 —— 没收口的活儿收口了再报
  }

  // ③ 待回答（docs/33 §2 blocked）：窗口结束时仍处于 blocked 的任务 ——
  // 它们不在 ①（run 已收口）也不在 ②（不是没跑），单独追讨
  for (const item of store.listBacklogItems()) {
    if (item.status !== "blocked") continue;
    if (!blocked.some((b) => b.includes(`「${item.title}」`))) {
      blocked.push(`「${item.title}」${item.attention !== null ? ` —— ${clip(item.attention, 90)}` : "（无问题描述，请回工作台看会话）"}`);
    }
  }

  // ①b 钟控自动化运行（含用量续跑 / 提醒送达，skipped 归 ②）
  for (const r of store.listAutomationRunsSince(windowStart)) {
    const auto = store.getAutomation(r.automationId)?.automation;
    const name = auto?.name ?? `已删任务 #${r.automationId}`;
    const kindTag = auto?.origin === "quota_resume" ? "用量续跑" : auto?.origin === "reminder" ? "提醒送达" : "定时";
    if (r.status === "skipped") {
      skipped += 1;
      missed.push(`${fmtDate(r.startedAt)} ${fmtHM(r.startedAt)} ⊘ 「${name}」错过窗口被跳过（${clip(r.detail, 60)}）`);
      continue;
    }
    if (r.status === "done") {
      done += 1;
      executed.push(`${fmtHM(r.startedAt)} ✓ ${name}（${kindTag} · ${auto?.runtimeId === "" || auto === undefined ? "—" : auto.runtimeId}）`);
    } else if (r.status === "failed") {
      failed += 1;
      executed.push(`${fmtHM(r.startedAt)} ✗ ${name} — ${clip(r.detail)}（${kindTag}）`);
    }
  }

  // ② 该跑而没跑：重试多次被调度器停用的行（enabled=0 且窗口内有新失败戳）
  for (const a of store.listAutomations()) {
    if (a.enabled || a.lastErrorAt === null || a.lastErrorAt < windowStart) continue;
    stopped += 1;
    const kindTag = a.origin === "quota_resume" ? "用量续跑" : a.origin === "reminder" ? "提醒" : "定时";
    missed.push(`⊘ 「${a.name}」${kindTag}重试多次后已停用 — ${clip(a.lastError)}`);
  }

  return {
    empty: executed.length === 0 && missed.length === 0 && blocked.length === 0,
    summary: { done, failed, skipped, stopped, blocked: blocked.length, dropped, handback },
    executed,
    missed,
    blocked,
    windowStart,
    windowEnd: now,
  };
}

export function renderSupervisorReport(r: SupervisorReport): string {
  const head = `【主管日报】${fmtDate(r.windowEnd)}（完成 ${r.summary.done} · 失败 ${r.summary.failed} · 跳过 ${r.summary.skipped} · 停用 ${r.summary.stopped} · 待回答 ${r.summary.blocked}${r.summary.dropped > 0 ? ` · 无需处理 ${r.summary.dropped}` : ""}${r.summary.handback > 0 ? ` · 交回 ${r.summary.handback}` : ""}）`;
  if (r.empty) return head;
  const lines = [head, ""];
  if (r.executed.length > 0) {
    lines.push("一、自动执行");
    lines.push(...r.executed);
  }
  if (r.missed.length > 0) {
    if (lines.length > 2) lines.push("");
    lines.push("二、该跑而没跑");
    lines.push(...r.missed);
  }
  if (r.blocked.length > 0) {
    if (lines.length > 2) lines.push("");
    lines.push("三、待你回答");
    lines.push(...r.blocked);
  }
  lines.push("");
  lines.push("（只汇总无人值守的自动活动；你手动起的不在此列）");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Watcher（到点没到点）
// ---------------------------------------------------------------------------

export interface SupervisorDeps {
  readonly store: Store;
  /** 送达通道（index 的 notifyUser：应用内 + IM；空报告不会走到这里） */
  readonly notify: (text: string, dayKey: string) => void;
  /** 测试/手动预览用的时间源 */
  readonly now?: () => number;
}

export class SupervisorWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: SupervisorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    log.info("supervisor watcher started", { tickMs: TICK_MS });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.maybeDaily();
    } catch (err: unknown) {
      log.warn("supervisor tick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
    }
  }

  /** 每日到点：过了 atMinutes 且今天还没发过 → 发。先落盘再干活（崩了也不会同日重发） */
  private maybeDaily(): void {
    const cfg = getSupervisorConfig(this.deps.store);
    if (!cfg.enabled) return;
    const now = new Date(this.deps.now?.() ?? Date.now());
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (now.getHours() * 60 + now.getMinutes() < cfg.atMinutes) return;
    if (this.deps.store.kvGet(LAST_DAY_KEY) === day) return;
    this.deps.store.kvSet(LAST_DAY_KEY, day);
    this.runNow();
  }

  /**
   * 立即生成并（非空时）送达。force 手动触发与每日到点共用 —— 窗口 = max(上次
   * 发报时刻, 24h 回看)：手动连按两次，第二次窗口收敛、不重复唱票。
   */
  runNow(): { report: SupervisorReport; text: string; delivered: boolean } {
    const store = this.deps.store;
    const now = this.deps.now?.() ?? Date.now();
    const lastAt = Number(store.kvGet(LAST_AT_KEY) ?? 0);
    const windowStart = Math.max(now - WINDOW_MS, Number.isFinite(lastAt) && lastAt > 0 ? lastAt : 0);
    const report = buildSupervisorReport(store, windowStart, now);
    const text = renderSupervisorReport(report);
    let delivered = false;
    if (!report.empty) {
      this.deps.notify(text, `supervisor:${new Date(now).toISOString().slice(0, 10)}`);
      delivered = true;
    }
    store.kvSet(LAST_AT_KEY, String(now));
    return { report, text, delivered };
  }
}
