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

/**
 * 对指定会话执行一次原生源文件对账与同步。
 * 如果源文件消息比工作台记录的多，补齐 missing 的 message.delta / message.completed 事件。
 */
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

  const existingMsgs = store.listMessages(sessionId, 5000);
  const currentCount = existingMsgs.length;
  const nativeCount = detail.transcript.length;

  // 如果消息数没增加，但源文件更新时间比数据库新，更新元数据即可
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

  log.info("[native-sync] 检测到外部会话新增消息，同步到工作台", {
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

  if (s) {
    store.setSessionStatus(s.id, s.status, detail.updatedAt, {
      ...s.stats,
      messages: nativeCount,
    });
    store.setSessionProgress(s.id, lastSeq, nativeCount);
  }

  // 广播状态更新让前端侧栏刷新
  if (wss) {
    broadcastEvent(wss, { type: "session.status", sessionId: sid, status: "idle" }, ++lastSeq);
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
  private fileMtimes = new Map<string, number>();
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
    }, 1500);
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
    // 保持关注集合轻量（最多最近 20 个）
    if (this.watchedSessionIds.size > 20) {
      const first = this.watchedSessionIds.values().next().value;
      if (first) this.watchedSessionIds.delete(first);
    }
  }

  private async poll(): Promise<void> {
    if (this.syncing || this.watchedSessionIds.size === 0) return;
    this.syncing = true;
    try {
      const wss = this.getWss();
      for (const sid of Array.from(this.watchedSessionIds)) {
        const s = this.store.getSession(sid);
        if (!s || !s.cliRef) continue;
        const bareExec = s.runtimeId.replace(/^daemon:/, "");
        const detail = await readNativeSession(bareExec, s.cliRef).catch(() => null);
        if (!detail || !detail.source) continue;

        let targetFile = detail.source;
        if (existsSync(path.join(detail.source, "messages.jsonl"))) {
          targetFile = path.join(detail.source, "messages.jsonl");
        }

        if (!existsSync(targetFile)) continue;

        let mtime = 0;
        try {
          mtime = statSync(targetFile).mtimeMs;
        } catch {
          continue;
        }

        const prevMtime = this.fileMtimes.get(targetFile);
        if (prevMtime === undefined) {
          this.fileMtimes.set(targetFile, mtime);
          continue;
        }

        if (mtime > prevMtime) {
          this.fileMtimes.set(targetFile, mtime);
          await syncNativeSession(sid, this.store, this.traceSink, wss ?? undefined);
        }
      }
    } finally {
      this.syncing = false;
    }
  }
}
