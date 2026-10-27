/**
 * 通知事实源（docs/21 P4b / D5）—— 事件 → 通知的聚合上移。
 *
 * 自然键去重 / 等级映射 / 文案与 prototype useNotifications 的口径逐条对齐
 * （同一套语义的 daemon 版，GUI 与 CLI/agent 消费同一份事实）；
 * 「你不在它面前」（inForeground/stillWatching）与已读标记是**每客户端的呈现**，
 * 留在客户端，行里不带 read 字段——这是操作/呈现二分的边界本身。
 *
 * 自动化终态在这里直接取台账任务名（index 汇点持有 automationRunBySession），
 * 取代前端「拉 automation.list 补偿解析」的旧路（docs/19 的「不改 daemon」
 * 决策由 ADR 0015 / docs/21 P4b 有意推翻）。
 *
 * 持久化：<homeDir>/notifications.json（通知是日志不是状态机，debounce 落盘，
 * 坏文件弃用从零开始）。实时推送经 setPush 挂进 wsd 的 notifications 帧。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "./contract.ts";
import type { BacklogSignal } from "../../prototype/src/core/backlog.ts";
import { SESSION_SOURCE_LABEL } from "../../prototype/src/core/units.ts";
import { log } from "./log.ts";

export interface NotificationRow {
  /** 自然键（去重口径），如 `end:s1` / `git:C:/repo` —— 与前端旧实现逐字一致 */
  readonly id: string;
  readonly at: number;
  readonly level: "info" | "ok" | "warn" | "loss";
  readonly kind: "session" | "permission" | "error" | "notice" | "steer" | "deliverable" | "backlog" | "git";
  readonly title: string;
  readonly text: string;
  /** 会话来源（SessionSource 原始值；客户端渲染徽标） */
  readonly source?: string;
  readonly sessionId?: string;
  readonly backlog?: boolean;
}

const MAX_ROWS = 100;
const PERSIST_DEBOUNCE_MS = 500;

/** 失败终态判据 —— 与 host 结算口径一致（error / *_error / executor_exited 都是失败） */
function isFailureReason(reason: string): boolean {
  return reason === "error" || reason === "executor_exited" || reason.endsWith("_error");
}

function endReasonLabel(reason: string): string {
  if (reason === "executor_exited") return "执行器退出";
  if (isFailureReason(reason)) return "出错";
  if (reason === "cancelled") return "被取消";
  return reason === "idle" || reason === "done" || reason === "completed" || reason === "closed" ? "正常完成" : reason;
}

function labelOf(source: string | undefined): string {
  if (source === undefined) return "后台";
  return SESSION_SOURCE_LABEL[source as keyof typeof SESSION_SOURCE_LABEL] ?? source;
}

/** 全文指纹（djb2 十六进制）：错误正文做去重键时截前 80 字会把开头相同的不同错误并成一条 */
function textKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

interface SessionMeta {
  source?: string;
  title?: string;
}

export class NotificationsService {
  #rows: NotificationRow[] = [];
  readonly #file: string;
  readonly #homeDir: string;
  readonly #metaOf: (sessionId: string) => SessionMeta | undefined;
  #push: ((row: NotificationRow) => void) | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(homeDir: string, metaOf: (sessionId: string) => SessionMeta | undefined) {
    this.#homeDir = homeDir;
    this.#file = path.join(homeDir, "notifications.json");
    this.#metaOf = metaOf;
    void this.#load();
  }

  /** attachWs 之后挂推送通道；此前到达的事件只记录不推送（历史以 list 拉取为准） */
  setPush(fn: (row: NotificationRow) => void): void {
    this.#push = fn;
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as { rows?: unknown };
      if (!Array.isArray(parsed.rows)) return;
      this.#rows = parsed.rows
        .filter(
          (r): r is NotificationRow =>
            typeof r === "object" && r !== null &&
            typeof (r as NotificationRow).id === "string" &&
            typeof (r as NotificationRow).at === "number" &&
            typeof (r as NotificationRow).title === "string" &&
            typeof (r as NotificationRow).kind === "string",
        )
        .slice(0, MAX_ROWS);
    } catch {
      /* 无文件 / 坏文件：弃用，从零开始 */
    }
  }

  #persist(): void {
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      void mkdir(this.#homeDir, { recursive: true })
        .then(() => writeFile(this.#file, JSON.stringify({ rows: this.#rows }), "utf8"))
        .catch((err: unknown) => log.warn("notifications persist failed", { error: err instanceof Error ? err.message : String(err) }));
    }, PERSIST_DEBOUNCE_MS);
  }

  #upsert(row: Omit<NotificationRow, "at">): void {
    const next: NotificationRow = { ...row, at: Date.now() };
    this.#rows = [next, ...this.#rows.filter((r) => r.id !== next.id)].slice(0, MAX_ROWS);
    this.#persist();
    try {
      this.#push?.(next);
    } catch (err: unknown) {
      log.warn("notifications push failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  list(limit?: number): NotificationRow[] {
    const n = typeof limit === "number" ? Math.min(Math.max(Math.trunc(limit), 1), MAX_ROWS) : MAX_ROWS;
    return this.#rows.slice(0, n);
  }

  /** 事件汇点：与前端 onRuntimeEvent 同一套映射，减去视图过滤（那是客户端呈现） */
  record(event: RuntimeEvent): void {
    switch (event.type) {
      case "session.ended": {
        const sid = String(event.sessionId);
        const meta = this.#metaOf(sid);
        this.#upsert({
          id: `end:${sid}`,
          level: isFailureReason(event.reason) ? "loss" : event.reason === "cancelled" ? "warn" : "ok",
          kind: "session",
          title: `${labelOf(meta?.source)}会话${endReasonLabel(event.reason)}`,
          text: meta?.title ?? sid,
          source: meta?.source,
          sessionId: sid,
        });
        return;
      }
      case "permission.requested": {
        const sid = String(event.sessionId);
        this.#upsert({
          id: `perm:${sid}:${event.requestId}`,
          level: "warn",
          kind: "permission",
          title: "等待审批",
          text: clip(event.detail),
          source: this.#metaOf(sid)?.source,
          sessionId: sid,
        });
        return;
      }
      case "error": {
        const sid = String(event.sessionId);
        this.#upsert({
          id: `err:${sid}:${textKey(event.message)}`,
          level: "loss",
          kind: "error",
          title: "会话出错",
          text: clip(event.message),
          sessionId: sid,
        });
        return;
      }
      case "system.notice": {
        const sid = String(event.sessionId);
        this.#upsert({
          id: `notice:${sid}:${event.title}:${event.text.slice(0, 60)}`,
          level: event.level === "warn" ? "warn" : event.level === "success" ? "ok" : "info",
          kind: "notice",
          title: event.title,
          text: clip(event.text),
          sessionId: sid,
        });
        return;
      }
      case "steer.undelivered": {
        const sid = String(event.sessionId);
        this.#upsert({
          id: `steer:${sid}`,
          level: "warn",
          kind: "steer",
          title: "插话未投递",
          text: `${event.inputs.length} 条插话在会话结束前没能发出`,
          sessionId: sid,
        });
        return;
      }
      case "deliverable": {
        const sid = String(event.sessionId);
        this.#upsert({
          id: `dlv:${sid}:${event.title}`,
          level: "ok",
          kind: "deliverable",
          title: `产出：${event.title}`,
          text: event.path ?? event.url ?? "",
          sessionId: sid,
        });
        return;
      }
      default:
        return;
    }
  }

  /** 自动化终态：台账任务名直取（取代前端拉 automation.list 补偿解析）——与 record 的
   *  end:{sid} 同键原位刷新成「任务名 + 摘要」 */
  notifyAutomationEnd(sessionId: string, reason: string, name?: string, summary?: string): void {
    const meta = this.#metaOf(sessionId);
    this.#upsert({
      id: `end:${sessionId}`,
      level: isFailureReason(reason) ? "loss" : reason === "cancelled" ? "warn" : "ok",
      kind: "session",
      title:
        name !== undefined && name !== ""
          ? `自动化「${name}」${endReasonLabel(reason)}`
          : `${labelOf(meta?.source)}会话${endReasonLabel(reason)}`,
      text: clip(summary ?? meta?.title ?? sessionId),
      source: "automation",
      sessionId,
    });
  }

  recordBacklogSignal(s: BacklogSignal): void {
    if (s.kind === "notice") {
      this.#upsert({
        id: `bl:${s.text.slice(0, 80)}`,
        level: s.level === "warn" ? "warn" : s.level === "success" ? "ok" : "info",
        kind: "backlog",
        title: "待办提醒",
        text: clip(s.text),
      });
      return;
    }
    if (s.kind === "proposal") {
      this.#upsert({
        id: `blp:${s.proposal.id}`,
        level: "info",
        kind: "backlog",
        title: "待办提议",
        text: clip(s.proposal.message !== "" ? s.proposal.message : s.proposal.title),
        backlog: true,
      });
    }
  }

  recordGitChanged(rootPath: string): void {
    const name = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? rootPath;
    this.#upsert({
      id: `git:${rootPath}`,
      level: "info",
      kind: "git",
      title: "仓库有新改动",
      text: name,
    });
  }

  /**
   * 手动同步外部源文件的结果（chatUI 头部同步按钮 / `aw call session.syncNative`）。
   * 状态键二分：「已是最新」与「同步到 N 条」各有自然键——状态变化才产生新行
   * 亮铃铛，重复点击同状态原位刷新不刷屏。GUI 与 CLI 调的是同一个 RPC，
   * 反馈落同一份事实源（ADR 0015 操作面纪律）。
   */
  notifySyncOutcome(sessionId: string, changed: boolean, newMessages: number): void {
    if (changed && newMessages > 0) {
      this.#upsert({
        id: `sync:${sessionId}:ok`,
        level: "ok",
        kind: "notice",
        title: "外部源同步",
        text: `同步到 ${newMessages} 条新消息`,
        sessionId,
      });
      return;
    }
    this.#upsert({
      id: `sync:${sessionId}:idle`,
      level: "info",
      kind: "notice",
      title: "外部源同步",
      text: "已是最新，源文件没有新消息",
      sessionId,
    });
  }
}
