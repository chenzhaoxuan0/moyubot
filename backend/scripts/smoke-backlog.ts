/**
 * 待办（GTD/backlog）端到端冒烟 —— 不碰真实订阅执行器：
 *
 *   自起 daemon（隔离 home + 随机端口）
 *   → backlog.list 空清单
 *   → backlog.create（mockperm 是测试夹具执行器，快答）
 *   → backlog.runNow（用户动作=确认门）→ 终态回灌 → 待验收
 *   → backlog.review 打回 → 就绪 → 再 runNow → 验收通过 → done
 *   → backlog.consolidate.run：播种 GTD.md 收件箱 + 追加一条 → 统合收录
 *   → 心跳护栏：未配执行器时 force 记 failed、forceBusy 拦截
 *   → backlog 信号帧（items/state）到达
 *
 * 用法：cd backend && pnpm smoke:backlog
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

let daemon: ChildProcess | undefined;
const daemonOutput: string[] = [];

function startDaemon(port: number, homeDir: string): void {
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOST: "127.0.0.1",
      AGENT_WORKBENCH_INSECURE: "1",
      AGENT_WORKBENCH_HOME: homeDir,
    },
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

async function waitHealthy(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon !== undefined && daemon.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

interface WsMessage {
  [k: string]: unknown;
}

let rpcSeq = 0;
function rpc(ws: WebSocket, method: string, params: unknown, timeoutMs = 30000): Promise<WsMessage> {
  const id = `smoke-${++rpcSeq}`;
  const p = nextMessage(ws, (f) => f["id"] === id, timeoutMs);
  ws.send(JSON.stringify({ v: 1, id, method, params }));
  return p;
}

function nextMessage(ws: WebSocket, pred: (f: WsMessage) => boolean, timeoutMs = 30000): Promise<WsMessage> {
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

interface ItemShape {
  id: number;
  status: string;
  title: string;
  lastRun: { status: string } | null;
}

async function listItems(ws: WebSocket): Promise<ItemShape[]> {
  const r = await rpc(ws, "backlog.list", null);
  return (r["result"] as { items: ItemShape[] }).items;
}

/** 等某条待办到达指定状态（终态回灌是异步的） */
async function waitForStatus(ws: WebSocket, id: number, status: string, timeoutMs = 20000): Promise<ItemShape | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await listItems(ws);
    const hit = items.find((i) => i.id === id);
    if (hit !== undefined && hit.status === status) return hit;
    await sleep(400);
  }
  return null;
}

async function main(): Promise<void> {
  const port = await freePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "awb-backlog-smoke-"));
  // 一个假工作空间：收件箱统合要往里播种 GTD.md
  const unitRoot = path.join(homeDir, "unit-demo");
  mkdirSync(unitRoot, { recursive: true });
  console.log(`smoke: daemon on 127.0.0.1:${port}, home=${homeDir}`);
  startDaemon(port, homeDir);

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(ws, (f) => f["type"] === "hello");

    // 1. 空清单 + 初始状态
    const empty = await rpc(ws, "backlog.list", null);
    const emptyResult = empty["result"] as { items: unknown[]; state: { phase: string; heartbeatEnabled: boolean }; config: { heartbeat: { runtimeId: string } } };
    check("backlog.list empty", emptyResult.items.length === 0, emptyResult);
    check("initial phase is busy or idle", ["busy", "idle"].includes(emptyResult.state.phase), emptyResult.state);
    check("heartbeat disabled by default", emptyResult.state.heartbeatEnabled === false);

    // 1b. 心跳常驻 bot 已注册（对齐 steward 的合成 bot 模式）
    const bots = await rpc(ws, "bot.list", null, 20000);
    const botList = (bots["result"] as Array<{ id?: string; bindings?: unknown[] }>);
    const hbBot = botList.find((b) => b.id === "heartbeat");
    check("heartbeat bot registered with primary binding", hbBot !== undefined && Array.isArray(hbBot.bindings) && hbBot.bindings.length > 0, hbBot);

    // 2. 创建 → 就绪（冒烟走 headless 管线验证确认门与验收状态机）
    const created = await rpc(ws, "backlog.create", {
      goal: "冒烟：验证待办全链路",
      unitId: "smoke-unit",
      unitName: "冒烟单元",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      prompt: "请回复「冒烟完成」并结束。",
      launchMode: "headless",
    });
    const createdItem = ((created["result"] as { item: ItemShape }).item);
    check("backlog.create → ready", createdItem.status === "ready", createdItem);
    const itemId = createdItem.id;

    // 3. 心跳护栏：强制忙碌压倒一切。心跳 bot 常驻后默认绑定兜底（不再有
    // 「未配置执行器」态），这里只验 forceBusy 拦截 —— 不真跑心跳会话（不烧额度）
    await rpc(ws, "backlog.state.forceBusy", { on: true });
    await rpc(ws, "backlog.heartbeat.force", null);
    await sleep(800); // force 受理即返，beat 的落账是异步的
    const busyBeat = await rpc(ws, "backlog.list", null);
    check(
      "forceBusy blocks heartbeat",
      (busyBeat["result"] as { state: { lastBeatOutcome: string | null } }).state.lastBeatOutcome === "skipped:forceBusy",
    );
    await rpc(ws, "backlog.state.forceBusy", { on: false });

    // 4. runNow（用户动作=确认门）→ mockperm 快答 → 终态回灌 → 待验收
    const run = await rpc(ws, "backlog.runNow", { id: itemId });
    check("backlog.runNow dispatches", run["ok"] === true, run);
    const reviewing = await waitForStatus(ws, itemId, "awaiting_review");
    check("run ends in awaiting_review", reviewing !== null, reviewing);

    // 5. 打回 → 就绪；再跑一次 → 验收通过 → done
    const reject = await rpc(ws, "backlog.review", { id: itemId, pass: false, note: "冒烟打回" });
    check("review reject → ready", reject["ok"] === true && (await listItems(ws)).find((i) => i.id === itemId)?.status === "ready");
    await rpc(ws, "backlog.runNow", { id: itemId });
    await waitForStatus(ws, itemId, "awaiting_review");
    const pass = await rpc(ws, "backlog.review", { id: itemId, pass: true });
    check("review pass → done", pass["ok"] === true && (await listItems(ws)).find((i) => i.id === itemId)?.status === "done");

    // 6. 收件箱：往 steward 根（已注册的 bot root —— 统合只扫 bot roots）写 GTD.md → 统合收录
    writeFileSync(
      path.join(homeDir, "steward", "GTD.md"),
      "# GTD 收件箱\n\n## 收件箱\n- [ ] 冒烟：从收件箱来的待办\n\n## 已收录\n",
      "utf8",
    );
    const cons = await rpc(ws, "backlog.consolidate.run", { force: true }, 45000);
    const consResult = cons["result"] as { created: number; duplicates: number; scanned: number };
    check("consolidate creates inbox item", consResult.created === 1, consResult);
    const inboxItem = (await listItems(ws)).find((i) => i.title.includes("收件箱"));
    check("inbox item is ready", inboxItem?.status === "ready", inboxItem);
    const afterFile = readFileSync(path.join(homeDir, "steward", "GTD.md"), "utf8");
    check("inbox file marks collected id", afterFile.includes(`已收录 #${inboxItem?.id}`), afterFile);
    // 再统合一次：已收录行不会再导入
    const cons2 = await rpc(ws, "backlog.consolidate.run", { force: true }, 45000);
    check("re-consolidate creates nothing", ((cons2["result"] as { created: number }).created) === 0, cons2["result"]);

    // 7. 信号帧：改状态触发 state 广播（forceBusy on → phase busy）
    const stateFrame = nextMessage(ws, (f) => f["type"] === "backlog" && (f["signal"] as { kind?: string })?.kind === "state", 8000)
      .catch(() => null);
    await rpc(ws, "backlog.state.forceBusy", { on: true });
    const frame = await stateFrame;
    check("backlog state signal broadcast", frame !== null && ((frame as never as { signal: { snapshot: { forceBusy: boolean } } }).signal.snapshot.forceBusy === true), frame);
    await rpc(ws, "backlog.state.forceBusy", { on: false });

    // 8. 配置归一：坏值被钳制
    const cfg = await rpc(ws, "backlog.config.set", { patch: { heartbeat: { intervalMinutes: 1 } } });
    check("config clamps interval", ((cfg["result"] as { config: { heartbeat: { intervalMinutes: number } } }).config.heartbeat.intervalMinutes) === 5, cfg["result"]);
    check("proposeNonAuto 默认关（打勾模型主流程，未打勾任务不被提议）", ((cfg["result"] as { config: { heartbeat: { proposeNonAuto: boolean } } }).config.heartbeat.proposeNonAuto) === false, cfg["result"]);

    // 9. 闲时自动执行（autopilot）：mockperm 夹具不烧真实额度。空闲判定口径 =
    // 距最近活动 ≥ idleMinutes，把阈值压到 1 分钟再等拍（tick 20s 一次）
    await rpc(ws, "backlog.config.set", { patch: { heartbeat: { idleMinutes: 1 }, autopilot: { enabled: true, maxConcurrent: 1, autoReview: true } } });
    const autoItem = ((await rpc(ws, "backlog.create", { goal: "冒烟：闲时自动执行直达 done", unitId: "smoke-unit", unitName: "冒烟单元", rootPath: unitRoot, runtimeId: "mockperm", prompt: "请回复「冒烟完成」并结束。", launchMode: "headless", auto: true }))["result"] as { item: { id: number } }).item;
    const manualItem = ((await rpc(ws, "backlog.create", { goal: "冒烟：非 auto 不被自动派发", unitId: "smoke-unit", unitName: "冒烟单元", rootPath: unitRoot, runtimeId: "mockperm", prompt: "请回复「冒烟完成」并结束。", launchMode: "headless" }))["result"] as { item: { id: number } }).item;
    const autoDone = await waitForStatus(ws, autoItem.id, "done", 300000);
    check("autopilot dispatches ready+auto straight to done (autoReview)", autoDone !== null, autoDone);
    check("non-auto item untouched by autopilot", (await listItems(ws)).find((i) => i.id === manualItem.id)?.status === "ready");
    const staleTarget = ((await rpc(ws, "backlog.create", { goal: "冒烟：指定死会话回落新开", unitId: "smoke-unit", unitName: "冒烟单元", rootPath: unitRoot, runtimeId: "mockperm", prompt: "请回复「冒烟完成」并结束。", launchMode: "headless", auto: true, targetSessionId: "sess-dead" }))["result"] as { item: { id: number } }).item;
    check("stale targetSessionId falls back to new session and completes", (await waitForStatus(ws, staleTarget.id, "done", 300000)) !== null);
    await rpc(ws, "backlog.config.set", { patch: { autopilot: { enabled: false } } });
    const gatedItem = ((await rpc(ws, "backlog.create", { goal: "冒烟：autopilot 关闭后不动", unitId: "smoke-unit", unitName: "冒烟单元", rootPath: unitRoot, runtimeId: "mockperm", prompt: "请回复「冒烟完成」并结束。", launchMode: "headless", auto: true }))["result"] as { item: { id: number } }).item;
    await sleep(45000);
    check("autopilot disabled keeps auto item ready", (await listItems(ws)).find((i) => i.id === gatedItem.id)?.status === "ready");

    // 10. 优雅退出
    const stopResp = await rpc(ws, "daemon.stop", null);
    check("daemon.stop acks", stopResp["ok"] === true);
    const exitPromise = new Promise<number | null>((resolve) => {
      daemon?.once("exit", (code) => resolve(code));
    });
    const exitCode = await Promise.race([exitPromise, sleep(8000).then(() => "timeout" as const)]);
    check("daemon exits 0", exitCode === 0, { exitCode });
    if (exitCode !== 0) await stopDaemon();
  } finally {
    await stopDaemon();
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
