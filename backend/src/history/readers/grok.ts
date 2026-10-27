/**
 * grok reader —— ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
 * 目录内（本机实测版本）：summary.json（{info:{id,cwd},created_at,updated_at,…}）
 *   + chat_history.jsonl（{type:"system"|"user"|"assistant",content:string}）
 * 新版文档另记有 updates.jsonl（权威 ACP 日志）——两者都探，优先 chat_history。
 * events.jsonl 是持久事件日志（工具/权限），暂不进转录。
 */

import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, NativeTranscriptEntry, SessionReader } from "../types.ts";
import { decodeEncodedCwd, entriesFromContent, fileMtimeMs, homeDir, isRecord, readJsonLines, samePath, str, toMs } from "../util.ts";

interface GrokScan {
  summary: NativeSessionSummary;
  transcriptFile: string | null;
}

function parseSummary(dir: string, id: string): { title: string; cwd: string | null; startedAt: number; updatedAt: number } {
  let title = "";
  let cwd: string | null = null;
  let startedAt = 0;
  let updatedAt = 0;
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) as Record<string, unknown>;
    const info = isRecord(raw["info"]) ? raw["info"] : undefined;
    cwd = str(info?.["cwd"]) ?? null;
    startedAt = toMs(raw["created_at"]) ?? toMs(info?.["created_at"]) ?? 0;
    updatedAt = toMs(raw["updated_at"]) ?? toMs(raw["last_message_at"]) ?? startedAt;
    title = (str(raw["session_summary"]) ?? str(raw["title"]) ?? "").trim();
  } catch {
    /* 无 summary.json 或坏 JSON：mtime 兜底 */
  }
  return { title, cwd, startedAt: startedAt || fileMtimeMs(dir), updatedAt: updatedAt || fileMtimeMs(dir) };
}

function scanAll(limit: number): GrokScan[] {
  const root = path.join(homeDir(), ".grok", "sessions");
  if (!existsSync(root)) return [];
  const out: GrokScan[] = [];
  let cwdDirs: string[] = [];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
  outer: for (const cwdDir of cwdDirs) {
    let sessionDirs: string[] = [];
    try {
      sessionDirs = readdirSync(cwdDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(cwdDir, e.name));
    } catch {
      continue;
    }
    for (const dir of sessionDirs) {
      if (out.length >= limit) break outer;
      const id = path.basename(dir);
      const meta = parseSummary(dir, id);
      const transcriptFile = existsSync(path.join(dir, "chat_history.jsonl"))
        ? path.join(dir, "chat_history.jsonl")
        : existsSync(path.join(dir, "updates.jsonl"))
          ? path.join(dir, "updates.jsonl")
          : null;
      if (transcriptFile === null) continue;
      out.push({
        summary: {
          executorId: "grok",
          sessionId: id,
          rootPath: meta.cwd ?? decodeEncodedCwd(path.basename(cwdDir)),
          title: meta.title === "" ? "grok 会话" : meta.title.slice(0, 80),
          startedAt: meta.startedAt,
          updatedAt: meta.updatedAt,
          messageCount: readJsonLines(transcriptFile).length,
          source: dir,
        },
        transcriptFile,
      });
    }
  }
  return out;
}

export function createGrokReader(): SessionReader {
  return {
    executorId: "grok",
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
      if (hit === undefined || hit.transcriptFile === null) return null;
      const transcript: NativeTranscriptEntry[] = [];
      for (const l of readJsonLines(hit.transcriptFile)) {
        if (!isRecord(l)) continue;
        const type = str(l["type"]);
        if (type === "user" || type === "assistant") {
          // content 可能是 string 或块数组（实测两种都有）
          for (const e of entriesFromContent(type, l["content"])) {
            if (e.kind === "user" && e.text.trim().startsWith("<system")) continue; // 注入的 system-reminder
            transcript.push({ ...e, text: e.text.slice(0, 4000) });
          }
        } else if (type === "tool_use" || type === "tool_result") {
          transcript.push({ kind: "tool", toolName: str(l["name"]) ?? type, text: JSON.stringify(l["content"]).slice(0, 1200) });
        }
        // OpenAI 风格行级 tool_calls（assistant 行携带，含 ask_user_question 问卷；
        // 源码：grok-build xai-grok-sampling-types conversation.rs AssistantItem）
        if (Array.isArray(l["tool_calls"])) {
          for (const tc of l["tool_calls"]) {
            if (!isRecord(tc)) continue;
            const fn = isRecord(tc["function"]) ? tc["function"] : tc;
            const name = str(fn["name"]) ?? "tool";
            const args = fn["arguments"] ?? tc["arguments"];
            const argText = typeof args === "string" ? args : JSON.stringify(args ?? "");
            if (argText !== "" && argText !== "{}") {
              transcript.push({ kind: "tool", toolName: name, text: argText.slice(0, 1200) });
            }
          }
        }
        // system（系统提示）不进转录
      }
      return { ...hit.summary, transcript };
    },
  };
}
