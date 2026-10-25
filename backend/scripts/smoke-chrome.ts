/**
 * 跨平台发现层契约冒烟 —— 三平台 CI 矩阵各跑各的真实平台分支（docs/06 冒烟体例）：
 *   1. chromiumCandidates 池形状：非空、绝对路径、无重复、平台特征（win32 全 .exe、
 *      darwin 全在 .app/Contents/MacOS 下、linux 无 snap/过渡 shim）；
 *   2. findChromium 两种偏好：null 或 {executable 存在且可执行, kind 合法}；
 *   3. SDK 解释器候选表：win32 含 py -3 兜底、unix python3 优先。
 * 封闭性：纯本机路径探测，不起 daemon、不装浏览器、不碰网络。
 * 跑法：cd backend && pnpm smoke:chrome
 */

import { existsSync } from "node:fs";
import { chromiumCandidates, findChromium } from "../src/browserctl/chrome.ts";
import { cachedPythonCommand, type PythonCommand } from "../src/runtime/adapters/agy.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// ---- 1. 候选池形状 ---------------------------------------------------------

const pools = chromiumCandidates();
for (const kind of ["chrome", "edge"] as const) {
  const list = pools[kind];
  check(`${kind} 池非空`, list.length > 0);
  check(`${kind} 池无重复`, new Set(list).size === list.length, list);
  check(`${kind} 池全为绝对路径`, list.every((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)), list);
}
if (process.platform === "win32") {
  check("win32 候选全为 .exe", [...pools.chrome, ...pools.edge].every((p) => p.endsWith(".exe")));
}
if (process.platform === "darwin") {
  check("darwin 候选全在 .app/Contents/MacOS 下", [...pools.chrome, ...pools.edge].every((p) => p.includes("Contents/MacOS")));
}
if (process.platform === "linux") {
  check(
    "linux 候选无 snap / 过渡 shim（沙箱与外部 profile 不兼容，宁可诚实报未找到）",
    ![...pools.chrome, ...pools.edge].some((p) => p.includes("snap") || p.endsWith("chromium-browser")),
    [...pools.chrome, ...pools.edge],
  );
}

// ---- 2. findChromium 回环 --------------------------------------------------

for (const preferred of ["chrome", "msedge"] as const) {
  const hit = findChromium(preferred);
  check(
    `findChromium(${preferred}) 返回形状`,
    hit === null || (typeof hit.executable === "string" && (hit.kind === "chrome" || hit.kind === "edge")),
    hit,
  );
  if (hit !== null) check(`findChromium(${preferred}) executable 真实存在`, existsSync(hit.executable), hit);
}

// ---- 3. SDK 解释器候选表（probe 未跑时胜者为空；跑过后必然命中候选之一） ----

const resolved = cachedPythonCommand();
if (resolved === undefined) {
  console.log("  ok   cachedPythonCommand 未探测时为 undefined（probe 前不应有胜者）");
} else {
  const valid: PythonCommand[] =
    process.platform === "win32"
      ? [{ file: "python", baseArgs: [] }, { file: "py", baseArgs: ["-3"] }]
      : [{ file: "python3", baseArgs: [] }, { file: "python", baseArgs: [] }];
  check(
    "cachedPythonCommand 是本平台候选之一",
    valid.some((c) => c.file === resolved.file && c.baseArgs.join(",") === resolved.baseArgs.join(",")),
    resolved,
  );
}

if (failures > 0) {
  console.error(`smoke-chrome: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("smoke-chrome: all checks passed");
