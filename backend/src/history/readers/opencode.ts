/**
 * opencode reader —— ~/.local/share/opencode/opencode.db（SQLite，WAL）：
 * - session 表：id(ses_…) / directory(工作区) / title / time_created / time_updated（ms）
 * - message 表：session_id / time_created / data(JSON: role)
 * - part 表：message_id / time_created / data(JSON: type=text|reasoning|step-finish…, text)
 * 实测采样 2026-10（v0.x 单库形态；旧版的 storage/<id>/ 目录形态本机已无样本，
 * 不再兼容）。CLI 正在跑时 WAL 并发读安全（readOnly 打开，busy 即跳过）。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { homeDir, isRecord, num, samePath, str } from "../util.ts";

function dbPath(): string {
  return path.join(homeDir(), ".local", "share", "opencode", "opencode.db");
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
}

function listRows(limit: number): SessionRow[] {
  const p = dbPath();
  if (!existsSync(p)) return [];
  const db = new DatabaseSync(p, { open: true, readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated FROM session
         ORDER BY time_updated DESC LIMIT ?`,
      )
      .all(limit) as unknown[];
    return rows.filter(isRecord).map((r) => ({
      id: str(r["id"]) ?? "",
      directory: str(r["directory"]) ?? null,
      title: str(r["title"]) ?? null,
      time_created: num(r["time_created"]) ?? null,
      time_updated: num(r["time_updated"]) ?? null,
    }));
  } finally {
    db.close();
  }
}

export function createOpencodeReader(): SessionReader {
  return {
    executorId: "opencode",
    async list(rootPath, limit) {
      const rows = listRows(Math.max(limit, 200));
      const summaries = rows
        .filter((r) => r.id !== "")
        .map((r) => ({
          executorId: "opencode",
          sessionId: r.id,
          rootPath: r.directory,
          title: (r.title ?? "").trim(),
          startedAt: r.time_created ?? r.time_updated ?? 0,
          updatedAt: r.time_updated ?? r.time_created ?? 0,
          messageCount: 0,
          source: dbPath(),
        }))
        .filter((s) => rootPath === null || (s.rootPath !== null && samePath(s.rootPath, rootPath)));
      return summaries.slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const p = dbPath();
      if (!existsSync(p)) return null;
      const db = new DatabaseSync(p, { open: true, readOnly: true });
      try {
        const hit = db
          .prepare(`SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?`)
          .get(sessionId);
        if (!isRecord(hit)) return null;
        const startedAt = num(hit["time_created"]) ?? 0;
        const summary: NativeSessionSummary = {
          executorId: "opencode",
          sessionId: str(hit["id"]) ?? sessionId,
          rootPath: str(hit["directory"]) ?? null,
          title: (str(hit["title"]) ?? "").trim(),
          startedAt,
          updatedAt: num(hit["time_updated"]) ?? startedAt,
          messageCount: 0,
          source: p,
        };
        const messages = db
          .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`)
          .all(sessionId) as unknown[];
        const parts = db
          .prepare(`SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC`)
          .all(sessionId) as unknown[];
        const partsByMessage = new Map<string, { at: number | undefined; data: Record<string, unknown> }[]>();
        for (const row of parts) {
          if (!isRecord(row)) continue;
          const mid = str(row["message_id"]);
          if (mid === undefined) continue;
          let data: unknown;
          try {
            data = JSON.parse(str(row["data"]) ?? "");
          } catch {
            continue;
          }
          if (!isRecord(data)) continue;
          const bucket = partsByMessage.get(mid) ?? [];
          bucket.push({ at: num(row["time_created"]), data });
          partsByMessage.set(mid, bucket);
        }
        const transcript: NativeTranscriptEntry[] = [];
        for (const row of messages) {
          if (!isRecord(row)) continue;
          let data: unknown;
          try {
            data = JSON.parse(str(row["data"]) ?? "");
          } catch {
            continue;
          }
          if (!isRecord(data)) continue;
          const role = str(data["role"]) === "user" ? "user" : "assistant";
          const at = num(row["time_created"]);
          const mid = str(row["id"]) ?? "";
          for (const part of partsByMessage.get(mid) ?? []) {
            const type = str(part.data["type"]);
            const text = (str(part.data["text"]) ?? "").trim();
            // 工具 part（含 question 问卷工具）：input 是发起（含选项 schema），
            // state.content 是结果——问卷待决识别全靠这两段（源码：opencode
            // packages/core/src/tool/plugin/question.ts，state.status running/completed）
            if (type === "tool") {
              const name = str(part.data["name"]) ?? "tool";
              const state = isRecord(part.data["state"]) ? part.data["state"] : undefined;
              const inputRaw = state?.["input"];
              const inputText = typeof inputRaw === "string" ? inputRaw : inputRaw === undefined ? "" : JSON.stringify(inputRaw);
              if (inputText !== "" && inputText !== "{}") {
                transcript.push({ kind: "tool", toolName: name, text: inputText.slice(0, 4000), at: part.at });
              }
              const contentRaw = state?.["content"];
              const resultText = Array.isArray(contentRaw)
                ? contentRaw.map((c) => (isRecord(c) && typeof c["text"] === "string" ? c["text"] : "")).join("\n").trim()
                : typeof contentRaw === "string"
                  ? contentRaw.trim()
                  : "";
              if (resultText !== "") {
                transcript.push({ kind: "tool", toolName: `${name} ·结果`, text: resultText.slice(0, 2000), at: part.at });
              }
              continue;
            }
            if (text === "") continue;
            if (type === "reasoning") transcript.push({ kind: "thinking", text: text.slice(0, 4000), at: part.at });
            else if (type === "text") transcript.push({ kind: role, text: text.slice(0, 4000), at: part.at });
          }
        }
        return { ...summary, messageCount: transcript.length, transcript };
      } finally {
        db.close();
      }
    },
  };
}
