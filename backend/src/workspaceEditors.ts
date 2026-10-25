/**
 * 外部编辑器检测与打开 —— 头部「打开方式」按钮的 daemon 侧实现
 * （workspace.listEditors / workspace.openInEditor）。
 *
 * 移植自 ZCode 的 packages/desktop/src/main/editors.ts 与 openInEditor.ts，
 * 语义逐条对齐（去掉 Electron 图标部分，daemon 是纯 Node）：
 * - 静态编辑器清单：登记 Windows exe 候选路径（LocalAppData\Programs
 *   与 Program Files 两族）+ CLI 命令名 + macOS 应用名；
 * - 探测链（resolveEditorAppPath）：exe 候选 existsSync → 由 CLI 命令位置反推
 *   相邻 exe（where.exe code 命中 bin\code.cmd 时，上一级就是 Code.exe 所在）→
 *   where.exe 命中的命令本身；
 * - 打开链（openInEditorApp）：Windows 直启解析到的 exe（explorer 同款
 *   detached + stdio ignore，脱离父进程管道 GUI 才能起窗）；exe 找不到时用
 *   cmd.exe /c 走 where.exe 命中的 CLI 兜底；macOS 先 CLI 后 `open -a`；
 * - 结果缓存：existsSync / where.exe 都是 IO，应用生命周期内探测一次即够。
 *
 * 只支持 VS Code：曾按 ZCode 清单登记过 Cursor / Trae / Antigravity，实测砍掉
 * —— 三者 PATH 里都没有 CLI（where.exe 查不到），只能 exe 直启，打开行为各有
 * 不稳（工作区识别 / 窗口派发）；需要时按 EditorDef 结构登记即可加回。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.ts";

export interface WorkspaceEditorInfo {
  id: string;
  name: string;
}

export interface OpenInEditorResult {
  ok: boolean;
  path: string;
  error?: string;
}

interface EditorDef {
  id: string;
  name: string;
  /** Windows exe 候选路径（LocalAppData\Programs / Program Files 两族都登记） */
  winExeCandidates: string[];
  /** CLI 命令名：where.exe 探测用；探测到还能反推相邻 exe */
  winCommand: string | null;
  /** CLI 反推 exe 时，在命令所在目录（及其上一级）找这些文件名 */
  winCommandAppNames: string[];
  /** macOS `open -a` 应用名（.app 前缀） */
  macApp: string;
  /** unix（macOS / Linux）CLI 命令名：PATH 里有就直接起（macOS 还能省一次 open -a 的应用名解析） */
  unixCommand: string | null;
}

/** LocalAppData\Programs —— VS Code 的默认安装位置 */
function localProgramsDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs");
}

function programFilesDirs(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return Array.from(
    new Set(
      [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        `${systemDrive}\\Program Files`,
        `${systemDrive}\\Program Files (x86)`,
      ].filter((p): p is string => typeof p === "string" && p.length > 0),
    ),
  );
}

const EDITOR_DEFS: EditorDef[] = [
  {
    id: "vscode",
    name: "VS Code",
    winExeCandidates: [
      path.join(localProgramsDir(), "Microsoft VS Code", "Code.exe"),
      ...programFilesDirs().map((root) => path.join(root, "Microsoft VS Code", "Code.exe")),
    ],
    winCommand: "code",
    winCommandAppNames: ["Code.exe"],
    macApp: "Visual Studio Code",
    unixCommand: "code",
  },
];

/** where.exe 探测命令位置（ZCode resolveWindowsCommandPaths 同款：1s 超时 + existsSync 过滤） */
function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

/** unix 上命令是否在 PATH（Linux 列编辑器用）。走 POSIX shell 内建 command -v：
 *  不依赖外部 which 二进制（NixOS / 精简容器可能没装）；1s 超时防慢速网络目录挂 PATH。 */
function unixCommandExists(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** 由 CLI 命令位置反推相邻 exe：PATH 里常见的是 bin\code.cmd，真实 exe 在上一级 */
function deriveWindowsAppPathsFromCommand(def: EditorDef): string[] {
  if (!def.winCommand || def.winCommandAppNames.length === 0) return [];
  const candidates: string[] = [];
  for (const commandPath of resolveWindowsCommandPaths(def.winCommand)) {
    const commandDir = path.dirname(commandPath);
    for (const appRoot of Array.from(new Set([commandDir, path.dirname(commandDir)]))) {
      for (const appName of def.winCommandAppNames) {
        candidates.push(path.join(appRoot, appName));
      }
    }
  }
  return Array.from(new Set(candidates)).filter((candidate) => existsFile(candidate));
}

function existsFile(target: string): boolean {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

/** 探测链：exe 候选 → CLI 反推 exe → where.exe 命中的命令本身 */
function resolveEditorLaunchTarget(def: EditorDef): { exe?: string; cli?: string } {
  const exe =
    def.winExeCandidates.find((candidate) => existsFile(candidate)) ??
    deriveWindowsAppPathsFromCommand(def)[0];
  if (exe) return { exe };
  const cliHit = def.winCommand ? resolveWindowsCommandPaths(def.winCommand)[0] : undefined;
  return cliHit ? { cli: cliHit } : {};
}

/**
 * 起一个脱离父进程的 GUI 启动器（index.ts launchFileManager 同款纪律）：
 * ⚠ 'error' 必须有人接，否则 spawn 失败会变成未捕获异常把 daemon 带下去。
 */
function launchDetached(file: string, args: string[], label: string, targetPath: string): boolean {
  try {
    const p = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    p.on("error", (err) => log.warn(`${label} spawn failed`, { err: err.message, path: targetPath }));
    p.unref();
    return true;
  } catch (err) {
    log.warn(`${label} spawn threw`, { err, path: targetPath });
    return false;
  }
}

/** 系统文件管理器的展示名（explorer id 由 index.ts 的 openFolder 通道处理，这里只给名字） */
export function fileManagerEditorName(): string {
  if (process.platform === "win32") return "资源管理器";
  if (process.platform === "darwin") return "Finder";
  return "文件管理器";
}

let cachedEditors: WorkspaceEditorInfo[] | null = null;

/**
 * 已安装编辑器清单（含排在最前的系统文件管理器）。
 * ZCode getInstalledEditors 同款：应用生命周期内缓存，探测 IO 只花一次。
 * Linux 没有 .app 白名单可探，用 which 探 CLI（code 官方脚本装法）。
 */
export function listInstalledEditors(): { editors: WorkspaceEditorInfo[] } {
  if (cachedEditors) return { editors: cachedEditors };

  const editors: WorkspaceEditorInfo[] = [{ id: "explorer", name: fileManagerEditorName() }];
  for (const def of EDITOR_DEFS) {
    const installed =
      process.platform === "win32"
        ? Object.keys(resolveEditorLaunchTarget(def)).length > 0
        : process.platform === "darwin"
          ? true // macOS 不做 .app existsSync 白名单探测，交给 open -a 报错兜底
          : def.unixCommand !== null && unixCommandExists(def.unixCommand);
    if (installed) editors.push({ id: def.id, name: def.name });
  }
  cachedEditors = editors;
  return { editors: cachedEditors };
}

/**
 * 用指定编辑器打开工作区目录（ZCode openInEditor 的本地目录分支）。
 * 返回 ok:false 时 error 带可直接展示的原因（如「未找到 VS Code 的安装位置」）。
 */
export function openInEditorApp(editorId: string, rawTargetPath: string): OpenInEditorResult {
  const def = EDITOR_DEFS.find((editor) => editor.id === editorId);
  if (!def) return { ok: false, path: rawTargetPath, error: `未知编辑器: ${editorId}` };

  const targetPath = path.resolve(rawTargetPath);
  const winPath = targetPath.replace(/\//g, "\\");
  if (process.platform === "win32") {
    const { exe, cli } = resolveEditorLaunchTarget(def);
    if (exe && launchDetached(exe, [winPath], `openWith ${def.id}`, targetPath)) {
      return { ok: true, path: targetPath };
    }
    // exe 候选全空时的兜底：where.exe 命中的多半是 .cmd shim，
    // 直接 spawn .cmd 不行（Node 不解析 PATHEXT），借 cmd.exe /c 转发。
    if (cli && launchDetached("cmd.exe", ["/c", cli, winPath], `openWith ${def.id} cli`, targetPath)) {
      return { ok: true, path: targetPath };
    }
    return { ok: false, path: targetPath, error: `未找到 ${def.name} 的安装位置` };
  }

  if (process.platform === "darwin") {
    if (def.unixCommand && launchDetached(def.unixCommand, [targetPath], `openWith ${def.id} cli`, targetPath)) {
      return { ok: true, path: targetPath };
    }
    if (launchDetached("open", ["-a", def.macApp, targetPath], `openWith ${def.id}`, targetPath)) {
      return { ok: true, path: targetPath };
    }
    return { ok: false, path: targetPath, error: `打开 ${def.name} 失败（未安装？）` };
  }

  // Linux：只有 CLI 在 PATH 才有机会（code 官方脚本装法），否则如实失败
  if (def.unixCommand && launchDetached(def.unixCommand, [targetPath], `openWith ${def.id} cli`, targetPath)) {
    return { ok: true, path: targetPath };
  }
  return { ok: false, path: targetPath, error: `Linux 上未找到 ${def.name} 命令行入口` };
}
