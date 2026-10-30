/**
 * 提醒错过补发（docs/30）检查 —— 调度器 misfire 分支的双轴语义分野：
 *
 *   任务（origin=manual）错过超 5 分钟宽限 → skipped 不补跑（历史行为）
 *   提醒（origin=reminder）错过同一时长 → 绕过宽限立即补发
 *
 * 直接实例化真 Store + AutomationScheduler，手动敲 tickInner（tick 定时器
 * 20s 一拍，等它不划算；分支逻辑全在 tickInner 里，敲它等于敲了那一拍）。
 * 用法：cd backend && pnpm check:reminder-catchup
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.ts";
import { AutomationScheduler } from "../src/automation/scheduler.ts";
import { buildAbsoluteSchedule, scheduleRuleToCron } from "../../prototype/src/core/automation.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const store = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-reminder-catchup-")));

// 两条一次性行，触发点都压在 6 分钟前（> MISFIRE_GRACE_MS 的 5 分钟）
const late = Date.now() - 6 * 60_000;
const rule = buildAbsoluteSchedule(late);
const cron = scheduleRuleToCron(rule);
const base = {
  name: "迟到的一次性",
  runtimeId: "",
  rootPath: os.tmpdir(),
  prompt: "检查用",
  model: null,
  mode: null,
  cron,
  scheduleRule: rule,
  recurring: false,
  maxRuns: 1,
  nextRunAt: late,
  launchMode: "headless" as const,
};
const reminderId = store.createAutomation({
  ...base,
  unitId: "reminder",
  unitName: "提醒",
  dispatchTarget: "notify",
  origin: "reminder",
});
const taskId = store.createAutomation({
  ...base,
  unitId: "unit",
  unitName: "单元",
  dispatchTarget: "new_session",
  origin: "manual",
});

const fired: number[] = [];
const scheduler = new AutomationScheduler(store, async (a) => {
  fired.push(a.id);
  return { runId: 0, sessionId: "" };
});
// 敲一拍（私有方法直调：check 里等 20s 定时器不值当，分支全在这函数里）
(scheduler as unknown as { tickInner: () => void }).tickInner();
// dispatch 是 fire-and-forget，给它一拍落地
await new Promise((r) => setTimeout(r, 100));

check("提醒越过宽限仍补发", fired.includes(reminderId), { fired });
check("任务越过宽限跳过不派发", !fired.includes(taskId), { fired });

const rows = new Map(store.listAutomations().map((a) => [a.id, a]));
check("补发的提醒一次性收口（enabled=false）", rows.get(reminderId)?.enabled === false);
check("跳过的任务也收口（enabled=false）", rows.get(taskId)?.enabled === false);

const taskRuns = store.listAutomationRuns(taskId, 10);
check("任务记 skipped（missed 原因）", taskRuns.some((r) => r.status === "skipped" && String(r.detail ?? "").startsWith("missed")), taskRuns);
const reminderRuns = store.listAutomationRuns(reminderId, 10);
check("提醒无 skipped 行", !reminderRuns.some((r) => r.status === "skipped"), reminderRuns);

console.log(failures === 0 ? "check: all checks passed" : `check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
