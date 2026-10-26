/**
 * daemon 传输适配器 —— RuntimeAdapter SPI 的 daemon 实现。
 *
 * 替换 mock 的方式兑现了 mock 头注释的承诺：换的是 adapters/ 目录，
 * core/ 与 ui/ 一行不改。每个 daemon 执行器（zcode / codex / mockperm…）
 * 注册一个 `daemon:<id>` 运行时，全部共享一条到 daemon 的 WS。
 *
 * 事件分发语义对齐 mock 的「缓冲 + 单槽」：daemon 会广播所有会话的事件，
 * 这里按「本实例创建/续接的会话」过滤后进同一队列 —— store 的每个 run()
 * 挂一个消费者，多消费者从同一队列取（每个事件恰好被时间线收一次）。
 */

import type {
  AdapterFactory,
  ConnectionState,
  PermissionDecision,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SendMessageRequest,
  StartSessionRequest,
} from "../../core/adapter.ts";
import type { RuntimeEvent } from "../../core/events.ts";
import { asModelId, type ModelId } from "../../core/models.ts";
import type { ChatAttachment } from "../../core/attachments.ts";
import {
  asRuntimeId,
  asSessionId,
  type RuntimeId,
  type Session,
  type SessionId,
  type WorkUnit,
} from "../../core/units.ts";
import { DaemonClient, type DaemonExecutorInfo } from "./client.ts";

/** 附件全带本地路径才交给 daemon 内联（docs/21 P4a）——与 store run() 的本地内联谓词一致 */
function hasPathedAttachments(atts: readonly ChatAttachment[] | undefined): boolean {
  return atts !== undefined && atts.length > 0 && atts.every((a) => typeof a.localPath === "string" && a.localPath !== "");
}

function attachmentPaths(atts: readonly ChatAttachment[] | undefined): string[] {
  return (atts ?? [])
    .map((a) => a.localPath)
    .filter((p): p is string => typeof p === "string" && p !== "");
}

const ACCENTS = ["#7C6CF5", "#10A37F", "#4D6BFE", "#D97757", "#0EA5E9", "#F59E0B"];

function accentFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length] ?? "#7C6CF5";
}

export function createDaemonFactory(info: DaemonExecutorInfo, endpoint: string): AdapterFactory {
  const runtimeId = asRuntimeId(`daemon:${info.id}`);
  const client = DaemonClient.get(endpoint);
  return {
    id: runtimeId,
    presentation: {
      displayName: info.displayName,
      vendor: "daemon",
      accent: accentFor(`daemon:${info.id}`),
      glyph: info.glyph,
      tagline: "本地 Runtime Host 守护进程 · 真实执行",
    },
    transport: {
      kind: "http" as const,
      endpoint: `${endpoint} (ws)`,
      requiresCwd: true,
    },
    capabilities: info.capabilities,
    models: info.models.map((m) => asModelId(m.id)),
    rawModels: info.models.map((m) => ({
      id: asModelId(m.id),
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      reasoningLevels: m.reasoningLevels,
      defaultReasoningLevel: m.defaultReasoningLevel,
      contextLengths: m.contextLengths,
      defaultContextLength: m.defaultContextLength,
      multimodal: m.multimodal,
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
    })),
    testOnly: info.testOnly,
    // 兜底标记必须跟着 rawModels 一起冻结进工厂：注册那一刻拿到的快照
    // 若来自 daemon 的 models-cache.json，不标出来界面就会把它当成刚探到的。
    ...(info.modelsCachedAt === undefined ? {} : { modelsCachedAt: info.modelsCachedAt }),
    create: async () => new DaemonRuntimeAdapter(runtimeId, info, client),
  };
}

class DaemonRuntimeAdapter implements RuntimeAdapter {
  readonly id: RuntimeId;
  readonly presentation;
  readonly transport;
  readonly capabilities;

  readonly #client: DaemonClient;
  readonly #executorId: string;
  /** 本实例创建/续接过的会话 —— 事件过滤的边界（别人的会话不进我的队列） */
  readonly #sessions = new Set<string>();
  /** 每会话已见最大 seq（WP-2 去重游标）：重放与补拉重叠的判据 */
  readonly #lastSeq = new Map<string, number>();
  // mock 同款「缓冲 + 单槽」：运行时不因 UI 未调 next() 丢事件
  readonly #pending: RuntimeEvent[] = [];
  #waiting: ((e: RuntimeEvent) => void) | null = null;
  #pumpInstalled = false;
  /**
   * startSession 在途缓冲：session.started 在 create RPC 返回**之前**广播，
   * 此刻会话 id 还没进 #sessions —— 不过缓冲就会把首个事件丢掉（探针实证）。
   * 只缓冲「未进 #sessions」的事件（评审 P2）：已知会话照常投递。
   *
   * ⚠ 缓冲是**共享**的、按 sessionId 各自认领，不能用「单槽 + 谁结束谁清空」：
   * 两个 startSession 并发时，后发起的那次会把前一次的缓冲清掉，而先结束的那次
   * 又把缓冲置空 —— 另一次会话的 started/首批 delta 就永久丢了（时间线从半途开始）。
   */
  #inflight: RuntimeEvent[] = [];
  /** 在途 startSession 计数：>0 时才需要缓冲未知会话的事件 */
  #pendingStarts = 0;

  constructor(id: RuntimeId, info: DaemonExecutorInfo, client: DaemonClient) {
    this.id = id;
    this.presentation = {
      displayName: info.displayName,
      vendor: "daemon",
      accent: accentFor(id),
      glyph: info.glyph,
      tagline: "本地 Runtime Host 守护进程 · 真实执行",
    };
    this.transport = {
      kind: "http" as const,
      endpoint: `${client.endpoint} (ws)`,
      requiresCwd: true,
    };
    this.capabilities = info.capabilities;
    this.#executorId = info.id;
    this.#client = client;
    this.#installPump();
  }

  #installPump(): void {
    if (this.#pumpInstalled) return;
    this.#pumpInstalled = true;
    this.#client.onEvent((event, seq) => {
      // git.changed 是仓库级事件（无 sessionId，docs/16）：会话泵不处理，
      // 消费方（useGit 的自动刷新安装器）直接订阅 DaemonClient。
      // session.foreground 同理（docs/23）：它带 sessionId 但用的是全局广播序号，
      // 不是会话账本 seq —— 进判重会污染 #lastSeq（假游标挡掉真账本帧，时间线丢事件），
      // 消费方（sessionForeground 安装器）也直接订阅 DaemonClient
      if (event.type === "git.changed" || event.type === "session.foreground") return;
      // WP-2 按 seq 判重：daemon 广播全量事件，重放/补拉的重叠在此挡住。
      // 补拉进行中的会话（评审 P1）帧进 stash——若照常推进游标，补拉响应会被整体判重丢洞
      if (seq !== undefined) {
        if (this.#resyncing.has(event.sessionId)) {
          this.#stash.get(event.sessionId)?.push({ seq, event });
          return;
        }
        const prev = this.#lastSeq.get(event.sessionId) ?? 0;
        if (seq <= prev) return;
        this.#lastSeq.set(event.sessionId, seq);
      }
      // 评审 P2：在途缓冲只收「还没进 #sessions」的会话（startSession 竞态窗口），
      // 已知会话照常走判重+投递——此前不分青红皂白全缓冲，并发 startSession 互相踩
      if (this.#pendingStarts > 0 && !this.#sessions.has(event.sessionId)) {
        this.#inflight.push(event);
        return;
      }
      if (!this.#sessions.has(event.sessionId)) return;
      this.#admit(event);
    });
    // 断线重连（非首连、未换代）→ 按会话游标增量补拉（WP-2）
    this.#client.onResync(() => {
      void this.#resync(false);
    });
    // daemon 换代（评审 P1）：seq 空间重置——清游标，对新代际做全量重拉
    this.#client.onGenerationChange(() => {
      this.#lastSeq.clear();
      void this.#resync(true);
    });
  }

  /** 补拉进行中的会话：实时帧暂存不投递，响应到达后按 seq 全序合并（防洞与乱序） */
  readonly #resyncing = new Set<string>();
  readonly #stash = new Map<string, Array<{ seq: number; event: RuntimeEvent }>>();

  /** 对跟踪中的会话逐个 since 补拉；reset=true 用于 daemon 换代（游标已清，全量重拉） */
  async #resync(reset: boolean): Promise<void> {
    for (const sessionId of this.#sessions) {
      // 换代（reset=true）时游标已清空，after=0 就是「从头发」——这里**不能**
      // 把 0 当「还没游标，跳过」。以前 `after <= 0 → continue` 让换代全量重拉
      // 变成空转：断线期间产生的事件永久缺失，in-flight 那轮看起来被截断。
      const cursor = reset ? 0 : this.#lastSeq.get(sessionId);
      if (cursor === undefined || cursor < 0) continue;
      const after = cursor;
      this.#resyncing.add(sessionId);
      this.#stash.set(sessionId, []);
      try {
        const items = await this.#client.rpc<Array<{ seq: number; event: RuntimeEvent }>>(
          "session.events.since",
          { sessionId, afterSeq: after },
          15000,
        );
        // 补拉响应与补拉期间到达的实时帧按 seq 全序合并去重，再统一投递
        const merged = [...(items ?? []), ...(this.#stash.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
        for (const item of merged) {
          const prev = this.#lastSeq.get(sessionId) ?? 0;
          if (item.seq <= prev) continue;
          this.#lastSeq.set(sessionId, item.seq);
          this.#admit(item.event);
        }
      } catch {
        // 补拉失败：保持游标，等下一条实时事件推进
      } finally {
        // 合并后才撤 stash：撤之前到达的尾部帧在此兜底排空（残余按游标判重）
        const late = this.#stash.get(sessionId) ?? [];
        this.#resyncing.delete(sessionId);
        this.#stash.delete(sessionId);
        for (const item of late) {
          const prev = this.#lastSeq.get(sessionId) ?? 0;
          if (item.seq <= prev) continue;
          this.#lastSeq.set(sessionId, item.seq);
          this.#admit(item.event);
        }
      }
    }
  }

  /** 缓冲 + 单槽投递：有人在等就直接交给他；没人等就进缓冲，绝不丢 */
  #admit(event: RuntimeEvent): void {
    const w = this.#waiting;
    if (w) {
      this.#waiting = null;
      w(event);
    } else {
      this.#pending.push(event);
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const r = await this.#client.rpc<ProbeResult>("adapter.probe", { runtimeId: this.#executorId }, 30000);
      return r;
    } catch (err: unknown) {
      const state: ConnectionState = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return { state, elapsedMs: 0 };
    }
  }

  async connect(): Promise<void> {
    await this.#client.ensureConnected();
  }

  async disconnect(): Promise<void> {}  async listSessions(_unit: WorkUnit): Promise<readonly Session[]> {
    const all = await this.#client.rpc<Session[]>("session.list", null, 15000);
    // 翻译放适配器边界（同 startSession/resumeSession 的约定，review P1）：
    // 裸执行器 id 落进前端 sessions[] 会让续聊判定永远不匹配 + 时间线 divider
    // 认不出执行器显示名
    return all.filter((s) => s.runtimeId === this.#executorId).map((s) => ({ ...s, runtimeId: this.id }));
  }

  async startSession(req: StartSessionRequest): Promise<Session> {
    // create 期间广播的 started/delta 先进共享缓冲，拿到 id 后按 sessionId 认领自己的那几条
    this.#pendingStarts++;
    try {
      const session = await this.#client.rpc<Session>(
        "session.start",
        {
          runtimeId: this.#executorId,
          unitId: req.unit.id,
          unitName: req.unit.name,
          rootPath: req.unit.rootPath,
          prompt: req.prompt,
          model: req.model,
          mode: req.loop?.mode ?? "build",
          reasoningLevel: req.loop?.reasoningLevel,
          contextLength: req.loop?.contextLength,
          // 源代码管理面板「在此工作树启动会话」：daemon 侧 ensure 后以工作树为 cwd
          ...(req.worktree !== undefined ? { worktree: req.worktree } : {}),
          // ADR 0012：谱系关联 —— 切换执行器开新段时延续同一对话线
          ...(req.conversationId !== undefined ? { conversationId: req.conversationId } : {}),
          // ADR 0012：只读转录交接（opt-in）
          ...(req.handoff !== undefined ? { handoff: { fromSessionId: req.handoff.fromSessionId } } : {}),
          // ADR 0013：对话分叉 —— 锚点轮边界开新段（HANDOFF 上界由 daemon 解析）
          ...(req.fork !== undefined ? { fork: req.fork } : {}),
          memoryOptions: req.memoryOptions,
          ...(req.contextManifestOverride !== undefined ? { contextManifestOverride: req.contextManifestOverride } : {}),
          // 附件内联上移（docs/21 P4a）：全部附件都带本地路径时把内联交给 daemon
          //（GUI 与 CLI 同一条组装路径）；混有浏览器附件（无路径）时不传——
          // run() 那侧已本地内联进 prompt，这里再传会造成双份。
          ...(hasPathedAttachments(req.attachments) ? { attachments: attachmentPaths(req.attachments) } : {}),
        },
        60000,
      );
      this.#sessions.add(session.id);
      // 认领自己的事件，并把它们从缓冲里摘掉（并发的另一次 startSession 不受影响）。
      // 泵已挡掉无 sessionId 的仓库级事件（git.changed），这里 `"sessionId" in e`
      // 只是让类型面也这么说
      const mine = this.#inflight.filter((e) => "sessionId" in e && e.sessionId === session.id);
      this.#inflight = this.#inflight.filter((e) => !("sessionId" in e) || e.sessionId !== session.id);
      for (const e of mine) this.#admit(e);
      // ⚠ daemon 返回的会话带的是**裸执行器 id**（host 侧 `runtimeId: adapter.id`，
      // 实测 "codex"），而前端注册表里的键是带命名空间的 `daemon:codex`。
      // 这里必须翻译一次：调用方（store 的续聊判定与 resolvePermission）拿
      // session.runtimeId 去比 / 去 getOrCreate，裸 id 会永远不相等 + 抛
      // 「未注册的运行时」。翻译放在适配器边界，因为只有这里同时知道两个 id。
      return { ...session, runtimeId: this.id };
    } finally {
      // 最后一次在途结束：没人能再认领了，清空避免无界增长
      this.#pendingStarts--;
      if (this.#pendingStarts === 0) this.#inflight = [];
    }
  }

  async resumeSession(sessionId: SessionId): Promise<Session> {
    const session = await this.#client.rpc<Session>("session.resume", { sessionId }, 30000);
    this.#sessions.add(session.id);
    // 同 startSession：裸 id → 注册表 id
    return { ...session, runtimeId: this.id };
  }

  /** 账本回放（ADR 0012）：热环 + 落盘账本，重建聊天页时间线用 */
  async eventsSince(sessionId: SessionId): Promise<readonly { seq: number; at: number; event: RuntimeEvent }[]> {
    this.#sessions.add(String(sessionId));
    const rows = await this.#client.rpc<Array<{ seq: number; at: number; event: RuntimeEvent }>>(
      "session.events.since",
      { sessionId, afterSeq: 0 },
      30000,
    );
    // 回放终点即游标（review P2）：openSession 的回放不经泵，泵内该会话游标
    // 还是 undefined —— 不推进的话，回放后~重连前的实时帧会被 resync 整体跳过
    const maxSeq = (rows ?? []).reduce((m, r) => Math.max(m, r.seq), 0);
    if (maxSeq > 0) this.#lastSeq.set(String(sessionId), Math.max(this.#lastSeq.get(String(sessionId)) ?? 0, maxSeq));
    return rows ?? [];
  }

  async sendMessage(req: SendMessageRequest): Promise<void> {
    this.#sessions.add(req.sessionId);
    await this.#client.rpc("session.send", {
      sessionId: req.sessionId,
      text: req.text,
      mode: req.loop?.mode,
      reasoningLevel: req.loop?.reasoningLevel,
      contextLength: req.loop?.contextLength,
      ...(req.contextInject !== undefined ? { contextInject: req.contextInject } : {}),
      // 同 startSession：全路径附件交给 daemon 内联（docs/21 P4a）
      ...(hasPathedAttachments(req.attachments) ? { attachments: attachmentPaths(req.attachments) } : {}),
    });
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await this.#client.rpc("session.cancel", { sessionId });
  }

  // ---- steer 待发送队列管理（host.pendingSends 的操作面）----
  async removeQueuedSend(sessionId: SessionId, id: string): Promise<void> {
    await this.#client.rpc("session.queue.remove", { sessionId, id }, 15000);
  }

  async sendQueuedNow(sessionId: SessionId, id: string): Promise<void> {
    // 取消当前轮要等 CLI 响应，给足余量
    await this.#client.rpc("session.queue.sendNow", { sessionId, id }, 30000);
  }

  async resumeQueuedSends(sessionId: SessionId): Promise<void> {
    await this.#client.rpc("session.queue.resume", { sessionId }, 15000);
  }

  async resolvePermission(sessionId: SessionId, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.#client.rpc("permission.resolve", { sessionId, requestId, decision });
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    while (true) {
      const next =
        this.#pending.length > 0
          ? this.#pending.shift()!
          : await new Promise<RuntimeEvent>((resolve) => {
              this.#waiting = resolve;
            });
      yield next;
    }
  }

  async exportTrace(sessionId: SessionId): Promise<string> {
    return this.#client.rpc<string>("session.trace", { sessionId }, 15000);
  }
}

/** 便捷：把 ModelId 字符串归一（daemon 的模型 id 即目录 id，直通） */
export function daemonModelId(v: string): ModelId {
  return asModelId(v);
}
