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
 *   → 总开关（autoClassify）：关 = 写入不排分类（runSeq 不动）；开 = config.set 补排存量
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
  categoryNote: string | null;
  status: string;
  hints: Record<string, unknown> | null;
  task: { id: number } | null;
}

async function listEntries(ws: WebSocket): Promise<EntryShape[]> {
  const r = await rpc(ws, "inbox.list", null);
  return (r["result"] as { entries: EntryShape[] }).entries;
}

type ItemShape = { id: number; auto: boolean; status: string; source: string; unitId: string; runtimeId: string; goal: string };
async function listItems(ws: WebSocket): Promise<ItemShape[]> {
  const r = (await rpc(ws, "backlog.list", null))["result"] as { items: ItemShape[] };
  return r.items;
}

async function classifierState(ws: WebSocket): Promise<{ classifying: boolean; lastOutcome: string | null; runSeq: number }> {
  const r = (await rpc(ws, "inbox.list", null))["result"] as { classifier: { classifying: boolean; lastOutcome: string | null; runSeq: number } };
  return r.classifier;
}

/** 等一轮新分类落定：runSeq 只增不减 —— 触发时刻**之前**先取 seq，等它前进且
 * classifying 归 false。直接比 lastOutcome 会把上一轮的残留当本轮结果（空转断言）。 */
async function waitForClassifierRun(ws: WebSocket, beforeSeq: number, timeoutMs = 30000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await classifierState(ws);
    if (!st.classifying && st.runSeq > beforeSeq) return st.lastOutcome;
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
    const seqBeforeAdd = (await classifierState(ws)).runSeq;
    const added = await rpc(ws, "inbox.add", { text: "冒烟：给 README 补一节迁移指南" });
    const addedEntry = (added["result"] as { entry: EntryShape }).entry;
    check("inbox.add → pending", addedEntry !== null && addedEntry.status === "pending" && addedEntry.category === null, addedEntry);
    const entriesFrame = await entriesFrameP;
    check("inbox entries signal broadcast", entriesFrame !== undefined, entriesFrame);
    // autoClassify 的 debounce（2.5s）后分类器跑起来，unknown runtime → startSession 抛错记账
    const outcome = await waitForClassifierRun(ws, seqBeforeAdd);
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
    const seqBeforeManual = (await classifierState(ws)).runSeq;
    await rpc(ws, "inbox.classify.run", null);
    const clsOutcome = await waitForClassifierRun(ws, seqBeforeManual);
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

    // 8c. 成功链路（mockrouting 夹具执行器：按关键词脚本化产出决策，不烧真实
    // 额度）—— 此前冒烟只覆盖优雅失败；落库/沉淀/链接/hints 优先/无效分类与
    // bot 回落的全链路在这里验收
    await rpc(ws, "inbox.config.set", { patch: { classifier: { runtimeId: "mockrouting" } } });
    const seqBeforeBatch = (await classifierState(ws)).runSeq;
    const ideaEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：这是一个想法，归档就好" }))["result"] as { entry: EntryShape }).entry;
    const badCatEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：坏分类条目的目标" }))["result"] as { entry: EntryShape }).entry;
    const badBotEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：坏bot条目的目标" }))["result"] as { entry: EntryShape }).entry;
    const plainEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：普通待办条目" }))["result"] as { entry: EntryShape }).entry;
    const hintedEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：带预置字段的条目", hints: { unitId: "steward", runtimeId: "mockperm" } }))["result"] as { entry: EntryShape }).entry;
    const okOutcome = await waitForClassifierRun(ws, seqBeforeBatch, 60000);
    check("mockrouting 分类成功记账", okOutcome !== null && okOutcome.startsWith("ok:"), okOutcome);
    const entries8c = await listEntries(ws);
    const entryById = (id: number | undefined): EntryShape | undefined => entries8c.find((e) => e.id === id);
    const idea8c = entryById(ideaEntry?.id);
    check("想法条目归档不建任务", idea8c?.status === "classified" && idea8c.category === "idea" && (idea8c.task === null || idea8c.task === undefined), idea8c);
    const badCat8c = entryById(badCatEntry?.id);
    check("无效分类回落 todo 且理由注明", badCat8c?.category === "todo" && (badCat8c.categoryNote ?? "").includes("无效"), badCat8c);
    const items8c = await listItems(ws);
    const taskOf = (e: EntryShape | undefined): ItemShape | undefined => (e?.task != null ? items8c.find((i) => i.id === e.task!.id) : undefined);
    const badBotItem8c = taskOf(entryById(badBotEntry?.id));
    check("未知 bot 建议不被采纳（回落真实 bot）", badBotItem8c !== undefined && badBotItem8c.unitId !== "nonexistent-bot", badBotItem8c);
    const plainItem8c = taskOf(entryById(plainEntry?.id));
    check("普通条目沉淀 auto 任务（source=inbox 默认打勾）", plainItem8c !== undefined && plainItem8c.auto === true && plainItem8c.source === "inbox" && plainItem8c.goal.startsWith("目标："), plainItem8c);
    const hintedItem8c = taskOf(entryById(hintedEntry?.id));
    check("预置字段优先（unitId/runtimeId 照 hints）", hintedItem8c !== undefined && hintedItem8c.unitId === "steward" && hintedItem8c.runtimeId === "mockperm", hintedItem8c);

    // 8d. 清单侧撤销降级（真实链接，替代夹具）：删条目 → 链着的干净任务摘勾
    const delLinked = await rpc(ws, "inbox.delete", { id: plainEntry!.id });
    check("删链接条目", delLinked["ok"] === true);
    const demoted = (await listItems(ws)).find((i) => i.id === plainItem8c!.id);
    check("清单侧撤销 → auto=false（降级手动）", demoted !== undefined && demoted.auto === false && demoted.status === "ready", demoted);

    // 8e. 重分类：旧任务摘勾作废、重新分类沉淀新任务（不双份执行）
    const badCatOldTaskId = badCat8c?.task?.id;
    const seqBeforeRe = (await classifierState(ws)).runSeq;
    await rpc(ws, "inbox.reclassify", { id: badCatEntry!.id });
    const reOutcome = await waitForClassifierRun(ws, seqBeforeRe, 60000);
    check("重分类完成", reOutcome !== null && reOutcome.startsWith("ok:"), reOutcome);
    const badCatAfter = (await listEntries(ws)).find((e) => e.id === badCatEntry!.id);
    check("重分类条目已再分类", badCatAfter?.status === "classified" && badCatAfter.task != null, badCatAfter);
    const items8e = await listItems(ws);
    const oldTask = items8e.find((i) => i.id === badCatOldTaskId);
    const newTask = badCatAfter?.task != null ? items8e.find((i) => i.id === badCatAfter.task!.id) : undefined;
    check("重分类 → 旧任务摘勾、新任务打勾", oldTask !== undefined && oldTask.auto === false && newTask !== undefined && newTask.auto === true && newTask.id !== badCatOldTaskId, { oldTask, newTask });

    // 9. 删条目；配置关掉自动分类（页面头部「自动分类」总开关的落点）
    const del = await rpc(ws, "inbox.delete", { id: hintsEntry!.id });
    check("inbox.delete", del["ok"] === true && (await listEntries(ws)).every((e) => e.id !== hintsEntry!.id));
    const cfgOff = await rpc(ws, "inbox.config.set", { patch: { autoClassify: false } });
    check("autoClassify toggle", ((cfgOff["result"] as { config: { autoClassify: boolean } }).config.autoClassify) === false);

    // 9b. 总开关关闭即静：写入不被排程 —— 等过 debounce 窗口（2.5s + 余量）
    // 断言 runSeq 不动、条目停在待分类（写测试不烧 routing 额度的保证）
    const seqBeforeGate = (await classifierState(ws)).runSeq;
    const gatedEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：总开关关闭期间写入的条目" }))["result"] as { entry: EntryShape }).entry;
    await sleep(3500);
    const gatedState = await classifierState(ws);
    const gatedList = (await listEntries(ws)).find((e) => e.id === gatedEntry?.id);
    check("总开关关：不排分类（runSeq 不动、无会话）", gatedState.runSeq === seqBeforeGate && gatedState.classifying === false, gatedState);
    check("总开关关：条目停在待分类", gatedList?.status === "pending", gatedList);

    // 9c. 总开关打开 → config.set 补排存量待分类（不等下一次写入/重启）
    const seqBeforeReopen = (await classifierState(ws)).runSeq;
    await rpc(ws, "inbox.config.set", { patch: { autoClassify: true } });
    const reopenOutcome = await waitForClassifierRun(ws, seqBeforeReopen, 60000);
    check("总开关开：补排一轮分类", reopenOutcome !== null && reopenOutcome.startsWith("ok:"), reopenOutcome);
    const reopened = (await listEntries(ws)).find((e) => e.id === gatedEntry?.id);
    check("总开关开：条目已分类并沉淀任务", reopened?.status === "classified" && reopened.task != null, reopened);

    // 10. 重启 sweep：带着 pending 重启 daemon → 启动 sweep（+5s）把它分掉。
    // 开关开着时直接写入会被 debounce 立刻分掉 —— 先把分类执行器指到不存在的
    // id 让自动分类优雅失败（条目保持 pending），再指回 mockrouting 后停机：
    // 新进程的 sweep 用 mockrouting 把它分掉
    await rpc(ws, "inbox.config.set", { patch: { classifier: { runtimeId: "nonexistent-exec" } } });
    const seqBeforeSweepAdd = (await classifierState(ws)).runSeq;
    const sweepEntry = ((await rpc(ws, "inbox.add", { text: "冒烟：重启前遗留的待分类条目" }))["result"] as { entry: EntryShape }).entry;
    const preRestartFail = await waitForClassifierRun(ws, seqBeforeSweepAdd);
    check("重启前：坏执行器分类失败记账", preRestartFail !== null && preRestartFail.startsWith("failed:"), preRestartFail);
    const sweepPending = (await listEntries(ws)).find((e) => e.id === sweepEntry?.id);
    check("重启前条目 pending", sweepPending?.status === "pending", sweepPending);
    await rpc(ws, "inbox.config.set", { patch: { classifier: { runtimeId: "mockrouting" } } });
    const stop1 = await rpc(ws, "daemon.stop", null);
    check("第一次优雅停机", stop1["ok"] === true);
    const exit1 = await Promise.race([
      new Promise<number | null>((resolve) => {
        daemon?.once("exit", (c) => resolve(c));
      }),
      sleep(8000).then(() => "timeout" as const),
    ]);
    if (exit1 === "timeout") await stopDaemon();
    startDaemon(port, homeDir);
    check("daemon 重启 healthy", await waitHealthy(port), daemonOutput);
    const ws2 = await wsOpen(`ws://127.0.0.1:${port}/ws`);
    await nextMessage(ws2, (f) => f["type"] === "hello");
    const sweepOutcome = await waitForClassifierRun(ws2, 0, 30000);
    check("重启 sweep 分掉遗留条目", sweepOutcome !== null && sweepOutcome.startsWith("ok:"), sweepOutcome);
    const sweepAfter = (await listEntries(ws2)).find((e) => e.id === sweepEntry?.id);
    const sweepTask = sweepAfter?.task != null ? (await listItems(ws2)).find((i) => i.id === sweepAfter.task!.id) : undefined;
    check("遗留条目分类并沉淀任务", sweepAfter?.status === "classified" && sweepTask !== undefined && sweepTask.auto === true, { sweepAfter, sweepTask });

    // 11. 优雅退出（重启后的进程与连接）
    const stopResp = await rpc(ws2, "daemon.stop", null);
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
