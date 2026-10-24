/**
 * 搜索桥的安装器 —— `<homeDir>/mcp/search-bridge.mjs` 的唯一出处。
 *
 * 桥是零依赖的 node 脚本（node ≥22 原生 fetch），被各执行器按 MCP stdio 拉起。
 * 装在 homeDir 而不是引用仓库路径：仓库会移动/重装，homeDir（默认
 * ~/.agent-workbench）是 daemon 的常驻领地，条目里的绝对路径才长期有效。
 *
 * 安装纪律对齐 ctrl/skills.ts：内容随仓库版本化，启动时按 sha256 比对，
 * 不一致才重写（daemon 端口等参数烘进脚本，端口变更 = 内容变更 = 自动重装）；
 * 只写自己的文件，停用不删（脚本本身无害，删家目录文件不是服务该做的事）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { logControlAction } from "../ctrl/store.ts";

/** 桥脚本内容：__DAEMON_URL__ 由安装器替换（daemon 实际端口烘进去） */
const BRIDGE_SOURCE = `#!/usr/bin/env node
/**
 * agent-workbench 搜索桥 —— workbench-search（MCP stdio server）。
 * 由执行器 CLI 拉起：会话 cwd 即 bot 工作区（--root 可显式覆盖）。
 * 工具面只有 web_search；真实搜索与密钥都在 daemon 侧，本进程只做转发。
 * 零依赖：node >= 22 原生 fetch。daemon 不可达时 fail-open（工具照常列出，
 * 调用时把「连不上工作台」如实报给模型，比一个空工具清单的哑服务器诚实）。
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const awbHome = process.env.AGENT_WORKBENCH_HOME || path.join(homedir(), ".agent-workbench");
const baseUrl = (
  argOf("url") || process.env.AGENT_WORKBENCH_ENDPOINT || "__DAEMON_URL__"
).replace(/\\/+$/, "");
const token =
  argOf("token") ||
  process.env.AGENT_WORKBENCH_TOKEN ||
  (() => {
    try {
      return readFileSync(path.join(awbHome, "token"), "utf8").trim() || null;
    } catch {
      return null;
    }
  })();
const rootOverride = argOf("root") || null;

async function rpc(method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + "/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-awb-token": token } : {}),
      },
      body: JSON.stringify({ v: 1, method, params }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
      const msg =
        body !== null && typeof body === "object" && body.error && body.error.message
          ? String(body.error.message)
          : "HTTP " + res.status;
      throw new Error("daemon RPC " + method + " 失败：" + msg);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

const WEB_SEARCH = {
  name: "web_search",
  description:
    "联网搜索。返回若干条结果（标题 / 链接 / 摘要），可能附一段直接答案。查实时信息、不确定的事实、或需要引用来源时先用它。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索词（中英文均可）" },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "返回条数（缺省 5）",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

async function respond(msg) {
  const id = msg.id;
  try {
    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "workbench-search", version: "0.1.0" },
        },
      };
    }
    if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (msg.method === "tools/list") {
      // 问一次 daemon：这个工作区配没配搜索。没配 → 空工具清单（对 bot 不可见）；
      // 问不出来（daemon 没起/超时）→ fail-open 照常列出。
      try {
        const r = await rpc(
          "search.sessionTools",
          { cwd: process.cwd(), root: rootOverride },
          2500,
        );
        const tools = r && Array.isArray(r.tools) ? r.tools : ["web_search"];
        return { jsonrpc: "2.0", id, result: { tools: tools.includes("web_search") ? [WEB_SEARCH] : [] } };
      } catch {
        return { jsonrpc: "2.0", id, result: { tools: [WEB_SEARCH] } };
      }
    }
    if (msg.method === "tools/call") {
      const name = (msg.params && msg.params.name) || "";
      const args = (msg.params && msg.params.arguments) || {};
      if (name !== "web_search") {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "未知工具：" + name }], isError: true },
        };
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "参数 query 必须是非空字符串" }], isError: true },
        };
      }
      const maxResults = typeof args.max_results === "number" && args.max_results >= 1 ? Math.min(10, Math.round(args.max_results)) : 5;
      try {
        const r = await rpc(
          "search.query",
          { cwd: process.cwd(), root: rootOverride, query, maxResults },
          120000,
        );
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: String((r && r.text) || "（无结果）") }] },
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  "搜索失败：" +
                  (e && e.message ? e.message : String(e)) +
                  (e && e.name === "AbortError"
                    ? "（daemon 在 " + baseUrl + " 不可达或超时；工作台没开时搜索不可用）"
                    : ""),
              },
            ],
            isError: true,
          },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not supported: " + String(msg.method) } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e && e.message ? e.message : String(e) } };
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 坏行丢弃：MCP 是逐条 JSON-RPC，不毒化整条流
  }
  if (msg === null || typeof msg !== "object") return;
  if (msg.id === undefined || msg.id === null) return; // 通知（含 initialized）不回包
  respond(msg).then(send, (e) =>
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e && e.message ? e.message : String(e) } }),
  );
});

// stdin 关了（执行器退出）就安静走：不挂着事件循环
process.stdin.on("close", () => process.exit(0));
`;

function bridgeContent(daemonUrl: string): string {
  return BRIDGE_SOURCE.replaceAll("__DAEMON_URL__", daemonUrl);
}

export function bridgePath(stateHome: string): string {
  return join(stateHome, "mcp", "search-bridge.mjs");
}

/**
 * 确保 <homeDir>/mcp/search-bridge.mjs 是当前版本（sha256 比对，变了才写）。
 * 返回 {path, changed}。
 */
export function ensureBridgeScript(stateHome: string, daemonPort: number): { path: string; changed: boolean } {
  const target = bridgePath(stateHome);
  const content = bridgeContent(`http://127.0.0.1:${daemonPort}`);
  const sha = createHash("sha256").update(content, "utf8").digest("hex");
  if (existsSync(target)) {
    try {
      const prev = readFileSync(target, "utf8");
      if (createHash("sha256").update(prev, "utf8").digest("hex") === sha) {
        return { path: target, changed: false };
      }
    } catch {
      // 读不了就当不存在，直接覆写
    }
  }
  mkdirSync(join(stateHome, "mcp"), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
  log.info("search bridge installed", { path: target });
  logControlAction("search", "bridge.install", `搜索桥已安装/更新 → ${target}`);
  return { path: target, changed: true };
}
