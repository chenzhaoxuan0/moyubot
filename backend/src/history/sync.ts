/**
 * 原生会话源文件同步器（docs/13 统一事实源）：
 * 当外部终端（如独立终端跑的 mcode/zcode）向同一会话追加新消息时，
 * 将原生源文件（如 messages.jsonl / sqlite / json）中新增的消息实时同步进
 * agent-workbench 的 traceSink 轨迹账本与 store.messages 库，并通过 WebSocket
 * 广播给前端对话时间线与侧栏子列表。
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { WebSocketServer } from "ws";
import type { Store } from "../store/db.ts";
import type { TraceSink } from "../runtime/trace.ts";
import { readNativeSession } from "./index.ts";
import { asSessionId, asUnitId, type RuntimeEvent, type SessionId, type UnitId } from "../contract.ts";
import { broadcastEvent } from "../wsd.ts";
import { log } from "../log.ts";

export interface SyncOutcome {
  readonly changed: boolean;
  readonly newMessages: number;
}

// 记录内存中每个会话已同步的原生 transcript 偏移量
const sessionNativeSyncedCounts = new Map<string, number>();

export async function syncNativeSession(
  sessionId: string,
  store: Store,
  traceSink: TraceSink,
  wss?: WebSocketServer,
): Promise<SyncOutcome> {
  const s = store.getSession(sessionId);
  let executorId = "";
  let cliRef = "";

  if (s !== undefined && s.cliRef !== null && s.cliRef !== "") {
    executorId = s.runtimeId.replace(/^daemon:/, "");
    cliRef = s.cliRef;
  } else if (sessionId.startsWith("imp_")) {
    const parts = sessionId.slice(4).split("_");
    if (parts.length >= 2) {
      executorId = parts[0]!;
      cliRef = parts.slice(1).join("_");
    }
  }

  if (!executorId || !cliRef) {
    return { changed: false, newMessages: 0 };
  }

  let detail;
  try {
    detail = await readNativeSession(executorId, cliRef);
  } catch (err: unknown) {
    log.debug("[native-sync] 读取原生会话失败（跳过）", { executorId, cliRef, err: String(err) });
    return { changed: false, newMessages: 0 };
  }

  if (!detail || !Array.isArray(detail.transcript) || detail.transcript.length === 0) {
    return { changed: false, newMessages: 0 };
  }

  const nativeCount = detail.transcript.length;

  // 1. 确定已同步游标（绝不拿只存 user/assistant 的 store.messages 条数当作全量 transcript 的游标）
  let currentCount = sessionNativeSyncedCounts.get(sessionId);
  if (currentCount === undefined) {
    // 首次进入：扫描账本中最后一条同步事件的索引编号（msg_ext_N / tc_ext_N）
    const traceRows = await traceSink.readSessionNdjson(asSessionId(sessionId), 0);
    let maxExtIdx = 0;
    if (traceRows.trim() !== "") {
      const matches = traceRows.matchAll(/(?:msg_ext_|tc_ext_)(\d+)/g);
      for (const m of matches) {
        const num = parseInt(m[1]!, 10);
        if (num > maxExtIdx) maxExtIdx = num;
      }
    }
    // 若账本中已有同步事件，则以此为准；若账本完全无同步事件且数据库已有记录，以 s.turnCount 兜底
    currentCount = maxExtIdx > 0 ? maxExtIdx : 0;
    sessionNativeSyncedCounts.set(sessionId, currentCount);
  }

  // 如果原生消息条数没有增加，更新状态后返回
  if (nativeCount <= currentCount) {
    if (s && detail.updatedAt > (s.endedAt ?? 0)) {
      store.setSessionStatus(s.id, s.status, detail.updatedAt, {
        ...s.stats,
        messages: Math.max(s.stats.messages, nativeCount),
      });
      return { changed: true, newMessages: 0 };
    }
    return { changed: false, newMessages: 0 };
  }

  log.info("[native-sync] 检测到外部会话新增消息，实时同步到工作台", {
    sessionId,
    executorId,
    currentCount,
    nativeCount,
    added: nativeCount - currentCount,
  });

  let lastSeq = s?.lastSeq ?? 0;
  const unitId = asUnitId(s?.unitId ?? "");
  const sid = asSessionId(sessionId);

  for (let idx = currentCount; idx < nativeCount; idx++) {
    const entry = detail.transcript[idx]!;
    const at = entry.at || detail.updatedAt || Date.now();
    const messageId = `msg_ext_${idx + 1}`;

    if (entry.kind === "user") {
      store.insertMessage(sessionId, at, "user", entry.text);
      const evDelta: RuntimeEvent = {
        type: "message.delta",
        sessionId: sid,
        messageId,
        role: "user",
        text: entry.text,
      };
      await traceSink.append({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: evDelta });
      if (wss) {
        broadcastEvent(wss, evDelta, lastSeq);
      }
    } else if (entry.kind === "assistant") {
      store.insertMessage(sessionId, at, "assistant", entry.text);
      const evDelta: RuntimeEvent = {
        type: "message.delta",
        sessionId: sid,
        messageId,
        role: "assistant",
        text: entry.text,
      };
      const evDone: RuntimeEvent = {
        type: "message.completed",
        sessionId: sid,
        messageId,
        text: entry.text,
      };
      await traceSink.append({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: evDelta });
      await traceSink.append({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: evDone });
      if (wss) {
        broadcastEvent(wss, evDelta, lastSeq - 1);
        broadcastEvent(wss, evDone, lastSeq);
      }
    } else if (entry.kind === "tool") {
      const callId = `tc_ext_${idx + 1}`;
      const evStarted: RuntimeEvent = {
        type: "tool.started",
        sessionId: sid,
        callId,
        toolName: entry.toolName ?? "tool",
        title: entry.text.slice(0, 80),
        input: entry.text,
      };
      const evCompleted: RuntimeEvent = {
        type: "tool.completed",
        sessionId: sid,
        callId,
        ok: true,
        output: "",
      };
      await traceSink.append({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: evStarted });
      await traceSink.append({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: evCompleted });
      if (wss) {
        broadcastEvent(wss, evStarted, lastSeq - 1);
        broadcastEvent(wss, evCompleted, lastSeq);
      }
    }
  }

  // 更新已同步游标
  sessionNativeSyncedCounts.set(sessionId, nativeCount);

  if (s) {
    store.setSessionStatus(s.id, s.status, detail.updatedAt, {
      ...s.stats,
      messages: nativeCount,
    });
    store.setSessionProgress(s.id, lastSeq, nativeCount);
  }

  // 广播状态更新让前端侧栏与任务栏无缝刷新
  if (wss) {
    const lastEntry = detail.transcript[detail.transcript.length - 1];
    const isAwaiting = Boolean(
      lastEntry &&
      lastEntry.kind === "tool" &&
      (lastEntry.toolName?.toLowerCase() === "ask_user" ||
        lastEntry.toolName?.toLowerCase() === "questionnaire" ||
        lastEntry.toolName?.toLowerCase() === "ask_question" ||
        lastEntry.toolName?.toLowerCase() === "askuserquestion")
    );
    const syncStatus = isAwaiting ? "awaiting_input" : "idle";
    broadcastEvent(wss, { type: "session.status", sessionId: sid, status: syncStatus }, ++lastSeq);
  }

  return { changed: true, newMessages: nativeCount - currentCount };
}

/**
 * 原生会话文件活动监视器：
 * 对正在被用户查看或最近活跃的会话，高频检测其源文件变化（mtime/size），
 * 一旦外部窗口写入新内容，秒级同步到当前时间线。
 */
export class NativeSessionWatcher {
  private watchedSessionIds = new Set<string>();
  private fileSignatures = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    private readonly store: Store,
    private readonly traceSink: TraceSink,
    private readonly getWss: () => WebSocketServer | null,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, 500);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  watchSession(sessionId: string): void {
    if (!sessionId) return;
    this.watchedSessionIds.add(sessionId);
    // 保持关注集合轻量（最多最近 25 个）
    if (this.watchedSessionIds.size > 25) {
      const first = this.watchedSessionIds.values().next().value;
      if (first) this.watchedSessionIds.delete(first);
    }
    // 立即执行一次探测，确保外部刚写的内容立刻呈现在眼前
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.syncing || this.watchedSessionIds.size === 0) return;
    this.syncing = true;
    try {
      const wss = this.getWss();
      for (const sid of Array.from(this.watchedSessionIds)) {
        let bareExec = "";
        let cliRef = "";
        const s = this.store.getSession(sid);
        if (s !== undefined && s.cliRef !== null && s.cliRef !== "") {
          bareExec = s.runtimeId.replace(/^daemon:/, "");
          cliRef = s.cliRef;
        } else if (sid.startsWith("imp_")) {
          const parts = sid.slice(4).split("_");
          if (parts.length >= 2) {
            bareExec = parts[0]!;
            cliRef = parts.slice(1).join("_");
          }
        }
        if (!bareExec || !cliRef) continue;

        const detail = await readNativeSession(bareExec, cliRef).catch(() => null);
        if (!detail || !detail.source) continue;

        let targetFile = detail.source;
        if (existsSync(path.join(detail.source, "messages.jsonl"))) {
          targetFile = path.join(detail.source, "messages.jsonl");
        }

        if (!existsSync(targetFile)) continue;

        let sig = "";
        try {
          const st = statSync(targetFile);
          sig = `${st.mtimeMs}_${st.size}`;
        } catch {
          continue;
        }

        const prevSig = this.fileSignatures.get(targetFile);
        if (prevSig === undefined) {
          this.fileSignatures.set(targetFile, sig);
          // 首次探测，执行一次对账确保不漏掉刚进来的新消息
          await syncNativeSession(sid, this.store, this.traceSink, wss ?? undefined);
          continue;
        }

        if (sig !== prevSig) {
          this.fileSignatures.set(targetFile, sig);
          await syncNativeSession(sid, this.store, this.traceSink, wss ?? undefined);
        }
      }
    } finally {
      this.syncing = false;
    }
  }
}
