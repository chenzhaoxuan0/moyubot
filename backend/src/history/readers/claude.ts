/**
 * claude reader —— ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
 * 每行：{type:"user"|"assistant"|"summary"|"queue-operation"|…, message?:{role,content},
 *        timestamp, sessionId, cwd?, isSidechain?}
 * 无格式稳定性承诺（内部 transcript），宽容解析。
 */

import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
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

/** 收集到的会话文件 + (mtime,size) 签名原料（缓存的失效依据） */
interface ClaudeFile {
  readonly f: string;
  readonly m: number;
  readonly s: number;
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
 * 扫描 ~/.claude/projects 的会话文件：mtime 从新到旧解析，**凑满 want 个匹配
 * rootPath 的会话即停**（早停语义）——活跃 bot 秒出；安静 bot 的老会话最坏
 * 全量（不再被全局 top-K 截断丢失，有 (mtime,size) 签名缓存与每 8 文件让行兜底）。
 * 逐文件同步解析曾是数秒级连续阻塞（实测 loop-stall），让行保住事件循环。
 */
async function scanAll(files: readonly ClaudeFile[], limit: number, rootPath: string | null): Promise<ClaudeScan[]> {
  const out: ClaudeScan[] = [];
  let matched = 0;
  for (let fi = 0; fi < files.length && matched < limit; fi++) {
    if (fi % 8 === 7) await new Promise<void>((resolve) => setImmediate(resolve));
    const hit = parseSessionFile(files[fi]!.f);
    if (hit === null) continue;
    // 目录过滤在解析后做（cwd 在文件内容里）：不匹配的也要占解析名额但计数
    if (rootPath !== null && hit.summary.rootPath !== null && !samePath(hit.summary.rootPath, rootPath)) {
      continue;
    }
    out.push(hit);
    matched++;
  }
  return out;
}

// ---- list 结果缓存（兑现上方注释的兜底承诺）--------------------------------
//
// 签名 = root 下文件清单（≤800 个 .jsonl）的 (path,mtime,size) 摘要：清单不变
// （无新增/修改/删除/重命名）→ list 结果必然不变，直接回缓存，安静 bot 的
// 全量解析每进程只付一次。同秒同长度的内容篡改检测不到——只读列表缓存接受
// 该残留风险（trace.ts 的 #fileIndex 同口径）。只缓存 list/scanAll 这类只读
// 结果；read 的详情解析不缓存（单文件，本就快路径）。

/** 缓存条目上限：key 是 (rootPath,limit) 组合，超了按插入序淘汰最旧的 */
const LIST_CACHE_MAX = 8;
const listCache = new Map<string, { signature: string; summaries: readonly NativeSessionSummary[] }>();

/** 清单 → 32 位 FNV-1a 短签名（文件名排序后折入，顺序稳定；带数量防撞） */
function signatureOf(files: readonly ClaudeFile[]): string {
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

/** 收集 root 下全部会话文件并附 (mtime,size)，按 mtime 从新到旧排序（文件随对话持续追加） */
function collectByMtime(): ClaudeFile[] {
  const root = path.join(homeDir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  return collectFiles(root, (n) => n.endsWith(".jsonl"), 800)
    .map((f) => {
      try {
        const st = statSync(f);
        return { f, m: st.mtimeMs, s: st.size };
      } catch {
        return { f, m: 0, s: 0 };
      }
    })
    .sort((a, b) => b.m - a.m);
}

/** 直接定位 <root>/<munged>/<sessionId>.jsonl（read 的快路径：免全库扫描） */
function findSessionFile(root: string, sessionId: string): string | null {
  // sessionId 来自 RPC 参数，可含 `..\` 之类穿越片段：含路径分隔符或 `..`
  // 直接拒绝（claude 的原生 id 是 uuid，合法 id 不会被误伤），绝不拼进路径
  if (sessionId === "" || sessionId.includes("..") || /[/\\]/.test(sessionId)) return null;
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
      // 签名缓存：清单不变直接回上一次的结果（详见 listCache 注释）——安静 bot
      // 的全量解析每进程最多付一次；即使上一次 list 被 withBudget 超时丢弃，
      // 底层扫描仍在后台跑完并落缓存，下一次 list 直接命中
      const files = collectByMtime();
      const signature = signatureOf(files);
      const key = `${rootPath ?? "*"}|${limit}`;
      const cached = listCache.get(key);
      if (cached !== undefined && cached.signature === signature) return cached.summaries;
      // 早停扫描：凑满 limit 个匹配该目录的会话即停（详见 scanAll 注释）——
      // 活跃 bot 毫秒级，安静 bot 的老会话也不会被全局截断丢掉
      const all = await scanAll(files, limit, rootPath);
      const summaries = all
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
      if (listCache.size >= LIST_CACHE_MAX) {
        const oldest = listCache.keys().next().value;
        if (oldest !== undefined) listCache.delete(oldest);
      }
      listCache.set(key, { signature, summaries });
      return summaries;
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
