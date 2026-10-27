/**
 * claude reader —— ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
 * 每行：{type:"user"|"assistant"|"summary"|"queue-operation"|…, message?:{role,content},
 *        timestamp, sessionId, cwd?, isSidechain?}
 * 无格式稳定性承诺（内部 transcript），宽容解析。
 */

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import {
  collectFiles,
  entriesFromContent,
  fileMtimeMs,
  homeDir,
  isRecord,
  readJsonLines,
  samePath,
  str,
  textOf,
  toMs,
} from "../util.ts";

function mungedToPath(dirName: string): string {
  // C--Users-chenziyu-project → C:\Users\chenziyu\project（claude 的 munge：: 和 \ 都变 -，不可逆，仅近似）
  return dirName.replace(/-/g, "\\").replace(/^([A-Za-z])\\/, "$1:\\");
}

interface ClaudeScan {
  summary: NativeSessionSummary;
  lines: unknown[];
}

/** 解析单个会话文件 → 摘要 + 原始行（scanAll 与 read 的快/慢路径共用） */
function parseSessionFile(file: string): ClaudeScan | null {
  const lines = readJsonLines(file);
  if (lines.length === 0) return null;
  const sessionId = path.basename(file, ".jsonl");
  const dirName = path.basename(path.dirname(file));
  let title = "";
  let startedAt = 0;
  let updatedAt = 0;
  let count = 0;
  let cwd: string | null = null;
  for (const l of lines) {
    if (!isRecord(l)) continue;
    if (cwd === null) cwd = str(l["cwd"]) ?? null;
    const at = toMs(l["timestamp"]);
    if (at !== undefined) {
      if (startedAt === 0) startedAt = at;
      updatedAt = Math.max(updatedAt, at);
    }
    const type = str(l["type"]);
    if (type !== "user" && type !== "assistant") continue;
    if (l["isSidechain"] === true) continue;
    count++;
    const m = l["message"];
    if (title === "" && type === "user" && isRecord(m)) {
      // 跳过命令回显（<command-name> 等）与系统注入
      const text = textOf(m["content"]).trim();
      if (text !== "" && !text.startsWith("<")) title = text.slice(0, 80);
    }
  }
  if (count === 0) return null;
  return {
    summary: {
      executorId: "claude",
      sessionId,
      rootPath: cwd ?? mungedToPath(dirName),
      title: title === "" ? "claude 会话" : title,
      startedAt: startedAt || fileMtimeMs(file),
      updatedAt: updatedAt || startedAt,
      messageCount: count,
      source: file,
    },
    lines,
  };
}

/**
 * 扫描 ~/.claude/projects 的会话文件（按 mtime 取最新的前 limit 个）。
 * 逐文件同步读+逐行解析在会话多时是数秒级连续阻塞（实测把主循环卡出
 * loop-stall）——mtime 排序取 top-K + 每 8 个文件让行一次，首扫毫秒级。
 */
async function scanAll(limit: number): Promise<ClaudeScan[]> {
  const root = path.join(homeDir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const all = collectFiles(root, (n) => n.endsWith(".jsonl"), 800);
  // updatedAt ≈ 文件 mtime（文件随对话持续追加）：mtime 排序后只需解析前 K 个
  const byMtime = all
    .map((f) => ({ f, m: fileMtimeMs(f) }))
    .sort((a, b) => b.m - a.m);
  const out: ClaudeScan[] = [];
  const target = byMtime.slice(0, limit);
  for (let fi = 0; fi < target.length; fi++) {
    if (fi % 8 === 7) await new Promise<void>((resolve) => setImmediate(resolve));
    const hit = parseSessionFile(target[fi]!.f);
    if (hit !== null) out.push(hit);
  }
  return out;
}

/** 直接定位 <root>/<munged>/<sessionId>.jsonl（read 的快路径：免全库扫描） */
function findSessionFile(root: string, sessionId: string): string | null {
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(root, d.name, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function createClaudeReader(): SessionReader {
  return {
    executorId: "claude",
    async list(rootPath, limit) {
      // 列表按 mtime 取最新 top-K 解析即可（updatedAt≈文件 mtime，文件随对话
      // 持续追加）：全量解析 800 个文件是秒级阻塞，top-K 后首扫毫秒级
      const all = await scanAll(Math.min(800, Math.max(60, limit * 2)));
      const filtered = rootPath === null ? all : all.filter((s) => s.summary.rootPath !== null && samePath(s.summary.rootPath, rootPath));
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      // 快路径：会话文件名即 id，直接定位解析，免全库扫描
      const root = path.join(homeDir(), ".claude", "projects");
      const file = findSessionFile(root, sessionId);
      const hit = file !== null ? parseSessionFile(file) : null;
      if (hit === undefined || hit === null) return null;
      const transcript = [];
      for (const l of hit.lines) {
        if (!isRecord(l)) continue;
        const type = str(l["type"]);
        const at = toMs(l["timestamp"]);
        if (type !== "user" && type !== "assistant") continue;
        if (l["isSidechain"] === true) continue;
        const m = l["message"];
        if (!isRecord(m)) continue;
        const text = textOf(m["content"]).trim();
        if (type === "user" && (text.startsWith("<command-") || text.startsWith("<local-"))) continue;
        transcript.push(...entriesFromContent(type, m["content"], at));
      }
      return { ...hit.summary, transcript };
    },
  };
}
