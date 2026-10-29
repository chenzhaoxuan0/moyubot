/**
 * zcode reader —— 双源：
 * 列表：~/.zcode/v2/sessions/<workspaceHash>/<taskId>.json（{meta:{taskId,title,workspacePath,
 *        createdAt,updatedAt,status},messages:[{role,content,timestamp,turnIndex}]}，最干净的一家）
 * 兜底：~/.zcode/cli/db/db.sqlite 的 session 表（daemon 既有先例同源）
 * 忽略 .deleted.json（已删会话）。
 */

import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { collectFiles, homeDir, isRecord, num, samePath, str } from "../util.ts";

interface ZcodeScan {
  summary: NativeSessionSummary;
  messages: unknown[];
}

// ---- JSON 存档扫描的清单签名缓存（同 readers/claude.ts 的 list 缓存口径）----
// v2/sessions 的 JSON 是落盘存档：安静时段清单不变，而此前每次 list 都全量
// JSON.parse 最多 300 个含完整 messages 的文件 —— 自动收录 30s 一轮 × 每 bot
// 一次，把这段同步读放大成事件循环上的周期性风暴（daemon 冷启动实测首个
// unit.history 被拖到 15s）。清单 (path,mtime,size) 摘要不变 → 结果必然不变，
// 直接回缓存，全量解析每进程只付一次。同秒同长度的内容篡改检测不到，只读
// 列表缓存接受该残留风险。sqlite 兜底源是索引快查，不进缓存保持新鲜。

let jsonArchivesSig: string | null = null;
let jsonArchivesCache: ZcodeScan[] = [];

/** 清单 → 32 位 FNV-1a 短签名（文件名排序折入，顺序稳定；带数量防撞） */
function signatureOf(files: readonly { f: string; m: number; s: number }[]): string {
  let h = 0x811c9dc5;
  const sorted = [...files].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  for (const e of sorted) {
    const s = `${e.f}:${e.m}:${e.s};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${sorted.length.toString(16)}-${h.toString(16)}`;
}

function scanJsonArchives(): ZcodeScan[] {
  const root = path.join(homeDir(), ".zcode", "v2", "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n.endsWith(".json") && !n.includes("deleted"), 300);
  // stat 失败的文件不入清单也不解析：{m:0,s:0} 桩会让签名在好坏间抖动，
  // 每次抖动都是一场 300 文件全量重解析（磁盘最忙时最不该发生）
  const stamped: { f: string; m: number; s: number }[] = [];
  for (const f of files) {
    try {
      const st = statSync(f);
      stamped.push({ f, m: st.mtimeMs, s: st.size });
    } catch {
      /* 跳过 */
    }
  }
  const sig = signatureOf(stamped);
  if (sig === jsonArchivesSig) return jsonArchivesCache;
  const out: ZcodeScan[] = [];
  for (const { f } of stamped) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const meta = raw["meta"];
    if (!isRecord(meta)) continue;
    const taskId = str(meta["taskId"]) ?? path.basename(f, ".json");
    const messages = Array.isArray(raw["messages"]) ? raw["messages"] : [];
    if (messages.length === 0) continue;
    const startedAt = num(meta["createdAt"]) ?? 0;
    out.push({
      summary: {
        executorId: "zcode",
        sessionId: taskId,
        rootPath: str(meta["workspacePath"]) ?? null,
        title: (str(meta["title"]) ?? "").trim() || "zcode 会话",
        startedAt,
        updatedAt: num(meta["updatedAt"]) ?? startedAt,
        messageCount: messages.length,
        source: f,
      },
      messages,
    });
  }
  jsonArchivesSig = sig;
  jsonArchivesCache = out;
  return out;
}

function scanAll(limit: number): ZcodeScan[] {
  // 拷贝再追加：scanJsonArchives 返回的是缓存数组本体，原地 push 会把 sqlite
  // 兜底行灌进缓存——每次清单命中都重复追加一份，无限增长且 sessionId 重复
  const out = [...scanJsonArchives()];
  out.push(...scanSqlite(limit, new Set(out.map((s) => s.summary.sessionId))));
  return out;
}

/**
 * sqlite 兜底源（~/.zcode/cli/db/db.sqlite 的 session 表）：CLI 近期会话在这里，
 * v2/sessions 的 JSON 只有落盘存档（实测本机 JSON 全是 claude-import 旧档）。
 * 只收 `sess_...` 的行 —— TUI 的 --resume 只认这个格式（--help 实测）；
 * `session_*`（app-server/host 面的会话，如工作台自己的 host 流）与
 * `sess_subagent_*`（内部子代理）传给 --resume 会静默开新会话，不收。
 * 正文不在此库，read() 对 sqlite-only 会话自然落 null。
 */
function scanSqlite(limit: number, exclude: ReadonlySet<string>): ZcodeScan[] {
  const dbPath = path.join(homeDir(), ".zcode", "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) return [];
  const out: ZcodeScan[] = [];
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, directory, path, title, time_created, time_updated FROM session
         WHERE time_deleted IS NULL AND id LIKE 'sess_%' AND id NOT LIKE 'sess_subagent_%'
         ORDER BY time_created DESC LIMIT ?`,
      )
      .all(limit) as unknown[];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const sessionId = str(row["id"]);
      if (sessionId === undefined || sessionId === "") continue;
      // 同会话两处都有时 JSON 版带正文，优先；sqlite 只补 JSON 没有的
      if (exclude.has(sessionId)) continue;
      const startedAt = num(row["time_created"]) ?? 0;
      out.push({
        summary: {
          executorId: "zcode",
          sessionId,
          rootPath: str(row["directory"]) ?? str(row["path"]) ?? null,
          title: (str(row["title"]) ?? "").trim(),
          startedAt,
          updatedAt: num(row["time_updated"]) ?? startedAt,
          messageCount: 0,
          source: dbPath,
        },
        messages: [],
      });
    }
  } catch {
    // busy / schema 变化 —— 兜底源静默跳过
  } finally {
    db.close();
  }
  return out;
}

export function createZcodeReader(): SessionReader {
  return {
    executorId: "zcode",
    async list(rootPath, limit) {
      const all = scanAll(300);
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(300).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript: NativeTranscriptEntry[] = [];
      for (const m of hit.messages) {
        if (!isRecord(m)) continue;
        const role: "user" | "assistant" = str(m["role"]) === "user" ? "user" : "assistant";
        const raw = m["content"];
        const text = (typeof raw === "string" ? raw : "").trim();
        if (text === "" || text.startsWith("<")) continue;
        transcript.push({ kind: role, text: text.slice(0, 4000), at: num(m["timestamp"]) });
      }
      return { ...hit.summary, transcript };
    },
  };
}
