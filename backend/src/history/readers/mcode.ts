/**
 * mcode reader —— ~/.minimax/v2/sessions/YYYY/MM/DD/HH-mm-ss-ms-session_<b64>/
 * 目录：manifest.json（schemaVersion/sessionId/createdAtMs/updatedAtMs/source/layout/paths）+ messages.jsonl
 *   （{message_id,turn_id,message:{role,content:[{type:"text",text}]}}）
 *
 * 优化实现：
 * 优先直接从 ~/.minimax/v2/sqlite/runtime-state.sqlite 的 local_runtime_sessions
 * 查取 history_relative_dir（几毫秒内唯一定位，彻底杜绝在数千目录中递归文件扫描导致的 20s 主循环 stall 与超时）。
 */

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import { entriesFromContent, homeDir, isRecord, readJsonLines, str } from "../util.ts";

interface McodeSessionRow {
  sessionId: string;
  title: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  historyRelativeDir?: string | null;
}

function openSqlite(): DatabaseSync | null {
  const dbPath = path.join(homeDir(), ".minimax", "v2", "sqlite", "runtime-state.sqlite");
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    return null;
  }
}

function querySessionsFromDb(limit: number): McodeSessionRow[] {
  const db = openSqlite();
  if (db === null) return [];
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms, history_relative_dir
         FROM local_runtime_sessions
         ORDER BY updated_at_ms DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];

    const out: McodeSessionRow[] = [];
    for (const r of rows) {
      const id = str(r["session_id"]);
      if (id === undefined) continue;
      out.push({
        sessionId: id,
        title: (str(r["title"]) ?? "").trim(),
        cwd: str(r["workspace_dir"]) ?? null,
        createdAt: Number(r["created_at_ms"]) || 0,
        updatedAt: Number(r["updated_at_ms"]) || 0,
        historyRelativeDir: str(r["history_relative_dir"]) ?? null,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function querySessionById(sessionId: string): McodeSessionRow | null {
  const db = openSqlite();
  if (db === null) return null;
  try {
    const r = db
      .prepare(
        `SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms, history_relative_dir
         FROM local_runtime_sessions
         WHERE session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!r) return null;
    const id = str(r["session_id"]);
    if (!id) return null;

    return {
      sessionId: id,
      title: (str(r["title"]) ?? "").trim(),
      cwd: str(r["workspace_dir"]) ?? null,
      createdAt: Number(r["created_at_ms"]) || 0,
      updatedAt: Number(r["updated_at_ms"]) || 0,
      historyRelativeDir: str(r["history_relative_dir"]) ?? null,
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function parseTranscript(messagesFile: string) {
  const transcript = [];
  for (const l of readJsonLines(messagesFile)) {
    if (!isRecord(l)) continue;
    const msg = l["message"];
    if (!isRecord(msg)) continue;
    const role = str(msg["role"]);
    if (role === "user" || role === "assistant") {
      const entries = entriesFromContent(role, msg["content"]);
      for (const e of entries) {
        if (e.kind === "user" && e.text.trim().startsWith("<system")) continue;
        transcript.push(e);
      }
    } else if (role === "toolResult" || role === "toolCall") {
      const name = str(msg["toolName"]) ?? str(msg["name"]) ?? "tool";
      const content = msg["content"];
      const text = typeof content === "string" ? content : JSON.stringify(content) ?? "";
      transcript.push({
        kind: "tool" as const,
        toolName: name,
        text,
      });
    }
  }
  return transcript;
}

export function createMcodeReader(): SessionReader {
  const root = path.join(homeDir(), ".minimax", "v2", "sessions");

  return {
    executorId: "mcode",
    async list(rootPath, limit) {
      const rows = querySessionsFromDb(Math.max(limit, 50));
      const out: NativeSessionSummary[] = [];

      for (const r of rows) {
        if (rootPath !== null && r.cwd !== null && r.cwd.toLowerCase() !== rootPath.toLowerCase()) {
          continue;
        }

        let dir = "";
        let messagesFile = "";
        if (r.historyRelativeDir) {
          dir = path.join(root, r.historyRelativeDir);
          messagesFile = path.join(dir, "messages.jsonl");
        }

        let count = 0;
        if (messagesFile && existsSync(messagesFile)) {
          // 快速统计消息行数
          count = readJsonLines(messagesFile).length;
        }

        out.push({
          executorId: "mcode",
          sessionId: r.sessionId,
          rootPath: r.cwd,
          title: r.title !== "" ? r.title : "mcode 会话",
          startedAt: r.createdAt,
          updatedAt: r.updatedAt || r.createdAt,
          messageCount: count,
          source: dir || path.join(root, r.sessionId),
        });

        if (out.length >= limit) break;
      }

      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async read(sessionId): Promise<NativeSessionDetail | null> {
      // 1. 尝试从 SQLite 精确查出路径
      const row = querySessionById(sessionId);
      let dir = "";
      let messagesFile = "";

      if (row && row.historyRelativeDir) {
        dir = path.join(root, row.historyRelativeDir);
        messagesFile = path.join(dir, "messages.jsonl");
      }

      // 2. 兜底：如果没查到，按 base64 命名规则快速定位
      if (!existsSync(messagesFile)) {
        const b64 = Buffer.from(sessionId).toString("base64");
        // 查看当前年份或全局（限制深度为年/月/日）
        const year = new Date().getFullYear().toString();
        const yearDir = path.join(root, year);
        if (existsSync(yearDir)) {
          // 浅查当前年/月
          const months = existsSync(yearDir) ? readdirSync(yearDir).slice(-3) : [];
          for (const m of months) {
            const mDir = path.join(yearDir, m);
            if (!existsSync(mDir)) continue;
            const days = readdirSync(mDir).slice(-7);
            for (const d of days) {
              const dDir = path.join(mDir, d);
              if (!existsSync(dDir)) continue;
              const entries = readdirSync(dDir);
              const matched = entries.find((e) => e.includes(b64));
              if (matched) {
                dir = path.join(dDir, matched);
                messagesFile = path.join(dir, "messages.jsonl");
                break;
              }
            }
            if (existsSync(messagesFile)) break;
          }
        }
      }

      if (!existsSync(messagesFile)) return null;

      const transcript = parseTranscript(messagesFile);

      return {
        executorId: "mcode",
        sessionId,
        rootPath: row?.cwd ?? null,
        title: row?.title && row.title !== "" ? row.title : "mcode 会话",
        startedAt: row?.createdAt ?? 0,
        updatedAt: row?.updatedAt ?? 0,
        messageCount: transcript.length,
        source: dir,
        transcript,
      };
    },
  };
}
