/**
 * 提醒（reminder，docs/30）端到端冒烟 —— 钟控轴 notify 载荷：
 *
 *   自起 daemon（隔离 home + 随机端口）
 *   → reminder.create runAt 过去 → 拒绝（不静默顺延）
 *   → reminder.create link 指向不存在的清单条目 → 拒绝（深链不许落空）
 *   → inbox.add 收一条 → reminder.create delayMinutes=1 链接它 → 排上
 *   → 到点发火：notifications.list 出现 kind=reminder 行（带 link 深链）、
 *     automation 行 origin=reminder / dispatchTarget=notify、run 记 done、
 *     一次性收口 enabled=false
 *   → daemon.stop 优雅退出
 *
 * 桌面 toast 与 IM 扇出不在冒烟范围（无 Electron / 飞书未配置走静默跳过）。
 * 错过补发（>5min 宽限的 bypass）由 check:reminder-catchup 在调度器层直测，
 * 冒烟不等 5 分钟。
 *
 * 用法：cd backend && npx tsx scripts/smoke-reminder.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
        const port = (addr as { port: number }).port;
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
    stream?.on("data", (chunk: Buffer) => console.log(`  daemon | ${chunk.toString().trimEnd()}`));
  }
}

async function stopDaemon(): Promise<number | null> {
  if (daemon === undefined || daemon.exitCode !== null) return daemon?.exitCode ?? null;
  const exited = new Promise<number | null>((resolve) => daemon?.once("exit", (code) => resolve(code)));
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
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "awb-reminder-smoke-"));
  startDaemon(port, homeDir);
  check("daemon healthy", await waitHealthy(port));
  if (failures > 0) {
    await stopDaemon();
    process.exit(1);
  }
  const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`);

  // 0. 先关自动分类：本冒烟只测提醒链路，不需要 routing —— routing bot 默认
  //   绑定 zcode，不关的话 inbox.add 会真的拉起 zcode 会话烧额度（smoke:inbox
  //   的既有教训：它把分类执行器指到不存在的 id，这里更干脆，直接关开关）。
  //   注意 config.set 的入参是 {patch} 包着的，传错形状会静默无效。
  const cfgOff = await rpc(ws, "inbox.config.set", { patch: { autoClassify: false } });
  check("自动分类已关", cfgOff["ok"] === true && ((cfgOff["result"] as { config?: { autoClassify?: boolean } } | undefined)?.config?.autoClassify === false), cfgOff);

  // 1. 过去的 runAt 直接拒 —— 静默顺延是最坏的失败形态
  const past = await rpc(ws, "reminder.create", { text: "过去的提醒", runAt: Date.now() - 60_000 });
  check("runAt 过去被拒", past["error"] !== undefined, past);

  // 2. 深链不许落空：link 指向不存在的条目直接拒
  const badLink = await rpc(ws, "reminder.create", { text: "悬空深链", delayMinutes: 5, link: { kind: "inbox-entry", id: 999_999 } });
  check("link 悬空被拒", badLink["error"] !== undefined, badLink);

  // 3. 正路：收一条清单 → 挂 1 分钟提醒链回它
  const added = await rpc(ws, "inbox.add", { text: "下午三点前给老板发周报（冒烟用例）" });
  const entryId = (added["result"] as { id: number } | undefined)?.id;
  check("清单条目已收", typeof entryId === "number", added);
  const created = await rpc(ws, "reminder.create", {
    text: "该发周报了",
    delayMinutes: 1,
    link: { kind: "inbox-entry", id: entryId },
  });
  const result = created["result"] as { id: number; nextRunAt: number } | undefined;
  check("提醒已排上", result !== undefined && typeof result.id === "number" && typeof result.nextRunAt === "number", created);
  if (result === undefined) {
    await stopDaemon();
    process.exit(1);
  }
  const reminderId = result.id;

  // 4. 到点发火（调度 20s tick + 1 分钟延迟：90s 预算内轮询通知账本）
  let fired: { id: string; kind: string; title: string; link?: { kind: string; id: number } } | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const listed = await rpc(ws, "notifications.list", { limit: 50 });
    const rows = (listed["result"] as { items?: unknown[] } | undefined)?.items ?? [];
    fired = rows.find(
      (r): r is { id: string; kind: string; title: string; link?: { kind: string; id: number } } =>
        typeof r === "object" && r !== null && (r as { id?: unknown }).id === `rem:${reminderId}`,
    );
    if (fired !== undefined) break;
  }
  check("到点送达通知账本", fired !== undefined && fired.kind === "reminder" && fired.title === "提醒");
  check("通知带深链", fired?.link?.kind === "inbox-entry" && fired?.link?.id === entryId, fired);

  // 5. 行与运行记录的收口形态
  const autos = await rpc(ws, "automation.list", null);
  const rows = ((autos["result"] as unknown[] | undefined) ?? []) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r["id"] === reminderId);
  check("行 origin=reminder / dispatchTarget=notify", row?.["origin"] === "reminder" && row?.["dispatchTarget"] === "notify", row);
  check("一次性收口 enabled=false", row?.["enabled"] === false, row);
  const runs = (row?.["runs"] as Array<Record<string, unknown>> | undefined) ?? [];
  check("run 记 done（提醒已送达）", runs.some((r) => r["status"] === "done" && String(r["detail"] ?? "").includes("提醒已送达")), runs);
  check("无 skipped 行（错过补发不记账为跳过）", !runs.some((r) => r["status"] === "skipped"), runs);

  // 6. 优雅退出：daemon.stop 的关停排在 30ms 定时器里，Windows 下立刻 SIGTERM
  //    会抢跑强杀（ graceful 日志都没有）—— 先给优雅路径一秒窗口
  const stop = await rpc(ws, "daemon.stop", null);
  check("daemon.stop acks", stop["ok"] === true, stop);
  await sleep(1000);
  const code = await stopDaemon();
  check("daemon exits 0", code === 0, code);

  console.log(failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error("smoke crashed:", err instanceof Error ? err.message : err);
  await stopDaemon();
  process.exit(1);
});
