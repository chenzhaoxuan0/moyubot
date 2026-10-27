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

/**
 * 剥掉 user 消息开头连续的 <system-reminder>…</system-reminder> 包裹块
 * （内嵌的其它 reminder 标签随整块一起剥掉；剥完为空 = 纯系统注入，整条丢弃）。
 */
function stripLeadingReminders(text: string): string {
  let t = text;
  for (;;) {
    const m = /^\s*<system-reminder>/.exec(t);
    if (m === null) break;
    const close = t.indexOf("</system-reminder>");
    if (close === -1) break; // 未闭合：不剥，原样保留
    t = t.slice(close + "</system-reminder>".length);
  }
  return t.trimStart();
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
        if (e.kind === "user") {
          // mcode 把系统提醒（tool_search 指引 / agent-context / master-reminder 等）
          // 与真实任务 prompt 拼在**同一条** user 消息里（子 agent 会话的首条即如此，
          // 实测 7KB 消息里前 4.4KB 是 reminder 包裹块）。剥掉前导的
          // <system-reminder>…</system-reminder> 块，余下正文才是真正的 prompt——
          // 整条丢弃会让会话「没有首条用户消息」，桌面端显示的正是剥后这段
          const stripped = stripLeadingReminders(e.text);
          if (stripped.trim() === "") continue;
          if (stripped !== e.text) transcript.push({ ...e, text: stripped });
          else transcript.push(e);
        } else {
          transcript.push(e);
        }
      }
    } else if (role === "compactionSummary") {
      // 续链会话（--session resume）的开头上文：前一段对话压缩成的摘要。不投影
      // 的话这份文件「凭空从中间开始」，用户翻到头只看到莫名的中段步骤
      const summary = str(msg["summary"]) ?? "";
      if (summary !== "") {
        transcript.push({ kind: "compaction" as const, text: summary });
      }
    } else if (role === "toolResult" || role === "toolCall") {
      const name = str(msg["toolName"]) ?? str(msg["name"]) ?? "tool";
      const content = msg["arguments"] ?? msg["args"] ?? msg["input"] ?? msg["content"];
      const text = typeof content === "string" ? content : JSON.stringify(content) ?? "";
      transcript.push({
        kind: "tool" as const,
        toolName: name,
        text,
        // 相位标记（同步器用）：call = 发起（可能仍在等待结果），result = 该调用的
        // 结果。配对后一个工具只占一个条目位；末尾 call 无 result = 真待决（问卷）
        meta: { phase: role === "toolCall" ? "call" : "result" },
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
        if (r.historyRelativeDir) {
          dir = path.join(root, r.historyRelativeDir);
        }

        out.push({
          executorId: "mcode",
          sessionId: r.sessionId,
          rootPath: r.cwd,
          title: r.title !== "" ? r.title : "mcode 会话",
          startedAt: r.createdAt,
          updatedAt: r.updatedAt || r.createdAt,
          // 列表不臆造消息条数（旧实现按文件大小估算 size/300，展示给用户的是
          // 编造的数字）：sqlite 索引里没有条数列；真实条数在展开回看时由
          // read() 的 transcript.length 提供（与 openclaw/antigravity 列表同口径）。
          messageCount: 0,
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
        // 从当前月起往回走 3 个月，每个月浅扫最近 7 天（目录为 YYYY/MM/DD，
        // 月/日都是两位补零）。用 Date 的月份回退做跨年换算 —— 一月会话能正确
        // 回看上一年十二月，不再假设「月份都在当前年」（评审：跨年边界缺陷）。
        const now = new Date();
        for (let back = 0; back < 3 && !existsSync(messagesFile); back++) {
          const m = new Date(now.getFullYear(), now.getMonth() - back, 1);
          const monthDir = path.join(root, String(m.getFullYear()), String(m.getMonth() + 1).padStart(2, "0"));
          if (!existsSync(monthDir)) continue;
          const days = readdirSync(monthDir).sort().slice(-7);
          for (const d of days) {
            const dDir = path.join(monthDir, d);
            if (!existsSync(dDir)) continue;
            const matched = readdirSync(dDir).find((e) => e.includes(b64));
            if (matched) {
              dir = path.join(dDir, matched);
              messagesFile = path.join(dir, "messages.jsonl");
              break;
            }
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
