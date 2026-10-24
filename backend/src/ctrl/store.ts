/**
 * 浏览器 / 电脑控制的共享存储（docs/14）—— 两个控制服务与 dsh 适配器共用的叶子模块。
 *
 * 职责刻意收窄：
 * - 配置文件读写（<homeDir>/browser-control.json、computer-control.json，坏文件 fail-open 回默认）；
 * - 动作日志环形缓冲（domain 无关，两域共用序号空间，前端按 domain 过滤）；
 * - dsh 的 ACP mcpServers 动态注入出口：服务层注册 provider，适配器侧只 import 本模块，
 *   不产生 services → adapter 的反向依赖。
 *
 * 本模块不 import mcpadmin / browserctl / computerctl —— 方向永远是别人 import 它。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AcpMcpServer,
  BrowserControlConfig,
  ComputerControlConfig,
  ControlActionEntry,
} from "../contract.ts";

/** 写进各执行器原生配置的 MCP 条目名（docs/14 §1 Q12） */
export const BROWSER_ENTRY_NAME = "playwright";
export const COMPUTER_ENTRY_NAME = "workbench-computer";

/** 电脑控制 MCP 端点（daemon HTTP 面上的裸路由） */
export const COMPUTER_MCP_PATH = "/mcp/computer";

export const BROWSER_CONTROL_DEFAULT: BrowserControlConfig = {
  enabled: false,
  mode: "isolated",
  browser: "msedge",
};

export const COMPUTER_CONTROL_DEFAULT: ComputerControlConfig = { enabled: false };

// ---- daemon 上下文（启动时注入一次；测试可反复注入） ----------------------------

interface ControlContext {
  homeDir: string;
  /** daemon 实际 HTTP 端口（电脑控制条目 url 用；测试注入随机端口） */
  port: number;
  /** 控制技能的安装目标（默认 ~/.agents/skills；冒烟注入临时目录防副作用） */
  skillsHome: string;
}

let ctx: ControlContext = { homeDir: "", port: 0, skillsHome: join(homedir(), ".agents", "skills") };

export function setControlContext(homeDir: string, port: number, skillsHome?: string): void {
  ctx = { homeDir, port, skillsHome: skillsHome ?? ctx.skillsHome };
}

export function controlHome(): string {
  return ctx.homeDir;
}

export function skillsHomeDir(): string {
  return ctx.skillsHome;
}

export function daemonHttpPort(): number {
  return ctx.port;
}

/** 电脑控制条目的 url（执行器配置与 ACP 注入共用一个口径） */
export function computerMcpUrl(): string {
  return `http://127.0.0.1:${ctx.port}${COMPUTER_MCP_PATH}`;
}

// ---- 配置文件 ------------------------------------------------------------------

function configPath(name: string): string {
  return join(ctx.homeDir, name);
}

function readJson<T>(name: string, fallback: T): T {
  const path = configPath(name);
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // 只认纯对象：数组/标量落进来会被 spread 成垃圾字段（评审收敛）
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...(parsed as object) } as T;
  } catch {
    // 坏文件 fail-open 回默认（显示层照常）；下次显式保存时覆写修复
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  const path = configPath(name);
  mkdirSync(dirname(path), { recursive: true });
  // 临时文件 + rename 的原子写（对齐 mcpadmin 的写安全纪律）：半截 JSON 只会
  // 留在 .tmp 里，正式文件要么旧要么新
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readBrowserControlConfig(): BrowserControlConfig {
  return readJson<BrowserControlConfig>("browser-control.json", BROWSER_CONTROL_DEFAULT);
}

export function writeBrowserControlConfig(cfg: BrowserControlConfig): void {
  writeJson("browser-control.json", cfg);
}

export function readComputerControlConfig(): ComputerControlConfig {
  return readJson<ComputerControlConfig>("computer-control.json", COMPUTER_CONTROL_DEFAULT);
}

export function writeComputerControlConfig(cfg: ComputerControlConfig): void {
  writeJson("computer-control.json", cfg);
}

// ---- 动作日志（环形缓冲 500 条，docs/14 §3.3） -----------------------------------

const ACTION_LIMIT = 500;
const actions: ControlActionEntry[] = [];
let actionSeq = 0;

export function logControlAction(domain: ControlActionEntry["domain"], action: string, detail: string): void {
  actionSeq += 1;
  actions.push({ seq: actionSeq, at: Date.now(), domain, action, detail });
  if (actions.length > ACTION_LIMIT) actions.splice(0, actions.length - ACTION_LIMIT);
}

/** 增量拉取：afterSeq 之后的条目（缺省全部） */
export function controlActions(afterSeq = 0): ControlActionEntry[] {
  return actions.filter((a) => a.seq > afterSeq);
}

// ---- dsh 的 ACP 注入出口 ---------------------------------------------------------

/** 服务层注册「当前应注入 dsh session/new 的 MCP 条目」（启用态才返回非空） */
let acpEntriesProvider: (rootPath?: string) => AcpMcpServer[] = () => [];

export function registerAcpEntriesProvider(fn: (rootPath?: string) => AcpMcpServer[]): void {
  acpEntriesProvider = fn;
}

/**
 * dsh 适配器调用：session/new / session/resume 的 mcpServers 参数。
 * rootPath 是会话工作目录——搜索条目按 bot 区分时要靠它（浏览器/电脑控制忽略）。
 */
export function acpMcpServers(rootPath?: string): AcpMcpServer[] {
  try {
    return acpEntriesProvider(rootPath);
  } catch {
    return []; // 注入面出错不阻断会话（docs/14 §2.4 的降级口径）
  }
}
