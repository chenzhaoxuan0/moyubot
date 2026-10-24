/**
 * 搜索冒烟 —— 全程临时 configHome/stateHome + 假提供商（不打真实搜索 API、
 * 不碰真实执行器配置、不写用户家目录）。
 *
 * 覆盖面：
 * 【1】configure：tavily 配置 → 12 家 workbench-search 条目扇出 + 桥脚本安装（端口烘焙）；
 * 【2】密钥语义：换家自动清旧 key、显式 "" 清除、provider none 删槽收条目（入停用库）；
 * 【3】env: 引用解析（临时 .env + setSecretsHome）；
 * 【4】sessionTools 按 cwd 收口：bot 工作区内暴露 web_search、区外/子目录嵌套、未配置归零；
 * 【5】query：假提供商跑通编排（用量计数、未配置 bot 拒绝、错误透传）；
 * 【6】真跑桥脚本（子进程 node + 假 daemon /rpc）：tools/list 按假 daemon 的答复收口、
 *      daemon 不可达时 fail-open 暴露 web_search。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { Store } from "../src/store/db.ts";
import { setSecretsHome } from "../src/secrets.ts";
import { acpMcpServers, registerAcpEntriesProvider, setControlContext } from "../src/ctrl/store.ts";
import { mcpInventory } from "../src/mcpadmin/service.ts";
import { createSearchService } from "../src/searchctl/service.ts";
import { SEARCH_PROVIDERS, type SearchProviderDef } from "../src/searchctl/providers.ts";
import type { BotDefinition } from "../src/bots/registry.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const root = join(tmpdir(), `agent-workbench-smoke-search-${Date.now()}`);
const configHome = join(root, "fake-user-home");
const stateHome = join(root, "awb-home");
mkdirSync(configHome, { recursive: true });
mkdirSync(stateHome, { recursive: true });

// ---- 夹具 ---------------------------------------------------------------------------

/** 两个假 bot（同根目录下扫描得到；alpha 嵌套 beta 的反面例：beta 在 alpha 外） */
const alphaRoot = join(root, "bots", "alpha");
const betaRoot = join(root, "bots", "beta");
for (const [id, r, name] of [
  ["bot-alpha", alphaRoot, "甲"],
  ["bot-beta", betaRoot, "乙"],
] as const) {
  mkdirSync(join(r, ".agent-workbench"), { recursive: true });
  writeFileSync(
    join(r, ".agent-workbench", "bot.json"),
    JSON.stringify({ id, name, rootPath: r }, null, 2),
    "utf8",
  );
}
const listBots = async (): Promise<BotDefinition[]> => [
  { id: "bot-alpha", name: "甲", rootPath: alphaRoot },
  { id: "bot-beta", name: "乙", rootPath: betaRoot },
];

let fakeSearchCalls = 0;
/** 假 tavily：search 恒成功返回 2 条；quota 恒回 used=3/limit=1000 */
const fakeTavily: SearchProviderDef = {
  ...(SEARCH_PROVIDERS.find((p) => p.id === "tavily")!),
  async search() {
    fakeSearchCalls += 1;
    return {
      text: "1. 假结果\n   https://example.com/a\n   摘要甲\n\n2. 假结果乙\n   https://example.com/b\n   摘要乙",
      resultCount: 2,
      provider: "tavily",
    };
  },
  async quota() {
    return {
      provider: "tavily",
      ok: true,
      plan: "free",
      used: 3,
      limit: 1000,
      remaining: 997,
      balance: null,
      resetsAt: Date.now() + 86_400_000,
      note: null,
      fetchedAt: Date.now(),
    };
  },
};

setControlContext(stateHome, 0);
const store = new Store(join(root, "state.db"));
const search = createSearchService(
  { configHome, stateHome, store, listBots },
  { providerOverride: (id) => (id === "tavily" ? fakeTavily : SEARCH_PROVIDERS.find((p) => p.id === id) ?? null) },
);
registerAcpEntriesProvider((rootPath) => search.acpEntries(rootPath));

async function main(): Promise<void> {
  // ---- 【1】configure + 扇出 + 桥 ----------------------------------------------
  console.log("\n【1】configure → 条目扇出 + 桥安装");
  let st = await search.configure({ botId: "bot-alpha", provider: "tavily", apiKey: "tvly-fake-key-000111" });
  check("status: 已配置 + 掩码（头4尾4）", st.configured === true && st.provider === "tavily" && st.apiKeyMasked === "tvly••••0111", st);
  const row = mcpInventory({ configHome, stateHome }).rows.find((r) => r.name === "workbench-search");
  check("12 家 live 条目", row?.instances.filter((i) => !i.disabled).length === 12, row?.instances.length);
  const claudeEntry = row?.instances.find((i) => i.executorId === "claude" && !i.disabled)?.entry;
  check(
    "条目 command=node + 指向桥脚本（cmd /c 包装由 mcpSave 统一做）",
    (claudeEntry?.command === "node" || claudeEntry?.command === "cmd") && JSON.stringify(claudeEntry?.args ?? []).includes("search-bridge.mjs"),
    claudeEntry,
  );
  const bridge = join(stateHome, "mcp", "search-bridge.mjs");
  check("桥脚本已装且端口占位已替换", existsSync(bridge) && !readFileSync(bridge, "utf8").includes("__DAEMON_URL__"));

  const overview1 = await search.overview();
  check("overview：条目已装 + 甲配置乙未配置", overview1.entryInstalled === true
    && overview1.bots.find((b) => b.botId === "bot-alpha")?.configured === true
    && overview1.bots.find((b) => b.botId === "bot-beta")?.configured === false);

  // ---- 【2】密钥语义 --------------------------------------------------------------
  console.log("\n【2】密钥语义");
  st = await search.configure({ botId: "bot-alpha", provider: "deepseek" }); // 换家不带 key → 清旧 key
  check("换家未给 key → 密钥清空（configured=false）", st.configured === false && st.apiKeySet === false, st);
  st = await search.configure({ botId: "bot-alpha", provider: "tavily", apiKey: "tvly-fake-key-000111" });
  st = await search.configure({ botId: "bot-alpha", provider: "tavily" }); // 同家不带 key → 保持
  check("同家未给 key → 密钥保持", st.configured === true, st);
  st = await search.configure({ botId: "bot-alpha", provider: "tavily", apiKey: "" }); // 显式空串 → 清除
  check("显式空串 → 清除", st.configured === false, st);
  await search.configure({ botId: "bot-alpha", provider: "none" });
  const rowOff = mcpInventory({ configHome, stateHome }).rows.find((r) => r.name === "workbench-search");
  check("provider none → 条目回收进停用库", rowOff !== undefined && rowOff.instances.every((i) => i.disabled) && rowOff.instances.length === 12, rowOff?.instances.length);
  const ovOff = await search.overview();
  check("回收后 overview.entryInstalled=false（回收的 not_found 不算已写入）", ovOff.entryInstalled === false);

  // ---- 【3】env: 引用 -------------------------------------------------------------
  console.log("\n【3】env: 引用");
  writeFileSync(join(stateHome, ".env"), "TAVILY_SMOKE_KEY=tvly-envref-fake99\n", "utf8");
  setSecretsHome(stateHome);
  st = await search.configure({ botId: "bot-alpha", provider: "tavily", apiKey: "env:TAVILY_SMOKE_KEY" });
  check("env: 引用解析成功（configured=true，掩码来自解析值）", st.configured === true && st.apiKeyMasked === "tvly••••ke99", st);

  // ---- 【4】sessionTools 按 cwd 收口 ---------------------------------------------
  console.log("\n【4】sessionTools 收口");
  let tools = await search.sessionTools({ cwd: alphaRoot });
  check("bot 根目录 → web_search", tools.tools.includes("web_search") === true, tools);
  tools = await search.sessionTools({ cwd: join(alphaRoot, "some", "sub", "dir") });
  check("bot 子目录 → web_search（祖先匹配）", tools.tools.includes("web_search") === true, tools);
  tools = await search.sessionTools({ cwd: root });
  check("bot 外目录 → 空", tools.tools.length === 0, tools);
  tools = await search.sessionTools({ cwd: alphaRoot, root: betaRoot });
  check("--root 优先于 cwd（乙未配置 → 空）", tools.tools.length === 0, tools);

  // ---- 【5】query 编排（假提供商）------------------------------------------------
  console.log("\n【5】query 编排");
  const q1 = await search.query({ cwd: alphaRoot, query: "冒烟测试", maxResults: 5 });
  check("返回归一文本（2 条假结果）", q1.resultCount === 2 && q1.text.includes("https://example.com/a"), q1);
  await search.query({ cwd: alphaRoot, query: "第二次" });
  st = await search.status({ botId: "bot-alpha" });
  check("本机月计数 = 2", st.localUsageMonth === 2, st.localUsageMonth);
  // 配额快照（假 usage API）走 search.quota：{botId} 口径
  const quota = await search.quota({ botId: "bot-alpha" });
  check("quota 快照 used=3/limit=1000/remaining=997", quota.ok === true && quota.used === 3 && quota.limit === 1000 && quota.remaining === 997, quota);
  // 未配置 bot 拒绝
  let refused = false;
  try {
    await search.query({ cwd: betaRoot, query: "不该走到这" });
  } catch (e) {
    refused = (e as { code?: string }).code === "search_not_configured";
  }
  check("未配置 bot → search_not_configured", refused);
  // 草稿口径 quota（provider+apiKey 直查）
  const probe = await search.quota({ provider: "tavily", apiKey: "tvly-probe-fake" });
  check("草稿预检口径可用", probe.ok === true && probe.used === 3, probe);

  // ---- 【6】dsh 注入形状 ----------------------------------------------------------
  console.log("\n【6】dsh 注入");
  const injected = acpMcpServers(alphaRoot);
  check("甲的会话注入 1 条 stdio 桥（--root 甲）", injected.length === 1 && injected[0]!.name === "workbench-search"
    && injected[0]!.args?.includes("--root") === true && injected[0]!.args?.includes(alphaRoot) === true, injected);
  // 乙未配置但注入是**有意宽松**的（acpEntries 同步、不扫盘）：条目照给，
  // 收口在桥的 tools/list——service 层已验证（【4】--root 乙 → 空工具）。
  const betaInjected = acpMcpServers(betaRoot).find((e) => e.name === "workbench-search");
  check("乙的会话条目带 --root 乙（收口靠桥问 daemon）", betaInjected !== undefined && betaInjected.args?.includes(betaRoot) === true, betaInjected);

  // ---- 【7】真跑桥脚本（子进程 + 假 daemon）---------------------------------------
  console.log("\n【7】桥脚本协议环");
  // 假 daemon：/rpc 信封按 method 应答 search.sessionTools
  const rpcLog: string[] = [];
  const fakeDaemon: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { method?: string; params?: { cwd?: string; query?: string } };
        rpcLog.push(String(parsed.method));
        let result: unknown = {};
        if (parsed.method === "search.sessionTools") {
          // 甲 → 有工具；其余 → 空
          result = { tools: parsed.params?.cwd === alphaRoot ? ["web_search"] : [] };
        } else if (parsed.method === "search.query") {
          result = { text: "桥回来的假结果：1. 甲 https://example.com/x" };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ v: 1, ok: true, result }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const daemonPort = (fakeDaemon.address() as AddressInfo).port;

  // 桥端口默认 5281——测试用 --url 指到假 daemon
  const bridgeProc = spawn(process.execPath, [bridge, "--url", `http://127.0.0.1:${daemonPort}`], {
    cwd: alphaRoot, // 会话 cwd = 甲的工作区
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridgeOut: unknown[] = [];
  const rl = createInterface({ input: bridgeProc.stdout });
  rl.on("line", (line) => {
    try {
      bridgeOut.push(JSON.parse(line));
    } catch {
      /* 忽略非 JSON 行 */
    }
  });
  const send = (msg: unknown): void => {
    bridgeProc.stdin!.write(`${JSON.stringify(msg)}\n`);
  };
  const waitOut = async (n: number, ms = 8000): Promise<void> => {
    const t0 = Date.now();
    while (bridgeOut.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await waitOut(1);
  const init = bridgeOut[0] as { result?: { serverInfo?: { name?: string } } };
  check("桥 initialize 回 workbench-search", init?.result?.serverInfo?.name === "workbench-search", init);

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await waitOut(2);
  const list = bridgeOut[1] as { result?: { tools?: { name?: string }[] } };
  check("甲 cwd + 假 daemon 答有配置 → 暴露 web_search", list?.result?.tools?.some((t) => t.name === "web_search") === true, list);
  check("桥确实问了 daemon（search.sessionTools）", rpcLog.includes("search.sessionTools"), rpcLog);

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "桥环测试" } } });
  await waitOut(3);
  const call = bridgeOut[2] as { result?: { content?: { text?: string }[]; isError?: boolean } };
  check("web_search 调用经 daemon 返回文本", call?.result?.isError !== true && (call?.result?.content?.[0]?.text ?? "").includes("桥回来的假结果"), call);

  bridgeProc.kill();
  await new Promise<void>((resolve) => {
    bridgeProc.once("exit", () => resolve());
    setTimeout(() => {
      bridgeProc.kill("SIGKILL");
      resolve();
    }, 3000);
  });

  // 桥 fail-open：daemon 不可达（随便指个死端口）→ tools/list 照常暴露
  const deadPort = 1;
  const failOpen = spawn(process.execPath, [bridge, "--url", `http://127.0.0.1:${deadPort}`], {
    cwd: alphaRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const failOut: unknown[] = [];
  const rl2 = createInterface({ input: failOpen.stdout });
  rl2.on("line", (l) => {
    try {
      failOut.push(JSON.parse(l));
    } catch {
      /* 忽略 */
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  failOpen.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`);
  const t0 = Date.now();
  while (failOut.length < 1 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
  const fo = failOut[0] as { result?: { tools?: { name?: string }[] } };
  check("daemon 不可达 → fail-open 暴露 web_search", fo?.result?.tools?.some((t) => t.name === "web_search") === true, fo);
  // Windows 上 cwd 在 root 里的进程没退干净，rmSync 会 EPERM——等退出再清理
  await new Promise<void>((resolve) => {
    failOpen.once("exit", () => resolve());
    failOpen.kill();
    setTimeout(() => {
      failOpen.kill("SIGKILL");
      resolve();
    }, 3000);
  });

  await new Promise<void>((r) => fakeDaemon.close(() => r()));
  store.close(); // state.db 的 WAL 句柄不关，Windows 上 rmSync 会 EPERM

  // ---- 收尾 -----------------------------------------------------------------------
  // 清理尽力而为：句柄/杀进程竞态不该把冒烟判成失败
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.warn(`（临时目录未删净，可手动清理：${root}）`);
  }
  console.log(failures === 0 ? "\n搜索冒烟：全部通过 ✅" : `\n搜索冒烟：${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("smoke crashed:", e);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    console.warn(`（临时目录未删净，可手动清理：${root}）`);
  }
  process.exit(1);
});
