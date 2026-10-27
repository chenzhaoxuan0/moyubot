/**
 * 会话分享（docs/26）——「文件即数据」的跨机器会话传递。
 *
 * 导出：session.export 把一条会话的全量事实（台账行 + messages + 轨迹账本
 * RuntimeEvent 流）打包成带版本号的 bundle。轨迹账本本身就是全量执行历史
 * （消息/工具调用/思考/用量），导出的文件导入后可完整回放——不需要 T3 那种
 * budget 化的上下文 handoff 摘要。
 *
 * 导入：session.importFile 把 bundle 落成 impf_ 前缀的台账行（source="shared"）。
 * 与 imp_ 原生导入行的关键差异：
 * - cliRef 剥离——原机器的原生会话在本机不存在，resume 不可能；继续对话走
 *   既有 conversation_id 换代开新段（行为与现有导入会话一致，无新逻辑）。
 * - 事件不是从原生存储投影，而是直接重放 bundle 里的 RuntimeEvent 流：
 *   seq 重排 1..n、sessionId 换新行 id、messageId/callId 加 impf_ 前缀重写
 *   （配对关系保持：同一原 id 恒映射同一新 id）。
 *
 * 格式纪律（沿 trace.ts 的文件头升版口径）：bundle 头带 {v, format}，行内容
 * 不随小改版重排；解析端遇到 v 高于自己认识的版本直接拒绝，提示升级工作台。
 */

import type { Store, SessionRow } from "../store/db.ts";
import type { TraceSink } from "../runtime/trace.ts";
import type { TraceRecord, RuntimeEvent, SessionId, UnitId } from "../contract.ts";
import { asSessionId, asUnitId } from "../contract.ts";
import { log } from "../log.ts";

export const SHARED_BUNDLE_FORMAT = "awb-session";
export const SHARED_BUNDLE_VERSION = 1;

/** 导出 bundle 的形状（v1 冻结；演进靠升 v，行内容不重排） */
export interface SharedSessionBundle {
  readonly v: number;
  readonly format: string;
  readonly exportedAt: number;
  readonly exportedBy: string;
  readonly session: {
    readonly originId: string;
    readonly title: string;
    readonly runtimeId: string;
    readonly rootPath: string | null;
    readonly source: string | null;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly turnCount: number;
    readonly stats: SessionRow["stats"];
  };
  readonly messages: ReadonlyArray<{ at: number; role: string; text: string }>;
  readonly events: ReadonlyArray<{ seq: number; at: number; event: RuntimeEvent }>;
}

/** bundle 事件条数上限：防手工拼的巨型文件把导入 RPC 卡成 DoS */
const MAX_EVENTS = 200_000;
const MAX_MESSAGES = 50_000;

/** 单条消息/事件正文的字节数感知上限（防内存炸弹；正常会话远达不到） */
function roughSize(s: string): number {
  return s.length * 2;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/** 导出侧：台账行 + messages + 账本 NDJSON → bundle。traceNdjson 由调用方读账本 */
export function buildSharedBundle(row: SessionRow, messages: SharedSessionBundle["messages"], events: SharedSessionBundle["events"]): SharedSessionBundle {
  return {
    v: SHARED_BUNDLE_VERSION,
    format: SHARED_BUNDLE_FORMAT,
    exportedAt: Date.now(),
    exportedBy: "agent-workbench",
    session: {
      originId: row.id,
      title: row.title,
      // 台账里个别路径带 daemon: 前缀，导出归一为裸执行器 id
      runtimeId: row.runtimeId.replace(/^daemon:/, ""),
      rootPath: row.rootPath,
      source: row.source ?? null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      turnCount: row.turnCount,
      stats: row.stats,
    },
    messages,
    events,
  };
}

/** 账本 NDJSON → bundle 的 events 段（容错读：坏行跳过，与 session.events.since 同口径） */
export function parseTraceNdjson(nd: string): SharedSessionBundle["events"] {
  const out: Array<{ seq: number; at: number; event: RuntimeEvent }> = [];
  for (const l of nd.split("\n")) {
    if (l === "" || l.startsWith(`{"v":`)) continue; // 跳过空行与文件头
    try {
      const r = JSON.parse(l) as { seq?: unknown; at?: unknown; event?: unknown };
      if (typeof r.seq === "number" && typeof r.event === "object" && r.event !== null) {
        out.push({ seq: r.seq, at: typeof r.at === "number" ? r.at : 0, event: r.event as RuntimeEvent });
      }
    } catch {
      // 坏行跳过（半刷行/截断行不崩导出）
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** 解析并校验 bundle（导入的第一道闸：形状、版本、规模） */
export function parseSharedBundle(raw: unknown): SharedSessionBundle {
  if (typeof raw !== "object" || raw === null) throw new BundleError("文件内容不是有效的会话分享包");
  const b = raw as Record<string, unknown>;
  if (b.format !== SHARED_BUNDLE_FORMAT) throw new BundleError("这不是工作台会话分享文件（format 不匹配）");
  if (typeof b.v !== "number") throw new BundleError("分享包缺少版本号");
  if (b.v > SHARED_BUNDLE_VERSION) {
    throw new BundleError(`分享包版本 v${String(b.v)} 高于本工作台支持的 v${SHARED_BUNDLE_VERSION}，请先升级工作台再导入`);
  }
  const s = b.session as Record<string, unknown> | undefined;
  if (typeof s !== "object" || s === null || typeof s.originId !== "string" || typeof s.title !== "string" ||
      typeof s.runtimeId !== "string" || typeof s.startedAt !== "number") {
    throw new BundleError("分享包的会话元数据不完整");
  }
  if (!Array.isArray(b.messages)) throw new BundleError("分享包缺少 messages 段");
  if (!Array.isArray(b.events)) throw new BundleError("分享包缺少 events 段");
  if (b.events.length > MAX_EVENTS) throw new BundleError(`分享包事件数超出上限（${b.events.length} > ${MAX_EVENTS}）`);
  if (b.messages.length > MAX_MESSAGES) throw new BundleError(`分享包消息数超出上限（${b.messages.length} > ${MAX_MESSAGES}）`);
  return raw as SharedSessionBundle;
}

/** importf 行 id：impf_ 前缀（不落入 imp_ 隐式解析空间，sync.ts 只认 imp_） */
export function sharedRowId(originId: string): string {
  return `impf_${originId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

/**
 * messageId / callId 重写表：同一原 id 恒映射同一新 id（impf_N 顺序编号），
 * message.delta↔completed、tool.started↔completed 的配对关系因此保持。
 */
class IdRemap {
  #next = 0;
  readonly #map = new Map<string, string>();
  remap(id: string): string {
    let mapped = this.#map.get(id);
    if (mapped === undefined) {
      mapped = `impf_${++this.#next}`;
      this.#map.set(id, mapped);
    }
    return mapped;
  }
}

/**
 * 重放 bundle 事件流到本地账本：seq 重排 1..n，sessionId 换新行 id，
 * messageId/callId 重写。返回写盘记录 + 事件正文的粗略规模（字节）。
 */
export function projectSharedEvents(
  bundle: SharedSessionBundle,
  newSessionId: string,
  unitId: string,
): { records: TraceRecord[]; bytes: number } {
  const sid = asSessionId(newSessionId);
  const uid = asUnitId(unitId);
  const runtimeId = bundle.session.runtimeId;
  const remap = new IdRemap();
  const records: TraceRecord[] = [];
  let bytes = 0;
  let seq = 0;
  for (const e of bundle.events) {
    const ev = e.event as Record<string, unknown>;
    if (typeof ev !== "object" || ev === null || typeof ev.type !== "string") continue;
    // 浅拷贝改字段（sessionId 恒换、id 字段按需重写），大段正文保持引用不复制
    const next: Record<string, unknown> = { ...ev, sessionId: sid };
    if (typeof ev.messageId === "string") next.messageId = remap.remap(ev.messageId);
    if (typeof ev.callId === "string") next.callId = remap.remap(ev.callId);
    bytes += roughSize(JSON.stringify(next));
    if (bytes > 512 * 1024 * 1024) throw new BundleError("分享包正文规模超出上限");
    records.push({ seq: ++seq, at: e.at, sessionId: sid, unitId: uid, runtimeId, event: next as unknown as RuntimeEvent });
  }
  return { records, bytes };
}

export interface ImportSharedResult {
  readonly imported: boolean;
  readonly sessionId?: string;
  readonly reason?: "exists";
  readonly messages: number;
  readonly events: number;
}

/**
 * 导入落库：台账行 + messages + 事件重放。已存在（同 originId 已导入过）幂等跳过。
 * 失败原子性靠顺序：先校验并重放好事件记录（纯内存），再写库写账本——中途
 * 失败最坏留下一条空行，重新导入会命中 exists 幂等，不产生半截时间线。
 */
export async function importSharedSession(
  store: Store,
  traceSink: TraceSink,
  args: { bundle: SharedSessionBundle; unitId: string },
): Promise<ImportSharedResult> {
  const { bundle } = args;
  const rowId = sharedRowId(bundle.session.originId);
  const messageCount = bundle.messages.length;
  const eventCount = bundle.events.length;
  if (store.getSession(rowId) !== undefined) {
    return { imported: false, reason: "exists", sessionId: rowId, messages: messageCount, events: eventCount };
  }
  const { records } = projectSharedEvents(bundle, rowId, args.unitId);

  // 谱系/分叉列不跨机器：conversationId 是本机谱系 id，fork 血缘同理，落 null
  store.upsertSession({
    id: rowId,
    unitId: args.unitId,
    runtimeId: bundle.session.runtimeId,
    title: bundle.session.title.trim() !== "" ? bundle.session.title.trim().slice(0, 120) : "（分享导入会话）",
    status: "done",
    startedAt: bundle.session.startedAt,
    endedAt: bundle.session.endedAt ?? bundle.session.startedAt,
    // 原生续跑引用剥离：原机器的 cliRef 在本机无意义，留着只会诱导 resume 失败
    cliRef: null,
    rootPath: bundle.session.rootPath,
    source: "shared",
    conversationId: null,
    lastSeq: records.length,
    turnCount: Number.isFinite(bundle.session.turnCount) ? bundle.session.turnCount : 0,
    forkOfSession: null,
    forkAtSeq: null,
    forkKind: null,
    stats: bundle.session.stats,
  });
  for (const m of bundle.messages) {
    const role = m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "system";
    store.insertMessage(rowId, Number.isFinite(m.at) ? m.at : bundle.session.startedAt, role, String(m.text ?? ""));
  }
  await traceSink.appendMany(records);
  log.info("[share-import] 分享会话已导入", {
    originId: bundle.session.originId,
    rowId,
    runtimeId: bundle.session.runtimeId,
    messages: messageCount,
    events: records.length,
  });
  return { imported: true, sessionId: rowId, messages: messageCount, events: records.length };
}
