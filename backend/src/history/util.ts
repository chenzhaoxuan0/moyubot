/**
 * reader 共用工具 —— 宽容 JSONL 读取、多 CLI 内容形状归一、zstd 解码。
 *
 * 各家的 message.content 形状（实测采样 2026-10）：
 * - pi:     string | Array<{type:"text",text}|{type:"thinking",thinking}|{type:"toolCall",toolCallId,toolName,args}|{type:"toolResult",toolCallId,toolName,content}>
 * - claude: string | Array<{type:"text",text}|{type:"thinking",thinking}|{type:"tool_use",id,name,input}|{type:"tool_result",tool_use_id,content}>
 * - codex:  payload.content = Array<{type:"input_text"|"output_text"|"text",text}>；工具走 function_call/function_call_output 顶层 item
 * - mcode:  Array<{type:"text",text}>
 * 全部走 textOf() / partsOf() 的字段名习惯匹配，不做严格 schema。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { inflateSync, zstdDecompressSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import type { NativeTranscriptEntry } from "./types.ts";

/** 宽容 JSONL 读取：坏行跳过；.zstd 帧自动解压（Node 24 的 zlib 内置 zstd）。 */
export function readJsonLines(file: string): unknown[] {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return [];
  }
  if (file.endsWith(".zstd")) {
    try {
      buf = zstdDecompressSync(buf);
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (s === "") continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** ISO / epoch(ms) / epoch(s) → epoch ms；解析失败返回 undefined */
export function toMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    // 秒级 epoch（< 10^12）转毫秒
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** 内容块数组里的文本拼接（text / input_text / output_text / summary_text 习惯字段） */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (!isRecord(part)) continue;
    const t = str(part["text"]) ?? str(part["thinking"]) ?? str(part["summary"]) ?? str(part["content"]);
    if (t !== undefined) out += t;
  }
  return out;
}

/**
 * 通用内容形状 → 转录条目。覆盖 pi/claude/mcode/kimi 的数组块形态：
 * text / thinking / tool_use|toolCall / tool_result|toolResult。
 */
export function entriesFromContent(role: "user" | "assistant", content: unknown, at?: number): NativeTranscriptEntry[] {
  if (typeof content === "string") {
    return content.trim() === "" ? [] : [{ kind: role, text: content, at }];
  }
  if (!Array.isArray(content)) return [];
  const out: NativeTranscriptEntry[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = str(part["type"]);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const t = str(part["text"]) ?? "";
      if (t.trim() !== "") out.push({ kind: role, text: t, at });
    } else if (type === "thinking") {
      const t = str(part["thinking"]) ?? str(part["text"]) ?? "";
      if (t.trim() !== "") out.push({ kind: "thinking", text: t, at });
    } else if (type === "toolCall" || type === "tool_use") {
      const name = str(part["toolName"]) ?? str(part["name"]) ?? "tool";
      const args = part["arguments"] ?? part["args"] ?? part["input"];
      const text = typeof args === "string" ? args : JSON.stringify(args) ?? "";
      out.push({ kind: "tool", text, toolName: name, at });
    } else if (type === "toolResult" || type === "tool_result") {
      const name = str(part["toolName"]) ?? "tool";
      out.push({ kind: "tool", text: textOf(part["content"]).slice(0, 2000), toolName: `${name} ·结果`, at });
    }
  }
  return out;
}

/** 从任意记录里按字段名习惯找 role / content（kimi/dsh 等形状未文档化的格式用） */
export function looseRoleContent(rec: Record<string, unknown>): { role: string; content: unknown } | null {
  const m = rec["message"];
  const role = str(rec["role"]) ?? (isRecord(m) ? str(m["role"]) : undefined) ?? str(rec["speaker"]);
  const content = rec["content"] ?? (isRecord(m) ? m["content"] : undefined) ?? rec["text"];
  if (role === undefined && content === undefined) return null;
  return { role: role ?? "assistant", content };
}

/** 递归收集目录下匹配谓词的文件（浅层优先，防深目录爆炸）。上限 max 个。 */
export function collectFiles(root: string, match: (name: string) => boolean, max: number): string[] {
  const out: string[] = [];
  let stack: string[] = [];
  try {
    stack = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
      .reverse();
    // 顶层文件先行
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && match(e.name)) out.push(path.join(root, e.name));
    }
  } catch {
    return [];
  }
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  }
  return out;
}

export function fileMtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** claude 的 munged 目录名（C--Users-x）与 grok/pi 的 URL 编码目录名 → 原路径 */
export function decodeEncodedCwd(dirName: string): string | null {
  // URL 编码形态：C%3A%5CUsers%5Cchenziyu → C:\Users\chenziyu
  try {
    const decoded = decodeURIComponent(dirName);
    if (decoded !== dirName && /^[A-Za-z]:[\\/]/.test(decoded)) return decoded;
  } catch {
    /* % 裸串 */
  }
  // munged 形态：C--Users-chenziyu-project → C:\Users\chenziyu\project（分隔符丢失，仅小写化比较用）
  if (/^[A-Za-z]--/.test(dirName)) {
    return dirName.replace(/-/g, "\\").replace(/^([A-Za-z])\\/, "$1:\\");
  }
  return null;
}

/** 路径宽松相等（大小写 / 分隔符 / 尾斜杠不敏感）—— rootPath 过滤用 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function homeDir(): string {
  return os.homedir();
}

/** 压缩的 zlib（gzip/deflate）兜底解压（dsh 旧版本/其它压缩格式尝试） */
export function maybeInflate(buf: Buffer): Buffer {
  try {
    return inflateSync(buf);
  } catch {
    return buf;
  }
}
