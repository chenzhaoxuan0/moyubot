/**
 * 启动引导「用户数据不覆盖」契约回归检查（2026-10-28 themeAccent 入列）。
 * 零依赖约定：node --experimental-strip-types 直跑（同 smoke-health）。
 *
 * 背景：ensureSteward / ensureHeartbeatBot 每次启动只补结构，用户在设置页改过的
 * 字段（含 2026-10-28 新增的 themeAccent）绝不能被硬编码初始值打回 —— 这个
 * bug 类历史上实测复现过（执行器被回写）。合并逻辑内联在 index.ts 的启动副作用
 * 里无法单测，这里把契约钉在声明处：USER_OWNED_BOT_KEYS 必须包含全部用户可改
 * 键，heartbeat 侧在共用清单之上附加 tags。将来加新用户字段忘了入列，此检查
 * 会 FAIL 提醒（配合 UI 侧新增可编辑字段时同步维护）。
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};

const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const decl = /const USER_OWNED_BOT_KEYS = \[([^\]]*)\] as const;/.exec(src)?.[1];
check("USER_OWNED_BOT_KEYS 声明可解析", typeof decl === "string" && decl.length > 0);
if (decl === undefined) {
  console.error("check-bot-bootstrap: cannot proceed without USER_OWNED_BOT_KEYS");
  process.exit(1);
}

for (const key of ["name", "bindings", "avatar", "themeAccent", "channels", "memory"]) {
  check(`用户数据键「${key}」在启动引导保留清单里`, decl.includes(`"${key}"`));
}
// 「name, bindings」开头的数组字面量应只剩 USER_OWNED_BOT_KEYS 声明这一处 ——
// 出现第二处就是有启动引导又手抄了一份清单
const handCopied = src.match(/\["name", "bindings"/g) ?? [];
check("两处启动引导都改用共享清单（不再各自手抄数组）", handCopied.length === 1);
check("heartbeat 在共享清单上附加 tags", src.includes('[...USER_OWNED_BOT_KEYS, "tags"]'));

if (failures > 0) {
  console.error(`check-bot-bootstrap: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-bot-bootstrap: all checks passed");
