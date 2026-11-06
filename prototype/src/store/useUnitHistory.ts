/**
 * 侧栏 bot 历史子列表（「垂直标签页」）的数据缓存 —— orca「展开只翻 UI 态」同款：
 * 数据在用户展开之前就该在 store 里，展开时先显示、再后台校准（SWR）。
 *
 * 此前数据存在 UnitRow 的组件 state 里，只在展开那一刻才拉：首开必经一次完整
 * RPC，[bot|项目] 切换 / 常驻移动导致的重挂还会把它丢掉 —— 每次都像首开。
 *
 * 三条来源把缓存焐热：
 * - 空闲预热（warm）：启动后按侧栏顺序逐个拉，单并发，条与条之间等浏览器空闲；
 * - 意图预取（prefetch）：bot 行悬停驻留 / 按下 / 键盘聚焦，「最新者胜」单槽，
 *   优先于空闲队列；
 * - 展开校准（ensure）：展开路径直调，不排队。
 *
 * 投机拉取（预取/预热）失败不写 error（orca 的投机工作无副作用口径）：真实路径
 * （展开）并入同一个在途请求时会把失败报出来。
 */
import { create } from "zustand";
import { fetchUnitHistory, type UnitHistoryEntry } from "../adapters/daemon/client.ts";

/** 与侧栏子列表的取数口径一致（一屏 6 条分页，100 条够翻） */
const HISTORY_LIMIT = 100;
/** 预取/预热的新鲜窗口：这么久内拉过的不再投机重拉（展开路径另有自己的窗口） */
const PREFETCH_FRESH_MS = 30_000;

export interface UnitHistoryCacheEntry {
  /** null = 从未成功拉到过 */
  readonly entries: readonly UnitHistoryEntry[] | null;
  /** 最近一次非投机拉取的失败信息（成功即清；失败时 entries 保留旧值） */
  readonly error: string | null;
  /** 最近一次成功拉取的时刻（新鲜度判定）；0 = 陈旧（从未拉到 / 已失效） */
  readonly at: number;
  readonly loading: boolean;
}

interface UnitHistoryState {
  readonly byUnit: Readonly<Record<string, UnitHistoryCacheEntry>>;
  /**
   * 确保缓存不旧于 maxAgeMs（缺省 0 = 强刷）：在途则合并，新鲜则跳过。
   * silent = 投机拉取，失败不写 error。
   */
  ensure: (unitId: string, opts?: { maxAgeMs?: number; silent?: boolean }) => Promise<void>;
  /** 失效（改名/导入/归档等）：保留旧数据照常显示，但不再算新鲜；缺省 = 全部 */
  invalidate: (unitId?: string) => void;
  /** 意图预取（悬停驻留/按下/聚焦）：单槽、最新者胜，优先于空闲队列 */
  prefetch: (unitId: string) => void;
  /** 空闲预热：按给定顺序排队，逐个在浏览器空闲时拉（已新鲜/在途的自动跳过） */
  warm: (unitIds: readonly string[]) => void;
}

interface Job {
  readonly seq: number;
  /** 发起时的失效代际：落地时代际变了，数据照存但不打新鲜戳 */
  readonly gen: number;
  /** 有非投机调用方在等：失败要写 error */
  report: boolean;
  promise: Promise<void>;
}

/** 未命中的兜底条目 —— 必须是模块级常量（selector 返回稳定引用，见 useNativeCommands 同款注释） */
export const EMPTY_HISTORY_ENTRY: UnitHistoryCacheEntry = { entries: null, error: null, at: 0, loading: false };

let seqCounter = 0;
let globalGen = 0;
const unitGen = new Map<string, number>();
/** 每 unit 只登记最新发起的那一个在途请求 */
const inflight = new Map<string, Job>();
/** 每 unit 最近一次落地的请求序号：更早发出、更晚落地的结果直接丢（旧数据不盖新数据） */
const appliedSeq = new Map<string, number>();

function genOf(unitId: string): number {
  return globalGen + (unitGen.get(unitId) ?? 0);
}

function patch(unitId: string, p: Partial<UnitHistoryCacheEntry>): void {
  useUnitHistory.setState((s) => ({
    byUnit: { ...s.byUnit, [unitId]: { ...(s.byUnit[unitId] ?? EMPTY_HISTORY_ENTRY), ...p } },
  }));
}

/* ------------------------------------------------------------- 预取调度 */

/** hover 槽：只留最新一个（指针扫过多个 bot 时，只有最后停住的那个值得拉） */
let hoverTarget: string | null = null;
const idleQueue: string[] = [];
/** 单并发：daemon 的 unit.history 是同步 SQLite，并发投机请求只会互相排队、挤占交互请求 */
let pumping = false;

function onIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === "function") ric(fn, { timeout: 1000 });
  else setTimeout(fn, 50);
}

function pump(): void {
  if (pumping) return;
  const next = hoverTarget ?? idleQueue.shift();
  hoverTarget = null;
  if (next === undefined) return;
  pumping = true;
  try {
    void useUnitHistory
      .getState()
      .ensure(next, { maxAgeMs: PREFETCH_FRESH_MS, silent: true })
      .finally(() => {
        pumping = false;
        // hover 槽有活立刻接着跑（用户正指着它）；空闲队列等浏览器空闲再取下一条
        if (hoverTarget !== null) pump();
        else if (idleQueue.length > 0) onIdle(pump);
      });
  } catch {
    // ensure 当前不会同步抛（内部全捕获），但谁也不保证明天不会 —— 真抛了的
    // 话复位泵再吞掉（调度器毒化成永久卡死比一次静默失败更糟，review P3）
    pumping = false;
  }
}

export const useUnitHistory = create<UnitHistoryState>((set, get) => ({
  byUnit: {},

  ensure: (unitId, opts) => {
    if (unitId === "") return Promise.resolve();
    const silent = opts?.silent === true;
    const gen = genOf(unitId);
    const running = inflight.get(unitId);
    // 在途合并：只并入失效之后发起的请求（失效前发出的结果可能早于改动）
    if (running !== undefined && running.gen === gen) {
      if (!silent) running.report = true;
      return running.promise;
    }
    const cur = get().byUnit[unitId];
    if (running === undefined && cur !== undefined && cur.at > 0 && Date.now() - cur.at < (opts?.maxAgeMs ?? 0)) {
      return Promise.resolve();
    }
    const job: Job = { seq: ++seqCounter, gen, report: !silent, promise: Promise.resolve() };
    inflight.set(unitId, job);
    patch(unitId, { loading: true });
    job.promise = (async () => {
      try {
        const list = await fetchUnitHistory(unitId, HISTORY_LIMIT);
        if ((appliedSeq.get(unitId) ?? 0) > job.seq) return;
        appliedSeq.set(unitId, job.seq);
        patch(unitId, { entries: list, error: null, at: job.gen === genOf(unitId) ? Date.now() : 0 });
      } catch (err: unknown) {
        // 失败也推进落地序号：这个请求已经是「最新结局」，更早发出的请求无论成功
        // 失败都不许再落地 —— 否则新请求刚写下的 error 会被旧请求迟到的成功悄悄
        // 清掉，还把改动前的旧数据当结果展示（review P2，执行复现后修）。
        // 投机拉取（!report）同样推进序号但失败静默：真实路径报错（orca 口径）
        if ((appliedSeq.get(unitId) ?? 0) <= job.seq) {
          appliedSeq.set(unitId, job.seq);
          if (job.report) patch(unitId, { error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        if (inflight.get(unitId) === job) {
          inflight.delete(unitId);
          patch(unitId, { loading: false });
        }
      }
    })();
    return job.promise;
  },

  invalidate: (unitId) => {
    if (unitId === undefined) {
      globalGen++;
      set((s) => {
        const next: Record<string, UnitHistoryCacheEntry> = {};
        for (const [k, v] of Object.entries(s.byUnit)) next[k] = v.at === 0 ? v : { ...v, at: 0 };
        return { byUnit: next };
      });
      return;
    }
    unitGen.set(unitId, (unitGen.get(unitId) ?? 0) + 1);
    const cur = get().byUnit[unitId];
    if (cur !== undefined && cur.at !== 0) patch(unitId, { at: 0 });
  },

  prefetch: (unitId) => {
    if (unitId === "") return;
    hoverTarget = unitId;
    pump();
  },

  warm: (unitIds) => {
    for (const id of unitIds) {
      if (id !== "" && !idleQueue.includes(id)) idleQueue.push(id);
    }
    pump();
  },
}));

// 改名 / 导入 / 归档 / 删除等都会广播 awb:history-refresh：收起着的 bot 也要知道自己
// 的缓存旧了（展开着的行另有自己的去抖重拉）
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("awb:history-refresh", (ev: Event) => {
    const unitId = (ev as CustomEvent<{ unitId?: string } | null>).detail?.unitId;
    useUnitHistory.getState().invalidate(unitId !== undefined ? String(unitId) : undefined);
  });
}
