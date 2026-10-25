/**
 * 执行器可执行文件解析 —— Windows npm shim 的坑在这里一次解决。
 *
 * Node spawn 在 win32 上不能直接跑 .cmd/.bat（CVE-2024-27980 之后强制要求 shell，
 * 而 shell:true 会把用户 prompt 里的引号/中文送进 cmd 转义地狱）。
 * 正确姿势：解析 npm shim 里的真实 node 脚本路径，spawn node + script；
 * 原生 .exe（codex 这类）直接 spawn。
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "../log.ts";

const execFileP = promisify(execFile);

export interface ResolvedCommand {
  /** 要 spawn 的可执行文件（node.exe / pwsh.exe / 原生 exe） */
  readonly file: string;
  /** file 之后的固定前缀参数（node 脚本路径 / pwsh -File 脚本路径） */
  readonly prefixArgs: readonly string[] | readonly string[];
  /** 解析方式，日志与排障用 */
  readonly via: "exe" | "npm-shim" | "ps-shim" | "shim-fallback";
}

const cache = new Map<string, ResolvedCommand>();

/**
 * 本机有没有 pwsh（PowerShell 7）。查一次就缓存。
 *
 * ⚠ 缓存的是 **Promise** 而不是「查过了」的布尔位：以前先置 pwshChecked=true
 * 再 await，并发的第二个调用者会看到 true 但 pwshOk 还是 false，于是走了
 * cmd.exe 兜底 —— 而 resolveCommand 会把这个结果永久缓存，之后每次 spawn
 * 都从 cmd.exe 走（那条路会截断多行 argv，就是「飞书回复只剩第一行」那个事故）。
 */
let pwshProbe: Promise<boolean> | null = null;

function hasPwsh(): Promise<boolean> {
  pwshProbe ??= locateOnPath("pwsh").then((p) => p.length > 0);
  return pwshProbe;
}

async function locateOnPath(name: string): Promise<string[]> {
  const out = process.platform === "win32"
    ? await execFileP("where.exe", [name]).catch(() => ({ stdout: "", stderr: "" }))
    : await execFileP("which", [name]).catch(() => ({ stdout: "", stderr: "" }));
  const hits = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (hits.length > 0) return hits;

  // 兜底：长驻进程中若在外部刚安装了新工具，当前 process.env.PATH 尚未继承
  // Windows Registry / unix shell rc 写入的新 PATH —— 「装完点重探还是未安装」的根因。
  // 按各 CLI 官方安装器的默认落点逐个 existsSync，确保即装即用。
  // unix 之前完全没有这层（直接返回 []），macOS/Linux 上同一类问题照发。
  const home = homedir();
  const suffixes = process.platform === "win32" ? [".cmd", ".ps1", ".exe"] : [""];
  const dirs =
    process.platform === "win32"
      ? [
          path.join(home, ".grok", "bin"),                          // grok 官方脚本
          path.join(home, ".codex", "bin"),                          // codex 原生安装器
          path.join(home, ".opencode", "bin"),                       // opencode 官方脚本
          path.join(home, "AppData", "Local", "cursor-agent"),       // cursor 官方脚本
          path.join(home, "AppData", "Roaming", "npm"),              // npm 全局 shim
          path.join(home, ".cargo", "bin"),
          path.join(home, ".local", "bin"),                          // claude 原生安装器
        ]
      : [
          path.join(home, ".local", "bin"),
          path.join(home, ".grok", "bin"),
          path.join(home, ".codex", "bin"),
          path.join(home, ".opencode", "bin"),
          path.join(home, ".cargo", "bin"),
          path.join(home, ".npm-global", "bin"),                     // 自定义 npm prefix 的常见位
          "/usr/local/bin",
          "/opt/homebrew/bin",                                       // Apple Silicon Homebrew
        ];
  const candidates = dirs.flatMap((dir) => suffixes.map((sfx) => path.join(dir, `${name}${sfx}`)));
  const found = candidates.filter((p) => existsSync(p));
  if (found.length > 0) return found;
  return [];
}

/**
 * npm 的 .cmd shim 里藏着真实的 node 调用行。**四种形态**都要认：
 *   1) `"C:\...\node.exe" "C:\...\script.js" %*`    完整 node 路径式
 *   2) `node "C:\...\script.cjs" %*`                 裸 node 式（zcode 的 shim）
 *   3) `... & "%_prog%"  "%dp0%\...\run.js" %*`     **现代 npm 作用域包**（lark-cli / mcode）
 *   4) `"%dp0%\node_modules\...\run.js"`            任意 %dp0% 形式的 .js
 *
 * 形态 3 是 2026-10-04 踩到的：前两种正则都匹配不上 → 掉进 cmd.exe 兜底 →
 * **参数里的换行被 cmd 当命令分隔符吃掉**，飞书回复只剩第一行
 * （实测 `unknown command "echo" for "lark-cli"`：只有第一行当命令，其余被丢弃）。
 *
 * 所以 shim 里的路径是**批处理变量**（`%dp0%` / `%~dp0%` / `%_prog%`），
 * 必须拿 shim 自己的目录代入，不能当字面路径用。
 */
function parseCmdShim(shimPath: string): { node: string; script: string } | null {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null; // 读不了就走 fallback
  }
  const shimDir = path.dirname(shimPath);
  /** %dp0% / %~dp0% → shim 所在目录；批处理里的 \ 换成 / 再交给 path 解析 */
  const sub = (p: string): string => p.replace(/%~dp0%|%dp0%/gi, shimDir);

  const m =
    text.match(/"%_prog%"\s+"([^"]+\.(?:c|m)?js)"/i) ??                 // 形态 3
    text.match(/"[^"]*node(?:\.exe)?"\s+"([^"]+\.(?:c|m)?js)"/i) ??    // 形态 1
    text.match(/(?:^|[\s&(])node(?:\.exe)?\s+"?([^"\r\n]+\.(?:c|m)?js)"?/im) ?? // 形态 2
    text.match(/"%dp0%[\\/]?([^"]+\.(?:c|m)?js)"/i);                    // 形态 4
  const raw = m?.[1];
  if (raw === undefined || raw === "") return null;

  const script = path.resolve(shimDir, sub(raw));
  if (!existsSync(script)) return null; // 解析出来但文件不在 → 老实走 fallback

  // node 二进制：shim 里写明了就用它（可能是随包自带的 node.exe），否则用当前进程
  const nodeM = text.match(/"([^"]*node(?:\.exe)?)"/i);
  const node = nodeM?.[1] !== undefined && existsSync(nodeM[1]) ? nodeM[1] : process.execPath;
  return { node, script };
}

export async function resolveCommand(name: string): Promise<ResolvedCommand> {
  const hit = cache.get(name);
  if (hit) return hit;

  const candidates = await locateOnPath(name);
  if (candidates.length === 0) {
    throw Object.assign(new Error(`executable not found on PATH: ${name}`), { code: "not_installed" });
  }

  let resolved: ResolvedCommand | null = null;
  // .exe 优先（codex 这类原生二进制）
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) {
    resolved = { file: exe, prefixArgs: [], via: "exe" };
  } else {
    const shim = candidates.find((c) => /\.cmd$/i.test(c)) ?? candidates[0];
    if (shim && /\.cmd$/i.test(shim)) {
      const parsed = parseCmdShim(shim);
      if (parsed && existsSync(parsed.script)) {
        resolved = { file: parsed.node, prefixArgs: [parsed.script], via: "npm-shim" };
      } else {
        // shim 解析不出 node 脚本时的兜底。**优先走 .ps1 孪生兄弟**：
        // PowerShell 的参数传递比 cmd.exe 可预测得多（cmd.exe /c 会把多行参数
        // 当命令分隔符吃掉 —— 这正是飞书回复只剩第一行的根因）。
        // mcode 走的就是这条：它的 shim 是自更新发布器（读 `current` 再调
        // .mcode-launcher.cmd），静态解析不出 node 脚本，但有可用的 .ps1 孪生。
        const ps1 = shim.replace(/\.cmd$/i, ".ps1");
        if (existsSync(ps1) && await hasPwsh()) {
          resolved = { file: "pwsh", prefixArgs: ["-NoProfile", "-File", ps1], via: "ps-shim" };
        } else {
          // 兜底：过一层 cmd.exe。
          //
          // ⚠️ **这条路径会吃掉参数里的换行** —— cmd.exe /c 把多行参数当命令分隔符，
          //   只有第一行被当成命令，其余静默丢弃（实测 `unknown command "echo"`，而我们
          //   想传的其实是 `echo 第一行\n第二行`）。所以它只对「prompt 走协议通道而非
          //   argv」的执行器无害（ACP / app-server 这类）；**任何把多行文本塞进 argv
          //   的调用方（飞书回复、telegram 回复）必须先确认 resolveCommand 没走这里**。
          log.warn("shim fallback to cmd.exe —— 多行 argv 会被截断，检查该 CLI 的 shim 形态", {
            name,
            shim,
          });
          resolved = { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", shim], via: "shim-fallback" };
        }
      }
    } else if (shim) {
      resolved = { file: shim, prefixArgs: [], via: "exe" };
    }
  }
  if (resolved === null) {
    throw Object.assign(new Error(`cannot resolve executable: ${name}`), { code: "not_installed" });
  }
  cache.set(name, resolved);
  return resolved;
}

// ---- 行式子进程 ------------------------------------------------------------

export interface SpawnLinesOptions {
  readonly cwd?: string;
  /** 追加环境变量（如 ELECTRON_RUN_AS_NODE），叠加在 process.env 之上 */
  readonly env?: NodeJS.ProcessEnv;
  readonly onLine: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  readonly onExit?: (code: number | null) => void;
  /**
   * spawn 后立即关 stdin（默认 true）：一次性 CLI（prompt 全在 argv）必须关，
   * 否则 codex 会停在 stdin 读取上；长驻协议进程（zcode app-server）必须传 false
   * —— stdin 就是它的协议通道，EOF = 优雅退出。
   */
  readonly closeStdin?: boolean;
}

export function spawnLines(cmd: ResolvedCommand, args: readonly string[], opts: SpawnLinesOptions) {
  const child = spawn(cmd.file, [...cmd.prefixArgs, ...args], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
  });
  if (opts.closeStdin !== false) child.stdin?.end();
  if (child.stdout) createInterface({ input: child.stdout }).on("line", opts.onLine);
  if (opts.onStderrLine && child.stderr) {
    createInterface({ input: child.stderr }).on("line", opts.onStderrLine);
  }
  let settled = false;
  child.on("exit", (code) => {
    settled = true;
    opts.onExit?.(code);
  });
  // ⚠ spawn 失败（ENOENT / EPERM / EACCES —— 例如 CLI 在 resolveCommand 缓存之后被
  // 卸载或锁住）时 Node **只发 'error'，不发 'close'**，而所有适配器都在
  // `await new Promise(r => child.once("close", r))`：没有这个补发，那一轮永远不结算
  // ——turnBusy 一直是 true、会话永远 running、后续消息静默排队、CLI 有没有装都没人知道。
  child.on("error", (err) => {
    log.warn("spawn failed", { file: cmd.file, error: err.message });
    if (settled) return;
    settled = true;
    opts.onExit?.(null);
    child.emit("close", null, null);
  });
  return child;
}

/** 一次性子进程：收集 stdout 全部输出直到退出（版本号探测用），带超时 */
export async function execLines(
  cmd: ResolvedCommand,
  args: readonly string[],
  timeoutMs = 15000,
  opts?: { readonly env?: NodeJS.ProcessEnv },
): Promise<string> {
  const child = spawn(cmd.file, [...cmd.prefixArgs, ...args], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
  });
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`exec timeout after ${timeoutMs}ms`), { code: "probe_timeout" }));
    }, timeoutMs);
    createInterface({ input: child.stdout! }).on("line", (l) => chunks.push(l));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(chunks.join("\n"));
    });
  });
}
