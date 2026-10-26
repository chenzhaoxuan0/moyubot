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
 * - 不自动 watch：watch 上限 25 是给「正在看」的会话的，打开（session.resume /
 *   events.since）才开始实时同步，语义不变。
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { WebSocketServer } from "ws";
import type { Store } from "../store/db.ts";
import type { BotDefinition } from "../bots/registry.ts";
import { listNativeSessions, readNativeSession, type NativeSessionSummary } from "./index.ts";
import { samePath } from "./util.ts";
import { broadcastEvent } from "../wsd.ts";
import { asSessionId, asUnitId } from "../contract.ts";
import { log } from "../log.ts";

/** 自动收录的执行器排除集：read() 无转录正文（列表可用、下钻为 null），
 * 自动收进来聊天页是空的——只留在手动导入面（用户自己选择时知情）。 */
const AUTOCOLLECT_EXCLUDED_EXECUTORS: ReadonlySet<string> = new Set(["antigravity", "cursor", "cursor-agent"]);

const AUTOCOLLECT_INTERVAL_MS = 30_000;
const AUTOCOLLECT_FIRST_DELAY_MS = 8_000;
const AUTOCOLLECT_SCAN_LIMIT = 100;
const AUTOCOLLECT_PER_UNIT_CAP = 50;
/** 回填 resumeRef 只看最近的终端运行：古老的死运行没有原生 id，每轮重试没有意义 */
const TERMINAL_BACKFILL_MAX_AGE_MS = 7 * 86_400_000;

/** 工作台已认识的 (执行器|原生会话 id) 集：sessions.cliRef + terminal_runs.resume_ref。
 * history.import.list / apply 与自动收录共用同一去重口径。 */
export function knownNativeRefs(store: Store): Set<string> {
  const known = new Set<string>();
  for (const s of store.listSessions()) {
    if (s.cliRef !== null && s.cliRef !== "") known.add(`${s.runtimeId}|${s.cliRef}`);
  }
  for (const r of store.listTerminalRuns(undefined, 500)) {
    if (r.resumeRef !== null && r.resumeRef !== "") known.add(`${r.runtimeId.replace(/^daemon:/, "")}|${r.resumeRef}`);
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
 * 空会话探测，三级从严（自动收录宁缺毋滥，手动导入不受此限）：
 * 1. messageCount > 0 —— 多数 reader 列表就报真实条数，直接过；
 * 2. 转录形 source stat —— mcode 等列表不臆造条数的家：source 是转录文件
 *    （.jsonl/.json/.ndjson）或含 messages.jsonl 的目录，size>0 才过（挡掉
 *    mcode 模型探测留下的 0 字节会话）。sqlite 路径（opencode/openclaw 等
 *    source=db 文件）不在此列——db 恒非空，stat 无意义；
 * 3. read() 下钻一次 —— 上面两级都判不了的候选（每轮差集后通常 0~2 条），
 *    读真实转录：null 或 0 条 = 无内容。本轮跳过的，下轮有内容了自然会再进差集。
 */
async function sessionHasContent(s: NativeSessionSummary): Promise<boolean> {
  if (s.messageCount > 0) return true;
  const transcriptShaped = (p: string): boolean => /\.(jsonl|ndjson|json)$/i.test(p);
  const candidates = transcriptShaped(s.source) ? [s.source] : [path.join(s.source, "messages.jsonl")];
  for (const candidate of candidates) {
    if (!transcriptShaped(candidate)) continue;
    try {
      const st = statSync(candidate);
      if (st.isFile()) return st.size > 0;
    } catch {
      // 探不到就落到 read() 下钻
    }
  }
  try {
    const detail = await readNativeSession(s.executorId, s.sessionId);
    return detail !== null && detail.transcript.length > 0;
  } catch {
    return false;
  }
}

export interface AutoCollectDeps {
  readonly store: Store;
  readonly listBots: () => Promise<readonly BotDefinition[]>;
  /** 回填该单元 terminal_runs 缺失的 resumeRef（index.ts 提供：与 unit.history 同款回溯）。
   * 在差集之前跑，保证工作台自己派发的 TUI 会话先进 known 集、不被重复收录。 */
  readonly backfillTerminalRefs: (unitId: string, rootPath: string) => Promise<void>;
  readonly getWss: () => WebSocketServer | null;
}

export interface NativeAutoCollector {
  /** 立即跑一轮（history.refreshNative 清缓存后联动）；上一轮在途时静默共享 */
  collectNow(): Promise<void>;
  stop(): void;
}

async function runPass(deps: AutoCollectDeps): Promise<void> {
  const bots = await deps.listBots().catch(() => [] as readonly BotDefinition[]);
  for (const bot of bots) {
    const unitId = typeof bot.id === "string" ? bot.id : "";
    const rootPath = typeof bot.rootPath === "string" ? bot.rootPath : "";
    if (unitId === "" || rootPath === "") continue;
    if (bot["unregistered"] === true) continue;
    // bot.json 的 autoCollect 字段缺省 = 开（收录是常态，关闭是显式选择）
    if (bot["autoCollect"] === false) continue;
    try {
      await collectUnit(deps, bot, unitId, rootPath);
    } catch (err: unknown) {
      log.debug("[auto-collect] 单元收录失败（跳过本轮）", { unitId, err: String(err) });
    }
  }
}

async function collectUnit(
  deps: AutoCollectDeps,
  bot: BotDefinition,
  unitId: string,
  rootPath: string,
): Promise<void> {
  await deps.backfillTerminalRefs(unitId, rootPath);
  const rows = await listNativeSessions(rootPath, [], AUTOCOLLECT_SCAN_LIMIT);
  const known = knownNativeRefs(deps.store);
  const unitName = typeof bot.name === "string" && bot.name !== "" ? bot.name : unitId;
  let imported = 0;
  for (const r of rows) {
    // 每 bot 每轮上限：首轮回填不风暴，剩下的下一轮继续（30s 后）
    if (imported >= AUTOCOLLECT_PER_UNIT_CAP) break;
    if (known.has(`${r.executorId}|${r.sessionId}`)) continue;
    if (AUTOCOLLECT_EXCLUDED_EXECUTORS.has(r.executorId)) continue;
    // cwd 不明（null）或不符的不自动收——手动导入仍可见可选
    if (r.rootPath === null || !samePath(r.rootPath, rootPath)) continue;
    if (!(await sessionHasContent(r))) continue;
    const rowId = materializeImportedSession(deps.store, {
      unitId,
      rootPath,
      executorId: r.executorId,
      native: { sessionId: r.sessionId, title: r.title, startedAt: r.startedAt, updatedAt: r.updatedAt },
      known,
    });
    if (rowId === null) continue;
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
