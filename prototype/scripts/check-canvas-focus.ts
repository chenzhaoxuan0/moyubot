/**
 * 对话窗格焦点链回归检查（docs/32 §十）—— node --experimental-strip-types 直跑。
 *
 * 被测对象：useChatPanes 的「单活+快照」焦点链（focus/snapshot/restore）与
 * useTerminalStore 焦点游标的联动。两个 store 顶层都挂着 node 拉不动的重依赖
 * （xterm 的 css / 真实 useWorkbench 的 daemon bootstrap），这里把两份源码
 * 复制进项目内工作目录（裸模块需沿项目 node_modules 解析），import 改指：
 * - TerminalSessionManager → 空桩
 * - useWorkbench/useShell → 可控桩（openSession 按 sessionId 回放假时间线）
 * 然后仿真用户操作序列（对话↔终端↔对话往返）并断言内容不丢。
 *
 * 防的就是这次的用户实测缺陷：点回对话标签被重置成头像初始态——根因是
 * focus() 把画布游标传来的 null 当「强制草稿」清空了时间线。
 *
 * 运行：pnpm check:canvas-focus（并入 pnpm check）。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workDir = join(here, ".canvas-focus-tmp");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const url = (p: string): string => JSON.stringify(pathToFileURL(join(workDir, p)).href);

try {
  /* ---- 桩与副本 ---- */
  writeFileSync(
    join(workDir, "wb-stub.ts"),
    `
import { create } from "zustand";
export const REPLAY: Record<string, object[]> = {
  s1: [{ type: "message.delta", role: "assistant", text: "m1" }, { type: "message.delta", role: "assistant", text: "m2" }],
};
export const useWorkbench = create<Record<string, unknown>>((set, get) => ({
  units: [{ id: "u1", name: "BotA", rootPath: "C:/x" }, { id: "u2", name: "BotB", rootPath: "C:/y" }],
  sessions: [
    { id: "s1", unitId: "u1", runtimeId: "daemon:zcode", conversationId: "L1", status: "idle" },
    { id: "s2", unitId: "u2", runtimeId: "daemon:zcode", conversationId: "L2", status: "idle" },
  ],
  activeUnitId: "u1",
  activeSessionId: null,
  timeline: [] as object[],
  busy: false,
  draft: "",
  selectUnit: (unitId: string) => set({ activeUnitId: unitId, activeSessionId: null, timeline: [], busy: false, draft: "" }),
  openSession: async (input: { sessionId: string }) => {
    await new Promise((r) => setTimeout(r, 10));
    set({ activeSessionId: input.sessionId, timeline: [...((REPLAY[input.sessionId] as object[]) ?? [])], busy: false });
  },
  pushNotice: (): void => {},
}));
export const useShell = create<Record<string, unknown>>((set) => ({
  mainView: "chat",
  setMainView: (mainView: string) => set({ mainView }),
}));
`,
    "utf-8",
  );
  writeFileSync(
    join(workDir, "ts-stub.ts"),
    `export const terminalSessionRegistry = { dispose(){}, disposeAll(){}, release(){} };\nexport const CHAT_DOCK_UNIT_ID = "__chatdock__";\n`,
    "utf-8",
  );
  writeFileSync(join(workDir, "types-dummy.ts"), `export interface TimelineItem { readonly id: number; readonly event: { type: string }; readonly at: number; }\n`, "utf-8");

  const chatPanesSrc = readFileSync(join(here, "..", "src", "store", "useChatPanes.ts"), "utf-8")
    .replace('import { useWorkbench, type TimelineItem } from "./useWorkbench.ts";', `import { useWorkbench } from ${url("wb-stub.ts")};\nimport type { TimelineItem } from ${url("types-dummy.ts")};`)
    .replace('import { useShell } from "./useShell.ts";', `import { useShell } from ${url("wb-stub.ts")};`)
    .replace('import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from "./TerminalSessionManager.ts";', "")
    .replaceAll('import("./useTerminalStore.ts")', `import(${url("store-copy.ts")})`)
    .replace('from "../core/units.ts"', 'from "../../src/core/units.ts"')
    .replace('from "../adapters/daemon/client.ts"', 'from "../../src/adapters/daemon/client.ts"');
  writeFileSync(join(workDir, "chatpanes-copy.ts"), chatPanesSrc, "utf-8");

  const storeSrc = readFileSync(join(here, "..", "src", "store", "useTerminalStore.ts"), "utf-8")
    .replace('import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from "./TerminalSessionManager.ts";', `import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from ${url("ts-stub.ts")};`)
    .replace('import { useChatPanes } from "./useChatPanes.ts";', `import { useChatPanes } from ${url("chatpanes-copy.ts")};`);
  writeFileSync(join(workDir, "store-copy.ts"), storeSrc, "utf-8");

  const { useTerminalStore } = await import(pathToFileURL(join(workDir, "store-copy.ts")).href);
  const { useWorkbench } = await import(pathToFileURL(join(workDir, "wb-stub.ts")).href);
  const { useChatPanes, installChatPaneSync } = await import(pathToFileURL(join(workDir, "chatpanes-copy.ts")).href);

  /* ---- 断言 ---- */
  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
    cond ? pass++ : fail++;
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const wb = useWorkbench as unknown as { getState: () => Record<string, unknown> };
  const globalLen = (): number => (wb.getState().timeline as unknown[]).length;
  const globalSid = (): unknown => wb.getState().activeSessionId;
  const paneOf = (unitId: string): { paneKey: string; timeline: unknown[]; sessionId: string | null } => {
    const pane = Object.values(useChatPanes.getState().panes).find((p) => p.unitId === unitId);
    if (pane === undefined) throw new Error(`pane of ${unitId} missing`);
    return { paneKey: pane.paneKey, timeline: [...pane.timeline], sessionId: pane.sessionId };
  };

  installChatPaneSync();

  // ① 开对话 A（u1 / s1）——openSession 应回放 s1 的 2 条
  useChatPanes.getState().openChatPane({ unitId: "u1", sessionId: "s1" });
  await sleep(80);
  ok("① 打开 A 即回放内容", globalLen() === 2 && globalSid() === "s1");

  // ② 泵进新内容（模拟 daemon 事件流）
  useWorkbench.setState({ timeline: [...(useWorkbench.getState().timeline as object[]), { type: "message.delta", text: "m3" } as never] });
  await sleep(20);
  ok("② A 持有 3 条", globalLen() === 3);

  // ③ 分屏终端并聚焦——对话链路不被终端焦点打扰（live 归属解耦）
  useTerminalStore.getState().splitPane({ direction: "horizontal" });
  await sleep(30);
  ok("③ 焦点→终端：全局内容不动", globalLen() === 3 && globalSid() === "s1" && useChatPanes.getState().focusedChatKey === paneOf("u1").paneKey);

  // ④ 点回 A：无重建、内容原样
  useTerminalStore.getState().activatePane(paneOf("u1").paneKey);
  await sleep(30);
  ok("④ 点回 A：内容原样（不重置成初始态）", globalLen() === 3 && globalSid() === "s1");

  // ⑤ 激活另一个对话 B（u2 / s2）：A 快照应封存 3 条
  useChatPanes.getState().openChatPane({ unitId: "u2", sessionId: "s2" });
  await sleep(80);
  ok("⑤ 切到 B：A 快照封存内容", paneOf("u1").timeline.length === 3 && globalSid() === "s2");

  // ⑥ 点回 A：openSession 权威重建，内容回来（本次用户缺陷的验收点）
  useTerminalStore.getState().activatePane(paneOf("u1").paneKey);
  await sleep(80);
  ok("⑥ 往返后 A 内容完整恢复", globalLen() === 2 && globalSid() === "s1" && paneOf("u1").sessionId === "s1");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
