/**
 * Claude Code 执行器适配器 —— **官方 Agent SDK 常驻形态**（docs/13 Phase 4 Tier 2）。
 *
 * 升级要点（原 `claude -p --output-format stream-json` 每轮一进程形态退役）：
 * - `query({ prompt: AsyncIterable<SDKUserMessage>, options })` 流式输入：一个会话
 *   一个常驻 CLI 子进程，多轮同进程续聊（上下文不重放），`interrupt()` 真取消
 * - `canUseTool` 回调 → permission.requested（统一权限闸）：headless 也有真审批面了
 *   （原 -p default 档写工具直接被拒）；resolvePermission → allow/deny 回执
 * - resume：options.resume 按原生 sessionId 接续（reattach 用）
 * - result 消息带 total_cost_usd 真实成本（网关计费），usage 原样上报
 * - 认证走本机 ~/.claude（SDK spawn 的 CLI 自己处理，daemon 透明）
 *
 * SDK 版本面（@anthropic-ai/claude-agent-sdk 0.3.x）：
 * - SDKPartialAssistantMessage（stream_event，includePartialMessages 开）→ 真 token delta
 * - SDKAssistantMessage（完整块：text/thinking/tool_use）→ message/tool 事件
 * - SDKUserMessageReplay（工具结果回放）→ tool.completed
 * - SDKResultMessage（turn 终态：result/is_error/total_cost_usd/usage/session_id）
 */

import { randomUUID } from "node:crypto";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type NativeModelConfig,
  type StartRequest,
} from "./types.ts";
import { readClaudeModelDefaults, writeClaudeModelDefaults } from "./model-defaults.ts";
import type {
  ModelId,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand } from "../exec.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { readStandardAgentsWorkspace, listMarkdownFilesPruned, cachedScan, commandCacheRootKey } from "./discovery.ts";
import { log } from "../../log.ts";

// ---- SDK 消息宽松视图（顶层判别用 SDK 类型，字段按宽容记录取） -------------------

interface SdkBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface SdkMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  replay?: boolean;
  parent_tool_use_id?: string | null;
  message?: { content?: SdkBlock[] | string };
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, number | undefined>;
  /** system/local_command_output 的输出正文 */
  content?: string;
  /** system/commands_changed 推送的最新命令清单 */
  commands?: readonly SdkSlashCommand[];
  /** system/informational 的渲染级别（info 只进 transcript，不上时间线） */
  level?: string;
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  readonly mode: StartRequest["mode"];
  /** claude 原生会话 id（system init / result 给出；reattach 与 cli_ref 用） */
  cliSessionId: string | null;
  sink: AdapterSink | null;
  /** 常驻 query（首个 send 时创建；进程与轮次共存亡） */
  q: Query | null;
  /** 流式输入队列：send() 推入，async iterator 消费 */
  queue: SDKUserMessage[];
  notify: (() => void) | null;
  /** canUseTool 挂起中的审批：requestId → resolve */
  approvals: Map<string, (allow: boolean) => void>;
  approvalSeq: number;
  loop: { reasoningLevel?: string; model?: string | null };
  usageCount: number;
  closed: boolean;
}

function modeToPermission(mode: StartRequest["mode"]): Options["permissionMode"] {
  if (mode === "yolo") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "plan") return "plan";
  return "default";
}

// ---- 原生斜杠命令（supportedCommands）----------------------------------------

/**
 * SDK 的 slash 命令清单里混着一类「UX 绑死在本地终端」的命令（SDK 文档原文：
 * terminal_slash_commands —— exit / statusline 这类）。Web 端执行它们没有意义
 * （/exit 甚至会杀掉常驻会话），菜单里直接隐藏。保守起见只藏确定终端绑定的这几个。
 */
const TERMINAL_BOUND_COMMANDS = new Set(["exit", "statusline", "terminal-setup", "vim", "ide"]);

/** SDK SlashCommand 的宽松视图（supportedCommands / commands_changed 共用） */
interface SdkSlashCommand {
  name?: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

function toNativeCommands(list: readonly SdkSlashCommand[]): readonly NativeCommandInfo[] {
  const out: NativeCommandInfo[] = [];
  for (const c of list) {
    if (typeof c.name !== "string" || c.name === "" || TERMINAL_BOUND_COMMANDS.has(c.name)) continue;
    out.push({
      name: c.name,
      description: c.description || undefined,
      argumentHint: c.argumentHint || undefined,
      aliases: Array.isArray(c.aliases) && c.aliases.length > 0 ? c.aliases.filter((a) => typeof a === "string") : undefined,
      builtin: c.builtin === true ? true : undefined,
      source: c.builtin === true ? "builtin" : undefined,
    });
  }
  return out;
}

// ---- 文件级发现（SDK 不可用时的兜底事实源）------------------------------------
//
// ~/.claude 与 <root>/.claude 下的三个目录是 Claude Code 的官方自定义面：
// - commands/**.md  → 斜杠命令（frontmatter: description / argument-hint）
// - skills/*/SKILL.md → 技能（frontmatter: name / description；"/name" 可触发）
// - agents/**.md    → 子智能体定义（frontmatter: name / description）
// 读文件不需要起 CLI —— SDK 的 spawn 在部分机器上会失败/悬死（实测本机：
// 自带 claude.exe spawn ENOENT），这份清单保证菜单在那种机器上依然有真数据。

/** 扁平 yaml frontmatter 的宽松解析：只取需要的键，坏格式当没有 */
function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return out;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return out;
  for (const line of raw.slice(raw.indexOf("\n") + 1, end).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

/** 枚举一层子目录里的 SKILL.md（skills/<name>/SKILL.md 约定，支持普通目录与符号链接） */
function readSkillDirs(dir: string): Array<{ name: string; description?: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; description?: string }> = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const skillPath = join(dir, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    out.push({ name: fm.name && fm.name !== "" ? fm.name : name, description: fm.description });
  }
  return out;
}

/** 枚举目录下（含一层子目录）的 .md 文件，返回 文件名(去后缀) → frontmatter */
function readMarkdownDefs(dir: string): Array<{ name: string; description?: string; argumentHint?: string }> {
  let files: string[];
  try {
    files = listMarkdownFilesPruned(dir).map((f) => join(dir, f));
  } catch {
    return [];
  }
  const out: Array<{ name: string; description?: string; argumentHint?: string }> = [];
  for (const file of files) {
    const name = file.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
    if (name === "") continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    out.push({ name, description: fm.description, argumentHint: fm["argument-hint"] ?? fm["argumentHint"] });
  }
  return out;
}

/**
 * 文件级三段发现（命令 / 技能 / 子智能体）。项目级覆盖用户级（同名取先见者）。
 * 只列自定义段 —— 内置命令清单没有独立事实源，不猜。
 */
function readClaudeFileLevel(rootPath: string): readonly NativeCommandInfo[] {
  // 每 root 记忆化：预热的「执行器 × root」笛卡尔积里，用户级目录（~/.claude/skills
  // 等数百条目）每次都是同一批文件 —— 见 discovery.ts 头注释的 loop-stall 教训
  return cachedScan(`claude-file-level|${commandCacheRootKey(rootPath)}`, () => scanClaudeFileLevel(rootPath));
}

function scanClaudeFileLevel(rootPath: string): readonly NativeCommandInfo[] {
  const bases: Array<{ base: string; source: "user" | "project" }> = [
    { base: join(homedir(), ".claude"), source: "user" },
    { base: join(rootPath, ".claude"), source: "project" },
  ];
  const commands: NativeCommandInfo[] = [];
  const skills: NativeCommandInfo[] = [];
  const agents: NativeCommandInfo[] = [];
  const seen = new Set<string>();
  for (const { base, source } of bases) {
    for (const d of readMarkdownDefs(join(base, "commands"))) {
      const key = `command:${d.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push({
        name: d.name, description: d.description, argumentHint: d.argumentHint,
        source, kind: "command",
      });
    }
    for (const s of readSkillDirs(join(base, "skills"))) {
      const key = `skill:${s.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ name: s.name, description: s.description, source, kind: "skill" });
    }
    for (const a of readMarkdownDefs(join(base, "agents"))) {
      const key = `agent:${a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      agents.push({ name: a.name, description: a.description, source, kind: "agent" });
    }
  }
  const standard = readStandardAgentsWorkspace(rootPath);
  for (const s of standard.skills) {
    const key = `skill:${s.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      skills.push(s);
    }
  }
  for (const a of standard.agents) {
    const key = `agent:${a.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      agents.push(a);
    }
  }
  return [...commands, ...skills, ...agents];
}

/** 别名 → 环境变量后缀。Claude Code 的四个档位别名，各网关可用环境变量改写其背后模型。 */
const CLAUDE_MODEL_ALIASES: readonly (readonly [string, string])[] = [
  ["fable", "FABLE"],
  ["opus", "OPUS"],
  ["sonnet", "SONNET"],
  ["haiku", "HAIKU"],
];

/**
 * 网关用模型名后缀标长上下文（`…[1M]`），这是本机网关与 zcode 内置目录共同的约定。
 * 只认这个明确写法，不按模型名猜窗口 —— 猜出来的数字比「未知」更坏。
 */
function contextWindowFromSuffix(model: string): number | undefined {
  const m = /\[(\d+(?:\.\d+)?)\s*([MKmk])\]$/.exec(model.trim());
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  return unit === "m" ? Math.round(n * 1_000_000) : Math.round(n * 1000);
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly glyph = "C";
  // Claude Code 兼读 cwd 下的 AGENTS.md（agents.md 标准，官方文档声明；版本不符以实测为准）
  readonly nativeContextFiles = ["AGENTS.md"];
  private _models: ExecutorModelInfo[] = [
    {
      id: "sonnet" as ModelId,
      displayName: "Sonnet（网关别名）",
      contextWindow: 200000,
      reasoningLevels: ["low", "medium", "high", "max"],
      multimodal: true,
    },
    { id: "opus" as ModelId, displayName: "Opus（网关别名）", contextWindow: 200000, multimodal: true },
    { id: "haiku" as ModelId, displayName: "Haiku（网关别名）", contextWindow: 200000, multimodal: false },
  ];

  get models(): readonly ExecutorModelInfo[] {
    return this._models;
  }

  /**
   * 动态对齐模型清单 —— 读 `~/.claude/settings.json` 的别名映射，**零用量**（纯读本地文件）。
   *
   * ## 为什么读配置而不是问 CLI
   *
   * Claude Code 没有 `--list-models` 也没有 models 子命令（实测 0.6.x：`unknown option`）。
   * 它「订阅里有哪些模型」这件事在配置里是**显式**的：
   * `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` 各写一个别名背后的真实模型。
   * 走第三方网关（本机就是 `ANTHROPIC_BASE_URL` 指向网关）时，官方那套 opus/sonnet
   * 名字背后早就换成别家模型了 —— 只有读这份映射才知道真正会跑什么。
   *
   * ## id 用真实模型名而不是别名
   *
   * 四个别名背后常常是同一个模型（实测本机 opus/sonnet/fable 全指向同一款）。
   * 按别名列会得到四行一模一样的条目，白占下拉框。这里按**解析后的真实模型去重**，
   * id 用真实模型名（`--model` 同时接受别名和全名，两者都合法），别名收进 displayName。
   */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      if (!existsSync(settingsPath)) {
        return { models: this._models, source: "static", reason: "未找到 ~/.claude/settings.json", elapsedMs: Date.now() - t0 };
      }
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        readonly env?: Readonly<Record<string, string>>;
      };
      const env = parsed.env ?? {};

      // 别名 → 背后真实模型；再按真实模型归并别名
      const byModel = new Map<string, { aliases: string[]; isDefault: boolean }>();
      for (const [alias, suffix] of CLAUDE_MODEL_ALIASES) {
        const target = env[`ANTHROPIC_DEFAULT_${suffix}_MODEL`];
        if (typeof target !== "string" || target === "") continue;
        const hit = byModel.get(target) ?? { aliases: [], isDefault: false };
        hit.aliases.push(alias);
        byModel.set(target, hit);
      }
      const fallback = env["ANTHROPIC_MODEL"];
      if (typeof fallback === "string" && fallback !== "") {
        const hit = byModel.get(fallback) ?? { aliases: [], isDefault: true };
        hit.isDefault = true;
        byModel.set(fallback, hit);
      }
      if (byModel.size === 0) {
        return {
          models: this._models,
          source: "static",
          reason: "settings.json 未配置任何 ANTHROPIC_*_MODEL 映射",
          elapsedMs: Date.now() - t0,
        };
      }

      // 上一份清单按别名继承能力字段（多模态等）：配置里查不到
      const priorByAlias = new Map<string, ExecutorModelInfo>();
      for (const m of this._models) priorByAlias.set(m.id, m);

      const out: ExecutorModelInfo[] = [];
      for (const [model, meta] of byModel) {
        const prior = meta.aliases.map((a) => priorByAlias.get(a)).find((p): p is ExecutorModelInfo => p !== undefined);
        const suffixHint = meta.aliases
          .map((a) => env[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL_NAME`])
          .find((n): n is string => typeof n === "string" && n !== "");
        const label = [model, meta.aliases.length > 0 ? `别名 ${meta.aliases.join("/")}` : "", meta.isDefault ? "默认" : "", suffixHint ?? ""]
          .filter((s) => s !== "")
          .join(" · ");
        out.push({
          id: model as ModelId,
          displayName: label,
          contextWindow: contextWindowFromSuffix(model) ?? prior?.contextWindow,
          reasoningLevels: prior?.reasoningLevels,
          defaultReasoningLevel: prior?.defaultReasoningLevel,
          multimodal: prior?.multimodal,
        });
      }
      // 默认模型排最前（它是不带 --model 时的实际取值）
      out.sort((a, b) => Number(b.displayName.includes("默认")) - Number(a.displayName.includes("默认")));

      this._models = out;
      log.info("claude models synced from ~/.claude/settings.json", { count: out.length });
      return { models: out, source: "live", elapsedMs: Date.now() - t0 };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.debug("claude 模型同步失败，用静态清单", { error: reason });
      return { models: this._models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
  }

  /**
   * 原生模型默认值 —— settings.json 的 env 键。读源就是 syncModels 那份文件：
   * 写完由 host 立刻调一次 syncModels，模型清单马上反映新默认（闭环可验）。
   */
  readModelDefaults(): NativeModelConfig {
    return readClaudeModelDefaults();
  }

  writeModelDefaults(values: Readonly<Record<string, string>>): NativeModelConfig {
    return writeClaudeModelDefaults(values);
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    // canUseTool 回调：headless 也有真反向审批流（Tier 2 升级的核心收益）
    permissions: true,
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime", // SDKPartialAssistantMessage 真 token 流
    steering: "mid-turn", // 流式输入模式：turn 进行中可继续入队
  };

  private readonly sessions = new Map<string, SessionState>();

  /** 原生命令缓存：rootPath → { 命令清单, 拉取时间 }。TTL 内菜单直接命中。 */
  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  /** listCommands 在途去重（菜单抖动/多视图并发打开时只拉一次） */
  private readonly commandFetches = new Map<string, Promise<readonly NativeCommandInfo[]>>();
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * 原生斜杠命令清单。**绝不为列清单另起 SDK query** —— throwaway spawn 在
   * 部分机器上会同步堵死 daemon 主线程（实测：菜单一次拉取让全部 RPC 超时
   * 数分钟，Promise.race 超时在主线程被堵时根本没机会触发，熔断器也只防
   * 后续不防首次）。两条零风险路径：
   * ① 活会话问询：常驻 query 已完成握手，supportedCommands() 是既有通道上的
   *    control 请求（内置 + 自定义 + 插件全量），不产生任何进程；
   * ② 文件级发现（readClaudeFileLevel）：~/.claude 与 <root>/.claude 的
   *    命令/技能/子智能体三段，毫秒级、零进程。内置段只在 ① 可用时出现。
   * 活会话里 CLI 还会推 commands_changed 热刷新缓存（见 onMessage）。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < ClaudeAdapter.COMMAND_TTL_MS) return hit.commands;

    const inflight = this.commandFetches.get(rootPath);
    if (inflight !== undefined) return inflight;

    const fetch = this.fetchCommandsUncached(rootPath)
      .then((commands) => {
        this.commandCache.set(rootPath, { commands, at: Date.now() });
        return commands;
      })
      .finally(() => {
        this.commandFetches.delete(rootPath);
      });
    this.commandFetches.set(rootPath, fetch);
    return fetch;
  }

  private async fetchCommandsUncached(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const fileLevel = readClaudeFileLevel(rootPath);

    // ① 活会话问询：内置段只有这里有（SDK 官方全量清单）。5s 竞速 —— 活会话
    //    的 control 通道正常是毫秒级；失约就只用文件级，不等它。
    const live = [...this.sessions.values()].find((s) => !s.closed && s.q !== null);
    if (live !== undefined && live.q !== null) {
      try {
        const list = await Promise.race([
          live.q.supportedCommands(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref?.()),
        ]);
        if (Array.isArray(list)) {
          const sdkCommands = toNativeCommands(list as readonly SdkSlashCommand[]);
          // SDK 清单只有命令段；技能/子智能体由文件级补齐（重名时 SDK 段优先）
          const sdkNames = new Set(sdkCommands.map((c) => c.name));
          return [...sdkCommands, ...fileLevel.filter((c) => c.kind !== "command" && !sdkNames.has(c.name))];
        }
        log.debug("claude 活会话 supportedCommands 超时，回落文件级", { rootPath });
      } catch (err: unknown) {
        log.debug("claude 活会话 supportedCommands 失败，回落文件级", { rootPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // ② 无活会话：内置目录（官方文档稳定集，见 builtin-catalogs.ts）+ 文件级三段。
    //    自定义与内置同名时自定义优先（与 SDK 清单的优先级一致）。
    const fileNames = new Set(fileLevel.map((c) => c.name));
    return [...builtinCommandsFor(this.id).filter((b) => !fileNames.has(b.name)), ...fileLevel];
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("claude");
      const out = await execLines(cmd, ["--version"], 15000);
      return {
        state: { status: "ready", version: out.trim() || "unknown" },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 claude CLI（npm i -g @anthropic-ai/claude-code）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: SessionState = {
      sessionId: `sess_${randomUUID()}` as SessionId,
      rootPath: req.rootPath,
      mode: req.mode ?? "build",
      cliSessionId: null,
      sink,
      q: null,
      queue: [],
      notify: null,
      approvals: new Map(),
      approvalSeq: 0,
      loop: { reasoningLevel: req.reasoningLevel, model: req.model ?? null },
      usageCount: 0,
      closed: false,
    };
    this.sessions.set(state.sessionId, state);
    return this.sessionImpl(state);
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      cliSessionId: ref,
      sink,
      q: null,
      queue: [],
      notify: null,
      approvals: new Map(),
      approvalSeq: 0,
      loop: {},
      usageCount: 0,
      closed: false,
    };
    this.sessions.set(sessionId, state);
    return this.sessionImpl(state);
  }

  private sessionImpl(state: SessionState): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel !== undefined) state.loop.reasoningLevel = loop.reasoningLevel;
        state.queue.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        });
        state.notify?.();
        // 首条消息启动常驻 query（同进程多轮，此后 send 只入队）
        if (state.q === null && !state.closed) void this.runQuery(state);
      },
      cancel: async () => {
        try {
          await state.q?.interrupt();
        } catch (err: unknown) {
          log.debug("claude interrupt 被拒", { error: err instanceof Error ? err.message : String(err) });
          state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
        }
      },
      resolvePermission: async (requestId: string, decision: "allow" | "deny" | "always") => {
        const resolve = state.approvals.get(requestId);
        if (resolve !== undefined) {
          state.approvals.delete(requestId);
          resolve(decision !== "deny");
          state.sink?.({
            type: "permission.resolved",
            sessionId: state.sessionId,
            requestId,
            decision: decision === "always" ? "allow" : decision,
          });
        }
      },
      externalRef: () => state.cliSessionId,
    };
  }

  async disconnect(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.closed = true;
      s.notify?.(); // 唤醒输入迭代器让它自然结束
    }
    this.sessions.clear();
  }

  // ---- 常驻 query：输入迭代器 + 消息翻译 ---------------------------------------

  private async runQuery(state: SessionState): Promise<void> {
    const input: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<SDKUserMessage>> =>
            new Promise((resolve) => {
              const first = state.queue.shift();
              if (first !== undefined) return resolve({ value: first, done: false });
              if (state.closed) return resolve({ value: undefined, done: true });
              state.notify = () => {
                const msg = state.queue.shift();
                if (msg !== undefined) resolve({ value: msg, done: false });
                else if (state.closed) resolve({ value: undefined, done: true });
              };
            }),
        };
      },
    };

    const options: Options = {
      cwd: state.rootPath,
      permissionMode: modeToPermission(state.mode),
      includePartialMessages: true,
      canUseTool: (toolName, input_, { signal }) =>
        new Promise((resolve) => {
          const requestId = `claude:${++state.approvalSeq}`;
          const kind = /write|edit/i.test(toolName) ? "file_write" : /bash|exec/i.test(toolName) ? "shell" : "tool";
          state.approvals.set(requestId, (allow) => {
            resolve(
              allow
                ? { behavior: "allow", updatedInput: input_ as Record<string, unknown> }
                : { behavior: "deny", message: "用户在 workbench 权限闸拒绝了这次调用" },
            );
          });
          state.sink?.({
            type: "permission.requested",
            sessionId: state.sessionId,
            requestId,
            kind,
            detail: `${toolName} ${JSON.stringify(input_).slice(0, 260)}`,
            risk: kind === "file_write" ? "medium" : "high",
          });
          // SDK 中止（interrupt/断连）时清挂起审批
          signal.addEventListener("abort", () => {
            if (state.approvals.delete(requestId)) resolve({ behavior: "deny", message: "aborted" });
          });
        }),
      ...(state.loop.model ? { model: state.loop.model } : {}),
      ...(state.cliSessionId !== null ? { resume: state.cliSessionId } : {}),
    };

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const q = query({ prompt: input, options });
      state.q = q;
      for await (const raw of q) {
        if (state.closed) break;
        this.onMessage(state, raw as unknown as SdkMsg);
      }
    } catch (err: unknown) {
      if (!state.closed) {
        state.sink?.({
          type: "error",
          sessionId: state.sessionId,
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        });
        state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "failed" });
      }
    } finally {
      state.q = null;
      // 拒掉所有挂起审批（query 结束后 canUseTool 的 Promise 不该再悬着）
      for (const [, resolve] of state.approvals) resolve(false);
      state.approvals.clear();
    }
  }

  private onMessage(state: SessionState, m: SdkMsg): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    switch (m.type) {
      case "system": {
        if (typeof m.session_id === "string") state.cliSessionId = m.session_id;
        // 原生命令面的两类 system 子消息：
        // - local_command_output：/usage /memory /doctor 这类**本地命令**的输出
        //   （不经过模型循环，TUI 里直接打印）→ 翻成 assistant 消息进时间线。
        //   不翻的话 Web 端发 /usage 就像石沉大海 —— 这正是「TUI 与 Web 天差地别」的主因之一。
        // - commands_changed：CLI 主动推送最新命令清单（新装插件/技能动态发现）→ 热刷新缓存。
        if (m.subtype === "local_command_output" && typeof m.content === "string" && m.content !== "") {
          sink({
            type: "message.completed",
            sessionId,
            messageId: `local_${Date.now()}`,
            text: m.content,
          });
        } else if (m.subtype === "informational" && typeof m.content === "string" && m.content !== "" && m.level !== "info") {
          // 横幅（Hook 拦截理由 / slash 命令状态行）：notice 起步才值得占时间线
          sink({
            type: "message.completed",
            sessionId,
            messageId: `banner_${Date.now()}`,
            text: m.content,
          });
        } else if (m.subtype === "commands_changed" && Array.isArray(m.commands)) {
          this.commandCache.set(state.rootPath, {
            commands: toNativeCommands(m.commands as readonly SdkSlashCommand[]),
            at: Date.now(),
          });
        }
        break;
      }
      case "stream_event": {
        // includePartialMessages：text_delta / thinking_delta 真流式
        const delta = m.event?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          const messageId = `msg_${state.sessionId.slice(5, 13)}`;
          sink({ type: "message.delta", sessionId, messageId, role: "assistant", text: delta.text });
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
          sink({ type: "reasoning.delta", sessionId, messageId: `think_${Date.now()}`, text: delta.thinking });
        }
        break;
      }
      case "assistant": {
        if (typeof m.session_id === "string" && state.cliSessionId === null) state.cliSessionId = m.session_id;
        const blocks = Array.isArray(m.message?.content) ? (m.message?.content as SdkBlock[]) : [];
        let finalText = "";
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") {
            finalText += b.text;
          } else if (b.type === "tool_use") {
            sink({
              type: "tool.started",
              sessionId,
              callId: b.id ?? `call_${Date.now()}`,
              toolName: b.name ?? "tool",
              title: `${b.name ?? "tool"} ${JSON.stringify(b.input ?? {}).slice(0, 80)}`,
              input: (b.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        if (finalText !== "") {
          // delta 已流式发过（SDK 不给流与块的稳定 id 对齐），completed 用完整文本收口
          const messageId = `msg_${state.sessionId.slice(5, 13)}`;
          sink({ type: "message.completed", sessionId, messageId, text: finalText });
        }
        break;
      }
      case "user": {
        // 工具结果回放（replay）→ tool.completed
        if (m.replay !== true) break;
        const blocks = Array.isArray(m.message?.content) ? (m.message?.content as SdkBlock[]) : [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            const text =
              typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .map((x) => (typeof x === "object" && x !== null && "text" in x ? String((x as SdkBlock).text ?? "") : ""))
                      .join("")
                  : "";
            sink({
              type: "tool.completed",
              sessionId,
              callId: b.id ?? `call_${Date.now()}`,
              ok: b.is_error !== true,
              output: text.slice(0, 4000),
            });
          }
        }
        break;
      }
      case "result": {
        if (typeof m.session_id === "string") state.cliSessionId = m.session_id;
        const usage = m.usage ?? {};
        const billedInput = (usage["input_tokens"] ?? 0) + (usage["cache_creation_input_tokens"] ?? 0);
        if (billedInput > 0 || (usage["output_tokens"] ?? 0) > 0) {
          sink({
            type: "usage",
            sessionId,
            // 计费口径对齐契约（dsh）：billedInput = uncached + cacheWrite
            inputTokens: billedInput,
            outputTokens: usage["output_tokens"] ?? 0,
            cacheReadTokens: usage["cache_read_input_tokens"],
            cacheWriteTokens: usage["cache_creation_input_tokens"],
            // total_cost_usd 是网关真实计费，非估算
            costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0,
            model: String(state.loop.model ?? "claude"),
            requestId: `claude:${state.cliSessionId ?? sessionId}:p${process.pid}:${++state.usageCount}`,
          });
        }
        if (m.is_error === true) {
          sink({ type: "error", sessionId, message: m.result ?? "turn failed", recoverable: true });
          sink({ type: "session.status", sessionId, status: "failed" });
        } else {
          // agent loop 语义：turn 完成 ≠ 会话结束（常驻 query 继续可聊）
          sink({ type: "session.status", sessionId, status: "idle" });
        }
        break;
      }
      default:
        break; // status/notification 等辅助消息不进事件流
    }
  }
}
