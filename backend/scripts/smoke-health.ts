/**
 * Phase 0 验收（docs/06 §九 冒烟基准的雏形）：
 *
 *   自起 daemon（随机空闲端口）→ GET /healthz → WS 握手收 hello
 *   → method 调用回环 → 错误帧（unknown_method / bad_frame）
 *   → SIGTERM 优雅退出 → 断言退出码 0
 *
 * 验收口径（docs/06 §六 Phase 0）：daemon 起、日志清、脚本可连。
 * 任何一步失败都以非零码退出；daemon 的日志原样透传到本脚本输出，人工过目。
 *
 * 用法：cd backend && pnpm smoke
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 冒烟家（隔离 AGENT_WORKBENCH_HOME）：daemon 全部状态住临时目录，绝不碰真实 ~/.agent-workbench */
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "aw-health-home-"));

// ---- 小工具 ---------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// ---- daemon 子进程 --------------------------------------------------------

let daemon: ChildProcess | undefined;
const daemonOutput: string[] = [];

function startDaemon(port: number): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1", AGENT_WORKBENCH_HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      daemonOutput.push(text);
      console.log(`  daemon | ${text}`);
    });
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => {
    daemon?.once("exit", (code) => resolve(code));
  });
  daemon.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    daemon.kill("SIGKILL");
    return null;
  }
  return code;
}

// ---- HTTP / WS 断言 -------------------------------------------------------

async function waitHealthy(port: number, timeoutMs = 15000): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return null; // daemon 先死了
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  return null;
}

interface WsMessage {
  [k: string]: unknown;
}

function nextMessage(ws: WebSocket, pred: (f: WsMessage) => boolean, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for ws frame"));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as WsMessage;
      if (!pred(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
  });
}

function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)));
  });
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

// ---- 主流程 ---------------------------------------------------------------

async function main(): Promise<void> {
  const port = await freePort();
  console.log(`smoke: starting daemon on 127.0.0.1:${port}`);
  startDaemon(port);

  try {
    // 1. REST: /healthz
    const health = (await waitHealthy(port)) as Record<string, unknown> | null;
    check("GET /healthz responds", health !== null, daemonOutput);
    check("health payload shape", health !== null && health["ok"] === true && typeof health["version"] === "string" && typeof health["pid"] === "number" && typeof health["uptimeMs"] === "number", health);

    // 404 也该是 JSON 而不是崩
    const miss = await fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(3000) });
    check("unknown route is JSON 404", miss.status === 404 && (await miss.json()) !== null);

    // 2. WS: 握手 hello
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`);
    const hello = await nextMessage(ws, (f) => f["type"] === "hello");
    const daemonInfo = hello["daemon"] as Record<string, unknown> | undefined;
    check("hello frame on connect", hello["v"] === 1 && typeof daemonInfo === "object" && typeof daemonInfo?.["pid"] === "number", hello);

    // 3. 方法回环
    send(ws, { v: 1, id: "smoke-1", method: "health", params: null });
    const resp = await nextMessage(ws, (f) => f["id"] === "smoke-1");
    check("method call round-trips", resp["ok"] === true && (resp["result"] as Record<string, unknown> | undefined)?.["ok"] === true, resp);

    // 3b. 编辑器清单回环 —— 三平台矩阵各跑各的平台分支（win32 探测链 / darwin / linux command -v），
    //     断言契约而非环境：文件管理器恒在且排最前，id 只认已知值
    send(ws, { v: 1, id: "smoke-editors", method: "workspace.listEditors", params: null });
    const editorsResp = await nextMessage(ws, (f) => f["id"] === "smoke-editors");
    const editors =
      ((editorsResp["result"] as { editors?: { id: string; name: string }[] } | undefined)?.["editors"]) ?? [];
    check("workspace.listEditors round-trips", editorsResp["ok"] === true && Array.isArray(editors) && editors.length >= 1, editorsResp);
    check("文件管理器恒在且排最前", editors[0]?.["id"] === "explorer" && typeof editors[0]?.["name"] === "string", editors);
    check("只登记已知编辑器 id", editors.every((e) => e["id"] === "explorer" || e["id"] === "vscode"), editors);

    // 4. 错误帧：未知方法 / 坏 envelope / 非 JSON
    send(ws, { v: 1, id: "smoke-2", method: "does_not_exist" });
    const unknown = await nextMessage(ws, (f) => f["id"] === "smoke-2");
    check("unknown method gets error frame", unknown["ok"] === false && (unknown["error"] as Record<string, unknown> | undefined)?.["code"] === "unknown_method", unknown);

    send(ws, { v: 1, id: "smoke-3" });
    const bad = await nextMessage(ws, (f) => f["type"] !== "hello" && f["error"] !== undefined);
    check("bad envelope gets id:null error frame", bad["id"] === null && (bad["error"] as Record<string, unknown> | undefined)?.["code"] === "bad_frame", bad);

    ws.send("this is not json");
    const notJson = await nextMessage(ws, (f) => f["type"] !== "hello" && f["error"] !== undefined);
    check("non-JSON frame gets id:null error frame", notJson["id"] === null && (notJson["error"] as Record<string, unknown> | undefined)?.["code"] === "bad_frame", notJson);

    // 5. 优雅退出：走协议原生的 daemon.stop（Windows 跨进程 SIGTERM 不可投递）
    send(ws, { v: 1, id: "smoke-5", method: "daemon.stop" });
    const stopResp = await nextMessage(ws, (f) => f["id"] === "smoke-5");
    check("daemon.stop acks", stopResp["ok"] === true, stopResp);

    const exitPromise = new Promise<number | null>((resolve) => {
      daemon?.once("exit", (code) => resolve(code));
    });
    const exitCode = await Promise.race([exitPromise, sleep(8000).then(() => "timeout" as const)]);
    check("daemon exits 0 after daemon.stop", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    const code = await stopDaemon(); // 失败路径兜底，不留孤儿进程
    if (code === null && daemon !== undefined && daemon.exitCode === null) {
      console.error("smoke: daemon did not exit, killed");
    }
  }

  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

await main().catch((err: unknown) => {
  console.error("smoke: crashed", err);
  void stopDaemon();
  process.exit(1);
});
