/**
 * 打包形态冒烟 —— 跑 daemon-deploy bundle（而不是 src 源码树）：
 *
 *   起 bundle daemon（随机端口 + 临时 AGENT_WORKBENCH_HOME）
 *   → terminal.create（平台默认 shell）→ 断言 PTY 输出回传 → echo 回环 → kill
 *   → daemon.stop 优雅退出
 *
 * 为什么必须有它（v0.1.0 Windows 翻车复盘）：终端走 node-pty worker 线程，
 * dev（tsx + src 树）和 bundle（esbuild 产物）的 **worker 入口解析路径不同**——
 * esbuild 不重写 `new Worker(new URL("./ptyWorker.ts"))` 这类代码文件引用，
 * bundle 里只有单独产出的 ptyWorker.js 才存在。这个差异只有「真跑 bundle」
 * 才暴露得出来：src 形态的冒烟（smoke / smoke:inbox / …）全部探测不到，
 * v0.1.0 三平台 CI 全绿但打包版终端全军覆没（exit=-1）。
 *
 * 前置：先 pnpm -C backend build:daemon（CI 里由 workflow 步骤保证）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = path.join(backendRoot, "dist", "daemon-deploy");
const daemonEntry = path.join(deployDir, "daemon.js");
const workerEntry = path.join(deployDir, "ptyWorker.js");
const smokeHome = mkdtempSync(path.join(os.tmpdir(), "aw-packaged-home-"));

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

interface WsMessage {
  [k: string]: unknown;
}

function nextMessage(ws: WebSocket, pred: (f: WsMessage) => boolean, timeoutMs = 20000): Promise<WsMessage> {
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

async function main(): Promise<void> {
  if (!existsSync(daemonEntry)) {
    console.error(`smoke-packaged: 缺 ${daemonEntry} —— 先 pnpm -C backend build:daemon`);
    process.exit(1);
  }
  const port = await freePort();
  console.log(`smoke-packaged: starting bundle daemon on 127.0.0.1:${port}`);

  const daemon: ChildProcess = spawn(process.execPath, [daemonEntry], {
    cwd: deployDir,
    env: { ...process.env, AGENT_WORKBENCH_PORT: String(port), AGENT_WORKBENCH_HOST: "127.0.0.1", AGENT_WORKBENCH_INSECURE: "1", AGENT_WORKBENCH_HOME: smokeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream?.on("data", (chunk: Buffer) => console.log(`  daemon | ${chunk.toString().trimEnd()}`));
  }

  try {
    // 0. 产物结构：bundle 里必须有 ptyWorker.js（worker 入口单独产出，见 build-daemon.mjs）
    check("ptyWorker.js shipped in bundle", existsSync(workerEntry));

    // 1. daemon 起得来（bundle 形态的基本面）
    let healthy = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(200);
    }
    check("bundle daemon healthy", healthy);
    if (!healthy) return;

    // 2. WS + 默认 shell 的 PTY 全链路：created → data（shell 横幅）→ echo 回环 → kill
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    });
    await nextMessage(ws, (f) => f["type"] === "hello", 10000);

    ws.send(JSON.stringify({ v: 1, id: "term-1", method: "terminal.create", params: { cols: 80, rows: 24 } }));
    const created = await nextMessage(ws, (f) => f["type"] === "terminal" && f["kind"] === "created");
    const terminalId = created["terminalId"] as string | undefined;
    check("terminal created via bundle", typeof terminalId === "string" && terminalId !== "", created);

    // 首批输出（shell 横幅 / 提示符）：PTY 起不来时这里只会等来 exit=-1
    const banner = await nextMessage(ws, (f) => f["type"] === "terminal" && f["terminalId"] === terminalId && f["kind"] === "data").catch(() => null);
    check("pty streams output (shell banner)", banner !== null && typeof banner["data"] === "string" && (banner["data"] as string).length > 0, banner);

    // echo 回环：cmd / pwsh / bash / zsh 通用，marker 唯一防撞提示符。
    // 注意所有请求帧必须带 id —— 信封校验（wsd.ts）缺 id 直接 bad_frame，方法不派发
    if (terminalId !== undefined) {
      ws.send(JSON.stringify({ v: 1, id: "term-in", method: "terminal.input", params: { terminalId, data: "echo awb-pkg-smoke-ok\r" } }));
      const echoBack = await nextMessage(ws, (f) => f["type"] === "terminal" && f["kind"] === "data" && String(f["data"] ?? "").includes("awb-pkg-smoke-ok"), 10000).catch(() => null);
      check("echo round-trips through pty", echoBack !== null);
      ws.send(JSON.stringify({ v: 1, id: "term-kill", method: "terminal.kill", params: { terminalId } }));
      await sleep(500);
    }

    // 3. 优雅退出
    ws.send(JSON.stringify({ v: 1, id: "stop", method: "daemon.stop", params: null }));
    const stopResp = await nextMessage(ws, (f) => f["id"] === "stop");
    check("daemon.stop acks", stopResp["ok"] === true, stopResp);

    const exitCode = await new Promise<number | null>((resolve) => {
      daemon.once("exit", (code) => resolve(code));
      sleep(8000).then(() => resolve(null));
    });
    check("daemon exits 0", exitCode === 0, exitCode);
    ws.close();
  } finally {
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
}

main().then(
  () => {
    if (failures > 0) {
      console.error(`smoke-packaged: ${failures} 失败`);
      process.exit(1);
    }
    console.log("smoke-packaged: all checks passed");
  },
  (err) => {
    console.error("smoke-packaged: crashed", err);
    process.exit(1);
  },
);
