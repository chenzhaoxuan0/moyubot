/**
 * 共享 Chrome（接管模式）的发现与拉起 —— docs/14 §2.3。
 *
 * 生命周期口径：
 * - 端口从 9333 起探测（Chrome Fleet 社区惯例段），选定的端口持久化进
 *   browser-control.json，playwright 条目与 dsh 注入因此跨重启稳定；
 * - 启动前先打 /json/version 健康检查：上一代 daemon 崩溃留下的 Chrome 还活着
 *   就直接收编（adopt），避免「同 profile 二次启动被旧进程吞掉后子进程秒退」
 *   的 Chrome 单实例委派陷阱；
 * - 停止走 taskkill /T /F（Windows 上杀进程树——Chrome 的子进程不杀干净会
 *   占住 profile 锁）。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.ts";

/** 默认调试端口基址（被占则上浮，最多试 7 个） */
export const SHARED_CHROME_BASE_PORT = 9333;
const PORT_TRIES = 7;

export interface ChromiumCandidate {
  readonly executable: string;
  readonly kind: "chrome" | "edge";
}

/** 存在且可执行：unix 用 X_OK（existsSync 过不掉 stale 非可执行文件/目录占位） */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 系统浏览器发现：Chrome 优先，Edge 兜底（Chromium 系都能 CDP，三平台各自的常见落点） */
export function findChromium(preferred: "chrome" | "msedge"): ChromiumCandidate | null {
  const prefer: readonly ("chrome" | "edge")[] = preferred === "chrome" ? ["chrome", "edge"] : ["edge", "chrome"];
  const pools = chromiumCandidates();
  for (const kind of prefer) {
    for (const p of pools[kind]) if (isExecutableFile(p)) return { executable: p, kind };
  }
  return null;
}

/** 各平台的 Chrome / Edge 可执行文件候选，按优先级排列。
 *  刻意不登记 snap chromium 与 Ubuntu 的 chromium-browser 过渡 shim：
 *  snap 沙箱禁止写 $HOME 下的隐藏目录（--user-data-dir 指向 ~/.agent-workbench
 *  必然失败），宁可诚实报「未找到」也不要 8 秒超时后给一个误导性错误。 */
export function chromiumCandidates(): Record<"chrome" | "edge", string[]> {
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const la = process.env["LOCALAPPDATA"] ?? "";
    return {
      chrome: [
        join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        ...(la !== "" ? [join(la, "Google", "Chrome", "Application", "chrome.exe")] : []),
      ],
      edge: [
        join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        ...(la !== "" ? [join(la, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
      ],
    };
  }
  if (process.platform === "darwin") {
    const home = homedir();
    return {
      chrome: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ],
      edge: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
      ],
    };
  }
  // Linux：发行版包名各异（google-chrome / chromium），另有 deb 直装落点
  return {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/opt/google/chrome/chrome",
    ],
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/edge/microsoft-edge"],
  };
}

/** CDP 健康检查：端口上是不是一个活的调试端点 */
export async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 收编前校验：端口上的调试端点必须自报 Chromium 系（Browser 字段含 Chrome/Edg）。
 * 否则那可能是用户日常浏览器或别的工具的调试端口——收编它等于把真实登录态
 * 交给所有执行器，且 executable/kind 会描述一个完全不同的二进制。
 */
async function cdpIsChromium(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return false;
    const v = (await res.json()) as { Browser?: unknown };
    return typeof v.Browser === "string" && /Chrome|Edg\//.test(v.Browser);
  } catch {
    return false;
  }
}

/** 预定一个空闲 TCP 端口（listen(0) 拿系统分配，随即关掉——有极小的抢占窗口，可接受） */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** 从基址起找一个没被监听的端口 */
export async function pickSharedPort(): Promise<number> {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = SHARED_CHROME_BASE_PORT + i;
    if (!(await portInUse(port))) return port;
  }
  return reservePort();
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
  });
}

export interface SharedChromeHandle {
  readonly child: ChildProcess | null; // adopt 时为 null
  readonly port: number;
  readonly executable: string;
  readonly kind: "chrome" | "edge";
}

/**
 * 拉起共享 Chrome（或收编存量实例）。user-data-dir 由调用方传入（daemon 家目录下）。
 * 返回 null = 找不到可执行文件。
 */
export async function launchSharedChrome(
  preferred: "chrome" | "msedge",
  userDataDir: string,
  preferPort: number | undefined,
): Promise<SharedChromeHandle | { error: string }> {
  const candidate = findChromium(preferred);
  if (candidate === null) {
    return { error: "找不到 Chrome / Edge 可执行文件（未安装或路径非标准）" };
  }
  let port = preferPort ?? (await pickSharedPort());
  if (await cdpIsChromium(port)) {
    // 收编存量（上一代 daemon 崩溃残留 / 用户手动同参数启动）——只认自报
    // Chromium 的端点（cdpIsChromium），防止误收用户日常浏览器的调试端口
    log.info("shared chrome adopted on existing debug port", { port });
    return { child: null, port, executable: candidate.executable, kind: candidate.kind };
  }
  if (await portInUse(port)) port = await pickSharedPort();

  let child: ChildProcess;
  try {
    child = spawn(
      candidate.executable,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        // 注意：不传 --restore-last-session —— Chromium 的 kRestoreLastSession 是
        // 存在性开关，带 =false 反而强制恢复上次全部标签页，跨会话越积越多
      ],
      { stdio: "ignore", detached: false, windowsHide: false },
    );
  } catch (e) {
    // spawn 同步抛（ENOENT/EACCES 等）——收窄成 {error}，别让调用方的 void boot() 变 unhandledRejection
    return { error: `拉起 ${candidate.executable} 失败：${e instanceof Error ? e.message : String(e)}` };
  }
  // Chrome 单实例委派：若同 profile 已有进程，新进程会把命令行交给旧进程后立刻退出。
  // 我们启动前已确认端口无人监听，正常路径不会走到这；防御性记录退出码。
  child.once("exit", (code) => {
    log.info("shared chrome process exited", { code });
  });
  // 等调试端口就绪（Chrome 起得慢，最多 8s）
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    if (await cdpAlive(port)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(await cdpAlive(port))) {
    killTree(child.pid);
    return { error: "共享 Chrome 启动后调试端口未就绪（8s 内 /json/version 无响应）" };
  }
  return { child, port, executable: candidate.executable, kind: candidate.kind };
}

/**
 * Windows 杀进程树；非 Windows 或无 pid 静默放过。
 * 返回 taskkill/kill 是否成功——调用方据此决定要不要验尸（端口是否真熄灭）。
 */
export function killTree(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], (err) => resolve(err === null));
    } else {
      try {
        process.kill(pid, "SIGTERM");
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}
