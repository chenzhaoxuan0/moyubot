/**
 * Google Antigravity（agy）执行器适配器 —— `agy --output-format stream-json --print` + `--conversation` 多轮。
 *
 * 协议事实（agy 1.2.5 实测）：
 * - init：首个事件，带 conversation_id / tools 清单 / permission_mode
 * - step_update：
 *   - step_type: "agent_response" + text_delta（增量文字流）
 *   - step_type: "tool" + state: "ACTIVE"（工具启动，tool_info.name / parameters）
 *   - step_type: "tool" + state: "DONE"（工具完成，tool_info.output）
 *   - state: "DONE" + usage（input_tokens / output_tokens / thinking_tokens / total_tokens）
 * - result：turn 终态 {status, response, duration_seconds, usage, conversation_id}
 * - 多轮：--conversation <conversation_id> 维系上下文
 * - 权限模式：--mode (accept-edits | plan)，默认传入 --dangerously-skip-permissions 免除无头死锁
 * - 模型：--model <model>，推理档位：--effort (low | medium | high)
 * - 动态模型：`agy models` 探测可用模型清单
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type ModelSyncOutcome,
  type StartRequest,
} from "./types.ts";
import { builtinCommandsFor } from "./builtin-catalogs.ts";
import { discoverAgySkillsAndAgents, mergeCommandEntries } from "./discovery.ts";
import type { NativeCommandInfo } from "../../contract.ts";
import type {
  ModelId,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionId,
} from "../../contract.ts";
import { execLines, resolveCommand, spawnLines } from "../exec.ts";
import { log } from "../../log.ts";

/**
 * SDK sidecar 的 Python 解释器候选（按优先级）：
 * - unix：python3 优先（macOS / 多数发行版无裸 python），python 兜底；
 * - win32：python 优先，`py -3` 兜底（Windows 商店别名 stub 会让裸 python「存在但假」）。
 * 刻意不做 which/command -v 预筛：存在 ≠ 能跑，直接让 import 探测（probeSdk）说话，
 * 首个 import 成功的候选胜出并缓存 —— 模块装在哪个解释器里就用哪个。
 */
export interface PythonCommand {
  readonly file: string;
  readonly baseArgs: readonly string[];
}

function sdkPythonCandidates(): PythonCommand[] {
  return process.platform === "win32"
    ? [{ file: "python", baseArgs: [] }, { file: "py", baseArgs: ["-3"] }]
    : [{ file: "python3", baseArgs: [] }, { file: "python", baseArgs: [] }];
}

/** probe 成功后缓存的胜者。只缓存「import 真跑通」的正结果，失败不缓存（下次 probe 重试）。 */
let cachedSdkPython: PythonCommand | undefined;

export function cachedPythonCommand(): PythonCommand | undefined {
  return cachedSdkPython;
}

interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: "ACTIVE" | "DONE";
  step_type?: "user_input" | "system_message" | "agent_response" | "tool";
  text_delta?: string;
  thinking_delta?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: unknown;
    output?: unknown;
  };
}

interface AgyResult {
  conversation_id?: string;
  status?: "SUCCESS" | "ERROR";
  response?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyEvent {
  event?: "init" | "step_update" | "result";
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: AgyStepUpdate;
  result?: AgyResult;
}

interface SessionState {
  readonly sessionId: SessionId;
  readonly rootPath: string;
  mode: StartRequest["mode"];
  model: ModelId | null;
  reasoningLevel: string | undefined;
  /** CLI 原生会话 ID（--conversation 用），首轮 init 事件给出 */
  cliConversationId: string | null;
  sink: AdapterSink | null;
  cancelled: boolean;
  child: ChildProcess | null;
  usageCount: number;
  /** SDK sidecar（google-antigravity）传输：进程与轮内状态；null = 未启用/回落 CLI */
  sdkChild: ChildProcess | null;
  sdkFailed: boolean;
  sdkTurnText: string;
  sdkMessageId: string | null;
  sdkDone: boolean;
}

interface TurnAcc {
  readonly messageId: string;
  initSeen: boolean;
  sawAnyEvent: boolean;
  resultText: string | null;
  isError: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  durationMs?: number;
}

const STATIC_MODELS: readonly ExecutorModelInfo[] = [
  {
    id: "gemini-3.8-flash-high" as ModelId,
    displayName: "Gemini 3.8 Flash (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.8-flash-medium" as ModelId,
    displayName: "Gemini 3.8 Flash (Medium)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
  },
  {
    id: "gemini-3.8-flash-low" as ModelId,
    displayName: "Gemini 3.8 Flash (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "gemini-3.7-flash-high" as ModelId,
    displayName: "Gemini 3.7 Flash (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.7-flash-medium" as ModelId,
    displayName: "Gemini 3.7 Flash (Medium)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
  },
  {
    id: "gemini-3.7-flash-low" as ModelId,
    displayName: "Gemini 3.7 Flash (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "gemini-3.1-pro-high" as ModelId,
    displayName: "Gemini 3.1 Pro (High)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "high",
  },
  {
    id: "gemini-3.1-pro-low" as ModelId,
    displayName: "Gemini 3.1 Pro (Low)",
    contextWindow: 1_000_000,
    multimodal: true,
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
  },
  {
    id: "claude-sonnet-4-6" as ModelId,
    displayName: "Claude Sonnet 4.6 (Thinking)",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "claude-opus-4-6-thinking" as ModelId,
    displayName: "Claude Opus 4.6 (Thinking)",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "gpt-oss-120b-medium" as ModelId,
    displayName: "GPT-OSS 120B (Medium)",
    contextWindow: 128_000,
    multimodal: false,
  },
  {
    id: "antigravity-default" as ModelId,
    displayName: "Antigravity Default",
    contextWindow: 1_000_000,
    multimodal: true,
  },
];

export class AgyAdapter implements ExecutorAdapter {
  readonly id = "agy";
  readonly displayName = "Antigravity";
  readonly glyph = "A";

  private dynamicModels: readonly ExecutorModelInfo[] | null = null;
  private readonly sessions = new Map<SessionId, SessionState>();

  get models(): readonly ExecutorModelInfo[] {
    return this.dynamicModels ?? STATIC_MODELS;
  }

  readonly capabilities: RuntimeCapabilities = {
    resumeSession: true,
    fileDiff: false,
    terminal: false,
    permissions: false, // 走 --dangerously-skip-permissions，由 daemon 权限闸统一治理
    subagents: true,
    worktrees: false,
    sandbox: false,
    mcp: true,
    usage: true,
    multimodal: true,
    streaming: "realtime",
    steering: "turn-end",
  };

  /** 动态对齐/刷新模型清单：实时调用 `agy models` */
  async syncModels(): Promise<ModelSyncOutcome> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("agy");
      const stdout = await execLines(cmd, ["models"], 35000);
      if (!stdout || stdout.trim() === "") {
        return { models: this.models, source: "static", reason: "agy models 无输出", elapsedMs: Date.now() - t0 };
      }

      const list: ExecutorModelInfo[] = [];
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Fetching")) continue;
        const parts = trimmed.split(/\t+|\s{2,}/);
        if (parts.length < 2) continue;
        const slug = parts[0]?.trim();
        const name = parts[1]?.trim();
        if (!slug || !name) continue;

        const isGemini = slug.startsWith("gemini");
        const isClaude = slug.startsWith("claude");
        const isLow = slug.includes("low");
        const isMed = slug.includes("medium");
        const isHigh = slug.includes("high");

        list.push({
          id: slug as ModelId,
          displayName: name,
          contextWindow: isGemini ? 1_000_000 : isClaude ? 200_000 : 128_000,
          multimodal: !slug.includes("gpt-oss"),
          reasoningLevels: isGemini ? ["low", "medium", "high"] : isLow ? ["low"] : isMed ? ["medium"] : isHigh ? ["high"] : undefined,
          defaultReasoningLevel: isHigh ? "high" : isMed ? "medium" : isLow ? "low" : undefined,
        });
      }

      if (list.length > 0) {
        // 保留 antigravity-default 占位
        if (!list.some((m) => m.id === "antigravity-default")) {
          list.push({
            id: "antigravity-default" as ModelId,
            displayName: "Antigravity Default",
            contextWindow: 1_000_000,
            multimodal: true,
          });
        }
        this.dynamicModels = list;
        return { models: list, source: "live", elapsedMs: Date.now() - t0 };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("agy syncModels failed", { error: reason });
      return { models: this.models, source: "static", reason, elapsedMs: Date.now() - t0 };
    }
    return { models: this.models, source: "static", reason: "agy models 输出未匹配到条目", elapsedMs: Date.now() - t0 };
  }


  private readonly commandCache = new Map<string, { commands: readonly NativeCommandInfo[]; at: number }>();

  /** 技能停用/恢复后由 host 调用：清空命令清单内存缓存，防止旧世界被原样返回并重新落盘 */
  invalidateCommands(): void {
    this.commandCache.clear();
  }
  private static readonly COMMAND_TTL_MS = 10 * 60 * 1000;

  /**
   * Antigravity (AGY) 原生命令、技能与子智能体面：
   * 内置目录（官方文档/包内注册表为事实源，见 builtin-catalogs.ts）+
   * 原生技能（内置 IDE 技能、全局 ~/.gemini/config/skills、插件技能及标准 .agents/skills）+
   * 原生子智能体（plugins 子目录 agents、全局 agents 与 .agents/agents）。
   * 执行语义：透传 —— "/name args" 原样发给 AGY，由 AGY 引擎原生分发。
   */
  async listCommands(rootPath: string): Promise<readonly NativeCommandInfo[]> {
    const hit = this.commandCache.get(rootPath);
    if (hit !== undefined && Date.now() - hit.at < AgyAdapter.COMMAND_TTL_MS) return hit.commands;
    const discovered = discoverAgySkillsAndAgents(rootPath);
    const builtins = builtinCommandsFor(this.id);
    const merged = mergeCommandEntries(builtins, discovered.skills, discovered.agents);
    this.commandCache.set(rootPath, { commands: merged, at: Date.now() });
    return merged;
  }

  async probe(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const cmd = await resolveCommand("agy");
      const out = await execLines(cmd, ["--version"], 15000);
      // antigravity SDK 探针：python + google-antigravity 在场即启用 sidecar 传输
      const sdk = await this.probeSdk();
      this.sdkAvailable = sdk;
      return {
        state: {
          status: "ready",
          version: (out.trim() || "unknown") + (sdk ? " + antigravity-sdk" : "（pip install google-antigravity 可启用 SDK 传输）"),
        },
        capabilities: this.capabilities,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      return {
        state:
          code === "not_installed"
            ? { status: "not_installed", hint: "未安装 agy CLI（请确保 agy 在 PATH 中）" }
            : { status: "error", message: err instanceof Error ? err.message : String(err) },
        elapsedMs: Date.now() - t0,
      };
    }
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const sessionId = `ses_${randomUUID()}` as SessionId;
    const state: SessionState = {
      sessionId,
      rootPath: req.rootPath,
      mode: req.mode,
      model: req.model,
      reasoningLevel: req.reasoningLevel,
      cliConversationId: null,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
      sdkChild: null,
      sdkFailed: false,
      sdkTurnText: "",
      sdkMessageId: null,
      sdkDone: false,
    };
    this.sessions.set(sessionId, state);

    // 适配器契约：start() 不发轮（host 返回后会自动 send(prompt) 驱动首轮）
    return {
      id: sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel) state.reasoningLevel = loop.reasoningLevel;
        // antigravity SDK sidecar 优先（docs/13 Tier 3，探针门控）；失败回落 CLI
        if (this.sdkAvailable && !state.sdkFailed) {
          try {
            await this.sdkTurn(state, text);
            return;
          } catch (err: unknown) {
            state.sdkFailed = true;
            log.info("agy SDK sidecar 失败，回落 CLI --print", { sessionId: state.sessionId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on agy session (auto-approved via --dangerously-skip-permissions)");
      },
      externalRef: () => state.cliConversationId,
    };
  }

  reattach(sessionId: SessionId, ref: string, rootPath: string, sink: AdapterSink): AdapterSession {
    const state: SessionState = {
      sessionId,
      rootPath,
      mode: "build",
      model: null,
      reasoningLevel: undefined,
      cliConversationId: ref,
      sink,
      cancelled: false,
      child: null,
      usageCount: 0,
      sdkChild: null,
      sdkFailed: false,
      sdkTurnText: "",
      sdkMessageId: null,
      sdkDone: false,
    };
    this.sessions.set(sessionId, state);
    return {
      id: sessionId,
      send: async (text: string, loop?: { reasoningLevel?: string }) => {
        if (loop?.reasoningLevel) state.reasoningLevel = loop.reasoningLevel;
        // antigravity SDK sidecar 优先（docs/13 Tier 3，探针门控）；失败回落 CLI
        if (this.sdkAvailable && !state.sdkFailed) {
          try {
            await this.sdkTurn(state, text);
            return;
          } catch (err: unknown) {
            state.sdkFailed = true;
            log.info("agy SDK sidecar 失败，回落 CLI --print", { sessionId: state.sessionId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await this.spawnTurn(state, text);
      },
      cancel: async () => {
        state.cancelled = true;
        state.child?.kill();
      },
      resolvePermission: async () => {
        log.warn("resolvePermission called on agy session (auto-approved via --dangerously-skip-permissions)");
      },
      externalRef: () => state.cliConversationId,
    };
  }

  async disconnect(): Promise<void> {
    for (const st of this.sessions.values()) {
      st.child?.kill();
      st.sdkChild?.kill();
    }
    this.sessions.clear();
  }

  // ---- antigravity SDK sidecar 传输（探针门控）-----------------------------------

  /** python + google-antigravity 可用性（probe 时探一次，缓存） */
  private sdkAvailable = false;

  /** probe 阶段探测：候选解释器按序跑 `import google.antigravity`，首个成功的胜出并缓存 */
  private async probeSdk(): Promise<boolean> {
    for (const cand of sdkPythonCandidates()) {
      try {
        await execLines({ file: cand.file, prefixArgs: cand.baseArgs, via: 'exe' }, ['-c', 'import google.antigravity'], 10000);
        cachedSdkPython = cand;
        return true; // 报错（未装/解释器跑不起来）会 throw → 试下一个候选
      } catch {
        continue;
      }
    }
    return false;
  }

  markSdkAvailable(v: boolean): void {
    this.sdkAvailable = v;
  }

  private ensureSdkChild(state: SessionState): ChildProcess {
    if (state.sdkChild !== null && state.sdkChild.exitCode === null) return state.sdkChild;
    const py = cachedSdkPython;
    if (py === undefined) throw new Error('antigravity sidecar 解释器未就绪（probe 未通过就起了 SDK 传输？）');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = spawn(py.file, [...py.baseArgs, '-u', path.join(here, 'agy-antigravity-sidecar.py')], {
      cwd: state.rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.sdkChild = child;
    state.sdkDone = false;
    createInterface({ input: child.stdout }).on('line', (line) => this.onSdkLine(state, line));
    child.stderr?.on('data', (d: Buffer) => log.debug('agy sidecar stderr', { line: d.toString().trim().slice(0, 160) }));
    child.once('exit', (code) => {
      state.sdkChild = null;
      if (!state.sdkDone) {
        state.sink?.({ type: 'error', sessionId: state.sessionId, message: 'antigravity sidecar 退出（' + code + '）', recoverable: false });
        state.sink?.({ type: 'session.status', sessionId: state.sessionId, status: 'failed' });
      }
    });
    // config：save_dir 落在会话目录（resume 用 conversation_id）
    child.stdin?.write(JSON.stringify({ op: 'config', saveDir: path.join(state.rootPath, '.agent-workbench', 'antigravity') }) + "\n");
    return child;
  }

  private onSdkLine(state: SessionState, line: string): void {
    const s = line.trim();
    if (s === '') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(s) as Record<string, unknown>;
    } catch {
      return;
    }
    const sink = state.sink;
    if (sink === null) return;
    const evt = String(msg['evt'] ?? '');
    if (evt === 'delta') {
      const text = String(msg['text'] ?? '');
      if (text === '') return;
      if (msg['kind'] === 'thinking') {
        sink({ type: 'reasoning.delta', sessionId: state.sessionId, messageId: 'think_' + Date.now(), text });
      } else {
        const messageId = state.sdkMessageId ?? 'msg_' + Date.now();
        state.sdkMessageId = messageId;
        state.sdkTurnText += text;
        sink({ type: 'message.delta', sessionId: state.sessionId, messageId, role: 'assistant', text });
      }
    } else if (evt === 'tool') {
      sink({ type: 'tool.started', sessionId: state.sessionId, callId: 't_' + Date.now(), toolName: String(msg['toolName'] ?? 'tool'), title: String(msg['toolName'] ?? ''), input: ((msg['input'] ?? msg['arguments'] ?? msg['args']) as unknown) ?? {} });
    } else if (evt === 'started') {
      const cid = String(msg['conversationId'] ?? '');
      if (cid !== '') state.cliConversationId = cid;
    } else if (evt === 'completed') {
      state.sdkDone = true;
      const messageId = state.sdkMessageId ?? 'msg_' + Date.now();
      const text = String(msg['text'] ?? state.sdkTurnText);
      if (state.sdkTurnText === '' && text !== '') {
        sink({ type: 'message.delta', sessionId: state.sessionId, messageId, role: 'assistant', text });
      }
      sink({ type: 'message.completed', sessionId: state.sessionId, messageId, text });
      sink({ type: 'session.status', sessionId: state.sessionId, status: 'idle' });
    } else if (evt === 'error') {
      state.sdkDone = true;
      sink({ type: 'error', sessionId: state.sessionId, message: String(msg['message'] ?? 'antigravity error'), recoverable: false });
      sink({ type: 'session.status', sessionId: state.sessionId, status: 'failed' });
    }
  }

  private async sdkTurn(state: SessionState, text: string): Promise<void> {
    const child = this.ensureSdkChild(state);
    state.sdkTurnText = '';
    state.sdkMessageId = null;
    state.sdkDone = false;
    state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "running" });
    child.stdin?.write(JSON.stringify({ op: "prompt", text }) + "\n");
    // 等轮末（sidecar 的 completed/error 事件置 sdkDone；120s 预算）
    const deadline = Date.now() + 120_000;
    while (!state.sdkDone && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!state.sdkDone) throw new Error('antigravity sidecar 轮超时（120s 无 completed）');
  }

  // ---- turn 执行 ----

  private async spawnTurn(state: SessionState, prompt: string): Promise<void> {
    state.cancelled = false;
    const cmd = await resolveCommand("agy");
    const args = ["--output-format", "stream-json"];

    if (state.cliConversationId !== null) {
      args.push("--conversation", state.cliConversationId);
    }

    if (state.model && state.model !== "antigravity-default") {
      args.push("--model", state.model);
    }

    if (state.reasoningLevel) {
      const effort = state.reasoningLevel.toLowerCase();
      if (["low", "medium", "high"].includes(effort)) {
        args.push("--effort", effort);
      }
    }

    if (state.mode === "plan") {
      args.push("--mode", "plan");
    } else if (state.mode === "edit") {
      args.push("--mode", "accept-edits");
    } else {
      args.push("--dangerously-skip-permissions");
    }

    // --print 必须紧跟 prompt
    args.push("--print", prompt);

    const acc: TurnAcc = {
      messageId: `msg_${Date.now()}`,
      initSeen: false,
      sawAnyEvent: false,
      resultText: null,
      isError: false,
    };

    const child = spawnLines(cmd, args, {
      cwd: state.rootPath,
      onLine: (line) => this.handleLine(state, acc, line),
      onStderrLine: (line) => log.debug("agy stderr", { line: line.slice(0, 200) }),
    });
    state.child = child;

    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    state.child = null;

    if (state.cancelled) {
      state.sink?.({ type: "session.status", sessionId: state.sessionId, status: "idle" });
      return;
    }
    this.finalizeTurn(state, acc, exitCode);
  }

  // ---- JSONL → RuntimeEvent（逐行）----

  private handleLine(state: SessionState, acc: TurnAcc, line: string): void {
    const sink = state.sink;
    if (sink === null || line.trim() === "") return;
    let ev: AgyEvent;
    try {
      ev = JSON.parse(line) as AgyEvent;
    } catch {
      return;
    }
    acc.sawAnyEvent = true;
    const sessionId = state.sessionId;

    if (ev.event === "init") {
      acc.initSeen = true;
      if (ev.conversation_id) {
        state.cliConversationId = ev.conversation_id;
        sink({ type: "session.ref", sessionId, ref: ev.conversation_id });
      }
      return;
    }

    if (ev.event === "step_update" && ev.step_update) {
      const update = ev.step_update;
      if (update.conversation_id && !state.cliConversationId) {
        state.cliConversationId = update.conversation_id;
        sink({ type: "session.ref", sessionId, ref: update.conversation_id });
      }

      // agent 回复的文字流 / 思考流
      if (update.step_type === "agent_response") {
        if (update.text_delta) {
          sink({
            type: "message.delta",
            sessionId,
            messageId: acc.messageId,
            role: "assistant",
            text: update.text_delta,
          });
        }
        if (update.thinking_delta) {
          sink({
            type: "reasoning.delta",
            sessionId,
            messageId: acc.messageId,
            text: update.thinking_delta,
          });
        }
        if (update.state === "DONE" && update.usage) {
          acc.usage = update.usage;
        }
        return;
      }

      // 工具执行流
      if (update.step_type === "tool") {
        const callId = `call_${update.step_index ?? Date.now()}`;
        const toolName = update.tool_name ?? update.tool_info?.name ?? "tool";

        if (update.state === "ACTIVE") {
          sink({
            type: "tool.started",
            sessionId,
            callId,
            toolName,
            title: toolName,
            input: update.tool_info?.parameters ?? null,
          });
        } else if (update.state === "DONE") {
          const outRaw = update.tool_info?.output;
          const output = typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw ?? "");
          sink({
            type: "tool.completed",
            sessionId,
            callId,
            ok: true,
            output: output.slice(0, 8000),
          });
        }
        return;
      }

      return;
    }

    if (ev.event === "result" && ev.result) {
      acc.resultText = ev.result.response ?? "";
      acc.isError = ev.result.status === "ERROR";
      acc.usage = ev.result.usage ?? acc.usage;
      acc.durationMs = (ev.result.duration_seconds ?? 0) * 1000;
      if (ev.result.conversation_id) {
        state.cliConversationId = ev.result.conversation_id;
      }
    }
  }

  private finalizeTurn(state: SessionState, acc: TurnAcc, exitCode: number | null): void {
    const sink = state.sink;
    if (sink === null) return;
    const sessionId = state.sessionId;

    if (!acc.sawAnyEvent) {
      sink({
        type: "error",
        sessionId,
        message: `Antigravity 未输出任何事件（进程退出码：${exitCode}）`,
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    if (acc.isError) {
      sink({
        type: "error",
        sessionId,
        message: acc.resultText || "Antigravity 执行出错",
        recoverable: false,
      });
      sink({ type: "session.status", sessionId, status: "failed" });
      return;
    }

    sink({
      type: "message.completed",
      sessionId,
      messageId: acc.messageId,
      text: acc.resultText ?? "",
    });

    state.usageCount += 1;
    const inTok = acc.usage?.input_tokens ?? 0;
    const outTok = acc.usage?.output_tokens ?? 0;
    const readTok = acc.usage?.cache_read_tokens ?? 0;
    sink({
      type: "usage",
      sessionId,
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: readTok,
      costUsd: 0,
      model: state.model ?? "gemini-3.8-flash-high",
      decodeMs: acc.durationMs,
      requestId: `agy:${state.cliConversationId ?? state.sessionId}:p${process.pid}:${state.usageCount}`,
    });

    sink({ type: "session.status", sessionId, status: "idle" });
  }
}
