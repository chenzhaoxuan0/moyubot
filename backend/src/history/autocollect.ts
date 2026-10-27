/**
 * 外部会话自动收录（auto-collect，docs/13 会话事实源的发现层）：
 * daemon 周期扫描各单元目录匹配的原生存储，把外部终端跑过、工作台尚未认识的
 * 会话自动落为导入行（imp_* 前缀，source="imported"）——「在已登记 bot 的目录下
 * 任意终端跑 mcode，会话自己出现在侧栏」就是这条链路。手动导入
 * （history.import.apply）仍是显式兜底：自动收录关闭或漏收的会话可手动补收。
 *
 * 纪律（沿 history/ 既有口径）：
 * - 只读 CLI 原生存储，绝不写；
 * - 自动收录比手动导入更保守——误收的行会凭空出现在用户的侧栏里：
 *   · cwd 不明的会话不收（reader 返回 rootPath=null 表示 CLI 没记 cwd，无法归属单元）；
 *   · 读不出正文的执行器不收（read() 返回 null，收进来聊天页是空的）；
 *   · 空会话不收（mcode 模型探测留下的 0 字节 messages.jsonl）；
 *   · 太年轻的会话不收（MIN_AGE 门槛）：工作台自己刚开的会话要等 cliRef 落账
 *     （首个 turn 事件才写），抢在前面收录就会造出「同一段对话两行」的影子行；
 * - 不自动 watch：watch 上限 25 是给「正在看」的会话的，打开（session.resume /
 *   events.since）才开始实时同步，语义不变；
 * - **不让出事件循环的活不干**（loop-stall 实测教训）：候选列表走注入的 TTL
 *   缓存通道、负探测结果按 (sessionId, updatedAt) 记忆、逐条收录间 setImmediate
 *   让行——一轮收录再大也不许把 daemon 主循环卡出秒级停顿。
 *
 * 影子行清扫（sweepShadowedImportRows）：真会话（工作台开的、TUI 运行认领的）
 * 与 imp_ 行指向同一原生会话时，imp_ 行是冗余投影——每轮差集前清扫，治愈
 * 「聊天页新建对话后侧栏多出一行相同内容」的竞态残留（创建竞态窗口内收录的）。
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { WebSocketServer } from "ws";
import type { Store } from "../store/db.ts";
import type { BotDefinition } from "../bots/registry.ts";
import type { NativeSessionSummary } from "./types.ts";
import { samePath } from "./util.ts";
import { forgetNativeSyncState } from "./sync.ts";
import { broadcastEvent } from "../wsd.ts";
import { asSessionId, asUnitId } from "../contract.ts";
import { log } from "../log.ts";

/** 自动收录的执行器排除集：read() 无转录正文（列表可用、下钻为 null），
 * 自动收进来聊天页是空的——只留在手动导入面（用户自己选择时知情）。 */
const AUTOCOLLECT_EXCLUDED_EXECUTORS: ReadonlySet<string> = new Set(["antigravity", "cursor", "cursor-agent"]);

const AUTOCOLLECT_INTERVAL_MS = 30_000;
const AUTOCOLLECT_FIRST_DELAY_MS = 8_000;
const AUTOCOLLECT_PER_UNIT_CAP = 50;
/** 年轻门槛：工作台自己开的会话，cliRef 要等首个 turn 事件才落账——窗口期内
 * 不收，等它进了 known 集自然跳过。代价是外部新会话最晚 ~75s 才出现，可接受。 */
const AUTOCOLLECT_MIN_AGE_MS = 45_000;
/** 回填 resumeRef 只看最近的终端运行：古老的死运行没有原生 id，每轮重试没有意义 */
const TERMINAL_BACKFILL_MAX_AGE_MS = 7 * 86_400_000;
/** 负探测记忆上限：超了整体清空重来（全量重探一轮的成本可承受，防 Map 无界） */
const NEGATIVE_PROBE_MEMO_CAP = 1000;

/** 事件循环让行：收录循环里每段可能同步阻塞的活之间插一脚 */
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 台账/终端行里的 runtimeId 归一（host 行裸 id，个别路径带 daemon: 前缀） */
const bareRuntime = (runtimeId: string): string => runtimeId.replace(/^daemon:/, "");

/** 工作台已认识的 (执行器|原生会话 id) 集：sessions.cliRef + terminal_runs.resume_ref。
 * history.import.list / apply 与自动收录共用同一去重口径。 */
export function knownNativeRefs(store: Store): Set<string> {
  const known = new Set<string>();
  for (const s of store.listSessions()) {
    if (s.cliRef !== null && s.cliRef !== "") known.add(`${bareRuntime(s.runtimeId)}|${s.cliRef}`);
  }
  for (const r of store.listTerminalRuns(undefined, 500)) {
    if (r.resumeRef !== null && r.resumeRef !== "") known.add(`${bareRuntime(r.runtimeId)}|${r.resumeRef}`);
  }
  return known;
}

/** 自动收录的种子行（与 history.import.apply 的入参同形） */
export interface NativeImportSeed {
  readonly sessionId: string;
  readonly title: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/**
 * imp_ 导入行落库（history.import.apply 与自动收录共用）。已认识（known 命中）
 * 返回 null 不落，否则返回新行 id（imp_ 前缀与真实会话 id 空间隔离）。
 * known 传入时原地补充，调用方可继续用同一集合差集。
 */
export function materializeImportedSession(
  store: Store,
  args: {
    unitId: string;
    rootPath: string | null;
    executorId: string;
    native: NativeImportSeed;
    known?: Set<string>;
  },
): string | null {
  const nativeId = args.native.sessionId;
  if (nativeId === "") return null;
  const known = args.known ?? knownNativeRefs(store);
  if (known.has(`${args.executorId}|${nativeId}`)) return null;
  const startedAt = Number.isFinite(args.native.startedAt) ? args.native.startedAt : 0;
  const updatedAt = Number.isFinite(args.native.updatedAt) ? args.native.updatedAt : startedAt;
  const title = args.native.title.trim() !== "" ? args.native.title.trim().slice(0, 120) : "（外部导入会话）";
  const rowId = `imp_${args.executorId}_${nativeId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  store.upsertSession({
    // imp_ 前缀与真实会话 id 空间隔离；原生 id 里可能出现的不安全字符压成 _
    id: rowId,
    unitId: args.unitId,
    runtimeId: args.executorId,
    title,
    status: "done",
    startedAt,
    endedAt: updatedAt,
    cliRef: nativeId,
    rootPath: args.rootPath,
    source: "imported",
    conversationId: null,
    lastSeq: 0,
    turnCount: 0,
    forkOfSession: null,
    forkAtSeq: null,
    forkKind: null,
    stats: { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
  });
  known.add(`${args.executorId}|${nativeId}`);
  return rowId;
}

/**
 * 影子行清扫：真会话（非 imported 的台账行，含工作台/渠道/自动化开的）或终端
 * 运行（terminal_runs.resume_ref）已认领某原生会话时，同原生会话的 imp_ 行是
 * 冗余投影——删除并广播 session.ended 让侧栏即时收掉。创建竞态（收录发生在
 * cliRef 落账之前）漏进来的影子行，下一轮就会被这里治愈。
 * 只清 status=done 的行：已被用户点开 reattach 的导入行（idle/running）是活的
 * 续聊段，不删。
 */
export function sweepShadowedImportRows(
  store: Store,
  unitId: string,
  wss: WebSocketServer | null,
  dropSession?: (sessionId: string) => void,
): number {
  const claimed = new Set<string>();
  for (const s of store.listSessions()) {
    if (s.source !== "imported" && s.cliRef !== null && s.cliRef !== "") {
      claimed.add(`${bareRuntime(s.runtimeId)}|${s.cliRef}`);
    }
  }
  for (const r of store.listTerminalRuns(unitId, 200)) {
    if (r.resumeRef !== null && r.resumeRef !== "") claimed.add(`${bareRuntime(r.runtimeId)}|${r.resumeRef}`);
  }
  if (claimed.size === 0) return 0;
  let removed = 0;
  for (const s of store.listSessions()) {
    if (s.unitId !== unitId || s.source !== "imported" || s.cliRef === null || s.cliRef === "") continue;
    if (s.status !== "done") continue;
    if (!claimed.has(`${bareRuntime(s.runtimeId)}|${s.cliRef}`)) continue;
    store.deleteSession(s.id);
    forgetNativeSyncState(s.id);
    dropSession?.(s.id);
    removed++;
    if (wss !== null) {
      broadcastEvent(wss, { type: "session.ended", sessionId: asSessionId(s.id), reason: "completed" }, 0);
    }
  }
  if (removed > 0) log.info("[auto-collect] 清扫影子导入行（真会话已认领同一原生会话）", { unitId, removed });
  return removed;
}

// 负探测记忆：key = executorId|sessionId → 上次判「无内容」时的 updatedAt。
// updatedAt 不变就不再探测（mcode read() 兜底是 3 个月×7 天的目录扫，反复跑
// 会把主循环卡出秒级停顿——实测教训）；变了（会话有新活动）才重探。
const negativeProbes = new Map<string, number>();

/**
 * 空会话探测，三级从严（自动收录宁缺毋滥，手动导入不受此限）：
 * 1. messageCount > 0 —— 多数 reader 列表就报真实条数，直接过；
 * 2. 转录形 source stat —— mcode 等列表不臆造条数的家：source 是转录文件
 *    （.jsonl/.json/.ndjson）或含 messages.jsonl 的目录，size>0 才过（挡掉
 *    mcode 模型探测留下的 0 字节会话）。sqlite 路径（opencode/openclaw 等
 *    source=db 文件）不在此列——db 恒非空，stat 无意义；
 * 3. readNativeSession 下钻一次 —— 上面两级都判不了的候选（每轮差集后通常
 *    0~2 条），读真实转录：null 或 0 条 = 无内容。
 */
export interface ContentProbeDeps {
  readonly readNativeSession: (executorId: string, sessionId: string) => Promise<{ transcript: readonly unknown[] } | null>;
}

async function sessionHasContent(
  s: NativeSessionSummary,
  deps: ContentProbeDeps,
): Promise<boolean> {
  if (s.messageCount > 0) return true;
  const memoKey = `${s.executorId}|${s.sessionId}`;
  const memoAt = negativeProbes.get(memoKey);
  if (memoAt !== undefined && memoAt === s.updatedAt) return false;
  const transcriptShaped = (p: string): boolean => /\.(jsonl|ndjson|json)$/i.test(p);
  const candidates = transcriptShaped(s.source) ? [s.source] : [path.join(s.source, "messages.jsonl")];
  let probed = false;
  for (const candidate of candidates) {
    if (!transcriptShaped(candidate)) continue;
    try {
      const st = statSync(candidate);
      if (st.isFile()) {
        probed = true;
        if (st.size > 0) return true;
      }
    } catch {
      // 探不到就落到 read() 下钻
    }
  }
  let has = false;
  if (!probed) {
    try {
      const detail = await deps.readNativeSession(s.executorId, s.sessionId);
      has = detail !== null && detail.transcript.length > 0;
    } catch {
      has = false;
    }
  }
  if (!has) {
    if (negativeProbes.size >= NEGATIVE_PROBE_MEMO_CAP) negativeProbes.clear();
    negativeProbes.set(memoKey, s.updatedAt);
  }
  return has;
}

export interface AutoCollectDeps {
  readonly store: Store;
  readonly listBots: () => Promise<readonly BotDefinition[]>;
  /** 该目录的原生会话候选（index.ts 提供：走 30s TTL 缓存通道，与 unit.history
   * 共享一次扫描——绝不每轮裸跑 14 家 reader 的同步 fs） */
  readonly listUnitCandidates: (rootPath: string) => Promise<readonly NativeSessionSummary[]>;
  /** 单条原生转录下钻（内容探测的第三级） */
  readonly readNativeSession: ContentProbeDeps["readNativeSession"];
  /** 回填该单元 terminal_runs 缺失的 resumeRef（index.ts 提供：与 unit.history 同款回溯）。
   * 在差集之前跑，保证工作台自己派发的 TUI 会话先进 known 集、不被重复收录。 */
  readonly backfillTerminalRefs: (unitId: string, rootPath: string) => Promise<void>;
  /** 落库行收编进 host 内存台账（index.ts 提供）：运行期创建的导入行不收编就
   * 不在 session.list 里，前端点开直接「打不开这个会话」 */
  readonly adoptSession: (sessionId: string) => void;
  /** 影子行删除时连带摘出 host 内存台账 */
  readonly dropSession: (sessionId: string) => void;
  readonly getWss: () => WebSocketServer | null;
}

export interface NativeAutoCollector {
  /** 立即跑一轮（history.refreshNative 清缓存后联动）；上一轮在途时静默共享 */
  collectNow(): Promise<void>;
  stop(): void;
}

async function runPass(deps: AutoCollectDeps): Promise<void> {
  const bots = await deps.listBots().catch(() => [] as readonly BotDefinition[]);
  const wss = deps.getWss();
  for (const bot of bots) {
    const unitId = typeof bot.id === "string" ? bot.id : "";
    const rootPath = typeof bot.rootPath === "string" ? bot.rootPath : "";
    if (unitId === "" || rootPath === "") continue;
    if (bot["unregistered"] === true) continue;
    // 影子行清扫不看 autoCollect 开关：已存在的冗余行是数据卫生问题，不是收录行为
    sweepShadowedImportRows(deps.store, unitId, wss, deps.dropSession);
    // bot.json 的 autoCollect 字段缺省 = 开（收录是常态，关闭是显式选择）
    if (bot["autoCollect"] === false) continue;
    try {
      await collectUnit(deps, bot, unitId, rootPath);
    } catch (err: unknown) {
      log.debug("[auto-collect] 单元收录失败（跳过本轮）", { unitId, err: String(err) });
    }
    await yieldLoop();
  }
}

async function collectUnit(
  deps: AutoCollectDeps,
  bot: BotDefinition,
  unitId: string,
  rootPath: string,
): Promise<void> {
  await deps.backfillTerminalRefs(unitId, rootPath);
  const rows = await deps.listUnitCandidates(rootPath);
  const known = knownNativeRefs(deps.store);
  let imported = 0;
  for (const r of rows) {
    // 每 bot 每轮上限：首轮回填不风暴，剩下的下一轮继续（30s 后）
    if (imported >= AUTOCOLLECT_PER_UNIT_CAP) break;
    if (known.has(`${r.executorId}|${r.sessionId}`)) continue;
    if (AUTOCOLLECT_EXCLUDED_EXECUTORS.has(r.executorId)) continue;
    // cwd 不明（null）或不符的不自动收——手动导入仍可见可选
    if (r.rootPath === null || !samePath(r.rootPath, rootPath)) continue;
    // 太年轻的不收：给工作台自己开的会话留出 cliRef 落账窗口（见文件头纪律）
    if (Date.now() - Math.max(r.startedAt, r.updatedAt) < AUTOCOLLECT_MIN_AGE_MS) continue;
    await yieldLoop();
    if (!(await sessionHasContent(r, deps))) continue;
    const rowId = materializeImportedSession(deps.store, {
      unitId,
      rootPath,
      executorId: r.executorId,
      native: { sessionId: r.sessionId, title: r.title, startedAt: r.startedAt, updatedAt: r.updatedAt },
      known,
    });
    if (rowId === null) continue;
    // 立即收编进 host 内存台账：否则 session.list 看不见这行，前端点开
    // historyOnly 回落会「打不开这个会话」、events.since 也按 unknown_session 抛错
    deps.adoptSession(rowId);
    imported++;
    // 侧栏即时出现：Sidebar 监听 session.started → 300ms 去抖重拉 unit.history。
    // source "imported" 不在任务栏的无人值守来源集里，不会凭空多任务条目。
    const wss = deps.getWss();
    if (wss !== null) {
      broadcastEvent(
        wss,
        { type: "session.started", sessionId: asSessionId(rowId), unitId: asUnitId(unitId), source: "imported" },
        0,
      );
    }
  }
  if (imported > 0) log.info("[auto-collect] 外部会话自动收录", { unitId, imported });
}

export function startNativeAutoCollect(deps: AutoCollectDeps): NativeAutoCollector {
  let timer: NodeJS.Timeout | null = null;
  let kickoff: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;
  const pass = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runPass(deps);
    } finally {
      running = false;
    }
  };
  // 首跑延迟：让 daemon 启动期的 bot 扫描 / WS 建连先尘埃落定
  kickoff = setTimeout(() => {
    void pass();
    timer = setInterval(() => void pass(), AUTOCOLLECT_INTERVAL_MS);
  }, AUTOCOLLECT_FIRST_DELAY_MS);
  return {
    collectNow: () => pass(),
    stop() {
      stopped = true;
      if (kickoff !== null) clearTimeout(kickoff);
      if (timer !== null) clearInterval(timer);
    },
  };
}

export { TERMINAL_BACKFILL_MAX_AGE_MS };
