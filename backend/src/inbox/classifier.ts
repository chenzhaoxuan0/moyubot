/**
 * InboxClassifier —— 清单分类引擎：把用户写进清单的条目批量交给 routing bot
 * 分类，产出落到该去的地方：
 *
 * - actionable 分类（目标/待办/用户自定义）→ 沉淀成 backlog_items（auto=true，
 *   直通闲时自动执行；用户预置字段 hints 优先，routing 只补空缺）
 * - 非 actionable 分类（想法/资料/以后再说）→ 只标记分类，留在清单按块归档
 *
 * 触发面：inbox.add 后 debounce（autoClassify 开）、daemon 启动 sweep、手动
 * inbox.classify.run。单飞保护：分类会话跑着的时候不再起第二个。
 * 分类是 routing bot 的活：会话宿主身份 = <homeDir>/routing（routingBot.ts 播种）。
 */

import path from "node:path";
import type {
  InboxConfig,
  InboxEntry,
  InboxSignal,
} from "../../../prototype/src/core/inbox.ts";
import {
  draftPromptOf,
} from "../../../prototype/src/core/backlog.ts";
import {
  DEFAULT_INBOX_CATEGORIES,
  hintsSummary,
  isActionableCategory,
} from "../../../prototype/src/core/inbox.ts";
import type { Store } from "../store/db.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { asModelId, asSessionId, asUnitId } from "../../../prototype/src/core/units.ts";
import { log } from "../log.ts";

/** 分类会话一层的总预算：超时按沉默收场，绝不让一层挂住调度 */
const CLASSIFY_BUDGET_MS = 3 * 60_000;
/** inbox.add 后的 debounce：用户连续写几条，凑一批一起分类 */
const SCHEDULE_DELAY_MS = 2_500;
/** 单飞占用时 debounce 的顺延间隔 */
const REARM_DELAY_MS = 5_000;
/** startSession 的看门狗：适配器握手挂死不能把 classifying 旗永久钉死 */
const START_SESSION_BUDGET_MS = 60_000;

const ROUTING_UNIT = "routing";

export interface ClassifyResult {
  attempted: number;
  classified: number;
  tasksCreated: number;
  failed: number;
}

export interface InboxClassifierDeps {
  readonly store: Store;
  readonly host: RuntimeHost;
  readonly homeDir: string;
  readonly getConfig: () => InboxConfig;
  readonly broadcast: (signal: InboxSignal) => void;
  /** 可选 bot 清单（分类建议 unitId / 兜底归属用） */
  readonly unitsWithRoots: () => Promise<Array<{ unitId: string; unitName: string; rootPath: string }>>;
  /** routing bot 的主绑定（inbox 配置未显式指定时的兜底） */
  readonly routingBinding?: () => Promise<{ runtimeId: string; model: string | null } | null>;
  /** 分类沉淀出任务时通知 backlog 面 —— BacklogPage/侧栏徽章只订 items 信号，
   * 不通知的话新任务要等下一个不相干信号才出现 */
  readonly notifyBacklogItems?: () => void;
}

interface RawDecision {
  id?: unknown;
  category?: unknown;
  title?: unknown;
  reason?: unknown;
  task?: unknown;
}

export class InboxClassifier {
  private readonly timer: { current: NodeJS.Timeout | null } = { current: null };
  /** 单飞旗（内存态：重启时那轮分类已经死了） */
  private classifying = false;
  private lastOutcome: string | null = null;
  /** 轮次序号：每次 setOutcome 自增。lastOutcome 跨轮残留会让「等这轮落定」的
   * 观察方（冒烟/前端）拿旧结果当新结果 —— seq 只增不减才是可靠的新鲜度凭据 */
  private runSeq = 0;

  constructor(private readonly deps: InboxClassifierDeps) {}

  // ---- 触发 -------------------------------------------------------------------

  /** inbox.add 后的 debounce 入口（autoClassify 关着就不排；reclassify 走 classify 直调不受此门限） */
  schedule(delayMs = SCHEDULE_DELAY_MS): void {
    if (!this.deps.getConfig().autoClassify) return;
    if (this.timer.current !== null) clearTimeout(this.timer.current);
    this.timer.current = setTimeout(() => {
      this.timer.current = null;
      // 单飞在跑就顺延一拍：到点即弃会让 debounce 期间新写的条目丢唤醒，
      // 只能等下一轮 add 才有机会被分到
      if (this.classifying) {
        this.schedule(REARM_DELAY_MS);
        return;
      }
      void this.classify().catch((err: unknown) =>
        log.warn("inbox classify scheduled run failed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }, delayMs);
    this.timer.current.unref?.();
  }

  /** daemon 启动 sweep：重启前遗留的待分类条目补一刀 */
  sweep(): void {
    const pending = this.deps.store.listInboxEntries().filter((e) => e.status === "pending");
    if (pending.length > 0) this.schedule(5_000);
  }

  state(): { classifying: boolean; lastOutcome: string | null; runSeq: number } {
    return { classifying: this.classifying, lastOutcome: this.lastOutcome, runSeq: this.runSeq };
  }

  // ---- 分类主流程 ---------------------------------------------------------------

  async classify(): Promise<ClassifyResult> {
    const result: ClassifyResult = { attempted: 0, classified: 0, tasksCreated: 0, failed: 0 };
    if (this.classifying) return result; // 单飞
    const cfg = this.deps.getConfig();
    const pending = this.deps.store.listInboxEntries().filter((e) => e.status === "pending");
    if (pending.length === 0) return result;
    // 同步占位再 await：resolveRuntime 的首个 await 之前不占旗，并发的手动
    // inbox.classify.run / inbox.reclassify 会双双通过单飞检查、同一批条目各建
    // 一份 auto 任务（双发）
    this.classifying = true;
    this.pushState();
    try {
      const { runtimeId, model } = await this.resolveRuntime(cfg);
      if (runtimeId === "") {
        this.setOutcome("failed:未配置分类执行器（inbox 设置或 routing bot 绑定其一）");
        return result;
      }
      const units = await this.deps.unitsWithRoots();
      const adapters = await this.safeAdapters();
      const answer = await this.runClassifySession(cfg, pending, units, adapters, runtimeId, model);
      const decisions = extractJsonArray(answer);
      if (decisions === null) {
        // 一整批沉默/解析失败：条目保持 pending —— 不是条目的错，不标 failed，
        // 也不自动重试（零进益的轮次重试只会烧额度）；下一次写入/手动触发再上
        this.setOutcome(`failed:分类会话没有产出有效决策，${pending.length} 条保持待分类（下次写入或手动触发再试）`);
        return result;
      }
      result.attempted = pending.length;
      const byId = new Map(pending.map((e) => [e.id, e]));
      for (const raw of decisions) {
        const id = Number(raw["id"]);
        const entry = byId.get(id);
        if (entry === undefined) continue;
        // 分类会话跑的几十秒里用户可能已手动分类/编辑：以最新状态为准，不再
        // pending 的条目跳过 —— 用户的手动决策不被过期快照背刺，任务兜底原话
        // 也用最新文本
        const fresh = this.deps.store.getInboxEntry(entry.id);
        if (fresh === undefined || fresh.status !== "pending") continue;
        const applied = this.applyDecision(fresh, raw, units, adapters);
        if (applied) {
          result.classified++;
          if (applied.taskCreated) result.tasksCreated++;
        } else {
          result.failed++;
          this.deps.store.updateInboxEntry(entry.id, { status: "failed" });
        }
      }
      this.setOutcome(
        `ok:分类 ${result.classified}/${result.attempted}，沉淀任务 ${result.tasksCreated} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ""}`,
      );
      if (result.classified > 0 || result.failed > 0) this.deps.broadcast({ kind: "entries" });
      if (result.tasksCreated > 0) {
        this.deps.broadcast({ kind: "notice", level: "success", text: `分类完成：${result.tasksCreated} 条沉淀为待办任务，空闲时自动执行` });
        this.deps.notifyBacklogItems?.();
      }
      // 分类期间又写进来的条目不在本批快照里 —— 本轮有进益才补一轮（routing 跳了
      // 某条/零决策时不自动重试，防热循环烧额度；那条等下一次 add / 手动触发带上）
      const progress = result.classified + result.failed;
      const remain = this.deps.store.listInboxEntries().filter((e) => e.status === "pending").length;
      if (progress > 0 && remain > 0) this.schedule();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setOutcome(`failed:${message}`);
      log.warn("inbox classify failed", { error: message });
    } finally {
      this.classifying = false;
      this.pushState();
    }
    return result;
  }

  /** 单条决策落库；返回 taskCreated（非 actionable / 决策无效都是 false） */
  private applyDecision(
    entry: InboxEntry,
    raw: RawDecision,
    units: Array<{ unitId: string; unitName: string; rootPath: string }>,
    adapters: ReadonlyArray<{ id: string }>,
  ): { taskCreated: boolean } | null {
    const cfg = this.deps.getConfig();
    const category = typeof raw["category"] === "string" ? raw["category"].trim() : "";
    const validIds = new Set([...DEFAULT_INBOX_CATEGORIES.map((c) => c.id), ...cfg.categories.map((c) => c.id)]);
    const task = parseTask(raw["task"]);
    // 分类 id 无效：带 task 字段就当 todo，否则回落 note（条目不丢，理由里说明）
    const finalCategory = validIds.has(category) ? category : task !== null ? "todo" : "note";
    const noteBase = typeof raw["reason"] === "string" ? raw["reason"].slice(0, 200) : "";
    const note = validIds.has(category) ? noteBase : `${noteBase}（分类结果无效，已回落 ${finalCategory}）`.trim();

    if (isActionableCategory(finalCategory, cfg.categories) && task !== null) {
      const hints = entry.hints;
      // 归属：用户预置 > routing 建议（须在可选清单里）> 第一个可用 bot > routing 自己的目录。
      // hints 也过同一道校验（注释里说「同款校验」就得真同款）：手滑写错的 unitId /
      // runtimeId 原样落库的话，任务会以退避节奏永久失败重试 + 通知轰炸
      const validUnit = (id: string | undefined): string =>
        id !== undefined && id !== "" && units.some((u) => u.unitId === id) ? id : "";
      const hintsUnit = validUnit(hints?.unitId);
      const unitId = hintsUnit !== "" ? hintsUnit : validUnit(task.unitId) || units[0]?.unitId || ROUTING_UNIT;
      const unit = units.find((u) => u.unitId === unitId);
      const rootPath = hints?.rootPath ?? unit?.rootPath ?? path.join(this.deps.homeDir, ROUTING_UNIT);
      // goal 兜底是用户原话全文 —— 清单允许长文本，任务目标必须钳住（prompt 会被无人值守派发）
      const goal = task.goal !== "" ? task.goal : entry.text.slice(0, 4000);
      // 执行器与 unit 同款校验：routing 编一个不存在的 id，任务会以退避节奏永久卡队列头；
      // 未知存空串 → autopilot 的余量门自己挑有余量的执行器（hints 留空 = 未指定，routing 建议可补位）
      const knownRuntime = (id: string | undefined): string =>
        id !== undefined && id !== "" && adapters.some((a) => a.id === id) ? id : "";
      const runtimeId = knownRuntime(hints?.runtimeId) || knownRuntime(task.runtimeId);
      // 建任务与回写链接必须同生共死：中间被 kill 会留下孤儿 auto 任务（会被
      // 闲时执行）+ 待分类条目，sweep 再分类就是重复任务、双份烧额度
      const taskId = this.deps.store.transaction(() => {
        const id = this.deps.store.createBacklogItem({
          title: task.title !== "" ? task.title : entry.text.split(/\r?\n/)[0]!.slice(0, 40),
          goal,
          prompt: task.prompt !== "" ? task.prompt : draftPromptOf(goal),
          unitId,
          unitName: unit?.unitName ?? unitId,
          rootPath,
          runtimeId,
          model: hints?.model !== undefined ? hints.model : task.model,
          launchMode: hints?.launchMode ?? "headless",
          auto: true,
          // targetSessionId 只认用户亲手预置的 hints —— routing 的输出不收这个字段
          // （间接提示注入可以把任意已有会话 id 塞进来，把任务 prompt 灌进别人的对话）
          targetSessionId: hints?.targetSessionId ?? null,
          source: "inbox",
        });
        this.deps.store.updateInboxEntry(entry.id, {
          category: finalCategory,
          categoryNote: note,
          taskId: id,
          status: "classified",
          classifiedAt: Date.now(),
        });
        return id;
      });
      return { taskCreated: true };
    }
    this.deps.store.updateInboxEntry(entry.id, {
      category: finalCategory,
      categoryNote: note,
      taskId: null,
      status: "classified",
      classifiedAt: Date.now(),
    });
    return { taskCreated: false };
  }

  // ---- 分类会话 -----------------------------------------------------------------

  private async resolveRuntime(cfg: InboxConfig): Promise<{ runtimeId: string; model: string | null }> {
    if (cfg.classifier.runtimeId !== "") {
      return { runtimeId: cfg.classifier.runtimeId, model: cfg.classifier.model };
    }
    try {
      const binding = (await this.deps.routingBinding?.()) ?? null;
      if (binding !== null && binding.runtimeId !== "") return binding;
    } catch {
      /* bot 注册表暂不可达（启动早期）按未配置处理 */
    }
    return { runtimeId: "", model: null };
  }

  private async safeAdapters(): Promise<Array<{ id: string; displayName: string }>> {
    try {
      const list = await this.deps.host.listAdapters(false);
      return list.map((a) => ({ id: a.id.replace(/^daemon:/, ""), displayName: a.displayName }));
    } catch {
      return [];
    }
  }

  private async runClassifySession(
    cfg: InboxConfig,
    pending: InboxEntry[],
    units: Array<{ unitId: string; unitName: string; rootPath: string }>,
    adapters: Array<{ id: string; displayName: string }>,
    runtimeId: string,
    model: string | null,
  ): Promise<string> {
    const categoryLines = [...DEFAULT_INBOX_CATEGORIES, ...cfg.categories].map(
      (c) => `- ${c.id}（${c.label}）${c.actionable ? "—— 沉淀成任务" : "—— 归档不执行"}`,
    );
    const entryLines = pending.map((e) => {
      const hs = hintsSummary(e.hints);
      return `#id:${e.id} ${e.text.replaceAll(/\s+/g, " ").slice(0, 500)}${hs !== "" ? `\n  用户预置字段（必须尊重）：${hs}` : ""}`;
    });
    const unitLines = units.map((u) => `- ${u.unitId}（${u.unitName}）工作目录 ${u.rootPath}`);
    const adapterLines = adapters.map((a) => `- ${a.id}（${a.displayName}）`);

    const prompt = [
      "你是 agent-workbench 的 routing bot。用户往清单里写进了以下条目（原文照录），请逐条分类。",
      "",
      "## 可用分类",
      ...categoryLines,
      "",
      "## 条目",
      ...entryLines,
      "",
      ...(units.length > 0 ? ["## 可选 bot（任务的归属工作单元）", ...unitLines, ""] : []),
      ...(adapters.length > 0 ? ["## 可选执行器", ...adapterLines, ""] : []),
      "## 你的任务",
      "对每条条目输出一个分类决策：目标/待办类给 task 字段（goal 一句话可执行目标、prompt 启动提示词、unitId/runtimeId 拿不准留空）；",
      "想法/资料类不要 task 字段。用户预置了字段的条目，task 里对应字段必须原样保留。",
      "只输出一个 JSON 数组，不要输出任何其他文字：",
      '[{"id":条目id,"category":"分类id","title":"一句话短标题","reason":"一句话理由","task":{"goal":"…","prompt":"…","unitId":"","runtimeId":"","model":null}}]',
    ].join("\n");

    const texts: string[] = [];
    // 订阅在 onSessionReady 回调里挂（startSession 返回前事件就可能到），
    // 所以用对象壳子持有退订函数 —— 直接 let 会被控制流分析收窄成 null/never
    const unsubRef: { fn: (() => void) | null } = { fn: null };
    // startSession 不在 CLASSIFY_BUDGET_MS 的守护圈内（那圈只罩 awaitTurnEnd）：
    // 适配器握手挂死会把 classifying 旗永久钉死、单飞从此拒收一切新条目 ——
    // 用看门狗竞速，输了按分类失败收场。race 输掉后 startSession 仍可能在
    // 未来某刻落定 —— abandoned 旗让迟到的订阅即挂即退，不泄漏监听器
    let abandoned = false;
    let watchdog: NodeJS.Timeout | null = null;
    let session: { id: string };
    try {
        session = await Promise.race([
          this.deps.host.startSession({
            runtimeId,
            unitId: asUnitId(ROUTING_UNIT),
            unitName: "Routing",
            rootPath: path.join(this.deps.homeDir, ROUTING_UNIT),
            prompt,
            model: model === null || model === "" ? null : asModelId(model),
            // plan 模式：分类会话的 prompt 里嵌着贴进来的外部原文（间接提示注入的
            // 首个落点），source=automation 本会自动放行全部权限 —— plan 闸兜底
            // 自动拦截 file_write/shell，被注入的分类会话最多「说」、不能「做」
            mode: "plan",
            source: "automation",
          onSessionReady: (id) => {
            unsubRef.fn = this.deps.host.onSessionEvent(id, "message.completed", (e) => {
              if (e.type === "message.completed") texts.push(e.text);
            });
            if (abandoned) {
              // 看门狗已放弃这一轮：会话照常跑完，但不再有人读它的输出
              unsubRef.fn?.();
              unsubRef.fn = null;
              log.info("inbox classify session materialized after watchdog", { sessionId: id });
            }
          },
        }),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error(`分类会话启动超时（${Math.round(START_SESSION_BUDGET_MS / 1000)}s）`)), START_SESSION_BUDGET_MS);
          watchdog.unref?.();
        }),
      ]);
    } catch (err: unknown) {
      abandoned = true;
      throw err;
    }
    try {
      await this.awaitTurnEnd(session.id, CLASSIFY_BUDGET_MS);
    } finally {
      unsubRef.fn?.();
      if (watchdog !== null) clearTimeout(watchdog);
    }
    return texts.at(-1) ?? "";
  }

  /** 等分类轮落定：session.ended（一次性执行器）或 status idle/failed（ACP agent-loop），加总超时兜底 */
  private awaitTurnEnd(sessionId: string, timeoutMs: number): Promise<void> {
    // 前置检查：快执行器可能在订阅前就已 ended 或已完成一轮（idle）——
    // 订阅晚一步就永远等不到事件，只能干等超时
    const persisted = this.deps.store.getSession(sessionId);
    if (persisted !== undefined && (persisted.endedAt !== null || persisted.status === "idle" || persisted.status.startsWith("failed"))) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve();
      };
      const unsub = this.deps.host.onSessionEvent(asSessionId(sessionId), "", (event) => {
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

  // ---- 状态 ---------------------------------------------------------------------

  private setOutcome(outcome: string): void {
    this.lastOutcome = outcome;
    this.runSeq += 1;
    this.pushState();
  }

  private pushState(): void {
    this.deps.broadcast({ kind: "state", classifying: this.classifying, lastOutcome: this.lastOutcome, runSeq: this.runSeq });
  }
}

// ---- 工具 -----------------------------------------------------------------------

interface ParsedTaskShape {
  goal: string;
  prompt: string;
  title: string;
  unitId: string;
  runtimeId: string;
  model: string | null;
}

/** task 字段归一：全字符串白名单截取，没有有效内容返回 null（当没给 task）。
 * 刻意不收 launchMode / targetSessionId / rootPath —— 执行方式系统定、会话目标
 * 只认用户亲手预置的 hints、工作目录只来自单元注册表，LLM 输出在这三处零信任。 */
export function parseTask(raw: unknown): ParsedTaskShape | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const strField = (k: string, max = 4000): string => {
    const v = r[k];
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  };
  const out: ParsedTaskShape = {
    goal: strField("goal"),
    prompt: strField("prompt"),
    title: strField("title", 80),
    unitId: strField("unitId", 100),
    runtimeId: strField("runtimeId", 100).replace(/^daemon:/, ""),
    model: typeof r["model"] === "string" && r["model"].trim() !== "" ? r["model"].trim().slice(0, 200) : null,
  };
  // 一个能用的字段都没有 = 没给 task（路由只贴了个分类标签）
  if (out.goal === "" && out.prompt === "" && out.title === "") return null;
  return out;
}

/** 从模型回复里抠 JSON 数组：整段 parse 不行就从第一个 [ 到最后一个 ] 试 */
export function extractJsonArray(text: string): RawDecision[] | null {
  const t = text.trim();
  if (t === "") return null;
  const candidates = [t, t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)];
  for (const c of candidates) {
    if (c === "" || c.length < 2) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (Array.isArray(v)) return v.filter((x): x is RawDecision => x !== null && typeof x === "object");
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}
