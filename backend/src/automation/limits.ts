/**
 * 定时任务创建上限 —— kv 单键整数（`automation.createLimit`）。
 *
 * 只数用户自建任务（origin !== "quota_resume"）：续跑有独立的保留策略
 * （QuotaResumeWatcher 清理已完结行），两者额度分账、互不占用。
 * 默认 20（对齐 ZCode AUTOMATION_CREATE_LIMIT）；用户可在自动化页就地改。
 * 钳到 [1, 500]：下界 1 防手滑写 0 把自建全堵死，上界防递归滥建把库灌爆
 * （批量管理就在同一页，真需要大规模清理不靠抬上限解决）。
 */

import type { Store } from "../store/db.ts";

const KEY = "automation.createLimit";

export const AUTOMATION_CREATE_LIMIT_MIN = 1;
export const AUTOMATION_CREATE_LIMIT_MAX = 500;
export const AUTOMATION_CREATE_LIMIT_DEFAULT = 20;

/** 读上限：脏值（非数/越界）一律回落默认，半行脏数据不能把创建堵死 */
export function getAutomationCreateLimit(store: Store): number {
  const raw = store.kvGet(KEY);
  if (raw === undefined) return AUTOMATION_CREATE_LIMIT_DEFAULT;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return AUTOMATION_CREATE_LIMIT_DEFAULT;
  return Math.min(AUTOMATION_CREATE_LIMIT_MAX, Math.max(AUTOMATION_CREATE_LIMIT_MIN, n));
}

/** 写上限：先钳后写，返回实际生效值（调用方拿它回显，别让 UI 显示没被接受的数） */
export function setAutomationCreateLimit(store: Store, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("上限必须是数字");
  }
  const clamped = Math.min(AUTOMATION_CREATE_LIMIT_MAX, Math.max(AUTOMATION_CREATE_LIMIT_MIN, Math.round(value)));
  store.kvSet(KEY, String(clamped));
  return clamped;
}
