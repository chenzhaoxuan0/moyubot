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
import type { TraceRecord } from "../contract.ts";
import { readNativeSession, type NativeSessionDetail } from "./index.ts";
import { asSessionId, asUnitId, type RuntimeEvent, type UnitId } from "../contract.ts";
import { broadcastEvent } from "../wsd.ts";
import { log } from "../log.ts";

export interface SyncOutcome {
  readonly changed: boolean;
  readonly newMessages: number;
}

/** (executorId, cliRef) 二元组：定位一条原生会话所需的最小信息，全文件随行 */
export interface NativeSessionRef {
  readonly executorId: string;
  readonly cliRef: string;
}

/**
 * 解析 `imp_<exec>_<cliRef>` 形态的隐式会话 id（外部导入会话在 store 无行时的
 * 兜底定位方式）。executorId 段不含下划线，其余部分整体归 cliRef（原生 id 自身
 * 可能含 `_`）。非该形态或残缺返回 null。
 */
export function parseImplicitSessionId(id: string): NativeSessionRef | null {
  if (!id.startsWith("imp_")) return null;
  const parts = id.slice(4).split("_");
  if (parts.length < 2 || parts[0] === "") return null;
  const cliRef = parts.slice(1).join("_");
  if (cliRef === "") return null;
  return { executorId: parts[0]!, cliRef };
}

// 记录内存中每个会话已同步的原生 transcript 偏移量
const sessionNativeSyncedCounts = new Map<string, number>();

// 单飞（single-flight）：session.events.since RPC 与 500ms watcher 会对同一会话
// 并发触发同步；lastSeq 从快照取值，并发跑会把同批消息重复记账。同一时刻同一
// 会话只允许一个在途同步，后来的调用共享同一个 Promise。
const nativeSyncInFlight = new Map<string, Promise<SyncOutcome>>();

/** 收回某会话的同步游标（session.forget 回收路径调用，防 Map 只增不减） */
export function forgetNativeSyncState(sessionId: string): void {
  sessionNativeSyncedCounts.delete(sessionId);
}

export function syncNativeSession(
  sessionId: string,
  store: Store,
  traceSink: TraceSink,
  wss?: WebSocketServer,
  snapshot?: NativeSessionDetail | null,
): Promise<SyncOutcome> {
  const inFlight = nativeSyncInFlight.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const p = performNativeSync(sessionId, store, traceSink, wss, snapshot).finally(() => {
    if (nativeSyncInFlight.get(sessionId) === p) nativeSyncInFlight.delete(sessionId);
  });
  nativeSyncInFlight.set(sessionId, p);
  return p;
}

async function performNativeSync(
  sessionId: string,
  store: Store,
  traceSink: TraceSink,
  wss: WebSocketServer | undefined,
  snapshot: NativeSessionDetail | null | undefined,
): Promise<SyncOutcome> {
  const s = store.getSession(sessionId);
  let executorId = "";
  let cliRef = "";

  if (s !== undefined && s.cliRef !== null && s.cliRef !== "") {
    executorId = s.runtimeId.replace(/^daemon:/, "");
    cliRef = s.cliRef;
  } else {
    const implicit = parseImplicitSessionId(sessionId);
    if (implicit !== null) {
      executorId = implicit.executorId;
      cliRef = implicit.cliRef;
    }
  }

  if (!executorId || !cliRef) {
    return { changed: false, newMessages: 0 };
  }

  // watcher 已在探测时读过一份就直传，避免同一变更周期里重复 readNativeSession
  let detail: NativeSessionDetail | null | undefined = snapshot;
  if (detail === undefined) {
    try {
      detail = await readNativeSession(executorId, cliRef);
    } catch (err: unknown) {
      log.debug("[native-sync] 读取原生会话失败（跳过）", { executorId, cliRef, err: String(err) });
      return { changed: false, newMessages: 0 };
    }
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

  // 工具配对（mcode 的 call/result 相位）：result 条目只补完对应 call 的
  // tool.completed，不再各自成对——否则问卷的「结果（=已作答）」条目会被投影
  // 成第二张问卷卡（选项解析出乱码），末尾 call 无 result 才是真待决
  let pendingCallIdx: number | null = null;

  // 批量落账（首开的整段投影动辄上千条记录，逐条 append 是上千次串行
  // appendFile——RPC 秒级等待的元凶；攒齐后 appendMany 一次写，广播随批后发）
  const records: TraceRecord[] = [];
  const frames: Array<{ ev: RuntimeEvent; seq: number }> = [];
  const emit = (at: number, ev: RuntimeEvent): void => {
    records.push({ seq: ++lastSeq, at, sessionId: sid, unitId, runtimeId: executorId, event: ev });
    frames.push({ ev, seq: lastSeq });
  };

  const emitToolCompleted = (callId: string, output: string, at: number): void => {
    emit(at, { type: "tool.completed", sessionId: sid, callId, ok: true, output });
  };

  for (let idx = currentCount; idx < nativeCount; idx++) {
    const entry = detail.transcript[idx]!;
    const at = entry.at || detail.updatedAt || Date.now();

    if (entry.kind === "tool" && entry.meta?.phase === "result") {
      if (pendingCallIdx !== null) {
        emitToolCompleted(`tc_ext_${pendingCallIdx + 1}`, entry.text, at);
        pendingCallIdx = null;
      } else {
        // 孤立 result（防御）：按旧形态自成一对
        const callId = `tc_ext_${idx + 1}`;
        emit(at, { type: "tool.started", sessionId: sid, callId, toolName: entry.toolName ?? "tool", title: "", input: "" });
        emitToolCompleted(callId, entry.text, at);
      }
      continue;
    }
    // 非工具条目打断未闭合的 call：补一个空结果收口（mcode 正常都配对，防御兜底）
    if (pendingCallIdx !== null) {
      emitToolCompleted(`tc_ext_${pendingCallIdx + 1}`, "", at);
      pendingCallIdx = null;
    }

    if (entry.kind === "user") {
      store.insertMessage(sessionId, at, "user", entry.text);
      emit(at, { type: "message.delta", sessionId: sid, messageId: `msg_ext_${idx + 1}`, role: "user", text: entry.text });
    } else if (entry.kind === "assistant") {
      const messageId = `msg_ext_${idx + 1}`;
      store.insertMessage(sessionId, at, "assistant", entry.text);
      emit(at, { type: "message.delta", sessionId: sid, messageId, role: "assistant", text: entry.text });
      emit(at, { type: "message.completed", sessionId: sid, messageId, text: entry.text });
    } else if (entry.kind === "thinking") {
      // 思考块也进账本（reasoning.delta）：折叠组里能看到「思考 N 阶段」的真实内容
      emit(at, { type: "reasoning.delta", sessionId: sid, messageId: `think_ext_${idx + 1}`, text: entry.text });
    } else if (entry.kind === "compaction") {
      // 续链会话的上文压缩摘要：投成说明卡，文件「从中间开始」不再莫名其妙
      const clipped = entry.text.length > 600 ? `${entry.text.slice(0, 600)}…（截断）` : entry.text;
      emit(at, { type: "system.notice", sessionId: sid, title: "前情摘要（续链会话的上文压缩）", text: clipped, level: "info" });
    } else if (entry.kind === "tool") {
      const callId = `tc_ext_${idx + 1}`;
      emit(at, {
        type: "tool.started",
        sessionId: sid,
        callId,
        toolName: entry.toolName ?? "tool",
        title: entry.text.slice(0, 80),
        input: entry.text,
      });
      if (entry.meta?.phase === "call") {
        // 只发 started：completed 等它的 result 条目（或保持待决）
        pendingCallIdx = idx;
      } else {
        // 无相位（其他 CLI reader）：started+completed 立即成对（旧形态）
        emitToolCompleted(callId, "", at);
      }
    }
  }

  // 一次链节点写完全部投影记录，再补发广播帧
  await traceSink.appendMany(records);
  if (wss) {
    for (const f of frames) broadcastEvent(wss, f.ev, f.seq);
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

  // 广播状态更新让前端侧栏与任务栏无缝刷新。
  // 待决判定（各家执行器协议口径，源码调研 2026-10）：转录末条是问卷族工具，
  // 且结果不像「已答/已取消」。mcode 立即返回 waiting 文案（已答注入
  // <questionnaire-response>）；dsh timed 超时返回 {"pending":true}；其余
  //（claude/zcode/kimi/grok/codex/opencode/hermes/openclaw）挂起式——末条
  // 是 call（无结果）即待决，已答的结果文案含 answered/answers 等标记。
  if (wss) {
    const tail = detail.transcript[nativeCount - 1];
    const tailTool = String(tail?.toolName ?? "").toLowerCase();
    const isQuestionnaireTool = Boolean(
      tail &&
      tail.kind === "tool" &&
      (tailTool === "ask_user" || tailTool === "ask_question" || tailTool === "ask_user_question" ||
        tailTool === "askuserquestion" || tailTool === "askquestion" || tailTool === "questionnaire" ||
        tailTool === "question" || tailTool === "clarify" ||
        tailTool === "request_user_input" || tailTool === "request_user_input_async"),
    );
    const answeredLooking = /<questionnaire-response>|user has answered|user selected|"status":\s*"answered"|"answers"\s*:|cancelled|question not asked/i;
    const pendingPositive = /is waiting for the local user|"pending":\s*true/i;
    const isAwaiting =
      isQuestionnaireTool &&
      !answeredLooking.test(tail?.text ?? "") &&
      (tail?.meta?.phase !== "result" || pendingPositive.test(tail?.text ?? ""));
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
  /** sessionId → 其源文件路径：收回关注时连带清掉对应的文件签名 */
  private sessionFiles = new Map<string, string>();
  private lastPruneAt = 0;
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
    // 保持关注集合轻量（最多最近 25 个），被挤出去的连带清掉文件签名
    if (this.watchedSessionIds.size > 25) {
      const first = this.watchedSessionIds.values().next().value;
      if (first) this.dropWatch(first);
    }
    // 立即执行一次探测，确保外部刚写的内容立刻呈现在眼前
    void this.poll();
  }

  /** 收回对某会话的关注（session.forget 等回收路径调用），同步清掉文件签名 */
  unwatchSession(sessionId: string): void {
    this.dropWatch(sessionId);
  }

  private dropWatch(sessionId: string): void {
    this.watchedSessionIds.delete(sessionId);
    const file = this.sessionFiles.get(sessionId);
    if (file !== undefined) {
      this.sessionFiles.delete(sessionId);
      this.fileSignatures.delete(file);
    }
  }

  /**
   * 兜底清理（评审 P2）：forget 钩子之外（store 被外部清理等）也要能收回内存。
   * 每分钟对照一次 store 会话表：游标 Map / 关注集里已不存在的会话直接丢弃；
   * imp_ 隐式形态可能没有 store 行，仍在关注中的保留。
   */
  private pruneStale(): void {
    this.lastPruneAt = Date.now();
    const alive = new Set(this.store.listSessions().map((r) => r.id));
    for (const sid of [...this.watchedSessionIds]) {
      if (!alive.has(sid) && parseImplicitSessionId(sid) === null) this.dropWatch(sid);
    }
    for (const sid of [...sessionNativeSyncedCounts.keys()]) {
      if (alive.has(sid)) continue;
      if (sid.startsWith("imp_") && this.watchedSessionIds.has(sid)) continue;
      sessionNativeSyncedCounts.delete(sid);
    }
  }

  private async poll(): Promise<void> {
    if (this.syncing || this.watchedSessionIds.size === 0) return;
    this.syncing = true;
    try {
      if (Date.now() - this.lastPruneAt > 60_000) this.pruneStale();
      const wss = this.getWss();
      for (const sid of Array.from(this.watchedSessionIds)) {
        let bareExec = "";
        let cliRef = "";
        const s = this.store.getSession(sid);
        if (s !== undefined && s.cliRef !== null && s.cliRef !== "") {
          bareExec = s.runtimeId.replace(/^daemon:/, "");
          cliRef = s.cliRef;
        } else {
          const implicit = parseImplicitSessionId(sid);
          if (implicit !== null) {
            bareExec = implicit.executorId;
            cliRef = implicit.cliRef;
          }
        }
        if (!bareExec || !cliRef) continue;

        // 快路径：上一轮已定位过源文件时先 stat，签名没变就零读取。此前每 500ms
        // 对每个被关注会话做一次全量 readNativeSession（只为算签名）——大会话
        // （10MB+ 转录）同步解析要秒级，等于把 daemon 主循环卡成常数级停顿，
        // 前端所有 RPC 跟着遭殃。变了（或缓存失位）才走慢路径全量读。
        const knownFile = this.sessionFiles.get(sid);
        if (knownFile !== undefined) {
          try {
            const kst = statSync(knownFile);
            const ksig = `${kst.mtimeMs}_${kst.size}`;
            if (ksig === this.fileSignatures.get(knownFile)) continue;
          } catch {
            // 缓存的源文件没了（CLI 清理/迁移）：落到慢路径重新定位
          }
        }

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

        this.sessionFiles.set(sid, targetFile);
        const prevSig = this.fileSignatures.get(targetFile);
        if (prevSig === undefined) {
          this.fileSignatures.set(targetFile, sig);
          // 首次探测，执行一次对账确保不漏掉刚进来的新消息；
          // 刚读的 detail 直传，避免同一周期里再读一遍源数据
          await syncNativeSession(sid, this.store, this.traceSink, wss ?? undefined, detail);
          continue;
        }

        if (sig !== prevSig) {
          this.fileSignatures.set(targetFile, sig);
          await syncNativeSession(sid, this.store, this.traceSink, wss ?? undefined, detail);
        }
      }
    } finally {
      this.syncing = false;
    }
  }
}
