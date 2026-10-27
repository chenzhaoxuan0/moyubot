/**
 * daemon WS 客户端 —— 前端到 Runtime Host 的唯一长连接（docs/07 线上协议 v1）。
 *
 * 每 endpoint 一个单例：daemon 对所有客户端广播全部执行器的事件，
 * 各适配器实例在适配器层按「本实例创建的会话」过滤。管理面 REST 不走这里。
 *
 * 帧形态：
 *   client → daemon : { v:1, id, method, params? }
 *   daemon → client : { v:1, id, ok, result|error } | { v:1, type:"hello",… }
 *                   | { v:1, type:"event", seq, event: RuntimeEvent }
 *                   | { v:1, type:"terminal", … }（终端页签接入时再消费）
 *
 * 断线重放（docs/08 WP-2）：事件帧带 per-session seq；重连（hello）成功后触发
 * resync 监听器，适配器按会话调 session.events.since 补拉缺口（判重在适配器侧）。
 * hello 帧的 daemon.generation（评审 P1）：daemon 换代后 seq 空间从 1 重来，
 * 检测到换代即通知适配器清游标做全量重拉——否则旧游标会把新事件全部判重丢弃。
 *
 * token（WP-7）：localStorage 显式配置优先（手机/局域网），否则回环经 /bootstrap
 * 自动取；都拿不到就连裸的，daemon 开着鉴权会 401。
 */

import type { NativeCommandInfo, RuntimeCapabilities } from "../../core/adapter.ts";
import type {
  GitBranchesResult,
  GitChangesResult,
  GitCommitResult,
  GitDiffResult,
  GitGraphResult,
  GitIdentity,
  GitPushResult,
  GitStatusResult,
  GitWorktree,
} from "../../core/git.ts";
import type { RuntimeEvent } from "../../core/events.ts";
import type { WorkspacePathsResult } from "../../core/workspacePaths.ts";
import { ruleFromCron, type Automation, type AutomationRun, type ScheduleRule } from "../../core/automation.ts";
import type { BacklogConfig, BacklogItem, BacklogProposal, BacklogSignal, BacklogStateSnapshot, QuotaHeadroom, QuotaResumeConfig } from "../../core/backlog.ts";
import type { WorkUnit } from "../../core/units.ts";
import type { SkillsInventory } from "../../core/skills.ts";
import type {
  McpCopyOutcome,
  McpInventory,
  McpMutationResult,
  McpServerEntry,
} from "../../core/mcp.ts";

export interface DaemonModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoningLevels?: readonly string[];
  readonly defaultReasoningLevel?: string;
  /** CLI 声明的可选上下文长度档（≥2 档时选择器出滑动条；value 原样透传） */
  readonly contextLengths?: readonly { readonly value: string; readonly label: string }[];
  /** 探测那一刻执行器正生效的上下文档 value */
  readonly defaultContextLength?: string;
  readonly multimodal?: boolean;
  readonly inputPerMTok?: number;
  readonly outputPerMTok?: number;
}

export interface DaemonExecutorInfo {
  readonly id: string;
  readonly displayName: string;
  readonly glyph: string;
  readonly models: readonly DaemonModelInfo[];
  /** daemon 侧能否动态发现模型清单。false = 模型按钮对它无效，界面要标出来 */
  readonly modelsDiscoverable?: boolean;
  /**
   * models 是从 daemon 的 models-cache.json 兜底来的，写于何时。
   * 缺省 = 本次进程真探到的。界面据此显示「来自上次探测 · X 前」——
   * 分不清「没刷新」和「刷新到了」，模型列表就成了玄学。
   */
  readonly modelsCachedAt?: number;
  readonly capabilities: RuntimeCapabilities;
  /** daemon 侧标了 = 这是测试夹具（mockperm），不是真的 CLI 工具 */
  readonly testOnly?: true;
  /** 该执行器原生读取的 cwd 项目上下文文件（ADR 0014 防双注注册表）。缺省 = 未标注 */
  readonly nativeContextFiles?: readonly string[];
}

/** 单家执行器的模型同步结果（daemon 返回） */
export interface ModelSyncReport {
  readonly runtimeId: string;
  readonly displayName: string;
  readonly count: number;
  /** live = 真从 CLI/本地目录探到的；static = 退回内置兜底清单 */
  readonly source: "live" | "static";
  readonly reason?: string;
  readonly elapsedMs: number;
  /** 本轮返回的清单是从兜底缓存沿用来的，写于何时。缺省 = 本轮真探到了 */
  readonly cachedAt?: number;
}

/**
 * daemon 端口。默认 5281，**可被 `VITE_AGENT_WORKBENCH_PORT` 覆盖**。
 *
 * 为什么需要这个：Windows 的 Hyper-V / WSL 会保留一整段动态端口
 * （本机实测 5141–5240 就被占了，旧默认 5181 正在其中），撞上时 `listen` 直接
 * EACCES，daemon 起不来。而端口同时被前端硬编码了 3 处 —— 服务端单方面换端口
 * 会让界面连不上，所以两端必须能一起改。
 *
 * 改法：起 daemon 时 `AGENT_WORKBENCH_PORT=5273 pnpm dev`，
 * 跑前端时 `VITE_AGENT_WORKBENCH_PORT=5273 pnpm dev`。
 */
const DAEMON_PORT = (import.meta.env?.VITE_AGENT_WORKBENCH_PORT as string | undefined)?.trim() || "5281";

/**
 * daemon 地址解析（WP-7 手机流程）：
 * 1. localStorage `agent-workbench:daemon-endpoint` 显式指定（最高优先）；
 * 2. 页面本身跑在非本机主机名上（手机开 http://<pc-ip>:5273）→ 自动跟随主机名，
 *    指向 <pc-ip>:<DAEMON_PORT> —— 手机端零配置连上同一台 daemon；
 * 3. 兜底 127.0.0.1:<DAEMON_PORT>（本机桌面）。
 */
export function defaultDaemonEndpoint(): string {
  try {
    const stored = localStorage.getItem("agent-workbench:daemon-endpoint");
    if (stored !== null && stored !== "") return stored;
  } catch { /* 私有模式 */ }
  if (typeof window !== "undefined") {
    // 无论是本机还是移动端局域网，前端开发服务器已将 /ws, /bootstrap, /api 代理转发至 daemon。
    // 使用同源 origin 既无需开放防火墙二级端口，又能跨网卡保证移动端直连。
    // 只认 http(s) 同源：桌面生产态的 origin 是 app://moyubot（自定义协议，没有
    // proxy 可用），file:// 更不必说——都回退直连 127.0.0.1:5281。
    const origin = window.location.origin;
    if (origin.startsWith("http://") || origin.startsWith("https://")) {
      return origin;
    }
  }
  return `http://127.0.0.1:${DAEMON_PORT}`;
}

export function wsUrlOf(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;
}

/** endpoint 的 http 形态（REST 用）：去尾斜杠与 /ws 后缀，ws 前缀还原成 http */
export function httpUrlOf(endpoint: string): string {
  return endpoint.replace(/\/+$/, "").replace(/\/ws$/, "").replace(/^ws/, "http");
}

export interface DaemonTerminalFrame {
  readonly terminalId: string;
  readonly kind: "data" | "exit" | "created";
  readonly data?: string;
  readonly exitCode?: number;
  /** kind=created 的档案：后端侧（自动化派发）新建终端的推送认领依据 */
  readonly executor?: string;
  readonly unitId?: string;
  readonly cwd?: string;
  readonly shell?: string;
}

export class DaemonClient {
  readonly #endpoint: string;
  #ws: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #eventListeners = new Set<(e: RuntimeEvent, seq?: number) => void>();
  readonly #backlogListeners = new Set<(s: BacklogSignal) => void>();
  readonly #notificationListeners = new Set<(row: DaemonNotificationRow) => void>();
  readonly #resyncListeners = new Set<() => void>();
  readonly #generationListeners = new Set<() => void>();
  readonly #terminalListeners = new Set<(f: DaemonTerminalFrame) => void>();
  #seq = 0;
  #everConnected = false;
  #generation: string | null = null;
  #token: string | null = null;

  private constructor(endpoint: string) {
    this.#endpoint = endpoint;
  }

  static readonly #instances = new Map<string, DaemonClient>();

  static get(endpoint: string): DaemonClient {
    let c = this.#instances.get(endpoint);
    if (!c) {
      c = new DaemonClient(endpoint);
      this.#instances.set(endpoint, c);
    }
    return c;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  /**
   * token 解析（WP-7）：localStorage 显式配置优先，否则回环自动经 GET /bootstrap 取。
   * 都拿不到返回 null——连裸的，鉴权开着会 401，调用方据此报"需要 token"。
   */
  async #ensureToken(): Promise<string | null> {
    if (this.#token !== null) return this.#token;
    try {
      if (typeof window !== "undefined") {
        const urlParams = new URLSearchParams(window.location.search);
        const qToken = urlParams.get("token");
        if (qToken) {
          localStorage.setItem("agent-workbench:daemon-token", qToken);
          this.#token = qToken;
          return qToken;
        }
      }
      const stored = localStorage.getItem("agent-workbench:daemon-token");
      if (stored !== null && stored !== "") {
        this.#token = stored;
        return stored;
      }
    } catch { /* 私有模式 localStorage 不可用 */ }
    try {
      const r = await fetch(`${this.#endpoint}/bootstrap`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = (await r.json()) as { token?: string | null };
        if (typeof j.token === "string" && j.token !== "") {
          this.#token = j.token;
          return j.token;
        }
      }
    } catch { /* daemon 未起或非回环拒绝 */ }
    return null;
  }

  async ensureConnected(timeoutMs = 8000): Promise<void> {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) return;
    if (this.#connecting !== null) return this.#connecting;
    const attempt: Promise<void> = new Promise<void>((resolve, reject) => {
      // 评审 P2：建连体全程 try/catch + attempt 级 settled 标记——此前超时不关 socket、
      // 迟到的 error/open 会 clobber 下一次尝试、WebSocket 构造同步抛会让 Promise 永不 settle
      let settled = false;
      let ws: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = (code: string, message: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (ws !== null) {
          try {
            ws.close();
          } catch { /* 已死不究 */ }
        }
        reject(Object.assign(new Error(message), { code }));
      };
      const succeed = (socket: WebSocket): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.#ws = socket;
        resolve();
      };

      void this.#ensureToken()
        .then((token) => {
          const base = wsUrlOf(this.#endpoint);
          const wsUrl = token !== null ? `${base}?token=${encodeURIComponent(token)}` : base;
          try {
            ws = new WebSocket(wsUrl);
          } catch (err: unknown) {
            fail("daemon_unreachable", `daemon ${this.#endpoint} 连接创建失败：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          timer = setTimeout(() => fail("daemon_connect_timeout", `daemon ${this.#endpoint} 连接超时`), timeoutMs);
          ws.addEventListener("open", () => succeed(ws!));
          ws.addEventListener("error", () => fail("daemon_unreachable", `daemon ${this.#endpoint} 连接失败（daemon 没起？或 token 不对）`));
          ws.addEventListener("message", (ev: MessageEvent) => this.#onFrame(ev));
          ws.addEventListener("close", () => {
            if (this.#ws === ws) this.#ws = null;
            // 挂起的 rpc 全部失败：调用方据此感知断线
            for (const p of this.#pending.values()) {
              clearTimeout(p.timer);
              p.reject(Object.assign(new Error("daemon 连接已断开"), { code: "daemon_disconnected" }));
            }
            this.#pending.clear();
          });
        })
        .catch((err: unknown) => fail("daemon_unreachable", err instanceof Error ? err.message : String(err)));
    }).finally(() => {
      if (this.#connecting === attempt) this.#connecting = null;
    });

    this.#connecting = attempt;
    return attempt;
  }

  /** 帧分发：hello（代际检测/resync 触发）、event、terminal、rpc 响应 */
  #onFrame(ev: MessageEvent): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame["type"] === "hello") {
      // 评审 P1：daemon 换代（pid 变）= seq 空间重置——通知适配器清游标全量重拉；
      // 未换代的重连走增量 resync。resync 触发统一收敛到 hello（连接建立的权威信号）。
      const daemon = frame["daemon"] as { generation?: string; pid?: number } | undefined;
      const gen = daemon === undefined ? "unknown" : (daemon.generation ?? `pid:${daemon.pid ?? "?"}`);
      const changed = this.#generation !== null && this.#generation !== gen;
      const wasConnected = this.#everConnected;
      this.#generation = gen;
      this.#everConnected = true;
      if (changed) {
        for (const fn of this.#generationListeners) fn();
      } else if (wasConnected) {
        for (const fn of this.#resyncListeners) fn();
      }
      return;
    }
    if (frame["type"] === "event") {
      const event = frame["event"] as RuntimeEvent | undefined;
      // 评审 P3：最小形状校验——半实现 daemon / wscat 手发帧不至于在监听器里抛 TypeError。
      // git.changed 是仓库级事件（无 sessionId，docs/16），凭 rootPath 放行
      if (
        event === undefined ||
        typeof event !== "object" ||
        (event.type === "git.changed"
          ? typeof (event as { rootPath?: unknown }).rootPath !== "string"
          : typeof (event as { sessionId?: unknown }).sessionId !== "string")
      ) {
        return;
      }
      const seq = typeof frame["seq"] === "number" ? frame["seq"] : undefined;
      for (const fn of this.#eventListeners) fn(event, seq);
      return;
    }
    if (frame["type"] === "terminal") {
      const tf = frame as unknown as DaemonTerminalFrame;
      for (const fn of this.#terminalListeners) fn(tf);
      return;
    }
    if (frame["type"] === "backlog") {
      const signal = frame["signal"] as BacklogSignal | undefined;
      // 最小形状校验（与 event 帧同理）：坏帧不进监听器
      if (signal === undefined || typeof signal !== "object" || typeof signal["kind"] !== "string") return;
      for (const fn of this.#backlogListeners) fn(signal);
      return;
    }
    if (frame["type"] === "notifications") {
      const row = frame["row"] as DaemonNotificationRow | undefined;
      // 最小形状校验（与 event/backlog 同理）
      if (row === undefined || typeof row !== "object" || typeof row.id !== "string" || typeof row.kind !== "string") return;
      for (const fn of this.#notificationListeners) fn(row);
      return;
    }
    // rpc 响应
    if (frame["id"] !== undefined && frame["id"] !== null && (frame["ok"] !== undefined || frame["error"] !== undefined)) {
      const key = String(frame["id"]);
      const p = this.#pending.get(key);
      if (!p) return;
      this.#pending.delete(key);
      clearTimeout(p.timer);
      if (frame["ok"] === true) p.resolve(frame["result"]);
      else {
        const err = frame["error"] as { code?: string; message?: string; data?: unknown } | undefined;
        p.reject(
          Object.assign(new Error(err?.message ?? "daemon rpc failed"), {
            code: err?.code ?? "daemon_error",
            // data 是后端给的结构化补充（冲突时含 reason + 盘上现值）——UI 要靠它
            // 指名是 bot.json 还是 AGENTS.md 被改过，不能让用户去猜。
            ...(err?.data !== undefined ? { data: err.data } : {}),
          }),
        );
      }
    }
  }

  rpc<T = unknown>(method: string, params: unknown, timeoutMs = 300_000): Promise<T> {
    return this.ensureConnected().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const ws = this.#ws;
          if (ws === null || ws.readyState !== WebSocket.OPEN) {
            reject(Object.assign(new Error("daemon 未连接"), { code: "daemon_unreachable" }));
            return;
          }
          const id = `c-${++this.#seq}`;
          const timer = setTimeout(() => {
            this.#pending.delete(id);
            reject(Object.assign(new Error(`${method} 超时（${timeoutMs}ms）`), { code: "daemon_rpc_timeout" }));
          }, timeoutMs);
          this.#pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
          ws.send(JSON.stringify({ v: 1, id, method, params }));
        }),
    );
  }

  /**
   * REST 面的鉴权 token（x-awb-token）。鉴权关着时为 null —— 此时裸调即可。
   * 出图代理这类带大载荷/流式的 REST 路由用它显式带头（不能走 rpc 通道）。
   */
  authToken(): Promise<string | null> {
    return this.#ensureToken();
  }

  onEvent(fn: (e: RuntimeEvent, seq?: number) => void): () => void {
    this.#eventListeners.add(fn);
    return () => this.#eventListeners.delete(fn);
  }

  /** 待办（GTD）信号：提议挂起 / 落定 / 总状态变化 / 清单变化 / 通知 */
  onBacklogSignal(fn: (s: BacklogSignal) => void): () => void {
    this.#backlogListeners.add(fn);
    return () => this.#backlogListeners.delete(fn);
  }

  /** daemon 聚合通知推流（docs/21 P4b）；历史以 fetchNotifications 拉取为准 */
  onNotification(fn: (row: DaemonNotificationRow) => void): () => void {
    this.#notificationListeners.add(fn);
    return () => this.#notificationListeners.delete(fn);
  }

  /** 重连（未换代）时触发——适配器按会话游标增量补拉 */
  onResync(fn: () => void): () => void {
    this.#resyncListeners.add(fn);
    return () => this.#resyncListeners.delete(fn);
  }

  /** daemon 换代（重连后 hello 的 generation 变化）——适配器清游标全量重拉 */
  onGenerationChange(fn: () => void): () => void {
    this.#generationListeners.add(fn);
    return () => this.#generationListeners.delete(fn);
  }

  /** 终端数据帧（terminal.create 之后到达；按 terminalId 过滤） */
  onTerminalFrame(fn: (f: DaemonTerminalFrame) => void): () => void {
    this.#terminalListeners.add(fn);
    return () => this.#terminalListeners.delete(fn);
  }
}

/**
 * 拉执行器清单 —— 前端据此为每个 daemon 执行器注册一个 RuntimeAdapter */
export async function listDaemonExecutors(endpoint: string = defaultDaemonEndpoint()): Promise<DaemonExecutorInfo[]> {
  const client = DaemonClient.get(endpoint);
  const list = await client.rpc<DaemonExecutorInfo[]>("adapter.list", null, 10000);
  return list;
}

/** 单家执行器的新版本结论（docs/27） */
export interface ExecutorUpdateItem {
  readonly runtimeId: string;
  readonly current: string;
  readonly latest: string | null;
  readonly state: "current" | "behind" | "unknown";
  /** 检测源描述（"npm @openai/codex"） */
  readonly source: string;
}

export interface ExecutorUpdatesReport {
  readonly checkedAt: number;
  readonly items: readonly ExecutorUpdateItem[];
  readonly hasUpdates: boolean;
}

/**
 * 执行器新版本检测（docs/27）：current 由前端探测注册表提供（裸执行器 id → 版本串，
 * 只放 ready 的），daemon 查 npm/PyPI latest 缓存比对。force = 绕过 daemon 侧 1h 缓存。
 */
export async function fetchExecutorUpdates(
  current: Readonly<Record<string, string>>,
  force = false,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<ExecutorUpdatesReport> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<ExecutorUpdatesReport>("adapter.updates", { current, force }, 30000);
}

/**
 * 重新探测模型清单（设置页「重新探测模型」按钮的落点）。
 *
 * 一次往返同时拿回**刷新报告**和**刷新后的完整执行器清单** —— 前端拿到就能就地
 * 更新注册表，不必再补一次 `adapter.list`。后者正是老 bug 的根源：`adapter.list`
 * 返回的是 daemon 注册时的清单快照，所以「后端刷新了、界面不更新」。
 *
 * 零用量：daemon 侧只跑各 CLI 的只读列清单命令或读本地目录文件，不发 prompt。
 */
export async function syncDaemonModels(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{
  readonly report: readonly ModelSyncReport[];
  readonly adapters: readonly DaemonExecutorInfo[];
}> {
  const client = DaemonClient.get(endpoint);
  return await client.rpc<{ report: ModelSyncReport[]; adapters: DaemonExecutorInfo[] }>(
    "adapter.models",
    null,
    // 各家 CLI 冷启动不便宜（grok 要起 ACP 进程、agy 35s 预算），给足预算
    120000,
  );
}

/**
 * 拉某执行器的**原生斜杠命令**清单（斜杠菜单数据源）。
 *
 * 空数组 = 该执行器没有原生命令面（不是错误）—— UI 回落工作台本地命令。
 * 注意 runtimeId 传**裸执行器 id**（daemon 侧口径），不是 `daemon:<id>`。
 * 30s：daemon 侧 claude 拉取有 20s 硬超时兜底，正常 1-3s 返回；
 * 再久只可能是 daemon 整体卡死，早点让 UI 进错误态。
 */
export async function fetchExecutorCommands(
  runtimeId: string,
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<readonly NativeCommandInfo[]> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<readonly NativeCommandInfo[]>("adapter.commands", { runtimeId, rootPath }, 30000);
}

// ---- 执行器原生模型默认值（设置页「写入 CLI 自己的配置」，cc-switch 同思路）----

/** 一个可写字段：key 是提交用的稳定 id；value 空串 = 未设置（提交空串 = 删键） */
export interface NativeModelField {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "number" | "enum";
  readonly options?: readonly string[];
  readonly value: string;
  readonly placeholder?: string;
  readonly hint?: string;
  /** 候选建议（daemon 注入的执行器当前模型清单）—— 输入框渲染成可选项 */
  readonly suggestions?: readonly string[];
}

export interface NativeModelConfig {
  readonly configPath: string;
  readonly note: string;
  readonly fields: readonly NativeModelField[];
}

export type NativeModelConfigResult = { supported: false; reason: string } | NativeModelConfig;

/**
 * 读执行器原生配置里的模型默认值。没有可写面的执行器返回 `{ supported: false }`
 * 而不是抛 —— 界面对它显示「参数随会话下发」的提示即可。裸 id 口径同上。
 */
export async function readModelDefaults(
  runtimeId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<NativeModelConfigResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<NativeModelConfigResult>("adapter.modeldefaults.get", { runtimeId }, 15000);
}

/**
 * 写模型默认值（字段级补丁进 CLI 配置文件）。daemon 写完会顺带刷一次该执行器的
 * 模型清单并带回全新清单 —— claude 的清单就住在 settings.json 里，界面立刻反映。
 */
export async function writeModelDefaults(
  runtimeId: string,
  values: Readonly<Record<string, string>>,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{
  readonly config: NativeModelConfig;
  readonly report: readonly ModelSyncReport[];
  readonly adapters: readonly DaemonExecutorInfo[];
}> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ config: NativeModelConfig; report: ModelSyncReport[]; adapters: DaemonExecutorInfo[] }>(
    "adapter.modeldefaults.set",
    { runtimeId, values: { ...values } },
    // set 顺带 syncModels：codex debug models 正常 1-8s，留足预算
    60000,
  );
}

// ---- 供应商级配置（pi / opencode 的累加式面）---------------------------------------

export interface ProviderEntry {
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** pi = api 协议；opencode = npm 包名 */
  readonly api: string;
  readonly models: readonly string[];
}

export interface ProviderWriteRow extends ProviderEntry {
  readonly origKey?: string;
}

export interface NativeProvidersInfo {
  readonly configPath: string;
  readonly note: string;
  readonly providers: readonly ProviderEntry[];
  readonly managedByExternal?: string;
}

export type ProvidersResult = { supported: false; reason: string } | NativeProvidersInfo;

export async function readModelProviders(
  runtimeId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<ProvidersResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<ProvidersResult>("adapter.providers.get", { runtimeId }, 15000);
}

export async function writeModelProviders(
  runtimeId: string,
  rows: readonly ProviderWriteRow[],
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{
  readonly providers: NativeProvidersInfo;
  readonly report: readonly ModelSyncReport[];
  readonly adapters: readonly DaemonExecutorInfo[];
}> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ providers: NativeProvidersInfo; report: ModelSyncReport[]; adapters: DaemonExecutorInfo[] }>(
    "adapter.providers.set",
    { runtimeId, rows: rows.map((r) => ({ ...r })) },
    60000,
  );
}

// ---- 执行器模型目录（codex model-catalogs 一类的清单级编辑）------------------------

/** 目录条目：slug 是模型身份；visibility "list"=可选 / "hide"=不出现在选择面 */
export interface ModelCatalogEntry {
  readonly slug: string;
  readonly display_name: string;
  readonly context_window?: number;
  readonly supported_reasoning_levels?: readonly string[];
  readonly default_reasoning_level?: string;
  readonly visibility: string;
  readonly multimodal?: boolean;
}

/** 提交行：origSlug 缺省 = 新增；有值 = 对该条目的就地编辑（含改名） */
export interface ModelCatalogWriteRow extends ModelCatalogEntry {
  readonly origSlug?: string;
}

export interface ModelCatalogInfo {
  /** 当前生效的目录文件；null = 未配置（entries 是生效清单的种子，保存即接管） */
  readonly activePath: string | null;
  readonly note: string;
  readonly entries: readonly ModelCatalogEntry[];
  /** 目录文件归别家工具管（如 cc-switch）—— 编辑可能被对方重生成覆盖 */
  readonly managedByExternal?: string;
}

export type ModelCatalogResult = { supported: false; reason: string } | ModelCatalogInfo;

/** 读执行器模型目录。没有目录面的执行器返回 supported:false（正常态，不抛） */
export async function readModelCatalog(
  runtimeId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<ModelCatalogResult> {
  const client = DaemonClient.get(endpoint);
  // 未配置目录时 daemon 会跑一次 codex debug models 做种子，给足预算
  return client.rpc<ModelCatalogResult>("adapter.modelcatalog.get", { runtimeId }, 30000);
}

/** 写目录（整表提交）。daemon 顺带刷该执行器模型清单并带回全新清单 */
export async function writeModelCatalog(
  runtimeId: string,
  rows: readonly ModelCatalogWriteRow[],
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{
  readonly catalog: ModelCatalogInfo;
  readonly report: readonly ModelSyncReport[];
  readonly adapters: readonly DaemonExecutorInfo[];
}> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ catalog: ModelCatalogInfo; report: ModelSyncReport[]; adapters: DaemonExecutorInfo[] }>(
    "adapter.modelcatalog.set",
    { runtimeId, rows: rows.map((r) => ({ ...r })) },
    60000,
  );
}

/**
 * 拉工作区路径建议（输入 @ 提及的菜单数据源，交互对齐 ZCode file-mention）。
 *
 * token 是 `@` 之后的已输入片段：带 `/` 时前半段定位目录、末段过滤名字。
 * 本地 readdir 快路径，5s 足够；失败由调用方决定展示（菜单不该因抖动报错）。
 */
export async function fetchWorkspacePaths(
  rootPath: string,
  token: string,
  opts?: { limit?: number; signal?: AbortSignal },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<WorkspacePathsResult> {
  const client = DaemonClient.get(endpoint);
  if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const pending = client.rpc<WorkspacePathsResult>(
    "workspace.paths.list",
    { rootPath, token, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
    5000,
  );
  opts?.signal?.addEventListener("abort", () => pending.catch(() => undefined), { once: true });
  return pending;
}

/**
 * 拉技能清单（设置页「技能」分区）：按技能源分组、每组带读取它的执行器。
 * rootPath 可选 —— 给了才纳入项目级技能源（公共库之外的项目目录跟随工作区）。
 */
export async function fetchSkillsInventory(
  rootPath?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<SkillsInventory> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<SkillsInventory>("skills.inventory", { rootPath: rootPath ?? null }, 15000);
}

/**
 * 技能停用/恢复 —— daemon 在技能源内把文件夹搬进/搬出 `.disabled/`。
 * 成功返回受影响的执行器 id（调用方据此清本地命令缓存）。
 */
export async function setSkillDisabledRpc(
  sourceDir: string,
  dirName: string,
  disabled: boolean,
  rootPath?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; readers: string[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean; readers: string[] }>(
    "skills.setDisabled",
    { sourceDir, dirName, disabled, rootPath: rootPath ?? null },
    15000,
  );
}

/** 跨技能源复制技能文件夹（矩阵视图「打钩到某源」）：复制非移动，多源共存各自演化 */
export async function copySkillRpc(
  fromSourceDir: string,
  dirName: string,
  toSourceDir: string,
  rootPath?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; readers: string[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean; readers: string[] }>(
    "skills.copy",
    { fromSourceDir, dirName, toSourceDir, rootPath: rootPath ?? null },
    30000,
  );
}

// ---- MCP 管理（ADR 0004：expectedSha 是乐观锁指纹，冲突时 daemon 报 code=conflict）----

/** 全量清单：五家文件状态 + 按名聚行的服务实例（live + 停用库） */
export async function mcpInventoryRpc(endpoint: string = defaultDaemonEndpoint()): Promise<McpInventory> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<McpInventory>("mcp.inventory", null, 15000);
}

/** 新增/编辑一条（回执带变更后文件全文 —— 「落盘后的内容」预览） */
export async function mcpSaveRpc(
  executorId: string,
  entry: McpServerEntry,
  expectedSha?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<McpMutationResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<McpMutationResult>("mcp.save", { executorId, entry, expectedSha: expectedSha ?? null }, 15000);
}

/** 删除：toVault=true（默认）移入停用库；false 彻底删除 */
export async function mcpRemoveRpc(
  executorId: string,
  name: string,
  opts: { toVault?: boolean; expectedSha?: string } = {},
  endpoint: string = defaultDaemonEndpoint(),
): Promise<McpMutationResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<McpMutationResult>(
    "mcp.remove",
    { executorId, name, toVault: opts.toVault !== false, expectedSha: opts.expectedSha ?? null },
    15000,
  );
}

/** 启停：false = live→停用库；true = 停用库→live */
export async function mcpSetEnabledRpc(
  executorId: string,
  name: string,
  enabled: boolean,
  expectedSha?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<McpMutationResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<McpMutationResult>(
    "mcp.setEnabled",
    { executorId, name, enabled, expectedSha: expectedSha ?? null },
    15000,
  );
}

/** 跨执行器复制（读源 → 转换 → 写目标；同名跳过不覆盖），逐目标独立成败 */
export async function mcpCopyRpc(
  fromExecutorId: string,
  name: string,
  toExecutorIds: readonly string[],
  expectedShas: Record<string, string> = {},
  endpoint: string = defaultDaemonEndpoint(),
): Promise<McpCopyOutcome[]> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<McpCopyOutcome[]>("mcp.copy", { fromExecutorId, name, toExecutorIds, expectedShas }, 30000);
}

/** 读配置文件原文（真相源就是它） */
export async function mcpReadFileRpc(
  executorId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ text: string; sha: string } | { missing: true }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ text: string; sha: string } | { missing: true }>("mcp.read", { executorId }, 15000);
}

/**
 * 写一个 bot 的定义到 <rootPath>/.agent-workbench/bot.json，并把 AGENTS.md 正文落盘到
 * <rootPath>/AGENTS.md（WP-5 写穿）。
 *
 * guards 是**外部修改检测的乐观锁**：调用方（bot 设置页）进入时拿到了当时的 revision 与
 * AGENTS.md 内容 hash，保存时一起传回。盘上在这期间变了就抛 code="conflict"，
 * daemon 不会覆盖——由 UI 弹「覆盖 / 重新加载 / 取消」。
 */
export async function putBotDefinition(
  unit: unknown,
  endpoint: string = defaultDaemonEndpoint(),
  guards: { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string } = {},
  opts: { createRoot?: boolean } = {},
): Promise<RawBotPutResult> {
  const client = DaemonClient.get(endpoint);
  // ⚠ 必须把 daemon 的返回值透出去：调用方要用新 revision/agentsMd 回写 store，
  // 否则第二次保存带着过期 revision 走 ifRevision 守卫，被判成
  // 「文件被外部改过」—— 明明是自己刚存的，却每次都要人手确认一遍。
  return client.rpc<RawBotPutResult>(
    "bot.put",
    { unit, ...guards, ...(opts.createRoot === true ? { createRoot: true } : {}) },
    15000,
  );
}

/** daemon `bot.put` 的回执：新 revision 与 AGENTS.md / SOUL.md 指纹（写回 store 用） */
export interface RawBotPutResult {
  readonly path?: string;
  readonly revision?: number;
  readonly updatedAt?: number;
  readonly agentsMd?: WorkUnit["agentsMdMeta"] | null;
  readonly soulMd?: WorkUnit["soulMdMeta"] | null;
}

/** daemon 挂在每个定义上的 $meta（后端内部字段名，前端不该看见） */
interface RawBotMeta {
  readonly revision?: number;
  readonly updatedAt?: number;
  readonly agentsMd?: WorkUnit["agentsMdMeta"] | null;
  readonly soulMd?: WorkUnit["soulMdMeta"] | null;
  readonly inlineAgentsMd?: boolean;
}

/** $meta 摊平成 WorkUnit 上的 revision / agentsMdMeta / soulMdMeta，其余原样 */
function flattenBotDef(def: unknown): WorkUnit {
  const d = def as Record<string, unknown>;
  const meta = d["$meta"] as RawBotMeta | undefined;
  const out = { ...d } as Record<string, unknown>;
  delete out.$meta;
  if (meta !== undefined && meta !== null) {
    if (typeof meta.revision === "number") out.revision = meta.revision;
    // 指针在但文件缺失时后端给的是 null；这里归一成 undefined，别把 null 漏进 UI 判空
    if (meta.agentsMd !== undefined && meta.agentsMd !== null) out.agentsMdMeta = meta.agentsMd;
    if (meta.soulMd !== undefined && meta.soulMd !== null) out.soulMdMeta = meta.soulMd;
  }
  return out as unknown as WorkUnit;
}

/** 拉全部落盘 bot 定义（WP-5：启动合并 / 刷新）。每次都重扫盘，无缓存。 */
export async function listBotDefinitions(endpoint: string = defaultDaemonEndpoint()): Promise<WorkUnit[]> {
  const client = DaemonClient.get(endpoint);
  const raw = await client.rpc<unknown[]>("bot.list", null, 15000);
  return raw.map(flattenBotDef);
}

/** 软删除/从工作台注销 Bot（保留本地磁盘文件） */
export async function unregisterBotRpc(
  botId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; path: string }> {
  return DaemonClient.get(endpoint).rpc("bot.unregister", { id: botId }, 15000);
}

/** 初始化/补齐工作区目录与标准技能 */
export async function initWorkspaceRpc(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ created: string[]; existed: string[] }> {
  return DaemonClient.get(endpoint).rpc("bot.initWorkspace", { rootPath }, 15000);
}

// ---- USER.md 全局层（ADR 0014 D5）：关于「人」的 evergreen 文件，逐 bot 开关注入 ----

export interface UserContextFile {
  readonly path?: string;
  readonly content: string;
  readonly chars: number;
  readonly limit: number;
  readonly exists: boolean;
}

export async function readUserContext(endpoint: string = defaultDaemonEndpoint()): Promise<UserContextFile> {
  return DaemonClient.get(endpoint).rpc<UserContextFile>("context.user.read", null, 15000);
}

export async function writeUserContext(
  content: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ path: string; chars: number; limit: number; nearLimit: boolean }> {
  return DaemonClient.get(endpoint).rpc("context.user.write", { content }, 15000);
}

/** daemon `bot.defaultRoot` 的回执：自动安置的默认位置 + 目录浏览器起始根候选 */
export interface BotDefaultRootResult {
  /** 默认安置根（<homeDir>/bots）。daemon 侧已幂等创建并登记为扫描根。 */
  readonly defaultRoot: string;
  /** 预填进新建对话框文件夹输入框的建议路径（defaultRoot 下不冲突的新目录名） */
  readonly suggestedPath: string;
  /** 目录浏览器（FolderPickerField）的起始根候选：homeDir + 各盘符根 */
  readonly browseRoots: readonly string[];
}

/**
 * 要一份「自动安置默认位置」（ADR 0011 第 4 条）。新建对话框打开时调用：
 * 用户不动输入框就是自动安置，改了就是自定义指位。
 * daemon 未连接时抛错——调用方回落手输路径。
 */
export async function fetchBotDefaultRoot(endpoint: string = defaultDaemonEndpoint()): Promise<BotDefaultRootResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<BotDefaultRootResult>("bot.defaultRoot", null, 8000);
}

// ---------------------------------------------------------------------------
// 目录探测与渠道运行态（docs/09 §七 P0-B / §五）
// ---------------------------------------------------------------------------

export interface BotInspectReport {
  readonly rootPath: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly isGitRepo: boolean;
  readonly hasAgentsMd: boolean;
  readonly hasBotJson: boolean;
  /** 从 AGENTS.md 派生的身份候选；没有 AGENTS.md 就是 null（不瞎猜） */
  readonly derived: { readonly name: string; readonly role: string } | null;
  readonly suggestedId: string;
  readonly assets: {
    readonly skillFiles: readonly string[];
    readonly skillDirs: readonly string[];
    readonly memoryFile: string | null;
    readonly hasSoul: boolean;
    readonly hasAutomations: boolean;
    readonly extraAgentFiles: readonly string[];
  };
  readonly conflicts: {
    readonly alreadyRegistered: { readonly unitId: string; readonly name: string } | null;
    readonly nestedInside: { readonly unitId: string; readonly rootPath: string } | null;
  };
  readonly scanRootEffect: {
    readonly parent: string;
    readonly willBecomeScanRoot: boolean;
    readonly siblingsFound: number;
    readonly warning: string | null;
  };
  readonly security: {
    readonly applicable: boolean;
    readonly agentWorkbenchIgnored: boolean;
    readonly safe: boolean;
    readonly message: string;
  };
}

/** 探测一个已存在的文件夹能不能被认领为 bot（纯读，不写盘） */
export async function inspectBotFolder(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ report: BotInspectReport; existing: WorkUnit | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ report: BotInspectReport; existing: WorkUnit | null }>("bot.inspect", { rootPath }, 15000);
}

/** 往仓库 .gitignore 追加 `.agent-workbench/`（幂等）。bot.json 有明文密钥时这是必须项 */
export async function ensureBotGitignore(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ changed: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ changed: boolean }>("bot.gitignore.ensure", { rootPath }, 15000);
}

// ---- git.* —— 源代码管理面板（类型定义在 core/git.ts，实现在 backend/src/git/repo.ts） ----

export async function fetchGitStatus(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitStatusResult> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<GitStatusResult>("git.status", { rootPath }, 20000);
  // 老 daemon（没 ADR 0010 的字段）不返回 dirtyFileCount：在此补齐，
  // 让 UI 不必为「开发时后端没重启」写满地的 ?? 0
  if (r.isRepo && typeof r.dirtyFileCount !== "number") {
    return { ...r, dirtyFileCount: r.dirty ? 1 : 0 };
  }
  return r;
}

export async function fetchGitBranches(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitBranchesResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.branches.list", { rootPath }, 20000);
}

export async function createGitBranch(
  params: { rootPath: string; name: string; ref?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.branch.create", params, 30000);
}

export async function checkoutGitBranch(
  params: { rootPath: string; name: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.branch.checkout", params, 30000);
}

export async function fetchGitWorktrees(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ worktrees: readonly GitWorktree[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.worktrees.list", { rootPath }, 30000);
}

export async function createGitWorktree(
  params: { rootPath: string; path?: string; branch?: string; commitish?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ path: string; branch: string | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.worktree.create", params, 60000);
}

/** force=true 即 `--force`：UI 在收到 worktree_dirty 错误码并经用户确认后重试 */
export async function removeGitWorktree(
  params: { rootPath: string; path: string; force?: boolean },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.worktree.remove", params, 60000);
}

/** 在系统文件管理器中显示该目录 */
export async function revealGitWorktree(
  path: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.worktree.reveal", { path }, 15000);
}

// ---- git.* 提交面（ADR 0010）：改了什么 / 要不要落库 ------------------------

export async function fetchGitChanges(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitChangesResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.changes", { rootPath }, 30000);
}

export async function fetchGitDiff(
  params: { rootPath: string; path: string; sourceId: "staged" | "unstaged" },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitDiffResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.diff", params, 30000);
}

export async function stageGitPaths(
  params: { rootPath: string; paths: readonly string[] },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.stage", { rootPath: params.rootPath, paths: [...params.paths] }, 30000);
}

export async function unstageGitPaths(
  params: { rootPath: string; paths: readonly string[] },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<null>("git.unstage", { rootPath: params.rootPath, paths: [...params.paths] }, 30000);
}

export async function commitGitChanges(
  params: { rootPath: string; message: string; paths: readonly string[]; stagedOnly?: boolean },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitCommitResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.commit", { ...params, paths: [...params.paths] }, 90000);
}

export async function pushGitBranch(
  params: { rootPath: string; remote?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitPushResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.push", params, 150000);
}

/** 提交身份；null = user.name / user.email 有缺，提交对话框据此显示警告条 */
export async function fetchGitIdentity(
  rootPath: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitIdentity | null> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.identity", { rootPath }, 20000);
}

/** 提交图一页（docs/16）。大仓库的 log 全量较慢，超时给足 */
export async function fetchGitGraph(
  params: { rootPath: string; skip?: number; maxCount?: number },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<GitGraphResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc("git.graph", params, 60000);
}

export interface ChannelStatus {
  readonly gateways: {
    readonly feishu: number;
    readonly telegram: number;
    readonly weixin?: number;
    readonly discord?: number;
    readonly [kind: string]: number | undefined;
  };
  readonly bots: readonly {
    readonly id: string;
    readonly channels: readonly { readonly kind: string; readonly enabled: boolean; readonly accounts: number }[];
  }[];
}

/** 渠道运行态：bot.json 声明了什么 vs 网关实际起没起 */
export async function fetchChannelStatus(endpoint: string = defaultDaemonEndpoint()): Promise<ChannelStatus> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<ChannelStatus>("channel.status", null, 15000);
}

export interface DiagnosisResult {
  readonly appId: string;
  readonly accountKey: string;
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

/**
 * 诊断某个 bot 的飞书账号连得通不（向导第三步）。
 *
 * botId + accountId 一起传：诊断的最小单位是**账号**——一个 bot 可以挂几个飞书
 * 应用，配错其中一个不该让另外几个也显示异常。
 */
export async function diagnoseChannel(
  params: { botId: string; accountId?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<DiagnosisResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<DiagnosisResult>("channel.diagnose", params, 30000);
}

/**
 * 一个 lark-cli profile 是哪个飞书机器人。
 *
 * 这是「界面上认得出」的唯一依据：profile 字符串谁也认不出，`appName` +
 * `avatarUrl` 才是飞书里那个机器人的脸。后端走 `bot/v3/info`，成功缓存 10 分钟。
 */
export interface LarkBotIdentity {
  readonly profile: string;
  readonly appId: string;
  readonly appName: string;
  readonly avatarUrl: string;
  readonly openId: string;
  /** 飞书侧三态，2 = 已启用；-1 = 没拿到 */
  readonly activateStatus: number;
  readonly ok: boolean;
  readonly detail: string;
}

export type ChannelIdentityMap = Record<string, LarkBotIdentity>;

/** 不传 profiles = 问盘上所有已启用飞书账号；传了 = 只认这几个（草稿配置用） */
export async function fetchChannelIdentity(
  profiles?: readonly string[],
  endpoint: string = defaultDaemonEndpoint(),
): Promise<ChannelIdentityMap> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<ChannelIdentityMap>(
    "channel.identity",
    profiles === undefined ? null : { profiles: [...profiles] },
    30000,
  );
}

export interface LarkProfileEntry {
  readonly name: string;
  readonly appId: string;
  readonly brand: string;
  readonly active: boolean;
  /** CLI 侧 user 身份的 token 状态；bot 身份不查这个 */
  readonly tokenStatus: string;
  /** 这个 profile 背后是哪个飞书机器人。认不出就是 ok:false，不是「未知」 */
  readonly identity: LarkBotIdentity;
}

export interface LarkProfileList {
  /** lark-cli 装没装 */
  readonly available: boolean;
  readonly version: string;
  readonly detail: string;
  readonly profiles: readonly LarkProfileEntry[];
}

/** 本机所有飞书机器人（= lark-cli profile list，逐个认过脸） */
export async function fetchLarkProfiles(endpoint: string = defaultDaemonEndpoint()): Promise<LarkProfileList> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<LarkProfileList>("channel.profiles", null, 45000);
}

export interface LarkProfileAddResult {
  readonly ok: boolean;
  /** 给界面显示的一句话。不含 secret，也不含它的任何片段 */
  readonly detail: string;
  readonly name: string;
  /** 建完立刻认的脸。ok=false 表示「写进去了但机器人认不出」 */
  readonly identity: LarkBotIdentity;
}

/**
 * 建一个新飞书机器人（= 加一个 lark-cli profile）。
 *
 * ⚠ `appSecret` 会被送到 daemon，由它交给 lark-cli 的 **stdin**：不进进程参数、
 * 不落盘到本工作台、不写日志、不回传。lark-cli 把它存进系统钥匙串，
 * `~/.lark-cli/config.json` 里只留 `{source:"keychain", id:…}` 句柄。
 */
export async function createLarkProfile(
  input: { name: string; appId: string; appSecret: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<LarkProfileAddResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<LarkProfileAddResult>("channel.profile.add", input, 60000);
}

/** 主动出站：让 bot 主动开口（日报 / 告警 / 自动化结果） */
export async function sendViaChannel(
  params: { botId: string; accountId?: string; receiveId: string; text: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; detail: string }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean; detail: string }>("channel.send", params, 30000);
}

/**
 * 用系统的文件资源管理器（Windows Explorer / macOS Finder）直接打开目标文件夹
 */
export async function openFolder(
  pathOrBotId: { path?: string; botId?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; path?: string }> {
  const client = DaemonClient.get(endpoint);
  try {
    return await client.rpc<{ ok: boolean; path?: string }>("workspace.openFolder", pathOrBotId, 10000);
  } catch (err: unknown) {
    // 降级尝试 HTTP POST（如果 WS 短暂重连）
    try {
      const httpOrigin = endpoint.replace(/^ws/, "http").replace(/\/ws$/, "");
      const res = await fetch(`${httpOrigin}/api/workspaces/open-folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pathOrBotId),
      });
      return (await res.json()) as { ok: boolean; path?: string };
    } catch {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 头部「打开方式」：已安装编辑器清单 + 指定编辑器打开（daemon 侧检测，
// 移植自 ZCode editors.ts；explorer id 即上面的 openFolder 通道）
// ---------------------------------------------------------------------------

export interface DaemonEditorInfo {
  readonly id: string;
  readonly name: string;
}

/** 已安装编辑器清单（explorer 永远排最前；daemon 缓存，探测 IO 只花一次） */
export async function listEditors(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ editors: DaemonEditorInfo[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ editors: DaemonEditorInfo[] }>("workspace.listEditors", {}, 10000);
}

/** 用指定编辑器（vscode / explorer）打开目标文件夹 */
export async function openInEditor(
  params: { path?: string; botId?: string; editorId: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean; path?: string; error?: string }>(
    "workspace.openInEditor",
    params,
    10000,
  );
}

// ---------------------------------------------------------------------------
// 自动化（Phase 5 v2）—— 定时任务 CRUD / 开关 / 立即运行 / 运行记录。
// daemon 返回的是带 scheduleRule 的权威形态（调度引擎与 UI 共享同一份规则对象），
// 映射成 core/automation.ts 的 Automation 给页面用。
// ---------------------------------------------------------------------------

export interface DaemonAutomationRun {
  readonly id: number;
  readonly automationId: number;
  readonly sessionId: string | null;
  /** running | done | failed | skipped */
  readonly status: string;
  /** schedule | manual */
  readonly trigger: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly detail: string | null;
}

export interface DaemonAutomation {
  readonly id: number;
  readonly unitId: string;
  readonly unitName: string;
  readonly name: string;
  readonly runtimeId: string;
  readonly rootPath: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly mode: string | null;
  readonly cron: string;
  readonly scheduleRule: ScheduleRule | null;
  readonly recurring: boolean;
  readonly maxRuns: number | null;
  readonly runCount: number;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  /** 执行方式三形态（terminal / chat / headless，语义见 core/automation.ts 的 LaunchMode）。旧行缺省按 terminal 读 */
  readonly launchMode?: "terminal" | "chat" | "headless";
  /** 到点把消息投到哪里。旧行缺省 = new_session */
  readonly dispatchTarget?: "new_session" | "existing_session";
  readonly targetSessionId?: string | null;
  readonly origin?: "manual" | "quota_resume";
  readonly createdAt: number;
  readonly runs: readonly DaemonAutomationRun[];
}

/** 创建/更新共用的入参。调度三选一：scheduleRule（权威）/ cron（兼容）/ delayMinutes（“N 分钟后”） */
export interface AutomationWriteInput {
  readonly name?: string;
  readonly unitId?: string;
  readonly unitName?: string;
  /** 裸执行器 id（如 "zcode"），不带 daemon: 前缀 —— host 侧注册表认裸 id */
  readonly runtimeId?: string;
  readonly rootPath?: string;
  readonly prompt?: string;
  readonly model?: string | null;
  readonly mode?: string | null;
  readonly recurring?: boolean;
  readonly maxRuns?: number | null;
  readonly scheduleRule?: ScheduleRule;
  readonly cron?: string;
  readonly delayMinutes?: number;
  /** 绝对时刻（epoch ms）「到 2026-10-20 15:09 只跑一次」。与 delayMinutes 互斥 */
  readonly runAt?: number;
  /** 执行方式：terminal（TUI）/ chat（对话页前台）/ headless（纯后台）。缺省 = terminal */
  readonly launchMode?: "terminal" | "chat" | "headless";
  /** 定时发送到已有对话。缺省 targetSessionId = 发火时按最新的可续接会话定 */
  readonly dispatchTarget?: "new_session" | "existing_session";
  readonly targetSessionId?: string | null;
}

function mapAutomationRun(r: DaemonAutomationRun): AutomationRun {
  return {
    startedAt: r.startedAt,
    endedAt: r.finishedAt ?? undefined,
    // skipped（错过窗口被跳过）必须保真 —— 映成 running 的话，misfire 过的任务
    // 会在卡片上永远挂着一个假「运行中」
    status:
      r.status === "done" ? "completed"
      : r.status === "failed" ? "failed"
      : r.status === "skipped" ? "skipped"
      : "running",
    summary: r.detail ?? undefined,
    sessionId: r.sessionId,
  };
}

/** daemon 权威形态 → 页面 Automation。runs 按时间升序（页面取 .at(-1) 当「最近」）。 */
export function daemonAutomationToAutomation(a: DaemonAutomation): Automation {
  return {
    id: String(a.id),
    name: a.name,
    description: a.prompt,
    unitId: a.unitId,
    unitName: a.unitName,
    runtimeId: a.runtimeId,
    // 纯 cron 旧行没有 rule：尽力还原成规则用于展示与本地预估，还原不出给个每日兜底
    rule: a.scheduleRule ??
      ruleFromCron(a.cron) ?? { frequency: "daily", hour: 0, minute: 0, weekdays: [], dayOfMonth: 1 },
    enabled: a.enabled,
    recurring: a.recurring,
    maxRuns: a.maxRuns ?? undefined,
    runCount: a.runCount,
    runs: [...a.runs].sort((x, y) => x.startedAt - y.startedAt).map(mapAutomationRun),
    deliverableIds: [],
    createdAt: a.createdAt,
    model: a.model,
    mode: a.mode,
    cron: a.cron,
    scheduleSource: a.scheduleRule === null ? "cron" : "rule",
    launchMode: a.launchMode === "headless" || a.launchMode === "chat" ? a.launchMode : "terminal",
    dispatchTarget: a.dispatchTarget === "existing_session" ? "existing_session" : "new_session",
    targetSessionId: a.targetSessionId ?? null,
    origin: a.origin === "quota_resume" ? "quota_resume" : "manual",
    nextRunAt: a.nextRunAt ?? undefined,
    lastFailure: a.lastError === null ? undefined : { at: a.lastErrorAt ?? a.createdAt, reason: a.lastError },
  };
}

export async function fetchAutomations(endpoint: string = defaultDaemonEndpoint()): Promise<Automation[]> {
  const client = DaemonClient.get(endpoint);
  const raw = await client.rpc<DaemonAutomation[]>("automation.list", null, 15000);
  return raw.map(daemonAutomationToAutomation);
}

/** daemon 聚合的通知事实行（docs/21 P4b）——read/「你不在它面前」是客户端呈现，行里没有 */
export interface DaemonNotificationRow {
  readonly id: string;
  readonly at: number;
  readonly level: "info" | "ok" | "warn" | "loss";
  readonly kind: "session" | "permission" | "error" | "notice" | "steer" | "deliverable" | "backlog" | "git";
  readonly title: string;
  readonly text: string;
  /** SessionSource 原始值（客户端渲染徽标） */
  readonly source?: string;
  readonly sessionId?: string;
  readonly backlog?: boolean;
}

export async function fetchNotifications(endpoint: string = defaultDaemonEndpoint()): Promise<DaemonNotificationRow[]> {
  const client = DaemonClient.get(endpoint);
  const raw = await client.rpc<{ items?: DaemonNotificationRow[] }>("notifications.list", null, 15000);
  return raw.items ?? [];
}

/** 一条「可续接的对话」—— 定时发送的目标选项 */
export interface ResumableSession {
  readonly id: string;
  readonly title: string;
  readonly runtimeId: string;
  readonly unitId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastActiveAt: number;
  /** 会话来源（workbench/automation/feishu…）：目标选择器的来源徽标用，旧行可能缺省 */
  readonly source?: string | null;
}

/**
 * 可续接的对话清单（「定时发送到已有对话」的下拉数据源）。
 *
 * 只有 cli_ref 非空的才会出现 —— 那些才是真能在发火时接回来的。
 * 列出来的每个选项都保证能用，不给用户「选了个必然失败」的余地。
 */
export async function fetchResumableSessions(
  params: { runtimeId?: string; limit?: number } = {},
  endpoint: string = defaultDaemonEndpoint(),
): Promise<readonly ResumableSession[]> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<{ sessions: readonly ResumableSession[] }>(
    "session.resumable",
    { runtimeId: params.runtimeId ?? null, limit: params.limit ?? 20 },
    15000,
  );
  return r.sessions;
}

/**
 * 续跑判定快照：每个订阅执行器「用尽没有 / 排没排 / 为什么没排」。
 *
 * 只读缓存，不触发探针（探针要起子进程，5 分钟 TTL）；要强制刷新走
 * `backlog.quotas` 的 refresh 参数。
 */
export interface QuotaResumeStateRow {
  readonly runtimeId: string;
  readonly percent: number | null;
  readonly resetsAt: number | null;
  readonly scheduledAutomationId: number | null;
  readonly fireAt: number | null;
  readonly targetSessionId: string | null;
  /** 没排的原因；有值时界面必须显示，否则用户只看到「没反应」 */
  readonly note: string | null;
  readonly checkedAt: number;
}

export async function fetchQuotaResumeState(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ enabled: boolean; config: QuotaResumeConfig; states: readonly QuotaResumeStateRow[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ enabled: boolean; config: QuotaResumeConfig; states: readonly QuotaResumeStateRow[] }>(
    "quotaResume.state",
    null,
    15000,
  );
}

export async function createAutomation(
  input: AutomationWriteInput,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ id: number; nextRunAt: number | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ id: number; nextRunAt: number | null }>("automation.create", input, 15000);
}

export async function updateAutomation(
  id: number,
  patch: AutomationWriteInput,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ automation: DaemonAutomation | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ automation: DaemonAutomation | null }>("automation.update", { id, ...patch }, 15000);
}

export async function setAutomationEnabled(
  id: number,
  enabled: boolean,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ changed: boolean; nextRunAt: number | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ changed: boolean; nextRunAt: number | null }>("automation.setEnabled", { id, enabled }, 15000);
}

export async function deleteAutomation(
  id: number,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ deleted: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ deleted: boolean }>("automation.delete", { id }, 15000);
}

/** 批量删除（列表页多选管理）。daemon 逐条走与单删相同的收口，返回实际删除数 */
export async function deleteAutomations(
  ids: readonly number[],
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ deleted: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ deleted: number }>("automation.deleteMany", { ids }, 30000);
}

/** 批量启用/停用。重新启用终态行的触发点重算口径与单条 setEnabled 一致 */
export async function setAutomationsEnabled(
  ids: readonly number[],
  enabled: boolean,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ changed: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ changed: number }>("automation.setEnabledMany", { ids, enabled }, 30000);
}

/** 读定时任务创建上限（用户设置，默认 20；只数用户自建任务，不含自动排的用量续跑） */
export async function fetchAutomationCreateLimit(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ limit: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ limit: number }>("automation.limit.get", null, 15000);
}

/** 改创建上限。daemon 侧钳到 [1, 500]，返回实际生效值 */
export async function updateAutomationCreateLimit(
  limit: number,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ limit: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ limit: number }>("automation.limit.set", { limit }, 15000);
}

export async function fetchAutomationRuns(
  id: number,
  limit = 50,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<DaemonAutomationRun[]> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<DaemonAutomationRun[]>("automation.runs", { id, limit }, 15000);
}

// ---- 单元历史（unit.history）---------------------------------------------------

/** 单元历史条目：自动化 / 待办 / 手动派发终端 / 会话统一时间轴（见后端 unit.history 注释） */
export interface UnitHistoryEntry {
  readonly key: string;
  readonly kind: "automation" | "backlog" | "manual" | "session";
  readonly unitId?: string;
  readonly unitName?: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly runtimeId: string;
  /** 执行方式（terminal=TUI / chat=对话页前台 / headless=纯后台） */
  readonly launchMode: "terminal" | "chat" | "headless";
  readonly status: string;
  readonly trigger: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly detail: string | null;
  /** headless 会话 id（可查 session.messages 下钻对话）；TUI 运行为 null */
  readonly sessionId: string | null;
  /** 执行器原生会话引用（cli_ref）—— TUI 恢复按各家 resume 口径用它 */
  readonly resumeRef: string | null;
  /** 终端运行 id（用于检索终端纯文本日志/transcript） */
  readonly terminalId?: string | null;
  /** 对话分叉血缘（ADR 0013）：分支徽标与版本家族折叠（P2 按 forkOf+forkAtSeq 分组）用 */
  readonly forkOf?: string | null;
  readonly forkAtSeq?: number | null;
  readonly forkKind?: "branch" | "revision" | null;
  /** 会话来源（workbench/feishu/mobile/automation…，仅 session 类行带）：来源标签用 */
  readonly source?: string | null;
}

export async function fetchUnitHistory(
  unitId?: string,
  limit = 100,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<UnitHistoryEntry[]> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<{ entries: UnitHistoryEntry[] }>(
    "unit.history",
    unitId ? { unitId, limit } : { limit },
    25000,
  );
  return r.entries;
}

/** 会话消息（host 活会话优先，历史会话由 daemon 从 store 兜底读） */
export async function fetchSessionMessages(
  sessionId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<Array<{ at: number; role: string; text: string }>> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<Array<{ at: number; role: string; text: string }>>("session.messages", { sessionId }, 15000);
}

/**
 * daemon 全量会话台账（跨执行器，ADR 0012 谱系查询用）。
 * 带 conversationId（谱系归属）与 live/resumable（readiness 事实）。
 * 与 DaemonRuntimeAdapter.listSessions 的区别：那边按单执行器过滤且翻译 runtimeId，
 * 这里是原始形状 —— 谱系匹配要跨执行器，过滤在调用方做。
 */
export interface DaemonSessionRow {
  readonly id: string;
  readonly unitId: string;
  readonly runtimeId: string;
  readonly conversationId?: string | null;
  /** 对话分叉血缘（ADR 0013）：树路径回溯与版本家族折叠用 */
  readonly forkOf?: string | null;
  readonly forkAtSeq?: number | null;
  readonly forkKind?: "branch" | "revision" | null;
  readonly status: string;
  readonly startedAt: number;
  readonly title?: string;
  readonly live?: boolean;
  readonly resumable?: boolean;
}

export async function fetchSessions(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<readonly DaemonSessionRow[]> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<readonly DaemonSessionRow[]>("session.list", null, 15000);
}

/** 删除一条会话台账（行 + 消息，不可恢复；运行中的会话会被 daemon 拒绝） */
export async function forgetSession(
  sessionId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<void> {
  const client = DaemonClient.get(endpoint);
  await client.rpc<{ forgotten: string }>("session.forget", { sessionId }, 15000);
}

/** 会话分享包（docs/26）：daemon session.export 组装的全量执行历史（结构只透传，导入时 daemon 再校验） */
export type SharedSessionBundle = Record<string, unknown>;

/** 导出一条会话为分享 bundle（台账行 + messages + RuntimeEvent 流；长会话，超时放宽） */
export async function exportSession(
  sessionId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<SharedSessionBundle> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<SharedSessionBundle>("session.export", { sessionId }, 60000);
}

/** 分享文件导入结果：已导入 / 幂等跳过（同 originId 已存在） */
export interface ImportSharedOutcome {
  readonly imported: boolean;
  readonly sessionId?: string;
  readonly reason?: "exists";
  readonly messages: number;
  readonly events: number;
}

/** 导入分享 bundle 到指定 bot（unitId）。bundle 由前端读文件得到，daemon 侧校验形状与版本 */
export async function importSessionFile(
  bundle: unknown,
  unitId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<ImportSharedOutcome> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<ImportSharedOutcome>("session.importFile", { bundle, unitId }, 60000);
}

/** 读取终端会话的输出文本快照（ANSI 过滤后的纯文本日志） */
export async function fetchTerminalTranscript(
  terminalId: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<string | null> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<{ terminalId: string; text: string | null }>(
    "terminal.transcript",
    { terminalId },
    15000,
  );
  return r.text;
}

/** 原生会话摘要（docs/13 Phase 1 会话事实源层：直接读各 CLI 自己的存储） */
export interface NativeSessionSummary {
  readonly executorId: string;
  readonly sessionId: string;
  readonly rootPath: string | null;
  readonly title: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  /** 来源标识（文件路径 / db 表），提示用 */
  readonly source?: string;
}

/** 原生会话转录条目 */
export interface NativeTranscriptEntry {
  readonly kind: "user" | "assistant" | "tool" | "thinking" | "system" | "compaction";
  readonly text: string;
  readonly toolName?: string;
  readonly at?: number;
}

export interface NativeSessionDetail extends NativeSessionSummary {
  readonly transcript: readonly NativeTranscriptEntry[];
}

/** 列出各 CLI 的原生会话（TUI 里聊的也在）；unitId 提供时按该 bot 的 rootPath 过滤 */
export async function fetchNativeSessions(
  unitId: string | null,
  limit = 50,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<readonly NativeSessionSummary[]> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<{ sessions: readonly NativeSessionSummary[] }>(
    "history.native.list",
    { unitId: unitId ?? undefined, limit },
    20000,
  );
  return r.sessions;
}

/** 单条原生会话的富转录下钻。tail：只取最近 N 条（长会话截尾，防大 payload + 全量渲染卡顿） */
export async function fetchNativeSessionDetail(
  executorId: string,
  sessionId: string,
  tail?: number,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<NativeSessionDetail> {
  const client = DaemonClient.get(endpoint);
  const r = await client.rpc<{ detail: NativeSessionDetail }>(
    "history.native.detail",
    { executorId, sessionId, ...(tail !== undefined ? { tail } : {}) },
    20000,
  );
  return r.detail;
}

// ---- 外部会话导入 -------------------------------------------------------------

/** 可导入的外部会话行：原生会话 + 工作台认识状态（known = 已在历史中，不重复导） */
export interface ImportableNativeSession extends NativeSessionSummary {
  /** 已在历史中（作为会话行或 TUI 运行记录被认识） */
  readonly known: boolean;
}

/** 按 bot 工作区（+可选执行器）列出外部终端里跑过的 CLI 会话 */
export async function fetchImportableSessions(
  unitId: string,
  runtimeId: string | null,
  limit = 60,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ rootPath: string | null; sessions: readonly ImportableNativeSession[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ rootPath: string | null; sessions: readonly ImportableNativeSession[] }>(
    "history.import.list",
    { unitId, runtimeId: runtimeId ?? undefined, limit },
    20000,
  );
}

/** 历史行重命名（显示名覆盖层，daemon kv 落盘；title 传空 = 恢复原名） */
export async function renameHistoryEntry(
  key: string,
  title: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<void> {
  const client = DaemonClient.get(endpoint);
  await client.rpc<{ key: string; title: string }>("history.rename", { key, title }, 15000);
}

/** 把选中的外部会话导入工作台历史（daemon 落 sessions 表，source = "imported"）；keys = 导入行的 entry key（自动置顶用） */
export async function importNativeSessions(
  unitId: string,
  runtimeId: string,
  sessions: readonly { sessionId: string; title: string; startedAt: number; updatedAt: number }[],
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ imported: number; skipped: number; keys: string[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ imported: number; skipped: number; keys: string[] }>(
    "history.import.apply",
    { unitId, runtimeId, sessions },
    30000,
  );
}

/**
 * 手动派发终端：经派发系统打开前台 TUI（登记运行记录 → 进该 bot 的历史，
 * 终端标签带「派发」徽章；与终端面板手动开的裸 TUI 相区别）。不带 prompt。
 * args 透传给 CLI（历史会话恢复用，如 zcode 的 --resume <sessionId>）。
 */
export async function dispatchTerminal(
  input: { unitId: string; unitName: string; rootPath: string; runtimeId: string; args?: string[]; resumeRef?: string | null },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ terminalId: string; runId: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ terminalId: string; runId: number }>("terminal.dispatch", input, 15000);
}

/** 立即运行：手动触发一次（不消耗定时次数口径） */
export async function runAutomationNow(
  id: number,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ runId: number; sessionId: string }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ runId: number; sessionId: string }>("automation.runNow", { id }, 30000);
}

// ---------------------------------------------------------------------------
// 待办 / GTD（backlog）—— 清单 CRUD / 确认门 / 验收 / 心跳配置 / 余量。
// daemon 返回的形态与 core/backlog.ts 一致（engine.toItem 直出），直接透传。
// ---------------------------------------------------------------------------

export interface BacklogListResult {
  readonly items: readonly BacklogItem[];
  readonly proposal: BacklogProposal | null;
  readonly state: BacklogStateSnapshot;
  readonly config: BacklogConfig;
  readonly quotas: readonly QuotaHeadroom[];
}

export interface BacklogWriteInput {
  readonly title?: string;
  readonly goal?: string;
  readonly prompt?: string;
  readonly unitId?: string;
  readonly unitName?: string;
  readonly rootPath?: string;
  readonly runtimeId?: string;
  readonly model?: string | null;
  readonly mode?: string | null;
  readonly size?: string | null;
  /** 执行方式：terminal（TUI）/ chat（对话页前台）/ headless（纯后台）。缺省 = terminal */
  readonly launchMode?: "terminal" | "chat" | "headless";
}

export async function fetchBacklog(endpoint: string = defaultDaemonEndpoint()): Promise<BacklogListResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<BacklogListResult>("backlog.list", null, 20000);
}

export async function createBacklogItem(
  input: BacklogWriteInput,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ id: number; item: BacklogItem | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ id: number; item: BacklogItem | null }>("backlog.create", input, 15000);
}

export async function updateBacklogItem(
  id: number,
  patch: BacklogWriteInput,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ item: BacklogItem | null }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ item: BacklogItem | null }>("backlog.update", { id, ...patch }, 15000);
}

export async function deleteBacklogItem(id: number, endpoint: string = defaultDaemonEndpoint()): Promise<{ deleted: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ deleted: boolean }>("backlog.delete", { id }, 15000);
}

export async function reorderBacklog(ids: readonly number[], endpoint: string = defaultDaemonEndpoint()): Promise<{ reordered: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ reordered: number }>("backlog.reorder", { ids }, 15000);
}

export async function wakeBacklogItem(id: number, endpoint: string = defaultDaemonEndpoint()): Promise<{ ok: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean }>("backlog.wake", { id }, 15000);
}

export async function sleepBacklogItem(id: number, endpoint: string = defaultDaemonEndpoint()): Promise<{ ok: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean }>("backlog.sleep", { id }, 15000);
}

/** 确认门：确认当前提议（执行器可改选，选择记忆回待办） */
export async function confirmBacklogProposal(
  params: { runtimeId?: string; model?: string | null },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ runId: number; sessionId: string }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ runId: number; sessionId: string }>("backlog.proposal.confirm", params, 30000);
}

export async function rejectBacklogProposal(endpoint: string = defaultDaemonEndpoint()): Promise<{ ok: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean }>("backlog.proposal.reject", null, 15000);
}

/** 验收：pass=true 关闭；打回 = 回就绪重新排队（可附一句话备注） */
export async function reviewBacklogItem(
  params: { id: number; pass: boolean; note?: string },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ ok: boolean }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean }>("backlog.review", params, 15000);
}

/** 清单上的「立即执行」——按钮即确认动作（与自动化 runNow 同口径） */
export async function runBacklogNow(
  params: { id: number; runtimeId?: string; model?: string | null },
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ runId: number; sessionId: string }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ runId: number; sessionId: string }>("backlog.runNow", params, 30000);
}

export async function getBacklogConfigRpc(endpoint: string = defaultDaemonEndpoint()): Promise<BacklogConfig> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<BacklogConfig>("backlog.config.get", null, 15000);
}

export async function setBacklogConfigRpc(
  patch: Record<string, unknown>,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ config: BacklogConfig }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ config: BacklogConfig }>("backlog.config.set", { patch }, 15000);
}

export async function fetchBacklogQuotas(
  refresh = false,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ quotas: readonly QuotaHeadroom[] }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ quotas: readonly QuotaHeadroom[] }>("backlog.quotas", { refresh }, refresh ? 45000 : 15000);
}

export async function setForceBusy(on: boolean, endpoint: string = defaultDaemonEndpoint()): Promise<{ ok: boolean; snapshot: BacklogStateSnapshot }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ ok: boolean; snapshot: BacklogStateSnapshot }>("backlog.state.forceBusy", { on }, 15000);
}

export async function forceHeartbeat(endpoint: string = defaultDaemonEndpoint()): Promise<void> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<void>("backlog.heartbeat.force", null, 30000);
}

export async function runBacklogConsolidate(
  force = true,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<{ scanned: number; created: number; duplicates: number; skipped: number }> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<{ scanned: number; created: number; duplicates: number; skipped: number }>(
    "backlog.consolidate.run",
    { force },
    45000,
  );
}

// ---- 远程控制与多渠道网关 RPC ----------------------------------------------

export interface NetworkInterfaceInfo {
  readonly name: string;
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
  readonly type: "lan" | "tailscale" | "virtual" | "loopback" | "unknown";
  readonly priority: number;
}

export async function fetchNetworkInterfaces(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<readonly NetworkInterfaceInfo[]> {
  try {
    const res = await fetch(`${httpUrlOf(endpoint)}/api/network/interfaces`);
    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; interfaces: NetworkInterfaceInfo[] };
      return data.interfaces ?? [];
    }
  } catch (err) {
    console.warn("[client] fetchNetworkInterfaces failed:", err);
  }
  const client = DaemonClient.get(endpoint);
  const result = await client.rpc<{ interfaces: NetworkInterfaceInfo[] }>("network.interfaces", null, 10000);
  return result.interfaces ?? [];
}

export interface GatewayStatus {
  readonly kind: string;
  readonly running: boolean;
  readonly accounts: number;
  readonly details?: Record<string, unknown>;
}

export type ChannelStatusResult = ChannelStatus;
export const getChannelStatusRpc = fetchChannelStatus;

export interface WeixinQrCodeResult {
  readonly qrCode: string;
  readonly qrUrl: string;
}

export async function beginWeixinQrLogin(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<WeixinQrCodeResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<WeixinQrCodeResult>("channel.weixin.qr.begin", null, 15000);
}

export interface WeixinLoginPollResult {
  readonly status: "wait_scan" | "scanned" | "success" | "expired" | "canceled";
  readonly botToken?: string;
  readonly botId?: string;
  readonly message?: string;
}

export async function pollWeixinQrLogin(
  qrCode: string,
  botId?: string,
  endpoint: string = defaultDaemonEndpoint(),
): Promise<WeixinLoginPollResult> {
  const client = DaemonClient.get(endpoint);
  return client.rpc<WeixinLoginPollResult>("channel.weixin.qr.poll", { qrCode, botId }, 15000);
}

export type TunnelStatus = "stopped" | "starting" | "running" | "error";
export type TunnelProvider = "cloudflared" | "custom";

export interface TunnelState {
  readonly status: TunnelStatus;
  readonly provider: TunnelProvider;
  readonly url: string | null;
  readonly error: string | null;
  readonly cloudflaredAvailable: boolean;
  readonly customUrl: string | null;
}

export async function fetchTunnelState(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<TunnelState> {
  try {
    const res = await fetch(`${httpUrlOf(endpoint)}/api/tunnel/status`);
    if (res.ok) {
      return (await res.json()) as TunnelState;
    }
  } catch (err) {
    console.warn("[client] fetchTunnelState HTTP fallback:", err);
  }
  const client = DaemonClient.get(endpoint);
  return client.rpc<TunnelState>("tunnel.status", null, 10000);
}

export async function startTunnel(
  params: { provider?: TunnelProvider; customUrl?: string } = {},
  endpoint: string = defaultDaemonEndpoint(),
): Promise<TunnelState> {
  try {
    const res = await fetch(`${httpUrlOf(endpoint)}/api/tunnel/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      return (await res.json()) as TunnelState;
    }
  } catch (err) {
    console.warn("[client] startTunnel HTTP fallback:", err);
  }
  const client = DaemonClient.get(endpoint);
  return client.rpc<TunnelState>("tunnel.start", params, 20000);
}

export async function stopTunnel(
  endpoint: string = defaultDaemonEndpoint(),
): Promise<TunnelState> {
  try {
    const res = await fetch(`${httpUrlOf(endpoint)}/api/tunnel/stop`, {
      method: "POST",
    });
    if (res.ok) {
      return (await res.json()) as TunnelState;
    }
  } catch (err) {
    console.warn("[client] stopTunnel HTTP fallback:", err);
  }
  const client = DaemonClient.get(endpoint);
  return client.rpc<TunnelState>("tunnel.stop", null, 10000);
}



