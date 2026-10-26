/**
 * 用量耗尽自动续跑（QuotaResume）—— 把「5 小时窗口打满 → 恢复后接着干」这件事
 * 排成一条**普通的一次性自动化**，走的是和其他自动化完全一样的调度 / 派发 / 卡片。
 *
 * 为什么不做成独立的续跑引擎：
 *   续跑要的东西（延迟触发、失败徽章、运行记录、停用/重开、UI 卡片）自动化全有，
 *   自己再造一套等于把这个项目刚做完的调度状态机抄一遍。排一条 automation 就完事。
 *
 * 每跳做三件事：
 *   1. 读订阅执行器的余量（QuotaProbe，5 分钟 TTL 缓存 —— 这里不再起子进程）
 *   2. 剩余 ≤ exhaustedPercent 判「用尽」；**resetsAt 读不到就不排**（用户拍板的取舍：
 *      猜一个时间可能排到一半窗口还没恢复，宁可空着并在界面上说明）
 *   3. 排一条 one-shot：fireAt = resetsAt + delayMinutes，投递目标 = 该执行器最近
 *      一个还能 resume 的会话（同窗口只排一条，靠 origin=quota_resume 去重）
 *
 * 触发精度：共享调度引擎是**分钟粒度**（cron 五字段 + 分钟步进的锚点推进），
 * 所以 delayMinutes=1 的实际口径是「恢复后 1~2 分钟内发出」而不是「正好 60 秒」。
 * 向上取整只可能晚、不会早 —— 宁可多等一分钟，也不能在窗口还没开时就发。
 *
 * 去重口径：同一执行器 + origin=quota_resume + 仍有未来的 next_run_at = 已排过。
 * 窗口重置后那条自己跑完收口（recurring=false + maxRuns=1），下一轮用尽再排新的。
 */

import { buildRelativeDelaySchedule, scheduleRuleToCron, computeScheduleNextRunAt } from "../../../prototype/src/core/automation.ts";
import type { BacklogConfig, QuotaHeadroom } from "../../../prototype/src/core/backlog.ts";
import type { Store } from "../store/db.ts";
import type { QuotaProbe } from "../backlog/probe.ts";
import { log } from "../log.ts";

const TICK_MS = 60_000;
/** 排完后的状态保留时长：跑完的卡片还挂在库里，但这里不再重复追踪 */
const STATE_TTL_MS = 30 * 60_000;
/**
 * 已完结续跑行的保留量（每执行器）。跑完的一次性任务不会再发火，留最近几条当
 * 「发生过什么」的凭据即可 —— 不清理就是每个用量窗口永久占一行，列表越积越长，
 * 还会把 20 条创建额度吃光（2026-10-26 的教训，额度现已按来源拆开、互不占用）。
 */
const FINISHED_RETENTION_PER_RUNTIME = 5;

/** 一个执行器的续跑判定结果 —— 同时也是给前端看的展示态 */
export interface QuotaResumeState {
  readonly runtimeId: string;
  readonly percent: number | null;
  readonly resetsAt: number | null;
  /** 已排上的那条自动化 id（null = 没排） */
  readonly scheduledAutomationId: number | null;
  /** 到点时刻（= resetsAt + delayMinutes） */
  readonly fireAt: number | null;
  /** 投递到哪个对话（null = 发火时再按当时最新的可 resume 会话定） */
  readonly targetSessionId: string | null;
  /** 没排的原因 —— 有值时界面上要显示，否则用户只看到「没反应」 */
  readonly note: string | null;
  readonly checkedAt: number;
}

export interface QuotaResumeDeps {
  readonly store: Store;
  readonly probe: QuotaProbe;
  readonly getConfig: () => BacklogConfig;
}

export class QuotaResumeWatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** runtimeId → 最近一次判定 */
  private readonly states = new Map<string, QuotaResumeState>();

  constructor(private readonly deps: QuotaResumeDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    log.info("quota resume watcher started", { tickMs: TICK_MS });
    // 起来就跳一次：daemon 可能已经开着好几个小时，不先扫一趟会白等一整个 TTL
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 展示态快照：过期的直接剔掉，避免把半年前的「已用尽」挂在界面上 */
  snapshot(): QuotaResumeState[] {
    const now = Date.now();
    const out: QuotaResumeState[] = [];
    for (const [id, s] of this.states) {
      if (s.scheduledAutomationId === null && now - s.checkedAt > STATE_TTL_MS) {
        this.states.delete(id);
        continue;
      }
      out.push(s);
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // 上一跳还在跑（探针 20s 超时）—— 不叠第二份
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err: unknown) {
      log.warn("quota resume tick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    // 清理先于功能开关：已完结的续跑行只要存在就该收（用户关掉续跑功能后，
    // 历史遗留行也不会永远挂在列表里）
    this.pruneFinished();

    const cfg = this.deps.getConfig();
    const qr = cfg.quotaResume;
    if (!qr.enabled) return;

    const quotas = await this.deps.probe.readAll(cfg.runtimes);
    const watched = new Set(qr.runtimes ?? Object.keys(cfg.runtimes).filter((id) => cfg.runtimes[id]!.subscribed));

    for (const q of quotas) {
      if (!watched.has(q.runtimeId)) continue;
      this.consider(q, cfg);
    }
  }

  /** 单个执行器的判定：没打满就清状态，打满就排续跑。纯同步，好单测。 */
  private consider(q: QuotaHeadroom, cfg: BacklogConfig): void {
    const now = Date.now();
    const exhausted = q.percent !== null && q.percent <= cfg.quotaResume.exhaustedPercent;

    if (!exhausted) {
      // 用量回来了，之前那条要么已跑要么已被停用 —— 状态清掉，下一轮从零算
      this.states.delete(q.runtimeId);
      return;
    }

    // 用户拍板：恢复时间读不到就不排。宁可界面上写「等恢复时间未知」，
    // 也不要拿 windowHours 猜一个 —— 猜早了窗口没开，agent 会再撞一次墙。
    if (q.resetsAt === null) {
      this.states.set(q.runtimeId, {
        runtimeId: q.runtimeId,
        percent: q.percent,
        resetsAt: null,
        scheduledAutomationId: null,
        fireAt: null,
        targetSessionId: null,
        note: "用量已用尽，但探针没给出恢复时间 —— 暂不排续跑，等读到恢复时间",
        checkedAt: now,
      });
      return;
    }

    const fireAt = q.resetsAt + cfg.quotaResume.delayMinutes * 60_000;
    if (fireAt <= now) {
      // 恢复时刻已过（daemon 停机跨过了窗口）：这轮的续跑没意义了，下个窗口再排
      this.states.delete(q.runtimeId);
      return;
    }

    const existing = this.findPending(q.runtimeId, now);
    if (existing !== null) {
      // 同一窗口已排过 —— 只刷新展示态，绝不重复排（否则一轮窗口能堆出几十条）
      this.states.set(q.runtimeId, {
        runtimeId: q.runtimeId,
        percent: q.percent,
        resetsAt: q.resetsAt,
        scheduledAutomationId: existing.id,
        fireAt: existing.nextRunAt,
        targetSessionId: existing.targetSessionId,
        note: existing.enabled ? null : "已停用 —— 本窗口不会再自动续跑",
        checkedAt: now,
      });
      return;
    }

    this.schedule(q.runtimeId, fireAt, cfg);
  }

  /**
   * 已完结的续跑行，每执行器只留最近 FINISHED_RETENTION_PER_RUNTIME 条，更旧的
   * 连运行记录一起删掉。完结的两种形态：
   *   1. next_run_at 为空 —— 跑完终态 / misfire 跳过（调度器都已收口）；
   *   2. 停用且触发点已过 —— 用户停用后调度器不再认领也不 misfire（tick 先判
   *      enabled），这行永远不会发火；留着就是僵尸行，且下一窗口排新行不受
   *      影响（findPending 只认 next_run_at > now），删了正好。
   * 刻意保留：仅停用但触发点还在未来的行 —— 删了它，下一跳 findPending 会当
   * 「没排过」又排一条新的，等于把用户的停用作废（它不看 enabled 也是同一理由）。
   */
  private pruneFinished(): void {
    const now = Date.now();
    const byRuntime = new Map<string, number[]>();
    for (const a of this.deps.store.listAutomations()) {
      if (a.origin !== "quota_resume") continue;
      const finished = a.nextRunAt === null || (!a.enabled && a.nextRunAt <= now);
      if (!finished) continue;
      const ids = byRuntime.get(a.runtimeId);
      if (ids === undefined) byRuntime.set(a.runtimeId, [a.id]);
      else ids.push(a.id); // listAutomations 按 id DESC —— 组内越靠前越新
    }
    for (const ids of byRuntime.values()) {
      for (const id of ids.slice(FINISHED_RETENTION_PER_RUNTIME)) {
        this.deps.store.deleteAutomation(id);
      }
    }
  }

  /**
   * 该执行器在**本窗口**是否已经排过。
   *
   * 刻意不看 enabled：用户点「停用」表达的是「这一轮别再续跑」，
   * 而谓词里带 enabled 的话，停用后下一跳就判定成「没排过」又排一条新的 ——
   * 停用这个动作对自动排的续跑等于完全失效。
   * 只看 next_run_at > now：窗口过去后旧行自然失效，下个窗口可以照常排。
   */
  private findPending(runtimeId: string, now: number): { id: number; nextRunAt: number; targetSessionId: string | null; enabled: boolean } | null {
    for (const a of this.deps.store.listAutomations()) {
      if (a.origin !== "quota_resume" || a.runtimeId !== runtimeId) continue;
      if (a.nextRunAt === null || a.nextRunAt <= now) continue;
      return { id: a.id, nextRunAt: a.nextRunAt, targetSessionId: a.targetSessionId, enabled: a.enabled };
    }
    return null;
  }

  /** 排一条一次性自动化。投递目标交给发火时的 runAutomation 再定一次（那时会话可能变了）。 */
  private schedule(runtimeId: string, fireAt: number, cfg: BacklogConfig): void {
    const target = this.latestResumable(runtimeId);
    // 锚点只取一次，两处共用。buildRelativeDelaySchedule 内部默认再取一次 Date.now()，
    // 两次读数之间的间隔会被加进触发时刻 —— 实测能白漂 1ms~几秒，
    // delayMinutes 一旦因 ceil 进位，这个漂移就叠成整整一分钟的误差。
    const anchor = Date.now();
    const delayMinutes = Math.max(1, Math.ceil((fireAt - anchor) / 60_000));
    const rule = buildRelativeDelaySchedule(delayMinutes, anchor);
    const nextRunAt = computeScheduleNextRunAt(rule);
    if (nextRunAt === null) {
      log.warn("quota resume could not compute next run, skipped", { runtimeId, fireAt });
      return;
    }

    try {
      const id = this.deps.store.createAutomation({
        // unit 用执行器 id 当占位：续跑不属于任何工作单元，卡片上按执行器分组显示
        unitId: `quota:${runtimeId}`,
        unitName: runtimeId,
        name: `${runtimeId} 用量恢复后续跑`,
        runtimeId,
        rootPath: target?.rootPath ?? process.cwd(),
        prompt: cfg.quotaResume.message,
        model: null, // 跟随执行器默认 —— 原对话是什么模型就用什么模型
        mode: null,
        cron: scheduleRuleToCron(rule),
        scheduleRule: rule,
        recurring: false,
        maxRuns: 1,
        nextRunAt,
        launchMode: "headless", // 续跑是后台行为，不该在用户面前弹终端
        dispatchTarget: "existing_session",
        targetSessionId: target?.id ?? null,
        origin: "quota_resume",
      });
      log.info("quota resume scheduled", { runtimeId, automationId: id, fireAt, nextRunAt, targetSessionId: target?.id ?? null });
      this.states.set(runtimeId, {
        runtimeId,
        percent: null,
        resetsAt: fireAt - cfg.quotaResume.delayMinutes * 60_000,
        scheduledAutomationId: id,
        fireAt: nextRunAt,
        targetSessionId: target?.id ?? null,
        note: target === undefined || target === null ? "没找到可续接的对话，到点会新开会话" : null,
        checkedAt: Date.now(),
      });
    } catch (err: unknown) {
      log.warn("quota resume schedule failed", { runtimeId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 该执行器最近一个还能 resume 的会话（cli_ref 非空才接得回来）。
   *  导入的外部会话（source="imported"）不算 —— 它们是收进来的档案，不是
   *  工作台管理的对话，用量墙续跑不该自动往里发消息 */
  private latestResumable(runtimeId: string): { id: string; rootPath: string | null } | undefined {
    for (const s of this.deps.store.listSessions()) {
      if (s.runtimeId !== runtimeId || s.cliRef === null || s.source === "imported") continue;
      return { id: s.id, rootPath: s.rootPath };
    }
    return undefined;
  }
}
