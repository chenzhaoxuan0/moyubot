/**
 * 轨迹落盘 —— "落盘即轨迹"（docs/06 §五）：每个会话的 RuntimeEvent 打上
 * TraceRecord 时间戳，append-only 写 .waku/traces/<date>.jsonl。
 *
 * TraceRecord 本身没有版本字段（契约冻结，不为此改 events.ts），所以每个文件
 * 第一行写 {"v":1,"format":"trace"} 头——以后格式演进靠文件头升版，行内容不动。
 */

import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { SessionId, TraceRecord } from "../contract.ts";

const HEADER = JSON.stringify({ v: 1, format: "trace", writtenBy: "agent-workbench-daemon" });

export class TraceSink {
  private cachedDate = "";
  private cachedFile = "";
  /** 写链（评审 P2）：appendFile 并发完成顺序无保证，会让账本 seq 乱序、日期翻转首条双 header */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly homeDir: string) {}

  private fileFor(dateKey: string): string {
    if (this.cachedDate !== dateKey || this.cachedFile === "") {
      this.cachedDate = dateKey;
      this.cachedFile = path.join(this.homeDir, "traces", `${dateKey}.jsonl`);
    }
    return this.cachedFile;
  }

  /**
   * 追加一条轨迹。**串行化**：appendFile 的完成顺序无保证，并发写会让同一会话的
   * seq 在文件里乱序，且日期翻转时两个并发首写都看到「文件不存在」→ 双 header。
   * 调用方是 fire-and-forget（`void trace.append(...)`），所以链本身吞掉失败，
   * 失败只由本次调用的返回值报给调用方，不冒成 unhandled rejection。
   */
  append(record: TraceRecord): Promise<void> {
    const next = this.chain.then(
      () => this.appendNow(record),
      () => this.appendNow(record), // 上一次写失败不阻塞后续
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 批量追加（同一会话的一次性投影/重放用）：一条链节点写完全部记录——
   * 逐条 append 是每个记录一次 appendFile 系统调用，重投影一个数百条目的
   * 会话要上千次串行 IO，RPC 秒级等待的元凶之一。记录必须同会话同日期段
   * （调用方保证；跨日自动按日期分段写）。
   */
  appendMany(records: readonly TraceRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    const next = this.chain.then(
      () => this.appendManyNow(records),
      () => this.appendManyNow(records),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async appendManyNow(records: readonly TraceRecord[]): Promise<void> {
    // 按日期分段（投影时间戳取自原生转录，可能跨天）
    const byDate = new Map<string, TraceRecord[]>();
    for (const r of records) {
      const dateKey = new Date(r.at).toISOString().slice(0, 10);
      const bucket = byDate.get(dateKey);
      if (bucket === undefined) byDate.set(dateKey, [r]);
      else bucket.push(r);
    }
    for (const [dateKey, bucket] of byDate) {
      const file = this.fileFor(dateKey);
      await mkdir(path.dirname(file), { recursive: true });
      const lines = bucket.map((r) => JSON.stringify(r));
      const body = lines.join("\n") + "\n";
      if (existsSync(file)) {
        await appendFile(file, body, "utf8");
      } else {
        await appendFile(file, HEADER + "\n" + body, "utf8");
      }
      this.#indexAppend(file, lines);
    }
  }

  private async appendNow(record: TraceRecord): Promise<void> {
    const dateKey = new Date(record.at).toISOString().slice(0, 10);
    const file = this.fileFor(dateKey);
    await mkdir(path.dirname(file), { recursive: true });
    if (!existsSync(file)) {
      await appendFile(file, HEADER + "\n", "utf8");
    }
    const line = JSON.stringify(record);
    await appendFile(file, line + "\n", "utf8");
    this.#indexAppend(file, [line]);
  }

  /**
   * 按文件索引：file → {签名, 会话→行[]}。readSessionNdjson 曾是每次调用
   * 全库读入+逐行解析（42MB 级，秒级），点开会话/断线补拉都在这条路上——
   * 现在每个文件只解析一次，之后按 (mtime,size) 签名增量失效；追加写直接
   * 往索引里补行，读路径零解析。
   */
  readonly #fileIndex = new Map<string, { mtimeMs: number; size: number; bySid: Map<string, string[]> }>();

  async #ensureIndex(): Promise<void> {
    const dir = path.join(this.homeDir, "traces");
    if (!existsSync(dir)) {
      this.#fileIndex.clear();
      return;
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    // 磁盘上已消失的文件：索引条目一并清掉（防幽灵行）
    for (const known of this.#fileIndex.keys()) {
      if (!files.includes(known)) this.#fileIndex.delete(known);
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let st: { mtimeMs: number; size: number };
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const cur = this.#fileIndex.get(f);
      if (cur !== undefined && cur.mtimeMs === st.mtimeMs && cur.size === st.size) continue;
      const bySid = new Map<string, string[]>();
      try {
        const raw = await readFile(full, "utf8");
        for (const line of raw.split("\n")) {
          if (line === "" || !line.startsWith("{")) continue; // 首行是 {"v":1,"format":"trace"} 头
          try {
            const rec = JSON.parse(line) as TraceRecord;
            if (typeof rec.sessionId !== "string") continue;
            const bucket = bySid.get(rec.sessionId);
            if (bucket === undefined) bySid.set(rec.sessionId, [line]);
            else bucket.push(line);
          } catch {
            // 坏行跳过：账本容错读
          }
        }
      } catch {
        continue;
      }
      this.#fileIndex.set(f, { mtimeMs: st.mtimeMs, size: st.size, bySid });
    }
  }

  /** 追加后同步索引（避免下次读时因签名变化整文件重解析） */
  #indexAppend(file: string, lines: readonly string[]): void {
    const cur = this.#fileIndex.get(path.basename(file));
    if (cur === undefined) return; // 该文件还没进索引：下次 ensure 按需解析
    try {
      const st = statSync(file);
      cur.mtimeMs = st.mtimeMs;
      cur.size = st.size;
    } catch {
      /* 签名拿不到就让下次重解析 */
    }
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as TraceRecord;
        if (typeof rec.sessionId !== "string") continue;
        const bucket = cur.bySid.get(rec.sessionId);
        if (bucket === undefined) cur.bySid.set(rec.sessionId, [line]);
        else bucket.push(line);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 读回一个会话的完整轨迹（WP-3：exportTrace 以落盘账本为准，事件环只是热缓存）。
   * 跨日期文件升序拼接，NDJSON 输出（每行一个 TraceRecord，不含文件头行）；
   * afterSeq > 0 时只返回 seq 大于它的行（断线补拉的游标）。
   */
  async readSessionNdjson(sessionId: SessionId, afterSeq = 0): Promise<string> {
    await this.#ensureIndex();
    const out: string[] = [];
    // 按排序后的文件名序迭代（跨日期文件升序拼接的既定语义）：#fileIndex 的
    // Map 只当缓存用，插入序在「中间文件 stat 失败 continue / prune 后重插」
    // 之后会偏离文件名序，直接迭代 Map 会跨文件乱序
    const files = [...this.#fileIndex.keys()].sort();
    for (const f of files) {
      const entry = this.#fileIndex.get(f);
      if (entry === undefined) continue;
      const bucket = entry.bySid.get(sessionId);
      if (bucket === undefined) continue;
      if (afterSeq === 0) {
        // 循环 push：十万级 bucket 上 spread 会 Maximum call stack size exceeded
        for (const line of bucket) out.push(line);
        continue;
      }
      for (const line of bucket) {
        try {
          const rec = JSON.parse(line) as TraceRecord;
          if (rec.seq > afterSeq) out.push(line);
        } catch {
          // 坏行跳过：账本容错读
        }
      }
    }
    return out.length > 0 ? out.join("\n") + "\n" : "";
  }

  /**
   * 一次性算出每个会话在账本里的最大 seq（loadPersisted 的崩溃对账用）。
   * 逐会话调 readSessionNdjson 是每个会话全文重读所有 trace 文件——会话数 ×
   * 全库体积的并发字符串在途直接把堆打爆（实测 315 会话 × 42MB，启动 8 秒
   * OOM）；这里每个文件只读一遍，全库对账一次完成。
   */
  async maxSeqBySession(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const dir = path.join(this.homeDir, "traces");
    if (!existsSync(dir)) return out;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line === "" || !line.startsWith("{")) continue;
        try {
          const rec = JSON.parse(line) as TraceRecord;
          if (typeof rec.seq !== "number" || typeof rec.sessionId !== "string") continue;
          const prev = out.get(rec.sessionId);
          if (prev === undefined || rec.seq > prev) out.set(rec.sessionId, rec.seq);
        } catch {
          // 坏行跳过：账本容错读
        }
      }
    }
    return out;
  }

  /**
   * 一次性迁移用：从账本剔除指定会话的**原生投影**记录（msg_ext_/tc_ext_/
   * think_ext_ 前缀），保留可能存在的真实 host 事件（旧版点击即 reattach 的
   * 续聊轮次）。逐文件原子重写；返回剔除条数。
   */
  async pruneExtRecords(sessionIds: readonly string[]): Promise<number> {
    const ids = new Set(sessionIds);
    const dir = path.join(this.homeDir, "traces");
    if (!existsSync(dir) || ids.size === 0) return 0;
    let removed = 0;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      const raw = await readFile(full, "utf8");
      let changed = false;
      const kept = raw.split("\n").filter((line) => {
        if (line === "" || !line.startsWith("{")) return true;
        try {
          const rec = JSON.parse(line) as TraceRecord & { event?: { messageId?: unknown; callId?: unknown } };
          if (!ids.has(String(rec.sessionId ?? ""))) return true;
          const extId = String(rec.event?.messageId ?? rec.event?.callId ?? "");
          if (/^(msg_ext_|tc_ext_|think_ext_)/.test(extId)) {
            changed = true;
            removed++;
            return false;
          }
        } catch {
          // 坏行保留：账本容错
        }
        return true;
      });
      if (changed) {
        const tmp = `${full}.tmp`;
        await writeFile(tmp, kept.join("\n"), "utf8");
        await rename(tmp, full);
        // 重写过：该文件的索引条目作废（下次读按需重解析）
        this.#fileIndex.delete(f);
      }
    }
    return removed;
  }
}
