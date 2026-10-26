/**
 * HTTP 面 —— 裸 node:http，无框架（`docs/06` §三：按最少依赖原则）。
 *
 * Phase 0 只挂 GET /healthz；后续 REST（配置与会话管理）往 ROUTES 里加，
 * 路由就是「方法 + 前缀匹配」，API 面小到不值得为它引 Fastify。
 * WS upgrade 在 wsd.ts 里借同一个 server 的 upgrade 事件。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.ts";
import { log } from "./log.ts";

export interface HealthPayload {
  readonly ok: true;
  readonly name: "agent-workbench-daemon";
  readonly version: string;
  readonly pid: number;
  readonly uptimeMs: number;
}

export function healthPayload(config: DaemonConfig, startedAt: number): HealthPayload {
  return {
    ok: true,
    name: "agent-workbench-daemon",
    version: config.version,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, allowOrigin?: string): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-awb-token",
  };
  // CORS 白名单（评审 P0）：只对本地源回显 allow-origin——此前 "*/bootstrap 回环豁免"
  // 的组合让任意网页可凭 fetch 直读本机 daemon（含 token）。非白名单源一律不带 CORS 头。
  if (allowOrigin !== undefined) headers["access-control-allow-origin"] = allowOrigin;
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * 显式扩展的受信源（逗号分隔）。桌面壳用：Electron 生产模式以自定义协议
 * app://moyubot 加载前端，页面 fetch /bootstrap 与 WS 鉴权都需要这个源进白名单。
 * 默认空 = 行为与纯本机部署完全一致。
 */
const extraAllowedOrigins: readonly string[] = (process.env.AGENT_WORKBENCH_EXTRA_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** 本地源判定（含 dev server 5280 等任意本机端口；桌面壳协议源走显式白名单） */
export function isLocalOrigin(origin: string): boolean {
  if (extraAllowedOrigins.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}

export interface HttpRouteContext {
  readonly url: URL;
  /** POST/DELETE 的 JSON body；无 body 或解析失败为 null */
  readonly body: unknown;
  /** 对端地址（/bootstrap 的回环豁免判定用，WP-7） */
  readonly remoteAddress: string | undefined;
}

export interface HttpRoute {
  readonly method: "GET" | "POST" | "DELETE";
  /** 精确路径（无通配；够用就不写路由匹配器） */
  readonly path: string;
  readonly handle: (ctx: HttpRouteContext) => unknown | Promise<unknown>;
}

/**
 * 裸路由 —— 需要自己读 body / 自己写响应的场景（流式透传、大载荷）。
 * 鉴权与 CORS 由 route() 统一处理后才进来，handler 只管业务。
 * 出图代理（/api/image/call）是当前唯一用户：JSON 框架的 1MB body 上限
 * 和 sendJson 缓冲式回包都装不下图片与 SSE 流。
 */
export interface RawHttpRoute {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly handle: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { readonly url: URL; readonly allowOrigin?: string },
  ) => void | Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { code: "too_large" });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function route(
  config: DaemonConfig,
  startedAt: number,
  routes: readonly HttpRoute[],
  req: IncomingMessage,
  res: ServerResponse,
  authorize?: (req: IncomingMessage, url: URL) => boolean,
  rawRoutes: readonly RawHttpRoute[] = [],
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  log.debug("http request", { method: req.method, path: url.pathname });
  const origin = req.headers.origin;
  const allowOrigin = typeof origin === "string" && isLocalOrigin(origin) ? origin : undefined;

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, healthPayload(config, startedAt), allowOrigin);
    return;
  }

  // 预检：带 JSON body 的跨源 POST/DELETE 需要
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, allowOrigin);
    return;
  }

  // 鉴权（docs/08 WP-7）：token 关闭时全放行；否则交给注入的 authorize（豁免面在 index 侧）
  if (authorize !== undefined && config.token !== null && !authorize(req, url)) {
    const provided = req.headers["x-awb-token"] ?? url.searchParams.get("token");
    if (typeof provided !== "string" || provided !== config.token) {
      sendJson(res, 401, { ok: false, error: { code: "unauthorized", message: "missing or bad token" } }, allowOrigin);
      return;
    }
  }

  const rawHit = rawRoutes.find((r) => r.method === req.method && r.path === url.pathname);
  if (rawHit !== undefined) {
    // 鉴权已过（上方统一拦截）；裸路由自己读 body、自己写响应（流式/大载荷）
    await rawHit.handle(req, res, { url, allowOrigin });
    return;
  }

  const hit = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (hit !== undefined) {
    const body = req.method === "GET" ? null : await readBody(req);
    const result = await hit.handle({ url, body, remoteAddress: req.socket.remoteAddress });
    sendJson(res, 200, result ?? { ok: true }, allowOrigin);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` },
  }, allowOrigin);
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export interface HttpHandle {
  readonly server: Server;
  /** 实际绑定的端口（传 0 时由系统分配，冒烟脚本用这个） */
  readonly port: number;
}

export function startHttp(
  config: DaemonConfig,
  startedAt: number,
  routes: readonly HttpRoute[] = [],
  authorize?: (req: IncomingMessage, url: URL) => boolean,
  rawRoutes: readonly RawHttpRoute[] = [],
): Promise<HttpHandle> {
  const server = createServer((req, res) => {
    void route(config, startedAt, routes, req, res, authorize, rawRoutes).catch((err: unknown) => {
      const code = err instanceof Error && "code" in err ? String(err.code) : "internal";
      log.error("http handler failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        const status =
          code === "bad_request" ? 400
          : code === "too_large" ? 413
          : code === "unauthorized" ? 401
          : code === "forbidden" ? 403
          : code === "not_found" || code === "unknown_bot" || code === "no_channel" ? 404
          : 500;
        sendJson(res, status, {
          ok: false,
          error: { code, message: err instanceof Error ? err.message : "internal error" },
        });
      } else res.destroy();
    });
  });

  // 畸形请求别掀翻 daemon
  server.on("clientError", (err, socket) => {
    log.warn("http client error", { error: err.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return new Promise((resolve, reject) => {
    let retries = 0;
    const maxRetries = process.env.NODE_ENV !== "production" ? 3 : 0;
    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries < maxRetries) {
          retries++;
          setTimeout(tryListen, 300);
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", onError);
        const addr = server.address() as AddressInfo;
        resolve({ server, port: addr.port });
      });
    };
    tryListen();
  });
}
