/**
 * daemon 配置 —— 环境变量覆盖默认值，不搞配置文件（Phase 0 没有第二处部署形态）。
 *
 * 路径解析锚定在本文件位置而不是 cwd：daemon 可能从任意目录被 spawn
 * （冒烟脚本、未来的前端拉起、开机自启），cwd 不可信。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** backend/ 目录的绝对路径（src/ 的上一级） */
export const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * daemon 默认端口。**只在这里写一次** —— 前端（`prototype/src/adapters/daemon/client.ts`
 * 的 DAEMON_PORT）、MCP 桥（`src/mcp.ts`）与文档都跟着它走。
 *
 * 为什么不是 5181：Windows 的 Hyper-V / WSL 保留了 5141–5240 一整段动态端口，
 * 5181 正在其中，`listen` 会直接 EACCES。踩过两次，别再搬回去。
 */
export const DEFAULT_DAEMON_PORT = 5281;

/** build-daemon 的 esbuild define 注入；tsx 跑源码时未定义（typeof 探测安全） */
declare const __AWB_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __AWB_VERSION__ === "string") return __AWB_VERSION__; // bundle 形态：打包时定格
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(backendRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface DaemonConfig {
  /** 监听地址。默认回环 —— daemon 能 spawn 任意进程，不对外网开门 */
  readonly host: string;
  readonly port: number;
  /**
   * daemon 工作目录（集中存储家，docs/08 存储归位）：
   * 默认 ~/.agent-workbench —— 会话/轨迹/用量/权限/cron/记忆/bot 索引全部收敛在此；
   * bot 的身份文件（AGENTS.md / bot.json）不在这里，跟各自的工作目录走。
   */
  readonly homeDir: string;
  readonly logLevel: LogLevel;
  readonly version: string;
  /**
   * 鉴权 token（docs/08 WP-7）：null = 关闭鉴权（AGENT_WORKBENCH_INSECURE=1，冒烟/本机调试）。
   * 默认开启：AGENT_WORKBENCH_TOKEN 显式指定，否则首启生成落盘 <homeDir>/token。
   * 回环客户端经 GET /bootstrap 免鉴权取 token；非回环（手机/局域网）必须自带。
   */
  readonly token: string | null;
}

/** 旧默认家（backend/.waku）——集中存储迁移的源（docs/08 存储归位） */
export const legacyDefaultHome = path.join(backendRoot, ".waku");

/**
 * 旧家平迁（docs/08 存储归位）：默认 home 改为 ~/.agent-workbench 后，首次启动把
 * backend/.waku 的运行数据整体搬过来（幂等：新家已有 state.db 即跳过）。
 * 必须在 loadConfig 的 token 生成之前跑——否则新 token 先落盘、旧 token 再覆盖，
 * 内存与磁盘就分叉了（实测踩过：迁移后用盘上 token 连不上，401）。
 * bot 身份文件不在迁移范围——它们跟各自的工作目录走。
 */
function migrateLegacyHome(newHome: string, legacyHome: string): void {
  if (existsSync(path.join(newHome, "state.db"))) return;
  if (!existsSync(path.join(legacyHome, "state.db"))) return;
  mkdirSync(newHome, { recursive: true });
  const items = ["state.db", "state.db-wal", "state.db-shm", "traces", "usage.jsonl", "eval_runs.jsonl", "token", "memory", "compare"];
  for (const item of items) {
    const from = path.join(legacyHome, item);
    if (!existsSync(from)) continue;
    try {
      cpSync(from, path.join(newHome, item), { recursive: true });
    } catch (err) {
      console.warn(`[config] legacy migrate item failed: ${item}`, err);
    }
  }
  console.info(`[config] legacy home migrated → centralized home: ${legacyHome} → ${newHome}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const rawLevel = env["AGENT_WORKBENCH_LOG_LEVEL"];
  const logLevel =
    rawLevel !== undefined && (LOG_LEVELS as readonly string[]).includes(rawLevel)
      ? (rawLevel as LogLevel)
      : "info";

  const homeOverride = env["AGENT_WORKBENCH_HOME"];
  const homeDir = homeOverride !== undefined && homeOverride !== ""
    ? homeOverride
    : path.join(os.homedir(), ".agent-workbench");
  // 平迁只属于「默认家」：显式指定 AGENT_WORKBENCH_HOME（冒烟/隔离环境/第二套安装）时，
  // legacy .waku 与这个家毫无关系 —— 照搬旧库会把过期的权限规则/自动化/会话整体克隆进去，
  // 权限闸从此静默自动放行（phase4「无规则应挂起」实测必挂）。
  if (homeDir === path.join(os.homedir(), ".agent-workbench")) migrateLegacyHome(homeDir, legacyDefaultHome);
  const insecure = env["AGENT_WORKBENCH_INSECURE"] === "1";
  const explicit = env["AGENT_WORKBENCH_TOKEN"];
  let token: string | null;
  if (insecure) {
    token = null;
  } else if (explicit !== undefined && explicit !== "") {
    token = explicit;
  } else {
    // 首启生成落盘；此后随 home 走（state.db 换 home 换 token，隔离成立）
    const tokenFile = path.join(homeDir, "token");
    try {
      token = readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      token = null;
    }
    if (token === null) {
      token = randomUUID().replace(/-/g, "");
      mkdirSync(homeDir, { recursive: true });
      // 评审 P3：tmp+rename 原子落盘（并发首启不读半行）、0600（多用户机器不全局可读）；
      // rename 失败（Windows 上目标已存在 = 并发首启）时采用先到者的 token
      const tmp = `${tokenFile}.${process.pid}.tmp`;
      writeFileSync(tmp, token + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        renameSync(tmp, tokenFile);
      } catch {
        try {
          token = readFileSync(tokenFile, "utf8").trim() || token;
        } catch { /* 保留本进程生成的 token */ }
        try {
          unlinkSync(tmp);
        } catch { /* noop */ }
      }
    }
  }

  return {
    host: env["AGENT_WORKBENCH_HOST"] ?? "127.0.0.1",
    port:
      Number.parseInt(env["AGENT_WORKBENCH_PORT"] ?? String(DEFAULT_DAEMON_PORT), 10) ||
      DEFAULT_DAEMON_PORT,
    homeDir,
    logLevel,
    version: readVersion(),
    token,
  };
}
