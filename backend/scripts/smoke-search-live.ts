/**
 * 搜索 live 冒烟 —— 自起**真实 daemon**（index.ts 全装配，随机端口 + 显式 token），
 * 走 HTTP-RPC 打 search.* 全链路：bot 注册表 → configure → 真实 mcpadmin 落盘扇出 →
 * sessionTools 收口 → overview。smoke-search.ts 打的是服务层（注入假 home），
 * 这里补「index.ts 装配 + 真实文件系统 + 真实 bot 注册表」这一层。
 *
 * 隔离三件套（绝不碰真实环境）：
 * - AGENT_WORKBENCH_HOME → 临时家（daemon 全部状态）
 * - USERPROFILE → 临时用户目录（os.homedir() 即执行器 configHome）
 * - LOCALAPPDATA → 临时（hermes 在 Windows 的配置根）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
writeSync(1, "live smoke: booting…\n");
const TOKEN = "smoke-search-live-token-0123456789";
const root = mkdtempSync(path.join(os.tmpdir(), "aw-search-live-"));
const smokeHome = path.join(root, "awb-home");
const fakeUser = path.join(root, "fake-user");
mkdirSync(path.join(fakeUser, "AppData", "Local"), { recursive: true });

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  // writeSync 而非 console.log：Windows 重定向下 process.exit 会截断缓冲输出，
  // 用异步日志的冒烟在 CI 里会「静默失败」（本文件踩过的坑，别改回去）
  if (cond) writeSync(1, `  ok   ${name}\n`);
  else {
    failures++;
    writeSync(2, `  FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}\n`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      // ⚠ 必须关掉再放行端口：占着端口的话 daemon 子进程 EADDRINUSE 起不来，
      // 父进程的 health fetch 会连上这个永不应答的探测服务器，整场冒烟挂死
      if (addr !== null && typeof addr === "object") srv.close(() => resolve(addr.port));
      else reject(new Error("no port"));
    });
    srv.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const port = await freePort();
  writeSync(1, `live smoke: freePort=${port}, spawning daemon…\n`);
  const daemon: ChildProcess = spawn(process.execPath, ["--import", "tsx", path.join(backendRoot, "src", "index.ts")], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AGENT_WORKBENCH_PORT: String(port),
      AGENT_WORKBENCH_HOST: "127.0.0.1",
      AGENT_WORKBENCH_TOKEN: TOKEN,
      AGENT_WORKBENCH_HOME: smokeHome,
      USERPROFILE: fakeUser,
      LOCALAPPDATA: path.join(fakeUser, "AppData", "Local"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  writeSync(1, `live smoke: spawn 返回 pid=${daemon.pid}\n`);
  let dead = false;
  daemon.once("exit", () => (dead = true));

  const rpc = async (method: string, params: unknown = null): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-awb-token": TOKEN },
      body: JSON.stringify({ v: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok !== true) {
      throw new Error(`${method} 失败：${body.error?.message ?? `HTTP ${res.status}`}`);
    }
    return body.result;
  };

  // 等 daemon 起来（health 通了再动手）
  const deadline = Date.now() + 40_000;
  let attempt = 0;
  for (;;) {
    if (dead) throw new Error(`daemon died during boot（退出码 ${daemon.exitCode}）`);
    try {
      await rpc("health");
      break;
    } catch (e) {
      attempt += 1;
      if (attempt <= 3 || attempt % 10 === 0) writeSync(1, `live smoke: health 未通（第 ${attempt} 次）：${e instanceof Error ? e.message : String(e)}\n`);
      if (Date.now() > deadline) throw new Error("daemon boot timeout");
      await sleep(400);
    }
  }
  check("daemon 起来了（index.ts 全装配无炸）", true);

  // 注册一个 bot（真实 bot.put → 临时家下的 bot.json + 工作区骨架）
  const botRoot = path.join(root, "bots", "livebot");
  await rpc("bot.put", {
    unit: { id: "bot-live", name: "活体", rootPath: botRoot, bindings: [] },
    createRoot: true,
  });

  writeSync(1, "\n【live-1】未配置态\n");
  const providers = (await rpc("search.providers")) as { id: string }[];
  check("providers 四家", providers.length === 4 && ["tavily", "deepseek", "doubao", "yuanbao"].every((id) => providers.some((p) => p.id === id)), providers);
  const ov0 = (await rpc("search.overview")) as { bots: { botId: string; configured: boolean }[]; entryInstalled: boolean; bridgePath: string };
  const me0 = ov0.bots.find((b) => b.botId === "bot-live");
  check("bot-live 在总览里且未配置", me0?.configured === false, ov0.bots.map((b) => b.botId));
  check("boot 对账后 entryInstalled=false（无配置不装条目）", ov0.entryInstalled === false);
  check("桥脚本已装进临时家", existsSync(ov0.bridgePath) && ov0.bridgePath.startsWith(smokeHome), ov0.bridgePath);

  writeSync(1, "\n【live-2】configure → 真实扇出落盘\n");
  const st = (await rpc("search.configure", { botId: "bot-live", provider: "tavily", apiKey: "tvly-live-dummy-aabb" })) as { configured: boolean; apiKeyMasked: string };
  check("configure 后 configured + 掩码", st.configured === true && st.apiKeyMasked === "tvly••••aabb", st);
  const claudeJson = path.join(fakeUser, ".claude.json");
  check(".claude.json 已写 workbench-search", existsSync(claudeJson) && readFileSync(claudeJson, "utf8").includes("workbench-search"));
  const codexToml = path.join(fakeUser, ".codex", "config.toml");
  check("codex config.toml 已写条目（TOML 写入器真实跑通）", existsSync(codexToml) && readFileSync(codexToml, "utf8").includes("workbench-search"));
  const keyStore = JSON.parse(readFileSync(path.join(smokeHome, "search-keys.json"), "utf8")) as { bots: Record<string, { provider: string }> };
  check("密钥落在临时家 search-keys.json", keyStore.bots["bot-live"]?.provider === "tavily");

  writeSync(1, "\n【live-3】sessionTools 收口 + 状态\n");
  const tools = (await rpc("search.sessionTools", { cwd: botRoot })) as { tools: string[] };
  check("bot 工作区 → web_search", tools.tools.includes("web_search") === true, tools);
  const ov1 = (await rpc("search.overview")) as { bots: { botId: string; configured: boolean }[]; entryInstalled: boolean; fanout: { ok: boolean }[] };
  check("总览：bot-live 已配置 + 条目已装 + 扇出全成", ov1.bots.find((b) => b.botId === "bot-live")?.configured === true
    && ov1.entryInstalled === true && ov1.fanout.length === 12 && ov1.fanout.every((f) => f.ok), ov1.fanout);

  writeSync(1, "\n【live-4】回收\n");
  await rpc("search.configure", { botId: "bot-live", provider: "none" });
  const claudeAfter = existsSync(claudeJson) ? readFileSync(claudeJson, "utf8") : "";
  check("claude 配置里条目已移除", !claudeAfter.includes("workbench-search"), claudeAfter.slice(0, 120));
  const ov2 = (await rpc("search.overview")) as { entryInstalled: boolean };
  check("entryInstalled 回到 false", ov2.entryInstalled === false);

  // 收摊：daemon.stop（优雅退出）后清临时目录
  try {
    await rpc("daemon.stop");
  } catch {
    daemon.kill();
  }
  await new Promise<void>((resolve) => {
    daemon.once("exit", () => resolve());
    setTimeout(() => {
      daemon.kill();
      resolve();
    }, 8000);
  });
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`（临时目录未删净，可手动清理：${root}）`);
  }
  writeSync(1, failures === 0 ? "\n搜索 live 冒烟：全部通过 ✅\n" : `\n搜索 live 冒烟：${failures} 项失败 ❌\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  // Windows 重定向下 console.error 是异步的，紧跟 process.exit 会整段截断——
  // 崩溃原因必须同步落盘（fs.writeSync）才看得见
  const msg = `live smoke crashed: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}\n`;
  try {
    writeSync(2, msg);
  } catch {
    /* stderr 不可写时的最后手段 */
    console.error(msg);
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* 尽力 */
  }
  process.exitCode = 1;
});
