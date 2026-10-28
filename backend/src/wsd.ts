/**
 * WS 面 —— 事件流出 + 方法调用的唯一通道，帧形态见 docs/07-wire-protocol.md（v1）。
 *
 *   client → daemon : { v:1, id:string, method:string, params?:unknown }
 *   daemon → client : { v:1, id:string, ok:true, result }        （对 request 的响应）
 *                   | { v:1, id:string, ok:false, error:{code,message} }
 *                   | { v:1, type:"hello", daemon:{…} }          （连上即推）
 *                   | { v:1, type:"event", event:RuntimeEvent }  （Phase 1 起的数据流）
 *
 * id 解析不出来的帧回 id:null 的错误帧，这是唯一允许 null id 的场景。
 */

import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeEvent } from "./contract.ts";
import type { DaemonConfig } from "./config.ts";
import { log } from "./log.ts";

export const WIRE_VERSION = 1 as const;

// ---- daemon → client ------------------------------------------------------

export interface HelloFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "hello";
  readonly daemon: {
    readonly version: string;
    readonly pid: number;
    readonly uptimeMs: number;
    /** 进程代际（评审 P1）：daemon 换代后 per-session seq 从 1 重新起算，客户端据此重置游标 */
    readonly generation: string;
  };
}

export interface EventFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "event";
  /** 会话内单调递增事件序号（WP-2）：断线方凭它调 session.events.since 补拉 */
  readonly seq: number;
  readonly event: RuntimeEvent;
}

/** 终端数据帧 —— 高频且非契约事件，独立于 event 流（docs/07 §二） */
export interface TerminalFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "terminal";
  readonly terminalId: string;
  readonly kind: "data" | "exit" | "created" | "title";
  readonly title?: string;
  readonly data?: string;
  readonly exitCode?: number;
  /** kind=created 的档案字段：前端推送认领开标签用 */
  readonly executor?: string;
  readonly unitId?: string;
  readonly cwd?: string;
  readonly shell?: string;
}

/**
 * 待办（GTD）信号帧 —— 与 terminal 同理独立于 event 流：RuntimeEvent 是
 * per-session 的（client 侧按 sessionId 过滤），而待办的提议/总状态是
 * daemon 级广播。signal 的类型见 prototype/src/core/backlog.ts 的 BacklogSignal。
 */
export interface BacklogFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "backlog";
  readonly signal: unknown;
}

/**
 * 清单（inbox）信号帧 —— 与 backlog 帧同理独立于 event 流：分类状态/清单变化是
 * daemon 级广播。signal 的类型见 prototype/src/core/inbox.ts 的 InboxSignal。
 */
export interface InboxFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "inbox";
  readonly signal: unknown;
}

/**
 * 通知帧（docs/21 P4b）—— daemon 聚合的通知事实推流，行形状见
 * notifications.ts 的 NotificationRow；历史以 notifications.list 拉取为准。
 */
export interface NotificationFrame {
  readonly v: typeof WIRE_VERSION;
  readonly type: "notifications";
  readonly row: unknown;
}

export type ResponseFrame =
  | { readonly v: typeof WIRE_VERSION; readonly id: string | null; readonly ok: true; readonly result: unknown }
  | {
      readonly v: typeof WIRE_VERSION;
      readonly id: string | null;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly data?: unknown };
    };

// ---- daemon ← client ------------------------------------------------------

export interface RequestFrame {
  readonly v: typeof WIRE_VERSION;
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

// ---- 方法注册表 -----------------------------------------------------------

type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

/** 方法元数据（docs/21 D6）：rpc.methods / aw methods / docs/07 §四生成表的共同口径 */
export interface MethodMeta {
  /** 一句话中文说明（会进 markdown 表格，禁用 `|` 字符） */
  readonly description: string;
  /** params 形状提示，如 `{rootPath}` / `{runtimeId?}` / `null` */
  readonly paramsHint?: string;
  /** 真危险面标注：CLI 交互确认提示用（--yes 跳过），不构成 agent 拦截 */
  readonly danger?: "high";
}

interface RegisteredMethod {
  handler: RpcHandler;
  meta?: MethodMeta;
}

const methods = new Map<string, RegisteredMethod>();

/** 注册一个 client 可调用的方法。同名注册是编程错误，直接掀桌。 */
export function registerMethod(name: string, handler: RpcHandler, meta?: MethodMeta): void {
  if (methods.has(name)) throw new Error(`rpc method already registered: ${name}`);
  methods.set(name, { handler, meta });
}

/**
 * 批量挂元数据（docs/21 D6）：集中表（methods.meta.ts）与注册点旁第三参并存。
 * 键必须已注册——未知键 = 元数据表与注册表漂移了，启动即掀桌（fail-fast）。
 */
export function applyMethodMeta(meta: Record<string, MethodMeta>): void {
  for (const [name, m] of Object.entries(meta)) {
    const entry = methods.get(name);
    if (entry === undefined) throw new Error(`method meta for unregistered method: ${name}`);
    entry.meta = m;
  }
}

export interface MethodDescriptor {
  readonly method: string;
  readonly description?: string;
  readonly paramsHint?: string;
  readonly danger?: "high";
}

/** 全量方法自描述（rpc.methods 的数据源；按名排序，域聚簇靠前缀天然成立） */
export function listMethodMeta(): MethodDescriptor[] {
  return [...methods.entries()]
    .map(([method, { meta }]) => ({ method, ...(meta ?? {}) }))
    .sort((a, b) => a.method.localeCompare(b.method));
}

// 自宿主：方法自描述（docs/21 D6）——aw methods 与 docs/07 §四生成表共用这一个入口
registerMethod("rpc.methods", () => {
  const list = listMethodMeta();
  return { count: list.length, methods: list };
});

/**
 * 统一分发器：WS 帧与 HTTP /rpc（docs/21 D2）共用同一条调用路径——信封校验之后的
 * 一切（方法查找、执行、错误整形）都在这里，两个通道不各养一套错误语义。
 */
export type RpcOutcome =
  | { readonly v: typeof WIRE_VERSION; readonly ok: true; readonly result: unknown }
  | {
      readonly v: typeof WIRE_VERSION;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly data?: unknown };
    };

export async function dispatchRpc(method: string, params: unknown): Promise<RpcOutcome> {
  const entry = methods.get(method);
  if (entry === undefined) {
    return {
      v: WIRE_VERSION,
      ok: false,
      error: { code: "unknown_method", message: `no such method: ${method}` },
    };
  }
  try {
    return { v: WIRE_VERSION, ok: true, result: (await entry.handler(params)) ?? null };
  } catch (err: unknown) {
    const extra =
      typeof err === "object" && err !== null && "data" in err && (err as { data: unknown }).data !== undefined
        ? { data: (err as { data: unknown }).data }
        : {};
    return {
      v: WIRE_VERSION,
      ok: false,
      error: {
        code: err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "internal",
        message: err instanceof Error ? err.message : String(err),
        // data：结构化补充（冲突时带 reason + 盘上现值）。没有它前端只能拿到一句
        // message 靠字符串猜「到底是 bot.json 变了还是 AGENTS.md 变了」，猜错就会
        // 告诉用户错的那个文件。跨线的是「发生了什么」，不是「怎么排版」。
        ...extra,
      },
    };
  }
}

// ---- 服务器 ---------------------------------------------------------------

export function attachWs(
  server: Server,
  opts: { config: DaemonConfig; startedAt: number; authorize?: (req: IncomingMessage, url: URL) => boolean },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // 鉴权（docs/08 WP-7）：WS 没有响应体可讲道理，upgrade 阶段直接拒绝
    if (opts.authorize !== undefined && opts.config.token !== null) {
      const provided = req.headers["x-awb-token"] ?? searchParams.get("token");
      if (typeof provided !== "string" || provided !== opts.config.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    log.info("ws client connected", { clients: clients.size });

    const hello: HelloFrame = {
      v: WIRE_VERSION,
      type: "hello",
      daemon: {
        version: opts.config.version,
        pid: process.pid,
        uptimeMs: Date.now() - opts.startedAt,
        generation: String(process.pid),
      },
    };
    ws.send(JSON.stringify(hello));

    ws.on("message", (data) => void handleRaw(ws, data));
    ws.on("close", () => {
      clients.delete(ws);
      log.info("ws client closed", { clients: clients.size });
    });
    ws.on("error", (err) => log.warn("ws client error", { error: err.message }));
  });

  return wss;
}

function send(ws: WebSocket, frame: HelloFrame | EventFrame | TerminalFrame | BacklogFrame | InboxFrame | ResponseFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** 向所有在线客户端广播一条终端帧（data 高频，无订阅者就丢弃） */
export function broadcastTerminal(wss: WebSocketServer, frame: TerminalFrame): void {
  const payload = JSON.stringify(frame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

/** 向所有在线客户端广播一条待办信号（无订阅者就丢弃，历史以 backlog.list 拉取为准） */
export function broadcastBacklog(wss: WebSocketServer, signal: unknown): void {
  const payload = JSON.stringify({ v: WIRE_VERSION, type: "backlog", signal } satisfies BacklogFrame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

/** 向所有在线客户端广播一条清单信号（无订阅者就丢弃，历史以 inbox.list 拉取为准） */
export function broadcastInbox(wss: WebSocketServer, signal: unknown): void {
  const payload = JSON.stringify({ v: WIRE_VERSION, type: "inbox", signal } satisfies InboxFrame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

/** 向所有在线客户端广播一条聚合通知（无订阅者就丢弃，历史以 notifications.list 拉取为准） */
export function broadcastNotification(wss: WebSocketServer, row: unknown): void {
  const payload = JSON.stringify({ v: WIRE_VERSION, type: "notifications", row } satisfies NotificationFrame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

async function handleRaw(ws: WebSocket, data: unknown): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    send(ws, {
      v: WIRE_VERSION,
      id: null,
      ok: false,
      error: { code: "bad_frame", message: "frame is not valid JSON" },
    });
    return;
  }

  const f = frame as Partial<RequestFrame> | null;
  if (
    f === null ||
    typeof f !== "object" ||
    f.v !== WIRE_VERSION ||
    typeof f.id !== "string" ||
    typeof f.method !== "string"
  ) {
    send(ws, {
      v: WIRE_VERSION,
      id: null,
      ok: false,
      error: { code: "bad_frame", message: `expected { v:${WIRE_VERSION}, id:string, method:string, params? }` },
    });
    return;
  }

  const id: string = f.id;
  const outcome = await dispatchRpc(f.method, f.params);
  send(
    ws,
    outcome.ok
      ? { v: WIRE_VERSION, id, ok: true, result: outcome.result }
      : { v: WIRE_VERSION, id, ok: false, error: outcome.error },
  );
}

/**
 * 向所有在线客户端广播一条 RuntimeEvent —— Phase 1 事件流的唯一出口。
 * 一个客户端都没有就丢弃：daemon 不为订阅者攒历史（历史 = 落盘的轨迹，不是内存队列）。
 * seq 供断线方补拉（session.events.since / session.trace 的 afterSeq 游标）。
 */
export function broadcastEvent(wss: WebSocketServer, event: RuntimeEvent, seq: number): void {
  const frame = JSON.stringify({ v: WIRE_VERSION, type: "event", seq, event } satisfies EventFrame);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
}
