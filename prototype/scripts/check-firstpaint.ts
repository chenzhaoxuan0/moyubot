/**
 * 首屏主题接力回归检查（2026-10-28）：
 *
 * 1. 三方键同步：appearanceStore.ts 的 FALLBACK_STORAGE_KEY 与 electron/preload.cjs、
 *    prototype/index.html 里的字面量必须逐字一致 —— preload 合并 mode、index.html
 *    首屏上色、useAppearance 初始态读的都是同一个 localStorage 键，任何一处改名
 *    都会让首帧接力静默失效（回落跟随系统 = 主题闪变回归），编译期查不出来。
 * 2. preload 接力行为：用 node:vm 沙箱直跑 preload.cjs（stub 掉 electron 与
 *    localStorage），钉住六个分支 —— 空缓存写骨架、旧缓存补 schemaVersion、
 *    mode 相同不写、非法 mode 不写、无 flag 不写、坏 JSON 重建、localStorage
 *    抛异常不炸后续 exposeInMainWorld。
 *
 * 零依赖约定：node --experimental-strip-types 直跑（同 check-models / check-sidepane）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const protoRoot = join(here, "..");
const read = (p: string): string => readFileSync(p, "utf8");

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};

/* ---------------- 1. 三方键同步 ---------------- */

const storeSrc = read(join(protoRoot, "src", "core", "appearanceStore.ts"));
const key = /FALLBACK_STORAGE_KEY = "([^"]+)"/.exec(storeSrc)?.[1];
check("FALLBACK_STORAGE_KEY 可解析", typeof key === "string" && key.length > 0);
if (key === undefined) {
  console.error("check-firstpaint: cannot proceed without FALLBACK_STORAGE_KEY");
  process.exit(1);
}

const html = read(join(protoRoot, "index.html"));
const preloadSrc = read(join(protoRoot, "..", "electron", "preload.cjs"));
check("index.html 内联脚本读同一 fallback 键", html.includes(`localStorage.getItem('${key}')`));
check("preload 合并同一 fallback 键", preloadSrc.includes(`const KEY = "${key}"`));
check("preload mode 白名单 = light/dark/auto", preloadSrc.includes('mode === "light" || mode === "dark" || mode === "auto"'));

/* ---------------- 2. preload 接力行为（vm 沙箱） ---------------- */

interface StoreStub {
  data: Map<string, string>;
  writes: number;
  broken: boolean;
}

/**
 * 在沙箱里跑一遍 preload.cjs。localStorage 用 Map 兜、require("electron") 用
 * no-op stub（记录 exposeInMainWorld 是否被调到），process.argv 可控。
 */
function runPreload(argv: string[], store: StoreStub): { exposed: boolean } {
  let exposed = false;
  const sandbox = {
    require: (mod: string) => {
      if (mod !== "electron") throw new Error(`unexpected require: ${mod}`);
      return {
        contextBridge: { exposeInMainWorld: () => { exposed = true; } },
        ipcRenderer: { on: () => {}, send: () => {}, invoke: () => Promise.resolve(null), removeAllListeners: () => {} },
      };
    },
    process: { argv, platform: "win32", arch: "x64" },
    // preload 顶层还有一段 Ctrl+滚轮缩放的 window.addEventListener（"wheel"），
    // 不给 window 沙箱里整个脚本会 ReferenceError 崩掉
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: {
      getItem: (k: string) => {
        if (store.broken) throw new Error("localStorage unavailable");
        return store.data.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (store.broken) throw new Error("localStorage unavailable");
        store.writes += 1;
        store.data.set(k, v);
      },
    },
    Promise,
    JSON,
  };
  vm.runInNewContext(preloadSrc, sandbox);
  return { exposed };
}

const mkStore = (initial: Record<string, string> = {}): StoreStub => ({ data: new Map(Object.entries(initial)), writes: 0, broken: false });
const readState = (store: StoreStub): Record<string, unknown> | null => {
  const raw = store.data.get(key);
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// 空缓存 + dark → 写最小骨架（schemaVersion 1 + mode）
{
  const store = mkStore();
  const { exposed } = runPreload(["electron", "--aw-appearance=dark"], store);
  const state = readState(store);
  check("空缓存：写入骨架 + mode=dark", state !== null && state.mode === "dark" && state.schemaVersion === 1);
  check("preload 后续 exposeInMainWorld 照常执行", exposed);
}

// 旧缓存缺 schemaVersion → 补 1，其余字段保留，mode 覆盖
{
  const store = mkStore({ [key]: JSON.stringify({ mode: "light", presetId: "x" }) });
  runPreload(["--aw-appearance=dark"], store);
  const state = readState(store);
  check("旧缓存补 schemaVersion 且保留其余字段", state !== null && state.schemaVersion === 1 && state.presetId === "x");
  check("旧缓存 mode 被接力值覆盖", state !== null && state.mode === "dark");
}

// mode 相同 → 不写
{
  const store = mkStore({ [key]: JSON.stringify({ schemaVersion: 1, mode: "dark" }) });
  runPreload(["--aw-appearance=dark"], store);
  check("mode 相同不写 localStorage", store.writes === 0);
}

// 非法 mode / 无 flag → 不写
{
  const store = mkStore({ [key]: JSON.stringify({ schemaVersion: 1, mode: "light" }) });
  runPreload(["--aw-appearance=blue"], store);
  check("非法 mode 值不写", store.writes === 0);
  const store2 = mkStore();
  runPreload(["electron"], store2);
  check("无 flag 不写", store2.writes === 0 && !store2.data.has(key));
}

// 坏 JSON 缓存 → 重建骨架
{
  const store = mkStore({ [key]: "{{{" });
  runPreload(["--aw-appearance=light"], store);
  const state = readState(store);
  check("坏 JSON 缓存重建骨架", state !== null && state.mode === "light" && state.schemaVersion === 1);
}

// localStorage 整体不可用 → 不炸，exposeInMainWorld 照常
{
  const store = mkStore();
  store.broken = true;
  const { exposed } = runPreload(["--aw-appearance=dark"], store);
  check("localStorage 抛异常不阻断 preload", exposed);
}

if (failures > 0) {
  console.error(`check-firstpaint: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-firstpaint: all checks passed");
