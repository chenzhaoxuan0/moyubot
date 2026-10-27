/**
 * 轨迹落盘 —— "落盘即轨迹"（docs/06 §五）：每个会话的 RuntimeEvent 打上
 * TraceRecord 时间戳，append-only 写 .waku/traces/<date>.jsonl。
 *
 * TraceRecord 本身没有版本字段（契约冻结，不为此改 events.ts），所以每个文件
 * 第一行写 {"v":1,"format":"trace"} 头——以后格式演进靠文件头升版，行内容不动。
 */

import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  private async appendNow(record: TraceRecord): Promise<void> {
    const dateKey = new Date(record.at).toISOString().slice(0, 10);
    const file = this.fileFor(dateKey);
    await mkdir(path.dirname(file), { recursive: true });
    if (!existsSync(file)) {
      await appendFile(file, HEADER + "\n", "utf8");
    }
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  }

  /**
   * 读回一个会话的完整轨迹（WP-3：exportTrace 以落盘账本为准，事件环只是热缓存）。
   * 跨日期文件升序拼接，NDJSON 输出（每行一个 TraceRecord，不含文件头行）；
   * afterSeq > 0 时只返回 seq 大于它的行（断线补拉的游标）。
   */
  async readSessionNdjson(sessionId: SessionId, afterSeq = 0): Promise<string> {
    const dir = path.join(this.homeDir, "traces");
    if (!existsSync(dir)) return "";
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    const out: string[] = [];
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line === "" || !line.startsWith("{")) continue; // 首行是 {"v":1,"format":"trace"} 头
        try {
          const rec = JSON.parse(line) as TraceRecord;
          if (rec.sessionId === sessionId && rec.seq > afterSeq) out.push(line);
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
      }
    }
    return removed;
  }
}
