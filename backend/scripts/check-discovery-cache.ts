/**
 * 发现层扫描缓存（discovery.ts cachedScan）回归检查（2026-10-28 loop-stall 修复）。
 * 零依赖约定：node --experimental-strip-types 直跑（同 smoke-health）。
 *
 * 钉住的契约：
 *   1. 同 key 记忆化 —— 只真扫一次、返回同引用、数组冻结（共享引用不许原地改）；
 *   2. resetDiscoveryCaches —— 磁盘事实变化（技能停用/新增）后必须重扫见效；
 *      host.invalidateCommandsFor 对它的调用点也一并 grep 断言（那行丢了失效就落空）；
 *   3. TTL 过期重扫；
 *   4. commandCacheRootKey —— bot.json 手填路径正反斜杠混用，key 必须归一到同一条。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  cachedScan,
  commandCacheRootKey,
  discoverSkillsInDir,
  resetDiscoveryCaches,
} from "../src/runtime/adapters/discovery.ts";

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: d\n---\nbody\n`;

// ---- 1/2：真目录上的记忆化 + 失效 ----
const dir = mkdtempSync(join(tmpdir(), "aw-disc-"));
mkdirSync(join(dir, "s1"));
writeFileSync(join(dir, "s1", "SKILL.md"), skillMd("s1"));

const a = discoverSkillsInDir(dir, "project");
const b = discoverSkillsInDir(dir, "project");
check("同 key 记忆化：同引用", a === b);
check("扫描结果冻结（共享引用防污染）", Object.isFrozen(a));

mkdirSync(join(dir, "s2"));
writeFileSync(join(dir, "s2", "SKILL.md"), skillMd("s2"));
check("未失效时读旧值（TTL 内不吃磁盘变化）", discoverSkillsInDir(dir, "project").length === 1);
resetDiscoveryCaches();
check("reset 后重扫见新技能", discoverSkillsInDir(dir, "project").length === 2);

// host.invalidateCommandsFor 必须调 reset —— 那是「技能停用→菜单更新」的依赖点
const hostSrc = readFileSync(new URL("../src/runtime/host.ts", import.meta.url), "utf8");
check("host.invalidateCommandsFor 仍调用 resetDiscoveryCaches", hostSrc.includes("resetDiscoveryCaches();"));

// ---- 3：TTL 过期重扫 ----
let calls = 0;
const scanFn = (): number => {
  calls += 1;
  return calls;
};
cachedScan("aw-check-k", scanFn);
cachedScan("aw-check-k", scanFn);
check("cachedScan 命中不重跑", calls === 1);
const realNow = Date.now;
const later = realNow() + 11 * 60 * 1000;
Date.now = () => later;
cachedScan("aw-check-k", scanFn);
Date.now = realNow;
check("TTL 过期重扫", calls === 2);

// ---- 4：rootPath 归一 ----
check("反斜杠 rootPath 归一为正斜杠", commandCacheRootKey("C:\\a\\b\\") === "C:/a/b/");
check("正斜杠 rootPath 原样", commandCacheRootKey("C:/a/b") === "C:/a/b");
const adapterSample = readFileSync(new URL("../src/runtime/adapters/claude.ts", import.meta.url), "utf8");
check("适配器 scan key 已用归一 helper", adapterSample.includes("cachedScan(`claude-file-level|${commandCacheRootKey(rootPath)}`"));

if (failures > 0) {
  console.error(`check-discovery-cache: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-discovery-cache: all checks passed");
