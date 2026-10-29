/**
 * 清单（inbox）端到端冒烟 —— 不烧真实执行器额度：
 *
 *   自起 daemon（隔离 home + 随机端口）
 *   → routing bot 已注册（常驻合成 bot，对齐 steward / heartbeat 模式）
 *   → inbox.list 空清单
 *   → inbox.add → pending（autoClassify 默认开，无执行器时分类优雅失败不丢条目）
 *   → inbox 信号帧（entries / 自动触发的 state）
 *   → inbox.update 手动改分类（不烧 routing 会话）→ 打回待分类 → 预置字段
 *   → inbox.config.set 自定义分类
 *   → inbox.classify.run 未配执行器 → failed 记账、条目原样
 *   → backlog.create（auto + targetSessionId）→ 待办卡片带闲时自动执行字段
 *   → inbox.delete → 优雅退出
 *
 * 用法：cd backend && npx tsx scripts/smoke-inbox.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
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

interface EntryShape {
  id: number;
  text: string;
  category: string | null;
  status: string;
  hints: Record<string, unknown> | null;
  task: { id: number } | null;
}

async function listEntries(ws: WebSocket): Promise<EntryShape[]> {
  const r = await rpc(ws, "inbox.list", null);
  return (r["result"] as { entries: EntryShape[] }).entries;
}

/** 等分类器落定（classifying=false 且 lastOutcome 非空）：分类会话是异步的，轮询比等帧稳 */
async function waitForClassifierSettled(ws: WebSocket, timeoutMs = 30000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = (await rpc(ws, "inbox.list", null))["result"] as { classifier: { classifying: boolean; lastOutcome: string | null } };
    if (!r.classifier.classifying && r.classifier.lastOutcome !== null) return r.classifier.lastOutcome;
    await sleep(400);
  }
  return null;
}

async function main(): Promise<void> {
  const port = await freePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "awb-inbox-smoke-"));
  const unitRoot = path.join(homeDir, "unit-demo");
  mkdirSync(unitRoot, { recursive: true });
  console.log(`smoke: daemon on 127.0.0.1:${port}, home=${homeDir}`);
  startDaemon(port, homeDir);

  try {
    check("daemon healthy", await waitHealthy(port), daemonOutput);
    const ws = await wsOpen(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(ws, (f) => f["type"] === "hello");

    // 1. routing bot 已注册（清单分类的总管 bot，与 steward/heartbeat 同模式）
    const bots = await rpc(ws, "bot.list", null, 20000);
    const botList = bots["result"] as Array<{ id?: string; bindings?: unknown[]; resident?: boolean }>;
    const routingBot = botList.find((b) => b.id === "routing");
    check("routing bot registered with primary binding", routingBot !== undefined && Array.isArray(routingBot.bindings) && routingBot.bindings.length > 0, routingBot);
    check("routing bot is resident", routingBot?.resident === true, routingBot);

    // 2. 空清单
    const empty = await rpc(ws, "inbox.list", null);
    const emptyResult = empty["result"] as { entries: unknown[]; config: { autoClassify: boolean }; classifier: { classifying: boolean } };
    check("inbox.list empty", emptyResult.entries.length === 0, emptyResult);
    check("autoClassify on by default", emptyResult.config.autoClassify === true);
    check("classifier idle initially", emptyResult.classifier.classifying === false);

    // 2b. 把分类执行器显式指到一个不存在的 id —— 冒烟不烧真实执行器：
    // 自动分类（routing bot 默认绑定 zcode）会走 startSession 快速抛错 → 记账失败，
    // 两个目的：验证优雅失败路径 + 不让冒烟真的拉起 zcode 会话
    await rpc(ws, "inbox.config.set", { patch: { classifier: { runtimeId: "nonexistent-exec" } } });

    // 3. 写一条 → pending；inbox 信号帧到达；自动触发的分类优雅失败
    // （信号帧监听先挂上再触发 —— 广播是一瞬间的，事后等会漏帧）
    const entriesFrameP = nextMessage(ws, (f) => f["type"] === "inbox" && (f["signal"] as { kind?: string })?.kind === "entries", 8000);
    const added = await rpc(ws, "inbox.add", { text: "冒烟：给 README 补一节迁移指南" });
    const addedEntry = (added["result"] as { entry: EntryShape }).entry;
    check("inbox.add → pending", addedEntry !== null && addedEntry.status === "pending" && addedEntry.category === null, addedEntry);
    const entriesFrame = await entriesFrameP;
    check("inbox entries signal broadcast", entriesFrame !== undefined, entriesFrame);
    // autoClassify 的 debounce（2.5s）后分类器跑起来，unknown runtime → startSession 抛错记账
    const outcome = await waitForClassifierSettled(ws);
    check("auto classify fails gracefully with bad runtime", outcome !== null && outcome.startsWith("failed:"), outcome);
    const stillPending = await listEntries(ws);
    check("entry survives failed classify", stillPending.length === 1 && stillPending[0]?.status === "pending", stillPending);

    // 4. 手动改分类（不烧 routing 会话）→ 打回待分类
    await rpc(ws, "inbox.update", { id: addedEntry!.id, category: "idea" });
    const afterManual = (await listEntries(ws)).find((e) => e.id === addedEntry!.id);
    check("manual category → classified", afterManual?.category === "idea" && afterManual.status === "classified", afterManual);
    await rpc(ws, "inbox.update", { id: addedEntry!.id, category: null });
    const backPending = (await listEntries(ws)).find((e) => e.id === addedEntry!.id);
    check("category null → back to pending", backPending?.status === "pending" && backPending.category === null, backPending);

    // 5. 直接带分类 + 预置字段提交（用户自己分好类，不进分类队列）
    const withHints = await rpc(ws, "inbox.add", {
      text: "冒烟：预置字段的条目",
      category: "todo",
      hints: { unitId: "smoke-unit", runtimeId: "mockperm", targetSessionId: "sess-xyz" },
    });
    const hintsEntry = (withHints["result"] as { entry: EntryShape }).entry;
    check("pre-classified entry skips queue", hintsEntry?.status === "classified" && hintsEntry.category === "todo", hintsEntry);
    check("hints persisted", hintsEntry?.hints?.unitId === "smoke-unit" && hintsEntry.hints.targetSessionId === "sess-xyz", hintsEntry?.hints);

    // 6. 配置归一：自定义分类 + 坏 id 过滤
    const cfg = await rpc(ws, "inbox.config.set", {
      patch: { categories: [{ label: "读书清单", actionable: false }, { label: "idea", actionable: true }, { label: "" }] },
    });
    const cfgResult = (cfg["result"] as { config: { categories: Array<{ id: string; label: string; actionable: boolean }> } }).config;
    check("custom category added", cfgResult.categories.length === 1 && cfgResult.categories[0]?.id === "读书清单", cfgResult.categories);
    check("builtin id collision filtered", cfgResult.categories.every((c) => c.id !== "idea"), cfgResult.categories);

    // 7. 手动触发分类：bad runtime → 快速记账失败，条目不丢
    await rpc(ws, "inbox.classify.run", null);
    const clsOutcome = await waitForClassifierSettled(ws);
    check("manual classify records failure", clsOutcome !== null && clsOutcome.startsWith("failed:"), clsOutcome);
    check("pending entries intact", (await listEntries(ws)).filter((e) => e.status === "pending").length === 1);

    // 8. backlog.create 带 auto + targetSessionId → 待办卡片带闲时自动执行字段
    const created = await rpc(ws, "backlog.create", {
      goal: "冒烟：闲时自动执行的待办",
      unitId: "smoke-unit",
      unitName: "冒烟单元",
      rootPath: unitRoot,
      runtimeId: "mockperm",
      prompt: "请回复「冒烟完成」并结束。",
      launchMode: "headless",
      auto: true,
      targetSessionId: "sess-xyz",
    });
    const createdItem = (created["result"] as { item: { id: number; auto: boolean; targetSessionId: string | null } }).item;
    check("backlog.create auto=true", createdItem.auto === true, createdItem);
    check("backlog.create targetSessionId", createdItem.targetSessionId === "sess-xyz", createdItem);

    // 8b. 打勾门：实质编辑即灭勾；仅勾选/原值编辑不灭
    const edited = await rpc(ws, "backlog.update", { id: createdItem!.id, goal: "冒烟：改过目标的待办" });
    const editedItem = (edited["result"] as { item: { auto: boolean; goal: string } }).item;
    check("实质编辑即灭勾", editedItem.auto === false && editedItem.goal === "冒烟：改过目标的待办", editedItem);
    const rechecked = await rpc(ws, "backlog.update", { id: createdItem!.id, auto: true });
    check("重新打勾恢复 auto", ((rechecked["result"] as { item: { auto: boolean } }).item).auto === true);
    const noopEdit = await rpc(ws, "backlog.update", { id: createdItem!.id, goal: "冒烟：改过目标的待办" });
    check("原值编辑不灭勾", ((noopEdit["result"] as { item: { auto: boolean } }).item).auto === true);

    // 8c. 清单侧撤销降级：条目链着的任务（清单来源+就绪+auto）随删除摘勾。
    // 链接与来源平时由分类器事务写入，冒烟的分类器指向不存在的执行器 —— 用
    // sqlite 夹具补上这两格再走真实 RPC，验证的是 delete 处理器的守卫本身。
    const linkedEntry = (await rpc(ws, "inbox.add", { text: "冒烟：将被撤销的条目", category: "todo" }))["result"] as { entry: EntryShape };
    {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(homeDir, "state.db"));
      db.prepare(`UPDATE inbox_entries SET task_id = ?, status = 'classified' WHERE id = ?`).run(createdItem!.id, linkedEntry.entry.id);
      db.prepare(`UPDATE backlog_items SET source = 'inbox' WHERE id = ?`).run(createdItem!.id);
      db.close();
    }
    const delLinked = await rpc(ws, "inbox.delete", { id: linkedEntry.entry.id });
    check("删链接条目 → 任务摘勾", delLinked["ok"] === true);
    const afterDel = (await rpc(ws, "backlog.list", null))["result"] as { items: Array<{ id: number; auto: boolean; status: string }> };
    const demoted = afterDel.items.find((i) => i.id === createdItem!.id);
    check("清单侧撤销 → auto=false（降级手动）", demoted !== undefined && demoted.auto === false && demoted.status === "ready", demoted);

    // 9. 删条目；配置关掉自动分类
    const del = await rpc(ws, "inbox.delete", { id: hintsEntry!.id });
    check("inbox.delete", del["ok"] === true && (await listEntries(ws)).every((e) => e.id !== hintsEntry!.id));
    const cfgOff = await rpc(ws, "inbox.config.set", { patch: { autoClassify: false } });
    check("autoClassify toggle", ((cfgOff["result"] as { config: { autoClassify: boolean } }).config.autoClassify) === false);

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
