/**
 * 命令清单磁盘缓存（host.ts commands-cache.json）回归检查（2026-10-28 启动性能修复）。
 * 运行方式：tsx 直跑（host.ts 构造器带参数属性，strip-types 跑不了；同 smoke-health）。
 *
 * 钉住的契约：
 *   1. normalizeCommandCacheKey —— 旧格式 key（反斜杠 rootPath）迁移归一；
 *   2. 载盘重名合并 —— 归一后撞 key 的两条取 at 新的，坏条目跳过不抛；
 *   3. commandsEqual —— 六字段逐一敏感（将来 NativeCommandInfo 加字段忘了同步这里会被此检查逼着面对）；
 *   4. 防抖/落盘生命周期 —— 内容变了合并成一次写（flush 收尾）、内容没变不落盘、
 *      干净态 flush 零开销。用 Object.create 绕过构造器（不碰适配器/会话），
 *      私有成员按字段名手工补齐 —— host 侧字段改名时这里会第一时间 FAIL。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeCommandInfo } from "../src/contract.ts";
import { RuntimeHost, normalizeCommandCacheKey, commandsEqual } from "../src/runtime/host.ts";

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};

// ---- 1：key 归一 ----
check("旧格式 key 迁移为正斜杠", normalizeCommandCacheKey("claude|C:\\a\\b") === "claude|C:/a/b");
check("无分隔符 key 原样保留", normalizeCommandCacheKey("weird") === "weird");
check("id 段原样（只归一路径段）", normalizeCommandCacheKey("zcode|/home/x") === "zcode|/home/x");

// ---- 3：commandsEqual 逐字段敏感 ----
const base: NativeCommandInfo = { name: "a", description: "d", kind: "skill", source: "user", builtin: false };
check("同引用相等", commandsEqual([base], [base]));
check("长度不同不等", !commandsEqual([base], [base, base]));
const fieldMutations: Array<[string, Partial<NativeCommandInfo>]> = [
  ["name", { name: "b" }],
  ["description", { description: "x" }],
  ["kind", { kind: "command" }],
  ["source", { source: "project" }],
  ["builtin", { builtin: true }],
];
for (const [field, patch] of fieldMutations) {
  check(`${field} 单字段不同即不等`, !commandsEqual([base], [{ ...base, ...patch }]));
}
const withHintA: NativeCommandInfo = { ...base, argumentHint: undefined };
const withHintB: NativeCommandInfo = { ...base, argumentHint: "<x>" };
check("argumentHint 参与比较", !commandsEqual([withHintA], [withHintB]));

// ---- 2/4：载盘迁移 + 生命周期（绕过构造器，只喂它要用的字段） ----
// 结构化类型按字段/方法名对齐（RuntimeHost 的这些成员是私有的，交叉类型会被
// TS 归约成 never，所以只声明自己这份视图）；host 侧字段改名时这里会第一时间 FAIL。
interface HostLike {
  homeDir: string;
  commandsDisk: Map<string, { commands: readonly NativeCommandInfo[]; at: number }>;
  commandsDiskLoaded: boolean;
  commandsDirty: boolean;
  commandsPersistTimer: NodeJS.Timeout | null;
  loadCommandsDiskOnce(): void;
  putCommandsDisk(key: string, commands: readonly NativeCommandInfo[]): void;
  flushCommandsDisk(): void;
}
const home = mkdtempSync(join(tmpdir(), "aw-cmdcache-"));
mkdirSync(home, { recursive: true });
const cachePath = join(home, "commands-cache.json");

const mkHost = (): HostLike => {
  const host = Object.create(RuntimeHost.prototype) as unknown as HostLike;
  host.homeDir = home;
  host.commandsDisk = new Map();
  host.commandsDiskLoaded = false;
  host.commandsDirty = false;
  host.commandsPersistTimer = null;
  return host;
};

const cmd = (name: string): NativeCommandInfo => ({ ...base, name });

// 载盘迁移：反斜杠 key 与其正斜杠孪生撞 key → 取 at 新的；坏条目跳过
writeFileSync(
  cachePath,
  JSON.stringify({
    "claude|C:\\bot\\a": { commands: [cmd("old")], at: 100 },
    "claude|C:/bot/a": { commands: [cmd("new")], at: 200 },
    "zcode|C:\\bot\\b": { commands: [cmd("z1")], at: 50 },
    "broken|no-commands": { at: 1 },
    "weird": { commands: [cmd("w")], at: 5 },
  }),
  "utf8",
);
{
  const host = mkHost();
  host.loadCommandsDiskOnce();
  const disk = host.commandsDisk;
  check("归一后撞 key 合并为一条", disk.has("claude|C:/bot/a") && disk.get("claude|C:/bot/a")!.commands[0]!.name === "new");
  check("反斜杠旧 key 已迁移（不再单独成条）", !disk.has("claude|C:\\bot\\a"));
  check("zcode 旧格式迁移", disk.has("zcode|C:/bot/b"));
  check("坏条目跳过不抛", !disk.has("broken|no-commands"));
  check("无分隔符 key 存活", disk.has("weird"));
  const onDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  check("迁移结果同步落盘", Object.keys(onDisk).includes("claude|C:/bot/a") && !Object.keys(onDisk).includes("claude|C:\\bot\\a"));
}

// 防抖生命周期
{
  const host = mkHost();
  host.loadCommandsDiskOnce();
  host.putCommandsDisk("a|C:/r", [cmd("c1")]);
  host.putCommandsDisk("a|C:/r", [cmd("c1"), cmd("c2")]);
  check("防抖窗口内未落盘", !(cacheHas("c2")));
  host.flushCommandsDisk();
  check("flush 把两次变更合并成一次落盘", cacheHas("c2"));
  check("flush 后清脏标记", host.commandsDirty === false && host.commandsPersistTimer === null);

  const before = readFileSync(cachePath, "utf8");
  host.putCommandsDisk("a|C:/r", [cmd("c1"), cmd("c2")]); // 内容相同 → 只续期内存 at
  host.flushCommandsDisk();
  check("内容相等不触发写盘（启动 13s 开销的回归位）", readFileSync(cachePath, "utf8") === before);
  check("内容相等仍续期内存 at", (host.commandsDisk.get("a|C:/r")!.at ?? 0) > 0);

  const cleanBefore = readFileSync(cachePath, "utf8");
  host.flushCommandsDisk();
  check("干净态 flush 零写盘", readFileSync(cachePath, "utf8") === cleanBefore);
}

function cacheHas(name: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { commands?: NativeCommandInfo[] }>;
    return Object.values(parsed).some((e) => e.commands?.some((c) => c.name === name));
  } catch {
    return false;
  }
}

if (failures > 0) {
  console.error(`check-commands-cache: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-commands-cache: all checks passed");
