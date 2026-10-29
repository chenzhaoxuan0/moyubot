/**
 * Store.transaction 检查 —— 多表写同生共死的凭据。
 *
 * transaction() 存在的全部理由是分类器「建任务 + 回写链接」的原子性（crash 在
 * 中间会留下孤儿 auto 任务，被闲时执行）；这里用临时 home 的真 Store 验证
 * 抛错回滚、正常提交两条路径。用法：cd backend && pnpm check:store-transaction
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const store = new Store(mkdtempSync(path.join(os.tmpdir(), "awb-store-check-")));
const item = { title: "事务检查", goal: "g", prompt: "p", unitId: "u", unitName: "u", rootPath: "/tmp", runtimeId: "", launchMode: "headless" as const };

// 抛错回滚：事务里的写入必须随异常一起消失
const before = store.listBacklogItems().length;
let threw = false;
try {
  store.transaction(() => {
    store.createBacklogItem(item);
    throw new Error("boom");
  });
} catch {
  threw = true;
}
check("事务抛错 → 写入回滚", threw && store.listBacklogItems().length === before, { threw, count: store.listBacklogItems().length });

// 正常提交
const committed = store.transaction(() => store.createBacklogItem(item));
check("事务提交 → 写入生效", committed > 0 && store.listBacklogItems().length === before + 1, { committed, count: store.listBacklogItems().length });

store.close();

if (failures > 0) {
  console.error(`check: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("check: all checks passed");
