/**
 * daemon 可分发构建 —— esbuild 打单入口 ESM bundle + 组装原生模块运行时目录。
 *
 * 产物：backend/dist/daemon-deploy/
 *   daemon.mjs                     主 bundle（node-pty worker 以 chunk 拆出）
 *   runtime/adapters/*.py          agy sidecar 等非 JS 资产（保持 src 相对结构）
 *   node_modules/{node-pty,@nut-tree-fork}   external 原生模块的实体副本
 *
 * 刻意不拷的包（「一个软件管理多个 CLI」口径）：
 *   @anthropic-ai/claude-agent-sdk（含平台二进制 claude.exe ~250MB）
 *   @earendil-works/pi-coding-agent
 * 两者在源码里都是动态 import + catch 降级（not_installed），缺包不影响 daemon 起动。
 *
 * pnpm 的 node_modules 是符号链接结构，cpSync 一律 dereference 拷实体，
 * 否则 electron-builder extraResources 会拷出断链。
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "daemon-deploy");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "runtime", "adapters"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  // ESM：import.meta.url / new Worker(new URL(...)) 原生语义保留，CJS 输出做不到
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: out,
  entryNames: "daemon",
  splitting: true,
  // ESM 输出里 CJS 依赖（ws 等）的 require("events"…) 需要 createRequire 兜底，
  // 否则启动即 "Dynamic require of ... is not supported"
  banner: {
    js: "import { createRequire as __awbCreateRequire } from 'node:module';\nconst require = __awbCreateRequire(import.meta.url);",
  },
  external: [
    "node-pty",
    "@nut-tree-fork/*",
    "@anthropic-ai/*",
    "@earendil-works/*",
  ],
  define: { __AWB_VERSION__: JSON.stringify(pkg.version ?? "0.0.0") },
  logLevel: "info",
});

const outputs = readdirSync(out).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
console.log(`[build-daemon] bundle: ${outputs.join(", ")}`);

// 目录自带 type:module：daemon-deploy 会被整体拷进 Electron resources（那里没有
// backend/package.json 的模块上下文），.js 输出靠这个声明按 ESM 解析
writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");

// sidecar python：bundle 只管 JS，非 JS 资产按 src 相对结构手工摆放
// （agy.ts resolveSidecarPath 的 bundle 形态候选与之对齐）
const sidecarFrom = path.join(root, "src", "runtime", "adapters", "agy-antigravity-sidecar.py");
if (existsSync(sidecarFrom)) {
  cpSync(sidecarFrom, path.join(out, "runtime", "adapters", "agy-antigravity-sidecar.py"));
}

// external 原生模块的运行时副本（node-pty 在 worker chunk 里 require，
// @nut-tree-fork/* 是 nut-js 的平台 prebuilt 家族）
for (const name of ["node-pty", "@nut-tree-fork"]) {
  const src = path.join(root, "node_modules", name);
  if (!existsSync(src)) {
    throw new Error(`[build-daemon] 缺 ${src}——先 pnpm install`);
  }
  cpSync(src, path.join(out, "node_modules", name), { recursive: true, dereference: true });
}

console.log(`[build-daemon] daemon-deploy 就绪: ${out}`);
