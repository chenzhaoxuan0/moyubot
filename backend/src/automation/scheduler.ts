/**
 * 自动化调度器（Phase 5 v2）—— 对齐 ZCode 的调度状态机，按本项目体量裁剪。
 *
 * 权威状态在 DB（automations.next_run_at），不靠内存推算：daemon 重启不丢拍，
 * 调度器只认 store。tick 每 20 秒扫一遍：
 *
 *   1. 重试到期的 → 原地再派（next_run_at 已在首次认领时前推，不再动它）
 *   2. next_run_at <= now 的 → 先认领（markAutomationFired 原子前推 + 计数）再异步派发，
 *      两帧 tick 不会对同一次触发重复发火
 *   3. 错过超过宽限（停机/休眠）→ 记 skipped 不补跑，直接排到下一个未来触发点；
 *      一次性任务错过即终态（completed），不会从延迟规则里推导出后续周期
 *   4. 派发失败 → 指数退避重试（30s 起步、15min 封顶、最多 5 次）；
 *      放弃时循环任务保持已前推的 next_run_at（这一窗丢掉、下一窗正常）；
 *      一次性任务在首次认领时即被停用（terminal），重试检查排在 enabled 判断
 *      之前才够得着 —— 见 tickInner 里的注释
 *
 * 会话结束态由 host 的事件流回灌（index.ts），调度器只管「到点没到点」。
 * 调度权威是 scheduleRule（共享引擎 computeScheduleNextRunAt，与 UI 同一份算术），
 * 纯 cron 的旧行走 cronNextAt 兜底。
 */

import { cronNextAt } from "./cron.ts";
import { computeScheduleNextRunAt, type ScheduleRule } from "../../../prototype/src/core/automation.ts";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

export type AutomationRow = ReturnType<Store["listAutomations"]>[number];

export type AutomationRunner = (a: AutomationRow, opts: { trigger: "schedule" | "manual" }) => Promise<{
  runId: number;
  sessionId: string;
}>;

const TICK_MS = 20_000;
/** misfire 宽限：next_run_at 早于 now 超过它 = 停机/休眠期间错过 → skipped 不补跑 */
const MISFIRE_GRACE_MS = 5 * 60_000;
/** 派发失败退避：30s 起步、15min 封顶、最多 5 次（对齐 ZCode 的 DISPATCH_RETRY_*） */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** 派发失败退避表（内存）：daemon 重启即清零 —— 重试是尽力而为，不是持久承诺 */
  private readonly retries = new Map<number, { attempts: number; at: number }>();

  constructor(
    private readonly store: Store,
    private readonly run: AutomationRunner,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.backfill();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    log.info("automation scheduler started", { tickMs: TICK_MS });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 旧库迁移：next_run_at 为空的启用行按当前规则补算一次，否则永远无人认领 */
  private backfill(): void {
    for (const a of this.store.listAutomations()) {
      if (!a.enabled || a.nextRunAt !== null) continue;
      const next = this.computeNext(a);
      try {
        this.store.updateAutomation(a.id, { nextRunAt: next });
      } catch (err: unknown) {
        // 单行写失败不该拖垮启动 —— 下一轮 tick 的兜底分支会把它停用 + 亮徽章
        log.warn("automation backfill write failed", { id: a.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      log.info("automation next_run_at backfilled", { id: a.id, next });
    }
  }

  /** 规则的下一次触发点。rule 缺失或坏 cron 都返回 null（由调用方决定兜底）。 */
  private computeNext(a: Pick<AutomationRow, "scheduleRule" | "cron">, from = Date.now()): number | null {
    if (a.scheduleRule !== null) {
      try {
        return computeScheduleNextRunAt(a.scheduleRule, from);
      } catch (err: unknown) {
        log.warn("automation rule compute failed", { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
    try {
      return cronNextAt(a.cron, from);
    } catch (err: unknown) {
      log.warn("automation has bad cron", { cron: a.cron, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private tick(): void {
    // 兜底：tick 是 daemon 的心跳，任何一行抛了（磁盘抖动 / 半损坏的行 / store 竞态）
    // 都不能让 interval 回调变成未捕获异常 —— 记下来，下一帧继续扫。
    try {
      this.tickInner();
    } catch (err: unknown) {
      log.warn("automation tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private tickInner(): void {
    const now = Date.now();
    for (const a of this.store.listAutomations()) {
      // 重试窗口必须排在 enabled 判断之前。
      // 一次性任务在 markAutomationFired(terminal) 认领的那一刻就被置成 enabled=0，
      // 若先判 enabled，退避表里的条目永远等不到执行 —— 派发失败 5 次退避形同虚设，
      // 而续跑最容易踩（resumeSession 要真拉起一个 CLI 进程）。
      // 停用是「别再排新的」，不是「把已经认领的那一次撤销」：退避表只在派发失败后
      // 短暂存在（30s~15min），让这一发跑完是符合直觉的。
      const retry = this.retries.get(a.id);
      if (retry !== undefined) {
        if (now < retry.at) continue;
        log.info("automation dispatch retry", { id: a.id, attempts: retry.attempts });
        // 在飞占位：dispatch 慢（续跑要真拉起 CLI，>20s 常见）时条目仍在本表，
        // 下一帧 tick 会再派发一次 —— 同一窗口双发会话/双发「继续」。把 at 推到
        // 最大值占位，dispatch() 结束后在成功路径删除、失败路径写回真实退避
        this.retries.set(a.id, { attempts: retry.attempts, at: Number.MAX_SAFE_INTEGER });
        void this.dispatch(a, "schedule");
        continue;
      }

      if (!a.enabled) continue;

      // 启用却推不出下次触发点：规则半损坏（手改库 / 旧数据迁移 / 重算失败落了 null）。
      // 不处理就是无声卡死 —— 永远不跑、界面上也没有任何解释。停用 + 亮徽章。
      if (a.nextRunAt === null) {
        this.store.updateAutomation(a.id, { enabled: false, nextRunAt: null });
        this.store.setAutomationError(a.id, "无法从当前规则推算下一次触发时间（已自动停用）", now);
        log.warn("automation unschedulable, disabled", { id: a.id, cron: a.cron });
        continue;
      }
      if (a.nextRunAt > now) continue;

      // misfire：停机/休眠期间错过的窗口跳过不补跑（调度器的职责是到点起会话，不是补账）。
      // 例外是提醒（notify 载荷，docs/30）：它的载荷是注意力不是副作用 —— 3 点的
      // 提醒 3:20（电脑唤醒、daemon 复活）送到仍救得了「忘了这件事」，跳过才是违约。
      // 任务错过=跳过，提醒错过=补发 —— 双轴承诺语义在错过路径上的分野。
      const isReminder = a.origin === "reminder";
      if (!isReminder && now - a.nextRunAt > MISFIRE_GRACE_MS) {
        const oneShot = !a.recurring && (a.maxRuns ?? 1) <= 1;
        const forward = oneShot ? null : this.computeNext(a, now);
        this.store.recordSkippedAutomationRun(a.id, a.nextRunAt, "missed: computer_asleep_or_app_not_running");
        this.store.updateAutomation(a.id, { nextRunAt: forward, ...(oneShot ? { enabled: false } : {}) });
        log.info("automation misfire skipped", { id: a.id, missedAt: a.nextRunAt, next: forward, oneShot });
        continue;
      }

      // 认领：先原子前推 next_run_at 再异步派发 —— 同一分钟内三帧 tick 只有一帧能认领
      const willBeCount = a.runCount + 1;
      const terminal = !a.recurring && willBeCount >= (a.maxRuns ?? 1);
      const forward = terminal ? null : this.computeNext(a, now);
      if (forward === null && !terminal) {
        // 规则推不出下一次（比如坏 cron）：停用并挂失败徽章，别让它在每帧 tick 里空转
        this.store.updateAutomation(a.id, { enabled: false, nextRunAt: null });
        this.store.setAutomationError(a.id, "无法从当前规则推算下一次触发时间（规则已停用）", now);
        log.warn("automation unschedulable, disabled", { id: a.id, cron: a.cron });
        continue;
      }
      // 认领失败（行刚被删除 / 并发改写）就别派发了 —— 否则给一条已删的自动化
      // 起会话，留下孤儿运行记录
      if (!this.store.markAutomationFired(a.id, forward, now, terminal)) {
        log.warn("automation claim lost (row gone or changed), skipping dispatch", { id: a.id });
        continue;
      }
      if (terminal) log.info("automation reached max runs, completed", { id: a.id, runs: willBeCount });
      void this.dispatch(a, "schedule");
    }
  }

  private async dispatch(a: AutomationRow, trigger: "schedule" | "manual"): Promise<void> {
    try {
      await this.run(a, { trigger });
      this.retries.delete(a.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (this.retries.get(a.id)?.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // 放弃 = failed 终态（ZCode 口径）：停用，等用户手动重开（setEnabled 会重排）。
        // 失败徽章由 runner 在每次失败时写；这里补上停用，别让坏任务每个周期空转。
        this.retries.delete(a.id);
        this.store.setAutomationEnabled(a.id, false);
        log.warn("automation dispatch gave up, disabled", { id: a.id, attempts, error: message });
      } else {
        const at = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS);
        this.retries.set(a.id, { attempts, at });
        log.warn("automation dispatch failed, will retry", { id: a.id, attempts, retryAt: at, error: message });
      }
    }
  }

  /** cron/规则变更后由 RPC 层调用：清退避表。next_run_at 的重算在 handler 里随更新落库。 */
  invalidate(id: number): void {
    this.retries.delete(id);
  }
}
