/**
 * 自动化页端到端 —— 真实 Chrome（headless）+ CDP 驱动 UI，断言全链路：
 *
 *   侧栏进自动化页 → 新建对话框 → 填单 → 创建 → daemon 落库
 *   → 开关（乐观翻转 + 持久化）→ 菜单删除 → daemon 删库
 *
 * 前置：daemon 跑在 5391（AGENT_WORKBENCH_HOME 随意），vite 跑在 5390
 * （VITE_AGENT_WORKBENCH_PORT=5391）。用法：
 *   cd backend && pnpm e2e:automation-ui
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendScriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 19333;
const UI_URL = "http://localhost:5390/";
const DAEMON_WS = "ws://127.0.0.1:5391/ws";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Chrome 进程句柄提到模块级：底部全局 catch 也要能杀它 */
const chromeRef: { proc: ChildProcess | null } = { proc: null };
function killChrome(): void {
  const c = chromeRef.proc;
  if (c === null || c.exitCode !== null) return;
  try { c.kill(); } catch { /* 已死不究 */ }
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 300));
  }
}

// ---- daemon 侧直连（断言落库真值，不经过 UI） --------------------------------

let ws: WebSocket | null = null;
let wsId = 0;

async function daemonConnect(): Promise<void> {
  // 鉴权开着时（没设 AGENT_WORKBENCH_INSECURE）WS 要带 token：回环走 /bootstrap 自取
  const boot = await (await fetch("http://127.0.0.1:5391/bootstrap")).json() as { token?: string | null };
  const url = typeof boot.token === "string" && boot.token !== "" ? `${DAEMON_WS}?token=${encodeURIComponent(boot.token)}` : DAEMON_WS;
  ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener("open", () => resolve());
    ws!.addEventListener("error", () => reject(new Error("daemon ws failed")));
  });
}

function call<T = unknown>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return reject(new Error("daemon ws not open"));
    const id = `e2e-${++wsId}`;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame["id"] !== id) return;
      ws?.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (frame["ok"] === true) resolve(frame["result"] as T);
      else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"])}`));
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ v: 1, id, method, params }));
  });
}

// ---- CDP ----------------------------------------------------------------------

let cdp: WebSocket | null = null;
let cdpId = 0;
// WebSocket 用 Node ≥22 的原生全局（与 smoke-* 脚本同款），不走 ws 包 —— 两套 MessageEvent 类型会打架

async function cdpSend<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (cdp === null || cdp.readyState !== WebSocket.OPEN) return reject(new Error("cdp not open"));
    const id = ++cdpId;
    const timer = setTimeout(() => reject(new Error(`cdp ${method} timed out`)), 20000);
    const handler = (ev: MessageEvent): void => {
      const resp = JSON.parse(String(ev.data)) as { id: number; error?: { message: string }; result?: unknown };
      if (resp.id !== id) return;
      cdp?.removeEventListener("message", handler);
      clearTimeout(timer);
      if (resp.error !== undefined) reject(new Error(resp.error.message));
      else resolve(resp.result as T);
    };
    cdp.addEventListener("message", handler);
    cdp.send(JSON.stringify({ id, method: method, params }));
  });
}

/** CDP 端口探测：无超时的 fetch 会把整个脚本吊死在黑洞端口上 */
async function fetchCdpTargets(timeoutMs = 3000): Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  return (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
}

/** 在页面里跑一段 JS。入参脚本必须自包含（CDP Runtime.evaluate 不带闭包）。 */
async function evaluate<T = unknown>(expression: string): Promise<T> {
  const r = await cdpSend<{ result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
  );
  if (r.exceptionDetails !== undefined) {
    throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  // cdpSend 已解一层（resp.result），这里再取 evaluate 的 result.value
  return r.result?.value as T;
}

/** 受控 React 输入的原生赋值（直接改 .value 会被 React 状态盖回去） */
const reactInputJs = `
  window.__awbSetReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  true;
`;

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch (err: unknown) {
      lastErr = err; // 页面还在变，继续等；超时后把最后一个错亮出来
    }
    if (Date.now() > deadline) {
      console.error(`  FAIL timeout waiting for ${desc}`, lastErr instanceof Error ? lastErr.message : "");
      failures += 1;
      return false;
    }
    await sleep(300);
  }
}

async function main(): Promise<void> {
  // 看门狗：任何环节吊死都在 3 分钟内带病退出，别把流水线挂住
  const watchdog = setTimeout(() => {
    console.error("e2e-automation-ui: watchdog fired (3min), aborting");
    killChrome();
    process.exit(1);
  }, 180_000);
  watchdog.unref();

  await daemonConnect();
  const before = await call<Array<{ id: number }>>("automation.list", null);
  check("daemon reachable, automation.list works", Array.isArray(before));

  const tmpProfile = mkdtempSync(path.join(os.tmpdir(), "awb-e2e-chrome-"));
  chromeRef.proc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    "--headless=new",
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    UI_URL,
  ], { stdio: "ignore" });

  await flow();
  await sleep(200);

  if (failures > 0) {
    console.error(`e2e-automation-ui: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("e2e-automation-ui: all checks passed — 新建 / 落库 / 开关持久化 / 两段式删除 全链路成立");
}

/** UI 流程本体。提前 return 的每条路径都必须经过 finally 清理 —— 否则
 *  打开的 WebSocket 会吊住事件循环，进程永不退出。 */
async function flow(): Promise<void> {
  try {
    // 等 CDP 与页面就绪
    let targetWsUrl = "";
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const list = await fetchCdpTargets();
        const page = list.find((item) => item.type === "page" && item.url.includes("localhost:5390"));
        if (page?.webSocketDebuggerUrl !== undefined) { targetWsUrl = page.webSocketDebuggerUrl; break; }
      } catch { /* chrome 还没起 */ }
    }
    check("chrome with page open", targetWsUrl !== "");
    if (targetWsUrl === "") return;

    cdp = new WebSocket(targetWsUrl);
    await new Promise<void>((resolve, reject) => {
      cdp!.addEventListener("open", () => resolve());
      cdp!.addEventListener("error", () => reject(new Error("cdp ws failed")));
    });
    await cdpSend("Runtime.enable");
    await cdpSend("Page.enable");
    // headless 默认视口 ~800×600，侧栏会折叠成图标模式（找不到文字按钮）。
    // 先改视口再**重载**：应用按初始化时的容器宽度决定折叠，事后 resize 不回弹。
    await cdpSend("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdpSend("Page.reload");
    await waitFor("page reloaded", async () => (await evaluate<string>("document.title")) === "MoyuBot", 15000);
    await evaluate(reactInputJs);
    // 兜底：还是折叠态就点「展开侧栏」
    await evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="展开侧栏"]');
      if (btn !== null) btn.click();
      return btn !== null;
    })()`);
    await sleep(500);

    // 1. 等 app 挂载（不依赖侧栏元素形态 —— 折叠/展开两种态结构不同）
    await waitFor("app mount + daemon connect", async () => {
      const ready = await evaluate<string>(
        `document.title === "MoyuBot" && window.__awbSetReactValue !== undefined ? "yes" : "no"`,
      );
      return ready === "yes";
    }, 20000);
    // 2. 进自动化页：侧栏动作钮带 aria-label（折叠成图标态也在）
    await evaluate(`(() => {
      const hit = document.querySelector('button[aria-label="自动化"]');
      if (hit === null) return false;
      hit.click();
      return true;
    })()`);
    await waitFor("automations page header", async () => {
      return (await evaluate<boolean>(`document.body.innerText.includes("定时巡航与自动化触发")`)) === true;
    });

    // 3. 新建对话框（页面头部的「新建」在 DOM 里晚于侧栏/顶栏的同名钮，取最后一个）
    await evaluate(`(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent?.replace(/\\s+/g, "") === "新建");
      const hit = btns.at(-1);
      if (hit === undefined) return false;
      hit.click();
      return true;
    })()`);
    const dialogOpened = await waitFor("create dialog", async () => {
      return (await evaluate<boolean>(`document.querySelector('[role="dialog"][aria-label="新建自动化"]') !== null`)) === true;
    });
    check("create dialog opens", dialogOpened);
    if (!dialogOpened) return;

    // 4. 填单：名称 / 提示词；单元默认第一个（新家已有 steward 总管）
    const fillState = await evaluate<string>(`(() => {
      const set = window.__awbSetReactValue;
      const name = document.querySelector('[aria-label="新建自动化"] input[placeholder^="例如"]');
      if (name === null) return "no name input";
      set(name, "E2E 冒烟任务");
      const ta = document.querySelector('[aria-label="新建自动化"] textarea');
      if (ta === null) return "no prompt textarea";
      set(ta, "E2E：回答 1+1 然后结束");
      const unitSel = document.querySelector('[aria-label="新建自动化"] select');
      if (unitSel === null || unitSel.options.length === 0) return "no unit options";
      return "ok";
    })()`);
    check("form filled", fillState === "ok", fillState);
    await sleep(300);

    // 5. 提交
    await evaluate(`(() => {
      const btns = [...document.querySelectorAll('[role="dialog"] button')];
      const hit = btns.find((b) => b.textContent?.trim() === "创建");
      if (hit === undefined) return false;
      hit.click();
      return true;
    })()`);
    const created = await waitFor("card appears (UI)", async () => {
      return (await evaluate<boolean>(`document.body.innerText.includes("E2E 冒烟任务")`)) === true;
    }, 8000);
    check("card appears in UI after create", created);
    if (!created) {
      // 失败时把对话框留在屏上的话捞出来 —— banner 里的报错就是根因
      const dialogText = await evaluate<string>(
        `(() => { const d = document.querySelector('[role="dialog"]'); return d === null ? "(dialog closed)" : d.innerText.slice(0, 400); })()`,
      );
      console.error("  dialog on failure:", dialogText);
    }

    const afterCreate = await call<Array<{ id: number; name: string; enabled: boolean; unitId: string; cron: string; scheduleRule: { frequency: string; hour: number; minute: number } | null }>>("automation.list", null);
    const mine = afterCreate.find((a) => a.name === "E2E 冒烟任务");
    check("automation persisted in daemon", mine !== undefined, afterCreate.map((a) => a.name));
    check("scheduleRule stored (daily 09:00)", mine?.scheduleRule?.frequency === "daily" && mine?.scheduleRule?.hour === 9, mine?.scheduleRule);
    check("card shows unit binding", (mine?.unitId ?? "") !== "");

    if (mine === undefined) return;

    // 5b. 一次性（delayMinutes）创建：回归「delay 分支同时发 maxRuns 被 create 拒」
    //     的缺陷 —— 修好前这条路径 100% 报「delayMinutes 是一次性任务，不能配 maxRuns」。
    await evaluate(`(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent?.replace(/\\s+/g, "") === "新建");
      const hit = btns.at(-1);
      if (hit === undefined) return false;
      hit.click();
      return true;
    })()`);
    const delayDialogOpened = await waitFor("create dialog (one-shot)", async () => {
      return (await evaluate<boolean>(`document.querySelector('[role="dialog"][aria-label="新建自动化"]') !== null`)) === true;
    });
    check("one-shot dialog opens", delayDialogOpened);
    if (delayDialogOpened) {
      const delayFill = await evaluate<string>(`(() => {
        const set = window.__awbSetReactValue;
        const dlg = document.querySelector('[aria-label="新建自动化"]');
        if (dlg === null) return "no dialog";
        const name = dlg.querySelector('input[placeholder^="例如"]');
        if (name === null) return "no name input";
        set(name, "E2E 一次性任务");
        const ta = dlg.querySelector("textarea");
        if (ta === null) return "no textarea";
        set(ta, "E2E 一次性：回答 2+2 然后结束");
        const tab = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === "一次性");
        if (tab === undefined) return "no delay tab";
        tab.click();
        return "ok";
      })()`);
      check("one-shot form filled + delay tab", delayFill === "ok", delayFill);
      await sleep(300);
      // delay 分支渲染出分钟输入后再填
      await evaluate(`(() => {
        const set = window.__awbSetReactValue;
        const num = document.querySelector('[aria-label="新建自动化"] input[type="number"]');
        if (num === null) return false;
        set(num, "3");
        return true;
      })()`);
      await sleep(200);
      await evaluate(`(() => {
        const btns = [...document.querySelectorAll('[role="dialog"] button')];
        const hit = btns.find((b) => b.textContent?.trim() === "创建");
        if (hit === undefined) return false;
        hit.click();
        return true;
      })()`);
      const delayCard = await waitFor("one-shot card appears (UI)", async () => {
        return (await evaluate<boolean>(`document.body.innerText.includes("E2E 一次性任务")`)) === true;
      }, 8000);
      check("one-shot create accepted (no maxRuns conflict)", delayCard);
      const afterDelay = await call<Array<{ id: number; name: string; recurring: boolean; maxRuns: number | null; scheduleRule: { frequency: string } | null }>>("automation.list", null);
      const delayRow = afterDelay.find((a) => a.name === "E2E 一次性任务");
      check("one-shot persisted recurring=false maxRuns=1", delayRow?.recurring === false && delayRow?.maxRuns === 1, delayRow);
      check("one-shot rule is custom interval", delayRow?.scheduleRule?.frequency === "custom", delayRow?.scheduleRule);
      // 立刻删掉，别让 3 分钟后真的替 steward 起会话
      if (delayRow !== undefined) await call("automation.delete", { id: delayRow.id });
    }

    // 6. 开关：点 role=switch → daemon 侧 enabled 变 false（持久化真值）
    await evaluate(`(() => {
      const sw = [...document.querySelectorAll('[role="switch"]')].at(-1);
      if (sw === undefined) return false;
      sw.click();
      return true;
    })()`);
    const toggled = await waitFor("daemon enabled=false after toggle", async () => {
      const list = await call<Array<{ id: number; enabled: boolean }>>("automation.list", null);
      return list.find((a) => a.id === mine.id)?.enabled === false;
    });
    check("toggle persists to daemon", toggled);

    // 7. 菜单删除（两段式确认）
    await evaluate(`(() => {
      const more = [...document.querySelectorAll('button[aria-label$="更多操作"]')].at(-1);
      if (more === undefined) return false;
      more.click();
      return true;
    })()`);
    await waitFor("menu open", async () => (await evaluate<boolean>(`document.body.innerText.includes("运行记录")`)) === true);
    await evaluate(`(() => {
      const items = [...document.querySelectorAll("button")];
      const del = items.reverse().find((b) => b.textContent?.trim() === "删除");
      if (del === undefined) return false;
      del.click();
      return true;
    })()`);
    await sleep(400); // 等菜单项重渲染成「确认删除？」
    await evaluate(`(() => {
      const items = [...document.querySelectorAll("button")];
      const del = items.reverse().find((b) => b.textContent?.trim() === "确认删除？");
      if (del === undefined) return false;
      del.click();
      return true;
    })()`);
    const deleted = await waitFor("card removed from UI", async () => {
      return (await evaluate<boolean>(`!document.body.innerText.includes("E2E 冒烟任务")`)) === true;
    }, 8000);
    check("card removed from UI after delete", deleted);
    const afterDelete = await call<Array<{ id: number }>>("automation.list", null);
    check("automation deleted in daemon", afterDelete.find((a) => a.id === mine.id) === undefined);

    // 截图留档
    const shot = await cdpSend<{ data: string }>("Page.captureScreenshot", { format: "png" });
    if (shot?.data !== undefined) {
      writeFileSync(path.join(backendScriptsDir, "e2e-automation-ui-last.png"), Buffer.from(shot.data, "base64"));
    }
  } finally {
    killChrome();
    // 打开的 WebSocket 会吊住事件循环 —— 断干净，进程才能自然退出
    ws?.close();
    cdp?.close();
  }
}

await main().catch((err: unknown) => {
  console.error("e2e-automation-ui: crashed", err);
  killChrome();
  process.exit(1);
});
