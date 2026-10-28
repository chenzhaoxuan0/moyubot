/**
 * history 层入口 —— reader 注册表 + 聚合入口。
 *
 * 聚合规则：所有 reader 并发跑（各 200ms 内完不成就跳过那家——历史浏览是
 * 增强面，不许任何一家拖死列表）；按 updatedAt 归并排序，limit 截断。
 * 单家 reader 抛错只影响自己（fail-open），错误进日志不进结果。
 */

import { log } from "../log.ts";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "./types.ts";
import { createPiReader } from "./readers/pi.ts";
import { createClaudeReader } from "./readers/claude.ts";
import { createCodexReader } from "./readers/codex.ts";
import { createGrokReader } from "./readers/grok.ts";
import { createMcodeReader } from "./readers/mcode.ts";
import { createKimiReader } from "./readers/kimi.ts";
import { createDshReader } from "./readers/dsh.ts";
import { createZcodeReader } from "./readers/zcode.ts";
import { createHermesReader } from "./readers/hermes.ts";
import { createOpencodeReader } from "./readers/opencode.ts";
import { createOpenclawReader } from "./readers/openclaw.ts";
import { createAntigravityReader } from "./readers/antigravity.ts";
import { createCursorReader } from "./readers/cursor.ts";

/** 单家 reader 的预算：超时跳过（历史是增强面，不许拖死聚合） */
const READER_BUDGET_MS = 2500;

const readers: readonly SessionReader[] = [
  createPiReader(),
  createClaudeReader(),
  createCodexReader(),
  createGrokReader(),
  createMcodeReader(),
  createKimiReader(),
  createDshReader(),
  createZcodeReader(),
  createHermesReader(),
  createOpencodeReader(),
  createOpenclawReader(),
  createAntigravityReader(),
  // cursor 与 cursor-agent 是同一 CLI 的新旧名，共享 ~/.cursor/chats 一份存储
  createCursorReader("cursor"),
  createCursorReader("cursor-agent"),
];

function withBudget<T>(p: Promise<T>, executorId: string): Promise<T | null> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      // 超时分支必须可观测：此前静默 resolve(null)，一家 reader 慢了整行从
      // 列表里无声消失，排查只能靠猜。reader 本体继续跑完（race 不取消），
      // claude 层的结果缓存仍会被填充——下一次 list 直接命中。
      log.warn(`[history] ${executorId} reader 超过 ${READER_BUDGET_MS}ms 预算，本次结果丢弃`, {
        budgetMs: READER_BUDGET_MS,
        elapsedMs: Date.now() - startedAt,
      });
      resolve(null);
    }, READER_BUDGET_MS);
  });
  return Promise.race([p.catch((err: unknown) => {
    log.info(`[history] ${executorId} reader 失败（跳过）`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }), timeout]).finally(() => clearTimeout(timer));
}

/** executorId → reader（detail 下钻用） */
export function readerOf(executorId: string): SessionReader | null {
  return readers.find((r) => r.executorId === executorId) ?? null;
}

/** 全部 reader 的 executorId（自动收录的缓存通道按家聚合用） */
export function readerIds(): readonly string[] {
  return readers.map((r) => r.executorId);
}

/** 跨家聚合列表。executorIds 为空 = 全部家。 */
export async function listNativeSessions(
  rootPath: string | null,
  executorIds: readonly string[],
  limit: number,
): Promise<readonly NativeSessionSummary[]> {
  const chosen = executorIds.length === 0 ? readers : readers.filter((r) => executorIds.includes(r.executorId));
  const results = await Promise.all(chosen.map((r) => withBudget(r.list(rootPath, limit), r.executorId)));
  const merged: NativeSessionSummary[] = [];
  for (const rows of results) {
    if (rows !== null) merged.push(...rows);
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 单会话富转录下钻 */
export async function readNativeSession(executorId: string, sessionId: string): Promise<NativeSessionDetail | null> {
  const reader = readerOf(executorId);
  if (reader === null) return null;
  return withBudget(reader.read(sessionId), executorId) as Promise<NativeSessionDetail | null>;
}

export type { NativeSessionSummary, NativeTranscriptEntry, NativeSessionDetail, SessionReader } from "./types.ts";
