/**
 * BacklogEngine —— 待办的调度心脏：总状态机、心跳（硬过滤 + 心跳 agent 软决策）、
 * 提议生命周期（确认门）、执行派发与终态回灌、重启自愈（ADR-0001/0003）。
 *
 *   工作中 ──(无运行会话 + 距用户活动≥N分钟)──▶ 空闲
 *   空闲 ──(周期到)──▶ 跳动中 ──(心跳挑了一条)──▶ 待确认 ──(用户确认)──▶ 执行中
 *                                                  │(拒绝/超时)            │(跑完)
 *                                                  ▼                       ▼
 *                                                休眠/就绪               待验收 ──(验收)──▶ 完成/就绪
 *
 * 铁规则：
 * - 确认门 —— 引擎自己无权启动任何待办，只有 confirm()（用户动作）才派发。
 * - 单飞 —— 同时至多 1 条待办在执行（executing 对心跳即"忙"）。
 * - 跨重启 —— 提议、心跳簿记全部落 kv，重启自愈把 executing/awaiting_confirm 收口。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  BacklogConfig,
  BacklogItem,
  BacklogProposal,
  BacklogSignal,
  BacklogStateSnapshot,
  QuotaHeadroom,
  WorkPhase,
} from "../../../prototype/src/core/backlog.ts";
import type { BacklogRow, Store } from "../store/db.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import type { SessionId } from "../../../prototype/src/core/units.ts";
import { asModelId, asSessionId, asUnitId } from "../../../prototype/src/core/units.ts";
import { QuotaProbe } from "./probe.ts";
import { consolidateInboxes, type ConsolidateResult } from "./consolidate.ts";
import { log } from "../log.ts";

const TICK_MS = 20_000;
/** 心跳会话一跳的总预算：超时按沉默收场，绝不让一跳挂住调度器 */
const BEAT_BUDGET_MS = 3 * 60_000;
/**
 * 时间盒续跑提示词（对齐 ZCode 闲时任务的 OFF_PEAK_RESUME_PROMPT 语义，docs/23）：
 * 中断/失败后重新执行时 resume 原会话发这一句 —— 会话里带着原始目标与已完成
 * 进度，不从头交代，也不重复原 prompt。
 */
const BACKLOG_RESUME_PROMPT =
  "继续之前的任务，从中断处接着做，不要从头开始。先简要回顾已完成的部分，再完成剩余工作。";
const KV_PROPOSAL = "backlog.proposal";
const KV_HEARTBEAT = "backlog.heartbeat.status";
const KV_FORCE_BUSY = "backlog.forceBusy";
const KV_LAST_CONSOLIDATE = "backlog.consolidate.lastAt";

const HEARTBEAT_UNIT = "heartbeat";

interface HeartbeatLedger {
  lastBeatAt: number | null;
  lastBeatOutcome: string | null;
}

export interface BacklogEngineDeps {
  readonly store: Store;
  readonly host: RuntimeHost;
  readonly homeDir: string;
  readonly getConfig: () => BacklogConfig;
  readonly broadcast: (signal: BacklogSignal) => void;
  /** 出站通知（飞书）；未配置时是 no-op，实现方负责吞错 */
  readonly notify: (text: string) => Promise<void>;
  /** 收件箱统合要的 root → unit 映射 */
  readonly rootsWithUnits: () => Promise<Array<{ rootPath: string; unitId: string; unitName: string }>>;
  /** 心跳 bot 的主绑定（常驻 bot 的用户可改执行器/模型）——配置未显式指定时的兜底 */
  readonly heartbeatBinding?: () => Promise<{ runtimeId: string; model: string | null } | null>;
  /**
   * TUI 派发（待办 launchMode=terminal）：在前端 PTY 里以 yolo 拉起执行器 TUI
   * 并注入提示词，返回 autoterm_ 前缀的终端 id。终态不经 host —— 由 index.ts 的
   * 终端 exit 帧回调调 onTerminalExited() 回灌。未提供时 terminal 模式降级 headless。
   */
  readonly launchTerminal?: (opts: { runtimeId: string; unitId: string; rootPath: string; prompt: string }) => Promise<string>;
  /**
   * 对话页前台拉起（待办 launchMode=chat）：会话开好后广播 session.foreground，
   * 前端把它打开到聊天时间线。未提供时 chat 模式退化为纯后台（会话照跑，只是不跳前台）。
   */
  readonly foreground?: (sessionId: string, unitId: string, runtimeId: string, cause: "backlog", title?: string) => void;
}

export class BacklogEngine {
  private readonly probe: QuotaProbe;
  private timer: NodeJS.Timeout | null = null;
  /** 跳动中的内存旗（跨重启无意义：重启时那跳已经死了） */
  private beating = false;
  private activeProposal: BacklogProposal | null = null;
  private proposalTimer: NodeJS.Timeout | null = null;
  /** sessionId → { runId, itemId }：执行终态回灌（内存映射 + DB 收口，对齐 automation 模式） */
  private readonly runBySession = new Map<string, { runId: number; itemId: number }>();
  /** terminalId → { runId, itemId }：TUI 模式（无 host 会话）的运行记录靠 exit 帧结算 */
  private readonly runByTerminal = new Map<string, { runId: number; itemId: number }>();
  private lastSnapshot: BacklogStateSnapshot | null = null;
  private lastLedger: HeartbeatLedger = { lastBeatAt: null, lastBeatOutcome: null };
  /**
   * 闲时边沿武装位（对齐 ZCode 闲时任务「空闲即跑」的时机语义，docs/23）：
   * phase 从非 idle 跳进 idle 的那一拍置位，maybeBeat 见到它就放行周期门 ——
   * 任务跑完/用户离开达到阈值的那一刻就提议，不等下一个 intervalMinutes。
   * 消费即清零；beat 内的 idle 判定与确认门等全部护栏照旧（ADR-0001 不动）。
   */
  private idleEdgeArmed = false;

  constructor(private readonly deps: BacklogEngineDeps) {
    this.probe = new QuotaProbe(deps.homeDir);
    mkdirSync(path.join(deps.homeDir, HEARTBEAT_UNIT), { recursive: true });
  }

  // ---- 生命周期 -------------------------------------------------------------

  start(): void {
    if (this.timer !== null) return;
    this.restoreLedger();
    this.restoreProposal();
    this.heal();
    this.timer = setInterval(() => this.safeTick(), TICK_MS);
    this.timer.unref();
    log.info("backlog engine started", { tickMs: TICK_MS });
    this.pushState(true);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.proposalTimer !== null) clearTimeout(this.proposalTimer);
    this.proposalTimer = null;
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (err: unknown) {
      log.warn("backlog tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private tick(): void {
    // 1. 提议超时（到点即结算，不靠前端拉取驱动）
    if (this.activeProposal !== null && Date.now() >= this.activeProposal.expiresAt) this.expireProposal();
    // 2. 每日统合时刻
    this.maybeConsolidate();
    // 3. 状态重算与广播（有变化才推）
    this.pushState();
    // 4. 心跳判定（不 await —— tick 是同步的，跳动自己管自己）
    void this.maybeBeat();
    // 5. 闲时自动执行（autopilot）：有余量就持续清 ready+auto 的清单 —— 同样不 await
    void this.maybeAutopilot();
  }

  // ---- 总状态 ---------------------------------------------------------------

  private restoreLedger(): void {
    const raw = this.deps.store.kvGet(KV_HEARTBEAT);
    if (raw === undefined) return;
    try {
      this.lastLedger = { lastBeatAt: null, lastBeatOutcome: null, ...(JSON.parse(raw) as Partial<HeartbeatLedger>) };
    } catch {
      /* 坏行按空账本处理 */
    }
  }

  private saveLedger(patch: Partial<HeartbeatLedger>): void {
    this.lastLedger = { ...this.lastLedger, ...patch };
    try {
      this.deps.store.kvSet(KV_HEARTBEAT, JSON.stringify(this.lastLedger));
    } catch {
      /* 记账失败不致命：只是下次心跳可能提前一拍 */
    }
  }

  forceBusy(): boolean {
    return this.deps.store.kvGet(KV_FORCE_BUSY) === "1";
  }

  setForceBusy(on: boolean): void {
    if (on) this.deps.store.kvSet(KV_FORCE_BUSY, "1");
    else this.deps.store.kvSet(KV_FORCE_BUSY, "0");
    this.pushState(true);
  }

  /** 用户最近活动：与 curator 同口径（会话起止 + 最后一条消息的最大值）——保守方向 */
  private lastUserActivityAt(): number {
    const rows = this.deps.store.listSessions();
    let max = 0;
    for (const r of rows) max = Math.max(max, r.startedAt, r.endedAt ?? 0);
    return Math.max(max, this.deps.store.latestMessageAt());
  }

  private computePhase(cfg: BacklogConfig): { phase: WorkPhase; reason: string; lastActivity: number } {
    const items = this.deps.store.listBacklogItems();
    const lastActivity = this.lastUserActivityAt();
    if (this.forceBusy()) return { phase: "busy", reason: "用户手动强制忙碌", lastActivity };
    if (this.beating) return { phase: "beating", reason: "心跳 agent 正在评估待办", lastActivity };
    if (this.activeProposal !== null) {
      return { phase: "awaiting_confirm", reason: `提议挂起：「${this.activeProposal.title}」等用户确认`, lastActivity };
    }
    if (items.some((i) => i.status === "executing")) {
      const run = items.find((i) => i.status === "executing");
      return { phase: "executing", reason: `长任务执行中：「${run!.title}」`, lastActivity };
    }
    if (items.some((i) => i.status === "awaiting_review")) {
      return { phase: "awaiting_review", reason: "有待验收的产出 —— 验收后心跳恢复", lastActivity };
    }
    const running = this.deps.host.listSessions().filter(
      (s) => s.status === "running" || s.status === "awaiting_permission" || s.status === "awaiting_input",
    );
    if (running.length > 0) {
      return { phase: "busy", reason: `${running.length} 个会话运行中`, lastActivity };
    }
    const idleMs = Date.now() - lastActivity;
    if (idleMs < cfg.heartbeat.idleMinutes * 60_000) {
      return { phase: "busy", reason: `最近活动 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟前（空闲阈值 ${cfg.heartbeat.idleMinutes} 分钟）`, lastActivity };
    }
    return { phase: "idle", reason: "空闲：无运行任务且超过空闲阈值", lastActivity };
  }

  /** 状态快照（变化才广播；force=true 强推一次，启动/强制忙碌切换用） */
  private pushState(force = false): BacklogStateSnapshot {
    const cfg = this.deps.getConfig();
    const { phase, reason, lastActivity } = this.computePhase(cfg);
    const nextBeat =
      phase === "idle" && cfg.heartbeat.enabled
        ? Math.max(Date.now(), (this.lastLedger.lastBeatAt ?? 0) + cfg.heartbeat.intervalMinutes * 60_000)
        : null;
    const snap: BacklogStateSnapshot = {
      phase,
      reason,
      lastUserActivityAt: lastActivity,
      idleMinutes: cfg.heartbeat.idleMinutes,
      forceBusy: this.forceBusy(),
      heartbeatEnabled: cfg.heartbeat.enabled,
      nextBeatAt: nextBeat,
      lastBeatAt: this.lastLedger.lastBeatAt,
      lastBeatOutcome: this.lastLedger.lastBeatOutcome,
    };
    if (force || this.lastSnapshot === null || this.lastSnapshot.phase !== snap.phase || this.lastSnapshot.reason !== snap.reason) {
      // 闲时边沿检测放在广播分支之外也要做（phase 没变时 lastSnapshot 也在更新）：
      // 判定用的是更新前的缓存，跳变发生在这一拍
      const enteredIdle = this.lastSnapshot !== null && this.lastSnapshot.phase !== "idle" && snap.phase === "idle";
      this.lastSnapshot = snap;
      this.deps.broadcast({ kind: "state", snapshot: snap });
      if (enteredIdle) this.idleEdgeArmed = true;
    } else {
      // phase/reason 没变也更新缓存（nextBeat/lastOutcome 会动）
      this.lastSnapshot = snap;
    }
    return snap;
  }

  snapshot(): BacklogStateSnapshot {
    return this.pushState();
  }

  // ---- 心跳 -----------------------------------------------------------------

  private async maybeBeat(): Promise<void> {
    const cfg = this.deps.getConfig();
    if (!cfg.heartbeat.enabled) {
      this.idleEdgeArmed = false;
      return;
    }
    if (this.beating || this.activeProposal !== null) return;
    const last = this.lastLedger.lastBeatAt ?? 0;
    // 闲时边沿放行：刚进入 idle 的那一拍不等周期（周期门只在常规轮询时生效）
    if (Date.now() - last < cfg.heartbeat.intervalMinutes * 60_000 && !this.idleEdgeArmed) return;
    this.idleEdgeArmed = false;
    await this.beat(false);
  }

  /** 手动触发一跳（测试/演示）：跳过周期与空闲判定，其余护栏照旧 */
  forceBeat(): Promise<void> {
    return this.beat(true);
  }

  // ---- 闲时自动执行（autopilot）-------------------------------------------------
  //
  // 「用量还有富余就持续把清单做完」的引擎面：空闲（无运行会话 + 超过空闲阈值）
  // 且余量 ≥ 地板时，直接派发下一条 ready + auto 的待办 —— 不进确认门（auto 条目
  // 的语义就是托管执行，确认门留给非 auto 条目的心跳提议），跑完自动验收。
  // 与心跳的分工：auto 条目不进心跳候选（免得同一批任务又被提议一遍）。

  /** 派发中的内存旗：tick 每 20s 一拍，派发是异步的，防同拍重入 */
  private autopilotBusy = false;

  private async maybeAutopilot(): Promise<void> {
    const cfg = this.deps.getConfig();
    const ap = cfg.autopilot;
    if (!ap.enabled) return;
    if (this.autopilotBusy || this.beating || this.activeProposal !== null) return;
    if (this.forceBusy()) return;
    // 空闲判定与心跳同口径：无运行会话 + 距用户最近活动 ≥ idleMinutes
    const lastActivity = this.lastUserActivityAt();
    if (Date.now() - lastActivity < cfg.heartbeat.idleMinutes * 60_000) return;
    const running = this.deps.host.listSessions().filter(
      (s) => s.status === "running" || s.status === "awaiting_permission" || s.status === "awaiting_input",
    );
    const executing = this.deps.store.listBacklogItems().filter((i) => i.status === "executing");
    if (running.length > 0 || executing.length >= Math.max(1, ap.maxConcurrent)) return;
    // 清单顺序即优先级（listBacklogItems 已按 sortPos 升序，done 沉底）——取第一条
    const next = this.deps.store.listBacklogItems().find((i) => i.status === "ready" && i.auto);
    if (next === undefined) return;
    // 余量门：指定了执行器就看它，没指定就在订阅执行器里挑剩余最多的
    const quotas = await this.probe.readAll(cfg.runtimes);
    const pick = pickAutopilotRuntime(next.runtimeId, quotas, ap.headroomFloorPercent);
    if (pick === null) {
      this.saveLedger({ lastBeatOutcome: "autopilot:no-headroom" });
      return;
    }
    this.autopilotBusy = true;
    try {
      await this.dispatch(next, pick, next.model, "autopilot");
      log.info("backlog autopilot dispatched", { itemId: next.id, runtimeId: pick });
    } catch (err: unknown) {
      // dispatch 失败已把条目回 ready 并挂 lastError —— 下一拍再试（连续失败靠
      // lastError 在 UI 上可见，不进休眠：闲时自动执行没有提议可忽略）
      log.warn("backlog autopilot dispatch failed", { itemId: next.id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.autopilotBusy = false;
      this.pushState(true);
    }
  }

  /**
   * 心跳会话跑在哪：backlog 配置显式指定（设置面板）优先，
   * 没指定就读常驻心跳 bot 的主绑定（bot 设置页改绑定即生效）。
   */
  private async resolveHeartbeatRuntime(cfg: BacklogConfig): Promise<{ runtimeId: string; model: string | null }> {
    if (cfg.heartbeat.runtimeId !== "") {
      return { runtimeId: cfg.heartbeat.runtimeId, model: cfg.heartbeat.model };
    }
    try {
      const binding = (await this.deps.heartbeatBinding?.()) ?? null;
      if (binding !== null && binding.runtimeId !== "") return binding;
    } catch {
      /* bot 注册表暂不可达（启动早期）按未配置处理 */
    }
    return { runtimeId: "", model: null };
  }

  private async beat(force = false): Promise<void> {
    if (this.beating) return; // 单飞
    // 任何一跳（含手动 forceBeat）都消费闲时边沿：否则手动跳完，挂着的
    // armed 位会让下一拍绕过周期门再跳一次（双跳）
    this.idleEdgeArmed = false;
    // 硬过滤（ADR-0003）：规则层一分钱不花。
    // 强制忙碌压倒一切自动与手动判定（共识 Q18），最先判；
    // 挂起提议/执行中/待验证对心跳即"忙"。
    const snap = this.pushState(true);
    if (snap.forceBusy) {
      this.saveLedger({ lastBeatAt: Date.now(), lastBeatOutcome: "skipped:forceBusy" });
      this.pushState();
      return;
    }
    const cfg = this.deps.getConfig();
    const { runtimeId, model } = await this.resolveHeartbeatRuntime(cfg);
    if (runtimeId === "") {
      this.saveLedger({ lastBeatAt: Date.now(), lastBeatOutcome: "failed:未配置心跳执行器（设置面板或心跳 bot 绑定其一）" });
      this.pushState();
      return;
    }
    const busyLike =
      this.activeProposal !== null || snap.phase === "awaiting_confirm" || snap.phase === "executing" || snap.phase === "awaiting_review";
    if (busyLike || (!force && snap.phase !== "idle")) {
      this.saveLedger({ lastBeatAt: Date.now(), lastBeatOutcome: `skipped:${snap.phase}` });
      this.pushState();
      return;
    }
    // 单飞与挂起提案在 phase 里已体现（executing/awaiting_confirm/awaiting_review 都不是 idle）
    // auto 条目不进心跳候选：它们归 autopilot 托管执行，再提议一遍是打扰
    const ready = this.deps.store.listBacklogItems().filter((i) => i.status === "ready" && !i.auto);
    this.saveLedger({ lastBeatAt: Date.now() });
    this.beating = true;
    this.pushState(true);
    try {
      if (ready.length === 0) {
        this.saveLedger({ lastBeatOutcome: "no-candidates" });
        return;
      }
      const quotas = await this.probe.readAll(cfg.runtimes);
      const answer = await this.runHeartbeatSession(cfg, ready, quotas, runtimeId, model);
      if (answer === null) {
        this.saveLedger({ lastBeatOutcome: "silence" });
        return;
      }
      if (answer["action"] !== "propose") {
        const why = typeof answer["message"] === "string" ? answer["message"].slice(0, 80) : "";
        this.saveLedger({ lastBeatOutcome: `silence${why === "" ? "" : `:${why}`}` });
        return;
      }
      const itemId = Number(answer["itemId"]);
      const item = ready.find((i) => i.id === itemId);
      if (item === undefined) {
        this.saveLedger({ lastBeatOutcome: `failed:心跳选了不存在/非就绪的待办 #${itemId}` });
        return;
      }
      await this.openProposal(cfg, item, quotas, {
        message: typeof answer["message"] === "string" ? answer["message"] : "",
        estimate: typeof answer["estimate"] === "string" ? answer["estimate"] : null,
        suggestedRuntimeId: typeof answer["suggestedRuntimeId"] === "string" ? answer["suggestedRuntimeId"] : null,
      });
      this.saveLedger({ lastBeatOutcome: `proposed:#${itemId}` });
    } catch (err: unknown) {
      this.saveLedger({ lastBeatOutcome: `failed:${err instanceof Error ? err.message : String(err)}` });
      log.warn("backlog beat failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.beating = false;
      this.pushState(true);
    }
  }

  /** 起心跳会话并等轮落定，返回解析出的 JSON 决策（null = 沉默/解析失败） */
  private async runHeartbeatSession(
    cfg: BacklogConfig,
    ready: BacklogRow[],
    quotas: QuotaHeadroom[],
    runtimeId: string,
    model: string | null,
  ): Promise<Record<string, unknown> | null> {
    const quotaLines = quotas.map((q) => `- ${q.runtimeId}：${q.percent !== null ? `剩余 ${q.percent}%` : "余量未知"}${q.resetsAt !== null ? `（${new Date(q.resetsAt).toLocaleString("zh-CN")} 重置）` : ""}${q.summary !== null ? ` — ${q.summary}` : ""}`);
    const itemLines = ready.map(
      (i) =>
        `#${i.id}【${i.size === "big" ? "大" : i.size === "small" ? "小" : "中"}】${i.title}\n目标：${i.goal}` +
        `${i.lastError !== null ? `\n上次失败：${i.lastError}` : ""}${i.lastRunAt !== null ? `\n上次运行：${new Date(i.lastRunAt).toLocaleString("zh-CN")}` : ""}`,
    );
    const prompt = [
      "你是 agent-workbench 的心跳 agent。当前工作台空闲，以下是待办清单与各订阅执行器的剩余用量。",
      "",
      "## 待办清单（按用户排序即优先级，从上往下）",
      ...itemLines,
      "",
      "## 执行器余量",
      ...(quotaLines.length > 0 ? quotaLines : ["（没有配置订阅执行器余量）"]),
      "",
      "## 你的任务",
      "从清单中挑出此刻最值得启动的一条（综合考虑：余量是否够、任务大小、上次结果），或判断本轮都不合适。",
      "只输出一个 JSON 对象，不要输出任何其他文字：",
      '{"action":"propose","itemId":编号,"message":"一句话说明为什么现在跑它","suggestedRuntimeId":"执行器id","estimate":"余量够不够的一句话预估"}',
      "或",
      '{"action":"silence","message":"一句话原因"}',
    ].join("\n");

    const texts: string[] = [];
    // 订阅在 onSessionReady 回调里挂（startSession 返回前事件就可能到），
    // 所以用对象壳子持有退订函数 —— 直接 let 会被控制流分析收窄成 null/never
    const unsubRef: { fn: (() => void) | null } = { fn: null };
    const session = await this.deps.host.startSession({
      runtimeId,
      unitId: asUnitId(HEARTBEAT_UNIT),
      unitName: "心跳",
      rootPath: path.join(this.deps.homeDir, HEARTBEAT_UNIT),
      prompt,
      model: model === null || model === "" ? null : asModelId(model),
      source: "automation",
      onSessionReady: (id) => {
        unsubRef.fn = this.deps.host.onSessionEvent(id, "message.completed", (e) => {
          if (e.type === "message.completed") texts.push(e.text);
        });
      },
    });
    try {
      await this.awaitTurnEnd(session.id, BEAT_BUDGET_MS);
    } finally {
      unsubRef.fn?.();
    }
    const last = texts.at(-1) ?? "";
    return extractJson(last);
  }

  /** 等心跳轮落定：session.ended（一次性执行器）或 status idle/failed（ACP agent-loop），加总超时兜底 */
  private awaitTurnEnd(sessionId: SessionId, timeoutMs: number): Promise<void> {
    // 前置检查：快执行器可能在订阅前就已 ended（订阅晚一步就永远等不到事件），
    // 已终态直接返回，不烧满整个预算
    const persisted = this.deps.store.getSession(sessionId);
    if (persisted !== undefined && persisted.endedAt !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve();
      };
      const unsub = this.deps.host.onSessionEvent(sessionId, "", (event) => {
        if (event.type === "session.ended") finish();
        else if (event.type === "session.status" && (event.status === "idle" || event.status.startsWith("failed"))) {
          // ACP 系会话轮落定但进程常开：留半秒收尾流再收卷
          setTimeout(finish, 500);
        }
      });
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }

  // ---- 提议生命周期 ----------------------------------------------------------

  private async openProposal(
    cfg: BacklogConfig,
    item: BacklogRow,
    quotas: QuotaHeadroom[],
    agent: { message: string; estimate: string | null; suggestedRuntimeId: string | null },
  ): Promise<void> {
    const now = Date.now();
    const proposal: BacklogProposal = {
      id: `bp-${now.toString(36)}`,
      itemId: item.id,
      title: item.title,
      prompt: item.prompt,
      message: agent.message === "" ? `空闲窗口适合启动「${item.title}」` : agent.message,
      estimate: agent.estimate,
      suggestedRuntimeId: agent.suggestedRuntimeId,
      quotas,
      createdAt: now,
      expiresAt: now + cfg.heartbeat.proposalTimeoutMinutes * 60_000,
    };
    this.activeProposal = proposal;
    this.deps.store.updateBacklogItem(item.id, { status: "awaiting_confirm", lastProposedAt: now });
    this.deps.store.kvSet(KV_PROPOSAL, JSON.stringify(proposal));
    this.armProposalTimeout();
    this.deps.broadcast({ kind: "proposal", proposal });
    this.deps.broadcast({ kind: "items" });
    void this.deps.notify(
      `【待办提议】${item.title}\n${proposal.message}\n${agent.estimate ?? ""}\n执行器余量：${quotas
        .map((q) => `${q.runtimeId} ${q.percent !== null ? `${q.percent}%` : "未知"}`)
        .join("、")}\n回工作台确认，或回复「确认 ${item.id}」/「拒绝 ${item.id}」`,
    );
    log.info("backlog proposal opened", { itemId: item.id, proposalId: proposal.id });
  }

  /** 恢复挂起的提议（重启自愈）：过期直接结算，没过期重新挂超时 */
  private restoreProposal(): void {
    const raw = this.deps.store.kvGet(KV_PROPOSAL);
    if (raw === undefined) return;
    try {
      const p = JSON.parse(raw) as BacklogProposal;
      const item = this.deps.store.getBacklogItem(p.itemId);
      if (item === undefined || item.status !== "awaiting_confirm") {
        this.deps.store.kvSet(KV_PROPOSAL, ""); // kv 无删除，写空串当删
        return;
      }
      this.activeProposal = p;
      if (Date.now() >= p.expiresAt) {
        this.expireProposal();
      } else {
        this.armProposalTimeout();
        log.info("backlog proposal restored", { itemId: p.itemId, expiresAt: p.expiresAt });
      }
    } catch {
      this.deps.store.kvSet(KV_PROPOSAL, "");
    }
  }

  private armProposalTimeout(): void {
    if (this.proposalTimer !== null) clearTimeout(this.proposalTimer);
    const p = this.activeProposal;
    if (p === null) return;
    const ms = Math.max(1000, p.expiresAt - Date.now());
    this.proposalTimer = setTimeout(() => {
      if (this.activeProposal?.id === p.id) this.expireProposal();
    }, ms);
    this.proposalTimer.unref?.();
  }

  /** 结算提议并清场（所有终态共用） */
  private settleProposal(decision: "confirmed" | "rejected" | "expired"): BacklogProposal | null {
    const p = this.activeProposal;
    if (p === null) return null;
    this.activeProposal = null;
    if (this.proposalTimer !== null) {
      clearTimeout(this.proposalTimer);
      this.proposalTimer = null;
    }
    this.deps.store.kvSet(KV_PROPOSAL, "");
    this.deps.broadcast({ kind: "settled", proposalId: p.id, itemId: p.itemId, decision });
    return p;
  }

  /** 超时 = 本次忽略：连续忽略达到上限进休眠 */
  private expireProposal(): void {
    const p = this.settleProposal("expired");
    if (p === null) return;
    const item = this.deps.store.getBacklogItem(p.itemId);
    if (item === undefined || item.status !== "awaiting_confirm") return;
    const cfg = this.deps.getConfig();
    const ignores = item.ignoreCount + 1;
    if (ignores >= cfg.heartbeat.maxIgnoreCount) {
      this.deps.store.updateBacklogItem(item.id, { status: "sleeping", ignoreCount: ignores });
    } else {
      this.deps.store.updateBacklogItem(item.id, { status: "ready", ignoreCount: ignores });
    }
    this.deps.broadcast({ kind: "items" });
    this.pushState(true);
    log.info("backlog proposal expired", { itemId: item.id, ignores });
  }

  proposal(): BacklogProposal | null {
    return this.activeProposal;
  }

  /** 确认门 —— 用户动作触发执行。执行器可在此改选（记忆回待办）。 */
  async confirm(opts: { runtimeId?: string; model?: string | null } = {}): Promise<{ runId: number; sessionId: string }> {
    const p = this.activeProposal;
    if (p === null) throw Object.assign(new Error("当前没有挂起的提议"), { code: "no_proposal" });
    const item = this.deps.store.getBacklogItem(p.itemId);
    if (item === undefined || item.status !== "awaiting_confirm") {
      this.settleProposal("expired");
      throw Object.assign(new Error("提议对应的待办已不在待确认状态"), { code: "stale_proposal" });
    }
    const chosen = opts.runtimeId ?? item.runtimeId ?? p.suggestedRuntimeId ?? "";
    if (chosen === "") throw Object.assign(new Error("没有可用的执行器（先在待办或设置里选一个）"), { code: "no_runtime" });
    this.settleProposal("confirmed");
    try {
      const r = await this.dispatch(item, chosen, opts.model ?? item.model);
      void this.deps.notify(`已确认启动：「${item.title}」（${chosen}）`);
      return r;
    } catch (err: unknown) {
      // 派发失败：提议已结算，待办回就绪并挂错误，下次心跳还可能再问
      const message = err instanceof Error ? err.message : String(err);
      this.deps.store.updateBacklogItem(item.id, { status: "ready", lastError: `派发失败：${message}` });
      this.deps.broadcast({ kind: "items" });
      this.pushState(true);
      throw err;
    }
  }

  /** 明确拒绝 = 直接休眠（用户说不要就是不要） */
  reject(): void {
    const p = this.settleProposal("rejected");
    if (p === null) return;
    const item = this.deps.store.getBacklogItem(p.itemId);
    if (item !== undefined && item.status === "awaiting_confirm") {
      this.deps.store.updateBacklogItem(item.id, { status: "sleeping" });
      this.deps.broadcast({ kind: "items" });
    }
    this.pushState(true);
  }

  /** 飞书入站关键词 → 确认/拒绝。命中返回 true（网关就不再把这条消息交给 bot 会话）。 */
  async handleInboundText(text: string): Promise<boolean> {
    const p = this.activeProposal;
    if (p === null) return false;
    const t = text.trim();
    const yes = new RegExp(`^(确认|确认执行|跑吧?|可以|ok|好)[：:\\s]*(${p.itemId})?$`, "i").test(t);
    const no = new RegExp(`^(拒绝|不跑|不要|先不|算了)[：:\\s]*(${p.itemId})?$`, "i").test(t);
    if (!yes && !no) return false;
    if (yes) {
      await this.confirm({});
      return true;
    }
    this.reject();
    return true;
  }

  // ---- 执行派发与终态回灌 ----------------------------------------------------

  /** 派发一条待办。terminal 模式：前端 PTY 拉执行器 TUI（yolo 免审批，人可看可插手），
   *  终态由终端 exit 帧回灌；chat / headless：复用 automation 的会话语义
   *  （source=automation → 权限全放行，deny 仍优先），chat 额外把前端拉到该会话。 */
  async dispatch(item: BacklogRow, runtimeId: string, model: string | null, trigger: "gtd" | "manual" | "autopilot" = "gtd"): Promise<{ runId: number; sessionId: string }> {
    if (item.launchMode === "terminal" && this.deps.launchTerminal !== undefined) {
      const runId = this.deps.store.startBacklogRun(item.id, null, runtimeId, trigger);
      this.deps.store.updateBacklogItem(item.id, { status: "executing", runtimeId, model, lastError: null, lastRunAt: Date.now() });
      this.deps.broadcast({ kind: "items" });
      try {
        const terminalId = await this.deps.launchTerminal({
          runtimeId,
          unitId: item.unitId,
          rootPath: item.rootPath,
          prompt: item.prompt,
        });
        this.deps.store.setBacklogRunSession(runId, terminalId);
        this.runByTerminal.set(terminalId, { runId, itemId: item.id });
        log.info("backlog item dispatched to terminal", { itemId: item.id, runId, terminalId, runtimeId });
        return { runId, sessionId: terminalId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.store.finishBacklogRun(runId, "failed", message);
        this.deps.store.updateBacklogItem(item.id, { status: "ready", lastError: message });
        this.deps.broadcast({ kind: "items" });
        throw err;
      }
    }

    const runId = this.deps.store.startBacklogRun(item.id, null, runtimeId, trigger);
    this.deps.store.updateBacklogItem(item.id, { status: "executing", runtimeId, model, lastError: null, lastRunAt: Date.now() });
    this.deps.broadcast({ kind: "items" });
    try {
      // 显式指定会话（清单升级的可选项）：接得上就往那个会话里发 prompt，
      // 接不上（记录缺失/换过执行器/无法续）回落新开 —— 指定是尽力而为不是硬约束
      const explicit = item.targetSessionId ?? null;
      // 时间盒续跑（docs/23）：上次失败且会话接得回来 → resume 原会话发续跑
      // 提示词，不从头开始；首跑 / 上次成功 / TUI 中断 / 换过执行器都走新开
      const resumeSid = this.resumeTargetFor(item.id, runtimeId);
      let sessionId: string;
      if (explicit !== null && explicit !== "" && this.explicitSessionResumable(explicit, runtimeId)) {
        if (!this.deps.host.isLive(asSessionId(explicit))) this.deps.host.resumeSession(asSessionId(explicit));
        this.deps.host.sendMessage(asSessionId(explicit), item.prompt, undefined, undefined, "automation");
        sessionId = explicit;
        log.info("backlog item dispatched to specified session", { itemId: item.id, runId, sessionId });
      } else if (resumeSid !== null) {
        this.deps.host.resumeSession(asSessionId(resumeSid));
        this.deps.host.sendMessage(asSessionId(resumeSid), BACKLOG_RESUME_PROMPT, undefined, undefined, "automation");
        sessionId = resumeSid;
        log.info("backlog item resumed previous session", { itemId: item.id, runId, sessionId });
      } else {
        const session = await this.deps.host.startSession({
          runtimeId,
          unitId: asUnitId(item.unitId),
          unitName: item.unitName,
          rootPath: item.rootPath,
          prompt: item.prompt,
          model: model === null || model === "" ? null : asModelId(model),
          mode: (item.mode ?? undefined) as "plan" | "build" | "edit" | "yolo" | undefined,
          source: "automation",
        });
        sessionId = String(session.id);
      }
      this.deps.store.setBacklogRunSession(runId, sessionId);
      // 快执行器可能在 startSession 的 promise 落定前就已 ended（automation 同款坑）
      const ended = this.deps.store.getSession(sessionId);
      if (ended !== undefined && ended.endedAt !== null) {
        const failed = ended.status === "failed";
        this.deps.store.finishBacklogRun(runId, failed ? "failed" : "done", `ended: ${ended.status}`);
        this.settleExecution(item.id, failed ? "failed" : "done", `ended: ${ended.status}`);
      } else {
        this.runBySession.set(sessionId, { runId, itemId: item.id });
      }
      // 对话页形态：把会话拉到前端聊天页前台（chat 与 headless 共用上面的派发路径）
      if (item.launchMode === "chat") this.deps.foreground?.(sessionId, item.unitId, runtimeId, "backlog", item.title);
      log.info("backlog item dispatched", { itemId: item.id, runId, sessionId, runtimeId });
      return { runId, sessionId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.store.finishBacklogRun(runId, "failed", message);
      this.deps.store.updateBacklogItem(item.id, { status: "ready", lastError: message });
      this.deps.broadcast({ kind: "items" });
      throw err;
    }
  }

  /**
   * 时间盒续跑判定（docs/23）：最近一次运行失败、sessionId 是真会话（autoterm_
   * 前缀 = TUI 运行，随 daemon 进程死，无会话可续）、执行器没换过、且接得回来
   * （live 或有 cli_ref）→ 返回该会话 id；否则 null（首跑 / 上次成功 / TUI 中断 /
   * 换执行器 / 接不回都走新开）。
   */
  private resumeTargetFor(itemId: number, runtimeId: string): string | null {
    const last = this.deps.store.latestBacklogRun(itemId);
    if (last === undefined || last.status !== "failed") return null;
    const sid = last.sessionId;
    if (sid === null || sid.startsWith("autoterm_")) return null;
    const row = this.deps.store.getSession(sid);
    if (row === undefined) return null;
    // 会话是执行器私有的：换了执行器还 resume 老会话 = 把续跑指令发进另一家的上下文
    if (row.runtimeId !== runtimeId) return null;
    if (!this.deps.host.isLive(asSessionId(sid)) && row.cliRef === null) return null;
    return sid;
  }

  /** 显式指定会话的「接得上」判定（与 resumeTargetFor 同口径，但不看上次成败） */
  private explicitSessionResumable(sessionId: string, runtimeId: string): boolean {
    const row = this.deps.store.getSession(asSessionId(sessionId));
    if (row === undefined) return false;
    if (row.runtimeId !== runtimeId) return false;
    return this.deps.host.isLive(asSessionId(sessionId)) || row.cliRef !== null;
  }

  /**
   * 执行终态收口：done → 待验收；failed → 回就绪挂错误。
   * auto 条目且 autopilot.autoReview 开：done 直接关闭（托管执行的语义就是
   * 无人值守跑完即结 —— 否则清单会被待验收积压卡住，闲时循环停摆）。
   */
  private settleExecution(itemId: number, status: "done" | "failed", detail: string): void {
    const item = this.deps.store.getBacklogItem(itemId);
    if (item === undefined || item.status !== "executing") return;
    const autoReview = item.auto && this.deps.getConfig().autopilot.autoReview;
    if (status === "done") {
      this.deps.store.updateBacklogItem(itemId, { status: autoReview ? "done" : "awaiting_review", lastError: null });
    } else {
      this.deps.store.updateBacklogItem(itemId, { status: "ready", lastError: `执行失败：${detail}` });
    }
    this.deps.broadcast({ kind: "items" });
    this.pushState(true);
    const title = item.title;
    void this.deps.notify(
      status === "done"
        ? autoReview
          ? `【清单任务完成】「${title}」已自动执行完毕（闲时托管）`
          : `【待办完成待验收】「${title}」跑完了 —— 回工作台看产出并验收`
        : `【待办失败】「${title}」：${detail}（已回就绪，下次心跳可能再提议）`,
    );
  }

  /** index.ts 的 broadcast 回调调这里：会话终态回灌 */
  onSessionEnded(sessionId: string, reason: string): void {
    const hit = this.runBySession.get(sessionId);
    if (hit === undefined) return;
    this.runBySession.delete(sessionId);
    const failed = reason === "error" || reason === "executor_exited";
    this.deps.store.finishBacklogRun(hit.runId, failed ? "failed" : "done", `ended: ${reason}`);
    this.settleExecution(hit.itemId, failed ? "failed" : "done", `ended: ${reason}`);
  }

  /** index.ts 的终端 exit 帧回调调这里：TUI 模式运行记录与待办状态机收口 */
  onTerminalExited(terminalId: string, exitCode: number): void {
    const hit = this.runByTerminal.get(terminalId);
    if (hit === undefined) return;
    this.runByTerminal.delete(terminalId);
    const ok = exitCode === 0;
    this.deps.store.finishBacklogRun(hit.runId, ok ? "done" : "failed", `terminal exit ${exitCode}`);
    this.settleExecution(hit.itemId, ok ? "done" : "failed", `terminal exit ${exitCode}`);
  }

  /** 重启自愈：running 的运行记录按会话台账收口；awaiting_confirm 无提议的行回就绪 */
  private heal(): void {
    let settled = 0;
    let reattached = 0;
    for (const r of this.deps.store.listRunningBacklogRuns()) {
      if (r.sessionId === null) {
        this.deps.store.finishBacklogRun(r.runId, "failed", "daemon 重启前未完成派发");
        const it = this.deps.store.getBacklogItem(r.itemId);
        if (it !== undefined && it.status === "executing") {
          this.deps.store.updateBacklogItem(r.itemId, { status: "ready", lastError: "daemon 重启中断了派发" });
        }
        settled++;
        continue;
      }
      // TUI 模式：session_id 列存的是 autoterm_ 前缀的终端 id。PTY 随 daemon 进程
      // 一起死了，重启后不可能还活着 —— 按中断收口、待办回就绪。
      if (r.sessionId.startsWith("autoterm_")) {
        this.deps.store.finishBacklogRun(r.runId, "failed", "daemon 重启，终端已随进程关闭");
        const it = this.deps.store.getBacklogItem(r.itemId);
        if (it !== undefined && it.status === "executing") {
          this.deps.store.updateBacklogItem(r.itemId, { status: "ready", lastError: "daemon 重启，终端已随进程关闭" });
        }
        settled++;
        continue;
      }
      const s = this.deps.store.getSession(r.sessionId);
      if (s === undefined) {
        this.deps.store.finishBacklogRun(r.runId, "failed", "daemon 重启后会话记录缺失");
        settled++;
        continue;
      }
      if (s.endedAt !== null) {
        const failed = s.status === "failed";
        this.deps.store.finishBacklogRun(r.runId, failed ? "failed" : "done", `ended: ${s.status}`);
        const it = this.deps.store.getBacklogItem(r.itemId);
        if (it !== undefined && it.status === "executing") {
          this.deps.store.updateBacklogItem(r.itemId, failed
            ? { status: "ready", lastError: `重启前会话已失败：${s.status}` }
            : { status: "awaiting_review" });
        }
        settled++;
        continue;
      }
      this.runBySession.set(r.sessionId, { runId: r.runId, itemId: r.itemId });
      reattached++;
    }
    // awaiting_confirm 但提议 kv 丢失（restoreProposal 没接上）的孤儿行：回就绪
    for (const it of this.deps.store.listBacklogItems()) {
      if (it.status !== "awaiting_confirm") continue;
      if (this.activeProposal !== null && this.activeProposal.itemId === it.id) continue;
      this.deps.store.updateBacklogItem(it.id, { status: "ready" });
      settled++;
    }
    if (settled > 0 || reattached > 0) log.info("backlog runs healed after restart", { settled, reattached });
  }

  // ---- 验收与手动动作 ---------------------------------------------------------

  /** 验收：通过 → done；打回 → ready（重新排队，下次心跳照常可再提议），可附一句话备注 */
  review(itemId: number, pass: boolean, note: string | null): void {
    const item = this.deps.store.getBacklogItem(itemId);
    if (item === undefined) throw Object.assign(new Error(`没有这个待办：${itemId}`), { code: "unknown_item" });
    if (item.status !== "awaiting_review") {
      throw Object.assign(new Error(`待办「${item.title}」不在待验收状态`), { code: "bad_state" });
    }
    this.deps.store.updateBacklogItem(itemId, {
      status: pass ? "done" : "ready",
      reviewNote: note,
      ...(pass ? {} : { ignoreCount: 0 }),
    });
    this.deps.broadcast({ kind: "items" });
    this.pushState(true);
  }

  wake(itemId: number): void {
    const item = this.deps.store.getBacklogItem(itemId);
    if (item === undefined) throw Object.assign(new Error(`没有这个待办：${itemId}`), { code: "unknown_item" });
    this.deps.store.updateBacklogItem(itemId, { status: "ready", ignoreCount: 0 });
    this.deps.broadcast({ kind: "items" });
    this.pushState();
  }

  sleep(itemId: number): void {
    const item = this.deps.store.getBacklogItem(itemId);
    if (item === undefined) throw Object.assign(new Error(`没有这个待办：${itemId}`), { code: "unknown_item" });
    if (item.status === "executing") throw Object.assign(new Error("执行中的待办不能休眠 —— 先等它跑完或去会话里停掉"), { code: "bad_state" });
    this.deps.store.updateBacklogItem(itemId, { status: "sleeping" });
    this.deps.broadcast({ kind: "items" });
  }

  // ---- 余量 -------------------------------------------------------------------

  quotas(refresh = false): Promise<QuotaHeadroom[]> {
    const cfg = this.deps.getConfig();
    if (!refresh) return this.probe.readAll(cfg.runtimes);
    // refresh：逐个强制刷新
    return Promise.all(
      Object.entries(cfg.runtimes)
        .filter(([, c]) => c.subscribed)
        .map(async ([id, c]) => this.probe.read(id, c, { refresh: true })),
    );
  }

  // ---- 收件箱统合 -------------------------------------------------------------

  private maybeConsolidate(): void {
    const cfg = this.deps.getConfig();
    if (!cfg.consolidate.enabled) return;
    const now = new Date();
    const todayMinutes = now.getHours() * 60 + now.getMinutes();
    if (todayMinutes < cfg.consolidate.atMinutes) return;
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (this.deps.store.kvGet(KV_LAST_CONSOLIDATE) === todayKey) return;
    this.deps.store.kvSet(KV_LAST_CONSOLIDATE, todayKey);
    void this.consolidate(false)
      .then((r) => log.info("backlog inbox consolidated", { ...r }))
      .catch((err: unknown) => log.warn("backlog consolidation failed", { error: err instanceof Error ? err.message : String(err) }));
  }

  async consolidate(force: boolean): Promise<ConsolidateResult> {
    const r = await consolidateInboxes({
      store: this.deps.store,
      roots: await this.deps.rootsWithUnits(),
    });
    if (r.created > 0 || r.duplicates > 0) {
      this.deps.broadcast({ kind: "items" });
      this.deps.broadcast({
        kind: "notice",
        level: r.created > 0 ? "success" : "info",
        text: `收件箱统合完成：新收录 ${r.created} 条${r.duplicates > 0 ? `，合并重复 ${r.duplicates} 条` : ""}（扫描 ${r.scanned} 个工作空间）`,
      });
      void this.deps.notify(`【待办统合】新收录 ${r.created} 条，合并重复 ${r.duplicates} 条（扫描 ${r.scanned} 个工作空间）`);
    } else if (force) {
      this.deps.broadcast({ kind: "notice", level: "info", text: `收件箱统合完成：没有新条目（扫描 ${r.scanned} 个工作空间）` });
    }
    return r;
  }

  // ---- DTO -------------------------------------------------------------------

  toItem(row: BacklogRow): BacklogItem {
    const run = this.deps.store.latestBacklogRun(row.id);
    return {
      id: row.id,
      title: row.title,
      goal: row.goal,
      prompt: row.prompt,
      unitId: row.unitId,
      unitName: row.unitName,
      rootPath: row.rootPath,
      runtimeId: row.runtimeId,
      model: row.model,
      mode: row.mode,
      launchMode: row.launchMode,
      size: row.size === "big" || row.size === "small" ? row.size : null,
      status: row.status as BacklogItem["status"],
      auto: row.auto,
      targetSessionId: row.targetSessionId,
      ignoreCount: row.ignoreCount,
      lastProposedAt: row.lastProposedAt,
      lastRunAt: row.lastRunAt,
      lastError: row.lastError,
      reviewNote: row.reviewNote,
      source: row.source === "inbox" ? "inbox" : "manual",
      sortPos: row.sortPos,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRun: run === undefined
        ? null
        : {
            runId: run.id,
            sessionId: run.sessionId,
            status: run.status,
            runtimeId: run.runtimeId,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            detail: run.detail,
          },
    };
  }

  listItems(): BacklogItem[] {
    return this.deps.store.listBacklogItems().map((r) => this.toItem(r));
  }
}

// ---- 工具 ---------------------------------------------------------------------

/**
 * autopilot 的执行器选择：item 指定了就看指定（percent 已知则须 ≥ 地板，未知放行
 * —— 探针失败不该把清单卡死）；没指定就在订阅执行器里挑剩余最多的，都低于地板
 * 返回 null（这一拍不跑，等窗口重置）。
 */
function pickAutopilotRuntime(
  preferred: string,
  quotas: QuotaHeadroom[],
  floorPercent: number,
): string | null {
  const known = (q: QuotaHeadroom | undefined): number | null => (q === undefined ? null : q.percent);
  if (preferred !== "") {
    const q = known(quotas.find((x) => x.runtimeId === preferred));
    return q === null || q >= floorPercent ? preferred : null;
  }
  const eligible = quotas
    .filter((q) => q.subscribed && (q.percent === null || q.percent >= floorPercent))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  return eligible[0]?.runtimeId ?? null;
}

/** 从模型回复里抠 JSON 决策：取「从某个 { 到最后一个 }」能 parse 的第一个（从右往左试） */
function extractJson(text: string): Record<string, unknown> | null {
  if (text === "") return null;
  const end = text.lastIndexOf("}");
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const slice = text.slice(start, end + 1);
    try {
      const v = JSON.parse(slice) as unknown;
      if (v !== null && typeof v === "object" && "action" in (v as Record<string, unknown>)) {
        return v as Record<string, unknown>;
      }
    } catch {
      /* 试下一个起点 */
    }
  }
  return null;
}
