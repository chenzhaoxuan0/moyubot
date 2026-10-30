/**
 * 主管日报（docs/30）检查 —— 报告口径与沉默纪律直测：
 *
 *   口径：autopilot 待办运行 + 钟控自动化发火（含 skipped / 停用）进报告；
 *         manual / gtd（经过用户手的）不进。
 *   沉默：三节全空 → empty=true，不送达。
 *   幂等：runNow 连按窗口收敛（lastAt 落盘），第二次不重复唱票；
 *         每日到点 gate 同日只发一次（先落盘再干活）。
 *
 * 用法：cd backend && pnpm check:supervisor
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.ts";
import {
  DEFAULT_SUPERVISOR_CONFIG,
  SupervisorWatcher,
  buildSupervisorReport,
  renderSupervisorReport,
} from "../src/automation/supervisor.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const store = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-supervisor-check-")));
const now = Date.now();
const windowStart = now - 3_600_000;

// 造数据：一条待办（autopilot 跑成 + manual 跑一次）、一条自动化
// （schedule 跑成 + skipped 一窗 + 重试停用一条）
const itemId = store.createBacklogItem({
  title: "整理项目文档",
  goal: "整理文档", prompt: "p", unitId: "steward", unitName: "Steward",
  rootPath: os.tmpdir(), runtimeId: "zcode", launchMode: "headless", auto: true, source: "inbox",
});
const autoDone = store.startBacklogRun(itemId, null, "zcode", "autopilot");
store.finishBacklogRun(autoDone, "done", null);
const manualRun = store.startBacklogRun(itemId, null, "zcode", "manual");
store.finishBacklogRun(manualRun, "done", null);

const autoId = store.createAutomation({
  unitId: "u", unitName: "单元", name: "周报生成", runtimeId: "zcode", rootPath: os.tmpdir(),
  prompt: "p", model: null, mode: null, cron: "0 9 * * 5", scheduleRule: null,
  recurring: true, maxRuns: null, nextRunAt: now + 60_000, launchMode: "headless",
});
const fireDone = store.startAutomationRun(autoId, null, "schedule");
store.finishAutomationRun(fireDone, "done", null);
store.recordSkippedAutomationRun(autoId, now - 1_800_000, "missed: computer_asleep_or_app_not_running");

const stoppedId = store.createAutomation({
  unitId: "u", unitName: "单元", name: "数据抓取", runtimeId: "zcode", rootPath: os.tmpdir(),
  prompt: "p", model: null, mode: null, cron: "0 * * * *", scheduleRule: null,
  recurring: true, maxRuns: null, nextRunAt: now + 60_000, launchMode: "headless",
});
store.setAutomationEnabled(stoppedId, false);
store.setAutomationError(stoppedId, "dispatch failed 5 times", now - 600_000);

// ---- 报告口径 -------------------------------------------------------------------

const report = buildSupervisorReport(store, windowStart, now);
check("autopilot 完成进「自动执行」", report.executed.some((l) => l.includes("整理项目文档") && l.includes("闲时托管")), report.executed);
check("manual 运行不进报告（经过用户手）", !report.executed.some((l) => l.includes("manual")), report.executed);
check("钟控完成进报告", report.executed.some((l) => l.includes("周报生成")), report.executed);
check("misfire 跳过进「该跑而没跑」", report.missed.some((l) => l.includes("周报生成") && l.includes("跳过")), report.missed);
check("重试停用进「该跑而没跑」", report.missed.some((l) => l.includes("数据抓取") && l.includes("停用")), report.missed);
check("计数正确", report.summary.done === 2 && report.summary.skipped === 1 && report.summary.stopped === 1, report.summary);
const text = renderSupervisorReport(report);
check("渲染含标题与两节", text.startsWith("【主管日报】") && text.includes("一、自动执行") && text.includes("二、该跑而没跑"), text);

// ---- 沉默纪律 -------------------------------------------------------------------

const emptyStore = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-supervisor-empty-")));
const emptyReport = buildSupervisorReport(emptyStore, now - 3_600_000, now);
check("空窗口 → empty（沉默不送达）", emptyReport.empty && renderSupervisorReport(emptyReport).startsWith("【主管日报】"), emptyReport);

// ---- Watcher：送达 + 窗口收敛 + 每日 gate ----------------------------------------

const notified: string[] = [];
// 收敛场景用独立 store：活动造在 2 小时前（相对首报时钟是旧数据）——首报唱票、
// 二报窗口从 lastAt 收敛后旧活动不再出现、空报告不送达。（主 store 的数据造在
// 脚本运行当刻，对二报来说是「首报之后的新活动」，重复唱票才是对的 —— 不能用）
const convergeStore = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-supervisor-converge-")));
const oldItemId = convergeStore.createBacklogItem({
  title: "旧活动", goal: "g", prompt: "p", unitId: "u", unitName: "U",
  rootPath: os.tmpdir(), runtimeId: "zcode", launchMode: "headless", auto: true, source: "inbox",
});
const oldRun = convergeStore.startBacklogRun(oldItemId, null, "zcode", "autopilot");
convergeStore.finishBacklogRun(oldRun, "done", null);
// started_at 是 NOW() 落库的 —— 手动回拨 2 小时，让它成为首报窗口内的旧数据
(convergeStore as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
  .db.prepare(`UPDATE backlog_runs SET started_at = ?, finished_at = ? WHERE id = ?`)
  .run(now - 7_200_000, now - 7_100_000, oldRun);

let clock = now;
const watcher = new SupervisorWatcher({
  store: convergeStore,
  notify: (t) => notified.push(t),
  now: () => clock,
});
const first = watcher.runNow();
check("首发生出报告并送达", first.delivered && notified.length === 1, { delivered: first.delivered, notified: notified.length });
clock = now + 60_000;
const second = watcher.runNow();
check("连按窗口收敛 → 旧活动不重唱、空报告不送达", !second.delivered && notified.length === 1, second.report.empty);

// 每日 gate：早于发报时刻不动；到点发一次；同日再 tick 不重发
const gateStore = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-supervisor-gate-")));
const gateWatcher = new SupervisorWatcher({ store: gateStore, notify: (t) => notified.push(t), now: () => clock });
gateStore.kvSet("supervisor.config", JSON.stringify({ enabled: true, atMinutes: 21 * 60 }));
const morning = new Date(now);
morning.setHours(9, 0, 0, 0);
clock = morning.getTime();
(gateWatcher as unknown as { maybeDaily: () => void }).maybeDaily();
check("早于 21:00 不发", gateStore.kvGet("supervisor.lastDay") === undefined);
const night = new Date(now);
night.setHours(21, 30, 0, 0);
clock = night.getTime();
(gateWatcher as unknown as { maybeDaily: () => void }).maybeDaily();
const day1 = gateStore.kvGet("supervisor.lastDay");
check("过 21:00 落当日幂等键", typeof day1 === "string" && day1.length > 0, day1);
clock = night.getTime() + 5 * 60_000;
(gateWatcher as unknown as { maybeDaily: () => void }).maybeDaily();
check("同日不重发", gateStore.kvGet("supervisor.lastDay") === day1);

// 默认配置
check("默认配置开 + 21:00", DEFAULT_SUPERVISOR_CONFIG.enabled && DEFAULT_SUPERVISOR_CONFIG.atMinutes === 21 * 60);

console.log(failures === 0 ? "check: all checks passed" : `check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
