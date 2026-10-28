import type { ToolExecutionData } from "../types.ts";

/**
 * 工具调用的「关键信息」提取（对齐 Codex：每行直接可见最重要参数，
 * 不需要点开就知道这条干了什么）。各执行器的 input 是原始对象，
 * 键名不统一（path/file_path/command/query/...），这里按语义优先级取值。
 */

/** 路径类键：展示时压成 basename（尾部两级），完整路径进 title */
const PATH_KEYS = new Set(["path", "file_path", "filePath", "file", "filename", "dir", "directory"]);

/** 取值优先级：越靠前越能代表「这条调用干了什么」 */
const KEY_PRIORITY = [
  "path",
  "file_path",
  "filePath",
  "file",
  "filename",
  "pattern",
  "glob",
  "regex",
  "command",
  "cmd",
  "command_line",
  "CommandLine",
  "script",
  "url",
  "uri",
  "query",
  "search",
  "name",
  "id",
  "prompt",
  "expr",
  "dir",
  "directory",
  "cwd",
] as const;

/** MCP 风格的嵌套包装键 */
const NESTED_KEYS = ["arguments", "args", "parameters", "options"] as const;

/** 路径压尾部两级（保住辨识度又不被绝对路径刷屏） */
export function shortenPath(v: string): string {
  const s = v.replace(/^[a-zA-Z]:[\\/]/, "");
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : s;
}

/** 提取一条工具调用的关键信息摘要；空串 = 没有可展示的参数 */
export function toolBriefOf(input: unknown, limit = 80): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return "";
    // 序列化 JSON 字符串（部分执行器把 input 整个 stringify）：**JSON.parse 成功
    // 且结果真是对象/数组**才走摘要分支。`[ -f x ] && …` 这类以 [ 开头的普通
    // 命令 parse 必失败 —— 回退原文本身，绝不能丢成空串（合并行会缺关键信息）；
    // 切一刀的 JSON 片段全是引号花括号，那才是该弃用的噪音
    if (looksSerialized(t)) {
      try {
        const parsed: unknown = JSON.parse(t);
        if (parsed !== null && typeof parsed === "object") {
          return toolBriefOf(parsed, limit);
        }
      } catch {
        // 非 JSON：走原文回退
      }
      return shortenPath(t).slice(0, limit);
    }
    return shortenPath(t).slice(0, limit);
  }
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of KEY_PRIORITY) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        const s = v.trim();
        return (PATH_KEYS.has(k) ? shortenPath(s) : s).slice(0, limit);
      }
      if (typeof v === "number") return String(v).slice(0, limit);
    }
    // 嵌套一层：MCP 风格的 arguments/parameters 包装
    for (const k of NESTED_KEYS) {
      const v = o[k];
      if (v !== null && typeof v === "object") {
        const nested = toolBriefOf(v, limit);
        if (nested) return nested;
      }
    }
    // 兜底：第一个非空短字符串（未知执行器的私有键）；跳过序列化 JSON——
    // 那是 content 数组之类，切一刀出来的片段全是引号花括号，纯噪音
    for (const v of Object.values(o)) {
      if (typeof v === "string" && v.trim() && v.length <= 200 && !looksSerialized(v)) {
        return shortenPath(v.trim()).slice(0, limit);
      }
    }
  }
  return "";
}

/** 序列化 JSON 的特征（content 数组 / 字符串化的对象） */
function looksSerialized(s: string): boolean {
  return /^\s*[\[{]/.test(s) || s.includes('":{"') || s.includes('":[{') || s.includes('\"');
}

/** 从 ToolExecutionData 提取；title 兜底——但 title 就是工具名时是噪音，弃用 */
export function toolBrief(data: ToolExecutionData, limit?: number): string {
  const extracted = toolBriefOf(data.input, limit);
  if (extracted) return extracted;
  const t = (data.title ?? "").trim();
  if (t && t !== String(data.toolName) && !looksSerialized(t)) return t.slice(0, 80);
  return "";
}
