/**
 * kimi reader —— ~/.kimi-code/sessions/<wd-hash>/session_<uuid>/agents/<agent>/wire.jsonl
 * wire 记录类型未对外文档化（本机样本只见 metadata/config.update/tools.set_active_tools，
 * 对话记录的字段按 role/content 习惯防御性提取）。标题/时间从 metadata 与目录名取。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { NativeSessionDetail, NativeSessionSummary, SessionReader } from "../types.ts";
import {
  collectFiles,
  entriesFromContent,
  fileMtimeMs,
  homeDir,
  isRecord,
  looseRoleContent,
  num,
  readJsonLines,
  samePath,
  str,
  toMs,
} from "../util.ts";

interface KimiScan {
  summary: NativeSessionSummary;
  wireFile: string;
}

function scanAll(limit: number): KimiScan[] {
  const root = path.join(homeDir(), ".kimi-code", "sessions");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (n) => n === "wire.jsonl", 300);
  const out: KimiScan[] = [];
  for (const file of files.slice(0, limit)) {
    const lines = readJsonLines(file);
    if (lines.length === 0) continue;
    // 会话 id 从目录名 session_<uuid>
    const sessionDir = path.basename(path.dirname(path.dirname(file))); // agents/<agent>/wire.jsonl → session_xxx
    const sessionId = sessionDir.startsWith("session_") ? sessionDir.slice("session_".length) : sessionDir;
    let startedAt = 0;
    let updatedAt = 0;
    let title = "";
    let count = 0;
    for (const l of lines) {
      if (!isRecord(l)) continue;
      if (startedAt === 0) startedAt = num(l["created_at"]) ?? toMs(l["created_at"]) ?? 0;
      const rc = looseRoleContent(l);
      if (rc !== null && (rc.role === "user" || rc.role === "assistant")) {
        const text = typeof rc.content === "string" ? rc.content : "";
        if (title === "" && rc.role === "user" && text.trim() !== "" && !text.trim().startsWith("<")) {
          title = text.trim().slice(0, 80);
        }
        count++;
      }
    }
    const mtime = fileMtimeMs(file);
    out.push({
      summary: {
        executorId: "kimi",
        sessionId,
        rootPath: null, // wire.jsonl 里无 cwd；wd-hash 目录不可逆
        title: title === "" ? "kimi 会话" : title,
        startedAt: startedAt || mtime,
        updatedAt: updatedAt || mtime,
        messageCount: count,
        source: file,
      },
      wireFile: file,
    });
  }
  return out;
}

export function createKimiReader(): SessionReader {
  return {
    executorId: "kimi",
    async list(rootPath, limit) {
      const all = scanAll(300);
      // kimi 的 cwd 不可恢复：带 rootPath 过滤时不显示（全量模式才进列表）
      const filtered = rootPath === null ? all : [];
      return filtered
        .map((s) => s.summary)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async read(sessionId): Promise<NativeSessionDetail | null> {
      const hit = scanAll(300).find((s) => s.summary.sessionId === sessionId);
      if (hit === undefined) return null;
      const transcript = [];
      for (const l of readJsonLines(hit.wireFile)) {
        if (!isRecord(l)) continue;
        const type = str(l["type"]);
        if (type === "config.update" || type === "tools.set_active_tools" || type === "metadata") continue;
      const rc = looseRoleContent(l);
      if (rc !== null && (rc.role === "user" || rc.role === "assistant")) {
        for (const e of entriesFromContent(rc.role, rc.content)) {
          if (e.kind === "user" && e.text.trim().startsWith("<")) continue;
          transcript.push(e);
        }
      }
      // wire 的工具调用不走 content 块：assistant 在 message.toolCalls 携带
      //（含 AskUserQuestion 问卷），结果以 role:"tool" 记录回投（源码：
      // kimi-code packages/agent-core-v2/src/wire/human.ts）——单独捞，防御式
      const msg = isRecord(l["message"]) ? l["message"] : undefined;
      if (msg !== undefined && Array.isArray(msg["toolCalls"])) {
        for (const tc of msg["toolCalls"]) {
          if (!isRecord(tc)) continue;
          const fn = isRecord(tc["function"]) ? tc["function"] : tc;
          const name = str(fn["name"]) ?? "tool";
          const args = fn["arguments"];
          const argText = typeof args === "string" ? args : JSON.stringify(args ?? "");
          if (argText !== "" && argText !== "{}") {
            transcript.push({ kind: "tool" as const, toolName: name, text: argText.slice(0, 4000) });
          }
        }
      }
      if (rc !== null && rc.role === "tool" && msg !== undefined) {
        const name = str(msg["toolName"]) ?? "tool";
        const resultText =
          typeof rc.content === "string" ? rc.content : rc.content === undefined ? "" : JSON.stringify(rc.content);
        if (resultText.trim() !== "") {
          transcript.push({ kind: "tool" as const, toolName: `${name} ·结果`, text: resultText.slice(0, 2000) });
        }
      }
    }
    return { ...hit.summary, transcript };
    },
  };
}
