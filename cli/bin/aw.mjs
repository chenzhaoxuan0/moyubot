#!/usr/bin/env node
/**
 * aw —— agent-workbench 命令行客户端（docs/21 D3）。
 *
 * 两层命令面：
 *   透传层 `aw call <method>`   全方法直达（agent 的兜底面；GUI 有而 call 打不到 = 缺口 bug）
 *   动词层  `aw bot/backlog/git/session …` 高频域的人机工效（长尾一律走 call）
 *
 * 纪律：stdout 只放数据（--json 强制机器口径），诊断走 stderr。
 * 退出码：0 成功 / 2 用法错 / 3 RPC 错（ok:false，error.code 进 stderr 首行）/ 4 传输错（连不上/401/非 200）。
 * 零运行时依赖（node ≥22 原生 fetch / WebSocket）；token 与 GUI 等权（docs/21 D7）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const VERSION = "0.1.0";
const DEFAULT_URL = "http://127.0.0.1:5281";

/** 与 daemon 侧 methods.meta.ts 的 danger 面同源（CLI 本地缓存，避免每次调用多一跳） */
const DANGER = new Set([
  "daemon.stop",
  "git.push",
  "git.worktree.remove",
  "bot.put",
  "computerControl.setEnabled",
  "mcp.save",
  "mcp.remove",
]);

const VALUE_FLAGS = new Set([
  "url", "token", "params", "params-file", "domain", "session", "since",
  "bot", "text", "file", "goal", "unit", "root", "id", "message", "paths", "wait", "attach",
  "model", "runtime", "title", "name", "prompt", "in", "at", "cron", "note",
]);

/** 布尔 flag：`--json=true` 这类 = 形式统一归一成 boolean（严格 === true 的消费点才不被静默绕过） */
const BOOLEAN_FLAGS = new Set(["json", "yes", "follow", "new", "create-root", "h", "help"]);

// 管道下游先关（`aw events --follow | head`）：EPIPE 是正常结束不是错误
process.stdout.on("error", (err) => {
  if (err !== null && typeof err === "object" && err.code === "EPIPE") process.exit(0);
  throw err;
});

class UsageError extends Error {}
class TransportError extends Error {}

// ---- 参数 ------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.h = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) {
        flags[key] = a.slice(eq + 1);
      } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  for (const k of BOOLEAN_FLAGS) {
    if (typeof flags[k] === "string") flags[k] = flags[k] === "true" || flags[k] === "1";
  }
  return { flags, positional };
}

const HELP = `aw ${VERSION} —— agent-workbench 命令行客户端（docs/21）

透传层（全方法直达，agent 兜底面）：
  aw call <method> [--params JSON | --params-file <path|->]   调任意 RPC 方法
  aw methods [--domain <前缀>]                                方法自描述清单

动词层（高频域）：
  aw bot list | inspect --root <path> | put --file <unit.json> [--create-root]
  aw bot ask --bot <id> --text <t> [--wait <ms>]
  aw session list | messages --id <sid> | send --id <sid> --text <t> | cancel --id <sid>
  aw session chat (--bot <id> | --unit <uid> --root <p>) --text <t> [--attach p1,p2]
                  [--model m] [--runtime r] [--session <sid>] [--new] [--wait <ms>]
  aw automation list                                        #id 开关 下次触发 名字
  aw automation add --unit <uid> --root <p> --runtime <r> --prompt <t>
                    (--in <分钟> | --at <YYYY-MM-DDTHH:MM> | --cron <五段>) [--name <n>]
  aw automation on|off --id <n>                             启用 / 停用（改定义走 aw call automation.update）
  aw automation run|runs|rm --id <n>                        立即跑 / 运行记录 / 删除
  aw backlog list | add --goal <g> --unit <uid> --root <path> [--title <t>]
  aw backlog run --id <n>                                   立即执行一条待办（确认门照旧）
  aw backlog done --id <n>          验收通过（仅「待验收」态；新建议先执行后验收）
  aw backlog reject --id <n> [--note <原因>]        验收打回，回到就绪重新排队
  aw git status --root <path> | commit --root <path> --message <m> [--paths a,b]

事件面：
  aw events --session <sid> [--since <seq>]        补拉会话事件（JSONL）
  aw events --follow [--session <sid>]             跟随事件流（WS → JSONL，Ctrl-C 断开）

自检：
  aw doctor                                        daemon 可达性 / 版本 / 方法面 / 执行器

全局：--url <base>  --token <t>  --json（机器口径输出）  --yes（跳过危险面确认）
连接发现：--url > AGENT_WORKBENCH_URL > ${DEFAULT_URL}
token：--token > AGENT_WORKBENCH_TOKEN > $AGENT_WORKBENCH_HOME|~/.agent-workbench/token
退出码：0 成功 / 2 用法错 / 3 RPC 错 / 4 传输错`;

// ---- 连接 ------------------------------------------------------------------

function discover(flags) {
  const baseUrl = (typeof flags.url === "string" ? flags.url : process.env.AGENT_WORKBENCH_URL) ?? DEFAULT_URL;
  if (baseUrl.trim() === "") throw new UsageError("--url 不能为空");
  let token = typeof flags.token === "string" ? flags.token : process.env.AGENT_WORKBENCH_TOKEN;
  let tokenFrom = typeof flags.token === "string" ? "--token" : token !== undefined ? "env" : null;
  if (token === undefined) {
    // 相对路径按当次 cwd 解析会跨目录漂移——统一 resolve
    const home = path.resolve(process.env.AGENT_WORKBENCH_HOME ?? path.join(homedir(), ".agent-workbench"));
    const tokenFile = path.join(home, "token");
    if (existsSync(tokenFile)) {
      try {
        token = readFileSync(tokenFile, "utf8").trim();
        tokenFrom = `file:${tokenFile}`;
      } catch {
        tokenFrom = `unreadable:${tokenFile}`; // 读不了（权限等）：按未配置处理，doctor 会如实报
      }
    }
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, tokenFrom };
}

let rpcSeq = 0;

async function rpc({ flags, method, params, timeoutMs }) {
  const { baseUrl, token } = discover(flags);
  // 危险面确认：交互判定与提示输出流对齐（stdin 可问 + stderr 可答），管道场景
  // （stdout 重定向）不该静默免确认
  if (DANGER.has(method) && flags.yes !== true && process.stdin.isTTY && process.stderr.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`⚠️  危险方法 ${method}，确认执行？[y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.error("已取消");
      process.exit(2);
    }
  }
  let res;
  try {
    res = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token !== undefined ? { "x-awb-token": token } : {}) },
      body: JSON.stringify({ v: 1, id: `aw-${++rpcSeq}`, method, params: params ?? null }),
      signal: AbortSignal.timeout(timeoutMs ?? 120_000),
    });
  } catch (err) {
    throw new TransportError(`connect failed: ${baseUrl} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new TransportError(`HTTP ${res.status} from ${baseUrl}/rpc`);
  const body = await res.json().catch(() => null);
  if (body === null || typeof body !== "object" || body.v !== 1) throw new TransportError("bad response envelope from /rpc");
  return body;
}

/** 调用并在 ok:false 时按纪律退出（exit 3） */
async function call(flags, method, params, timeoutMs) {
  const body = await rpc({ flags, method, params, timeoutMs });
  if (body.ok !== true) {
    const e = body.error ?? {};
    const extra = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
    console.error(`rpc error ${e.code ?? "internal"}: ${e.message ?? "unknown"}${extra}`);
    process.exit(3);
  }
  return body.result;
}

// ---- 输出 ------------------------------------------------------------------

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function requireFlag(flags, name, hint) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") throw new UsageError(`缺少 --${name}${hint === undefined ? "" : `（${hint}）`}`);
  return v;
}

/** 数值 flag：非有限数字直接用法错（exit 2），绝不把 NaN 序列化成 null 静默发给 daemon */
function numFlag(flags, name, hint) {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要数字${hint === undefined ? "" : `（${hint}）`}`);
  return n;
}

// ---- 命令 ------------------------------------------------------------------

async function cmdCall(flags, positional) {
  const method = positional[0];
  if (method === undefined) throw new UsageError("用法：aw call <method> [--params JSON | --params-file <path|->]");
  let params = null;
  try {
    if (typeof flags["params-file"] === "string") {
      const raw = flags["params-file"] === "-" ? await readStdin() : readFileSync(flags["params-file"], "utf8");
      params = raw.trim() === "" ? null : JSON.parse(raw);
    } else if (typeof flags.params === "string") {
      params = JSON.parse(flags.params);
    }
  } catch (err) {
    throw new UsageError(`params 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const result = await call(flags, method, params);
  printJson(result ?? null);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdMethods(flags) {
  const result = await call(flags, "rpc.methods", null);
  const list = result?.methods ?? [];
  const domain = typeof flags.domain === "string" ? flags.domain : null;
  const filtered = domain === null ? list : list.filter((m) => m.method.startsWith(`${domain}.`));
  if (flags.json === true) {
    printJson(filtered);
    return;
  }
  for (const m of filtered) {
    process.stdout.write(`${m.danger === "high" ? "⚠️ " : "  "}${m.method}\t${m.paramsHint ?? ""}\t${m.description ?? ""}\n`);
  }
}

async function cmdBot(flags, sub) {
  if (sub === "list") {
    const bots = await call(flags, "bot.list", null);
    if (flags.json === true) return printJson(bots);
    for (const b of bots) process.stdout.write(`${b.id}\t${b.name ?? ""}\t${b.rootPath ?? ""}\n`);
    return;
  }
  if (sub === "inspect") {
    const rootPath = requireFlag(flags, "root", "目录路径");
    return printJson(await call(flags, "bot.inspect", { rootPath }));
  }
  if (sub === "put") {
    const file = requireFlag(flags, "file", "unit JSON 文件");
    let unit;
    try {
      unit = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new UsageError(`unit 文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    return printJson(await call(flags, "bot.put", { unit, ...(flags["create-root"] === true ? { createRoot: true } : {}) }));
  }
  if (sub === "ask") {
    const botId = requireFlag(flags, "bot", "bot id");
    const text = requireFlag(flags, "text", "消息文本");
    const waitMs = numFlag(flags, "wait", "等待毫秒");
    return printJson(
      await call(flags, "bot.ask", { botId, text, ...(waitMs !== undefined ? { waitMs } : {}) }, (waitMs ?? 180_000) + 15_000),
    );
  }
  throw new UsageError("用法：aw bot list | inspect --root <p> | put --file <unit.json> | ask --bot <id> --text <t>");
}

async function cmdSession(flags, sub) {
  if (sub === "list") {
    const sessions = await call(flags, "session.list", null);
    if (flags.json === true) return printJson(sessions);
    for (const s of sessions) {
      process.stdout.write(`${s.id}\t${s.unitName ?? s.unitId ?? ""}\t${s.runtimeId ?? ""}\t${s.status ?? ""}\n`);
    }
    return;
  }
  if (sub === "messages" || sub === "cancel") {
    const sessionId = requireFlag(flags, "id", "session id");
    return printJson(await call(flags, sub === "messages" ? "session.messages" : "session.cancel", { sessionId }));
  }
  if (sub === "send") {
    const sessionId = requireFlag(flags, "id", "session id");
    const text = requireFlag(flags, "text", "消息文本");
    return printJson(await call(flags, "session.send", { sessionId, text }));
  }
  if (sub === "chat") {
    const text = requireFlag(flags, "text", "消息文本");
    const params = { text };
    if (typeof flags.session === "string") params.sessionId = flags.session;
    else if (typeof flags.bot === "string") params.botId = flags.bot;
    else {
      params.unitId = requireFlag(flags, "unit", "unit id（或用 --bot）");
      params.rootPath = requireFlag(flags, "root", "工作目录");
    }
    if (typeof flags.attach === "string") {
      params.attachments = flags.attach.split(",").map((p) => p.trim()).filter((p) => p !== "");
    }
    if (typeof flags.runtime === "string") params.runtimeId = flags.runtime;
    if (typeof flags.model === "string") params.model = flags.model;
    if (flags.new === true) params.newSession = true;
    const waitMs = numFlag(flags, "wait", "等待毫秒");
    if (waitMs !== undefined) params.waitMs = waitMs;
    // rpc 超时对齐 --wait：等轮落定可能远超默认 120s，客户端先 abort 会把「慢」误报成「连不上」
    const result = await call(flags, "session.chat", params, (waitMs ?? 180_000) + 15_000);
    if (flags.json === true) return printJson(result);
    process.stdout.write(`${(result.reply ?? "") + "\n"}`);
    console.error(`session ${result.sessionId}  ${result.status}${result.continued ? "  续聊" : "  新段"}  model=${result.model ?? `auto(${result.modelOrigin})`}`);
    return;
  }
  throw new UsageError("用法：aw session list | chat | messages --id <sid> | send --id <sid> --text <t> | cancel --id <sid>");
}

async function cmdBacklog(flags, sub) {
  if (sub === "list") {
    const view = await call(flags, "backlog.list", null);
    if (flags.json === true) return printJson(view);
    for (const it of view?.items ?? []) {
      process.stdout.write(`#${it.id}\t[${it.status ?? "?"}]\t${it.title ?? it.goal ?? ""}\n`);
    }
    return;
  }
  if (sub === "add") {
    const goal = requireFlag(flags, "goal", "待办目标");
    const unitId = requireFlag(flags, "unit", "unit id");
    const rootPath = requireFlag(flags, "root", "工作目录");
    const created = await call(flags, "backlog.create", {
      goal,
      unitId,
      rootPath,
      ...(typeof flags.title === "string" ? { title: flags.title } : {}),
    });
    return printJson(created);
  }
  if (sub === "done") {
    const id = numFlag(flags, "id", "待办 id");
    if (id === undefined) throw new UsageError("缺少 --id（待办 id）");
    return printJson(await call(flags, "backlog.review", { id, pass: true }));
  }
  if (sub === "reject") {
    const id = numFlag(flags, "id", "待办 id");
    if (id === undefined) throw new UsageError("缺少 --id（待办 id）");
    return printJson(
      await call(flags, "backlog.review", { id, pass: false, ...(typeof flags.note === "string" ? { note: flags.note } : {}) }),
    );
  }
  if (sub === "run") {
    const id = numFlag(flags, "id", "待办 id");
    if (id === undefined) throw new UsageError("缺少 --id（待办 id）");
    return printJson(await call(flags, "backlog.runNow", { id }));
  }
  throw new UsageError(
    "用法：aw backlog list | add --goal <g> --unit <uid> --root <path> [--title t] | run --id <n> | done --id <n> | reject --id <n> [--note 原因]",
  );
}

async function cmdAutomation(flags, sub) {
  if (sub === "list") {
    const list = await call(flags, "automation.list", null);
    if (flags.json === true) return printJson(list);
    for (const a of list ?? []) {
      const next = a.nextRunAt === null || a.nextRunAt === undefined ? "—" : new Date(a.nextRunAt).toLocaleString();
      process.stdout.write(`#${a.id}\t${a.enabled === false ? "off" : "on"}\t${next}\t${a.name ?? ""}\n`);
    }
    return;
  }
  if (sub === "add") {
    const unitId = requireFlag(flags, "unit", "unit id");
    const rootPath = requireFlag(flags, "root", "工作目录");
    const runtimeId = requireFlag(flags, "runtime", "执行器裸 id（如 zcode）");
    const prompt = requireFlag(flags, "prompt", "提示词（自包含、直接描述最终工作、无人值守）");
    // 调度三选一（对齐 daemon 的 automation.create 口径）：
    // --in N（分钟后，一次性）| --at 本地时刻（一次性）| --cron 五段（循环）
    const inMin = numFlag(flags, "in", "N 分钟后");
    const atRaw = typeof flags.at === "string" && flags.at !== "" ? flags.at : undefined;
    const cron = typeof flags.cron === "string" && flags.cron !== "" ? flags.cron : undefined;
    const given = [inMin !== undefined, atRaw !== undefined, cron !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UsageError("调度三选一：--in <分钟> | --at <YYYY-MM-DDTHH:MM> | --cron <五段表达式>");
    const params = { unitId, rootPath, runtimeId, prompt, ...(typeof flags.name === "string" && flags.name !== "" ? { name: flags.name } : {}) };
    if (inMin !== undefined) params.delayMinutes = inMin;
    else if (atRaw !== undefined) {
      const t = Date.parse(atRaw);
      if (!Number.isFinite(t)) throw new UsageError(`--at 解析失败：${atRaw}（示例 2026-10-25T09:00，本地时区）`);
      params.runAt = t;
    } else params.cron = cron;
    return printJson(await call(flags, "automation.create", params));
  }
  if (sub === "on" || sub === "off") {
    const id = numFlag(flags, "id", "自动化 id");
    if (id === undefined) throw new UsageError("缺少 --id（自动化 id，aw automation list 查）");
    return printJson(await call(flags, "automation.setEnabled", { id, enabled: sub === "on" }));
  }
  if (sub === "run" || sub === "runs" || sub === "rm") {
    const id = numFlag(flags, "id", "自动化 id");
    if (id === undefined) throw new UsageError("缺少 --id（自动化 id，aw automation list 查）");
    const method = sub === "run" ? "automation.runNow" : sub === "runs" ? "automation.runs" : "automation.delete";
    return printJson(await call(flags, method, { id }));
  }
  throw new UsageError(
    "用法：aw automation list | add --unit <uid> --root <p> --runtime <r> --prompt <t> (--in <分钟> | --at <时刻> | --cron <五段>) [--name <n>] | on|off|run|runs|rm --id <n>（改定义走 aw call automation.update）",
  );
}

async function cmdGit(flags, sub) {
  if (sub === "status") {
    const rootPath = requireFlag(flags, "root", "仓库路径");
    const s = await call(flags, "git.status", { rootPath });
    if (flags.json === true) return printJson(s);
    if (s.isRepo !== true) {
      process.stdout.write(`not a repo: ${rootPath}\n`);
      return;
    }
    process.stdout.write(`${s.branch ?? "(detached)"}\t↑${s.ahead ?? 0} ↓${s.behind ?? 0}\tdirty=${s.dirtyFileCount ?? 0}\n`);
    return;
  }
  if (sub === "commit") {
    const rootPath = requireFlag(flags, "root", "仓库路径");
    const message = requireFlag(flags, "message", "提交信息");
    const paths = typeof flags.paths === "string" ? flags.paths.split(",").map((p) => p.trim()).filter((p) => p !== "") : undefined;
    return printJson(await call(flags, "git.commit", { rootPath, message, ...(paths === undefined ? {} : { paths }) }));
  }
  throw new UsageError("用法：aw git status --root <path> | commit --root <p> --message <m> [--paths a,b]");
}

async function cmdEvents(flags) {
  const session = typeof flags.session === "string" ? flags.session : null;
  if (flags.follow === true) {
    if (flags.since !== undefined) {
      throw new UsageError("--follow 从连接时刻跟随新事件，不回放——补拉请去掉 --follow（--since 属于补拉口径）");
    }
    const { baseUrl, token } = discover(flags);
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws" + (token === undefined ? "" : `?token=${encodeURIComponent(token)}`);
    // 错误信息永不带 query（token 在里面）——凭证不进日志/CI 是硬规矩
    const shownUrl = wsUrl.replace(/\?token=.*/, "?token=***");
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      throw new UsageError(`ws 地址不合法：${shownUrl}（${err instanceof Error ? err.message : String(err)}）`);
    }
    let gotFrames = false;
    ws.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type !== "event") return;
      if (session !== null && frame.event?.sessionId !== session) return;
      gotFrames = true;
      process.stdout.write(JSON.stringify({ seq: frame.seq, event: frame.event }) + "\n");
    });
    ws.addEventListener("error", () => {
      console.error(`transport error: ws connect failed: ${shownUrl}`);
      process.exit(4);
    });
    // daemon 断开/关停：说清楚再退，别让进程静默消失（一帧没有 = 连了就断，按传输错）
    ws.addEventListener("close", () => {
      console.error(`ws closed: ${shownUrl}${gotFrames ? "" : "（未收到任何帧）"}`);
      process.exit(gotFrames ? 0 : 4);
    });
    return; // 常驻：Ctrl-C 由 node 默认退出
  }
  if (session === null) throw new UsageError("补拉需要 --session <sid>（跟随全量事件流用 --follow）");
  const since = numFlag(flags, "since", "游标 seq");
  const result = await call(flags, "session.events.since", { sessionId: session, ...(since === undefined ? {} : { afterSeq: since }) });
  for (const row of result ?? []) process.stdout.write(JSON.stringify(row) + "\n");
}

async function cmdDoctor(flags) {
  const { baseUrl, tokenFrom } = discover(flags);
  console.error(`url     ${baseUrl}`);
  console.error(`token   ${tokenFrom ?? "(none — daemon 未开鉴权或有别的门？)"}`);
  const health = await call(flags, "health", null);
  const methods = await call(flags, "rpc.methods", null);
  const adapters = await call(flags, "adapter.list", null);
  console.error(`daemon  ${health.version}  pid=${health.pid}  uptime=${Math.round(health.uptimeMs / 1000)}s`);
  console.error(`methods ${methods.count}（${(methods.methods ?? []).filter((m) => m.description !== undefined).length} 条带元数据）`);
  console.error(`adapters ${adapters.length} 个执行器：${adapters.map((a) => a.id).join(", ")}`);
  if (flags.json === true) printJson({ url: baseUrl, health, methodCount: methods.count, adapters: adapters.map((a) => a.id) });
}

// ---- 入口 ------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.h === true || flags.help === true || positional.length === 0) {
    process.stdout.write(HELP + "\n");
    return;
  }
  const [cmd, sub] = positional;
  switch (cmd) {
    case "call": return cmdCall(flags, positional.slice(1));
    case "methods": return cmdMethods(flags);
    case "bot": return cmdBot(flags, sub);
    case "session": return cmdSession(flags, sub);
    case "backlog": return cmdBacklog(flags, sub);
    case "automation": return cmdAutomation(flags, sub);
    case "git": return cmdGit(flags, sub);
    case "events": return cmdEvents(flags);
    case "doctor": return cmdDoctor(flags);
    default: throw new UsageError(`未知命令：${cmd}（aw --help 看用法）`);
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`用法错：${err.message}`);
    process.exit(2);
  }
  if (err instanceof TransportError) {
    console.error(`transport error: ${err.message}`);
    process.exit(4);
  }
  console.error(`error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
