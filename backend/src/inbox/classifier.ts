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
  InboxHints,
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
}

interface RawDecision {
  id?: unknown;
  category?: unknown;
  title?: unknown;
  reason?: unknown;
  task?: unknown;
}

interface ParsedTask {
  goal: string;
  prompt: string;
  title: string;
  unitId: string;
  runtimeId: string;
  model: string | null;
  targetSessionId: string | null;
}

export class InboxClassifier {
  private readonly timer: { current: NodeJS.Timeout | null } = { current: null };
  /** 单飞旗（内存态：重启时那轮分类已经死了） */
  private classifying = false;
  private lastOutcome: string | null = null;

  constructor(private readonly deps: InboxClassifierDeps) {}

  // ---- 触发 -------------------------------------------------------------------

  /** inbox.add 后的 debounce 入口（autoClassify 关着就不排） */
  schedule(delayMs = SCHEDULE_DELAY_MS): void {
    if (!this.deps.getConfig().autoClassify) return;
    if (this.timer.current !== null) clearTimeout(this.timer.current);
    this.timer.current = setTimeout(() => {
      this.timer.current = null;
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

  state(): { classifying: boolean; lastOutcome: string | null } {
    return { classifying: this.classifying, lastOutcome: this.lastOutcome };
  }

  // ---- 分类主流程 ---------------------------------------------------------------

  async classify(): Promise<ClassifyResult> {
    const result: ClassifyResult = { attempted: 0, classified: 0, tasksCreated: 0, failed: 0 };
    if (this.classifying) return result; // 单飞
    const cfg = this.deps.getConfig();
    const pending = this.deps.store.listInboxEntries().filter((e) => e.status === "pending");
    if (pending.length === 0) return result;
    const { runtimeId, model } = await this.resolveRuntime(cfg);
    if (runtimeId === "") {
      this.setOutcome("failed:未配置分类执行器（inbox 设置或 routing bot 绑定其一）");
      return result;
    }
    this.classifying = true;
    this.pushState();
    try {
      const units = await this.deps.unitsWithRoots();
      const adapters = await this.safeAdapters();
      const answer = await this.runClassifySession(cfg, pending, units, adapters, runtimeId, model);
      const decisions = extractJsonArray(answer);
      if (decisions === null) {
        // 一整批沉默/解析失败：条目保持 pending，下次再试（不标 failed —— 不是条目的错）
        this.setOutcome(`failed:分类会话没有产出有效决策（${pending.length} 条待重试）`);
        return result;
      }
      result.attempted = pending.length;
      const byId = new Map(pending.map((e) => [e.id, e]));
      for (const raw of decisions) {
        const id = Number(raw["id"]);
        const entry = byId.get(id);
        if (entry === undefined) continue;
        const applied = this.applyDecision(entry, raw, units);
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
      }
      // 分类期间又写进来的条目不在本批快照里 —— 本批全部消化完才补一轮（routing
      // 跳了某条不补，防热循环烧额度；那条等下一次 add / 手动触发自然带上）
      const allResolved = result.classified + result.failed === result.attempted;
      const remain = this.deps.store.listInboxEntries().filter((e) => e.status === "pending").length;
      if (allResolved && remain > 0) this.schedule();
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
      // 归属：用户预置 > routing 建议（须在可选清单里）> 第一个可用 bot > routing 自己的目录
      const validUnit = (id: string): string => (id !== "" && units.some((u) => u.unitId === id) ? id : "");
      const unitId =
        hints?.unitId !== undefined && hints.unitId !== ""
          ? hints.unitId
          : validUnit(task.unitId) || units[0]?.unitId || ROUTING_UNIT;
      const unit = units.find((u) => u.unitId === unitId);
      const rootPath = hints?.rootPath ?? unit?.rootPath ?? path.join(this.deps.homeDir, ROUTING_UNIT);
      const goal = task.goal !== "" ? task.goal : entry.text;
      const taskId = this.deps.store.createBacklogItem({
        title: task.title !== "" ? task.title : entry.text.split(/\r?\n/)[0]!.slice(0, 40),
        goal,
        prompt: task.prompt !== "" ? task.prompt : draftPromptOf(goal),
        unitId,
        unitName: unit?.unitName ?? unitId,
        rootPath,
        runtimeId: hints?.runtimeId ?? task.runtimeId,
        model: hints?.model !== undefined ? hints.model : task.model,
        launchMode: hints?.launchMode ?? "headless",
        auto: true,
        targetSessionId: hints?.targetSessionId ?? task.targetSessionId,
        source: "inbox",
      });
      this.deps.store.updateInboxEntry(entry.id, {
        category: finalCategory,
        categoryNote: note,
        taskId,
        status: "classified",
        classifiedAt: Date.now(),
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
      '[{"id":条目id,"category":"分类id","title":"一句话短标题","reason":"一句话理由","task":{"goal":"…","prompt":"…","unitId":"","runtimeId":"","model":null,"targetSessionId":null}}]',
    ].join("\n");

    const texts: string[] = [];
    // 订阅在 onSessionReady 回调里挂（startSession 返回前事件就可能到），
    // 所以用对象壳子持有退订函数 —— 直接 let 会被控制流分析收窄成 null/never
    const unsubRef: { fn: (() => void) | null } = { fn: null };
    const session = await this.deps.host.startSession({
      runtimeId,
      unitId: asUnitId(ROUTING_UNIT),
      unitName: "Routing",
      rootPath: path.join(this.deps.homeDir, ROUTING_UNIT),
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
      await this.awaitTurnEnd(session.id, CLASSIFY_BUDGET_MS);
    } finally {
      unsubRef.fn?.();
    }
    return texts.at(-1) ?? "";
  }

  /** 等分类轮落定：session.ended（一次性执行器）或 status idle/failed（ACP agent-loop），加总超时兜底 */
  private awaitTurnEnd(sessionId: string, timeoutMs: number): Promise<void> {
    // 前置检查：快执行器可能在订阅前就已 ended（订阅晚一步就永远等不到事件）
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
    this.pushState();
  }

  private pushState(): void {
    this.deps.broadcast({ kind: "state", classifying: this.classifying, lastOutcome: this.lastOutcome });
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
  targetSessionId: string | null;
}

/** task 字段归一：全字符串白名单截取，没有有效内容返回 null（当没给 task） */
function parseTask(raw: unknown): ParsedTaskShape | null {
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
    model: typeof r["model"] === "string" && r["model"].trim() !== "" ? r["model"].trim() : null,
    targetSessionId: strField("targetSessionId", 100) || null,
  };
  // 一个能用的字段都没有 = 没给 task（路由只贴了个分类标签）
  if (out.goal === "" && out.prompt === "" && out.title === "") return null;
  return out;
}

/** 从模型回复里抠 JSON 数组：整段 parse 不行就从第一个 [ 到最后一个 ] 试 */
function extractJsonArray(text: string): RawDecision[] | null {
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
