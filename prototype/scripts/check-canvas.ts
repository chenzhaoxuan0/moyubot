/**
 * 画布组栈模型回归检查（docs/32）—— node --experimental-strip-types 直跑。
 *
 * 被测对象是 src/store/useTerminalStore.ts 的纯状态机（分组/布局/焦点/拖拽
 * 语义）。store 顶层 import 了 TerminalSessionManager（xterm，含 .css）与
 * useChatPanes（拉起整个 workbench 链），node 直跑不动——这里把源码文本
 * 复制一份、把这两条 import 改指向本目录的内联桩，再动态 import 跑断言。
 * 桩只覆盖本测试触达的面：dispose/disposeAll/release 与 handlePaneClosed。
 *
 * 运行：pnpm check:canvas（退出码非 0 = 有 FAIL）。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "..", "src", "store", "useTerminalStore.ts");
// 工作副本必须在项目树内：裸模块（zustand）要沿项目 node_modules 上溯解析；
// 系统 tmp 下找不到。目录已入 .gitignore，跑完即删
const workDir = join(here, ".canvas-check-tmp");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

try {
  const stubs = `
export const terminalSessionRegistry = { dispose(){}, disposeAll(){}, release(){} };
export const CHAT_DOCK_UNIT_ID = "__chatdock__";
export const useChatPanes = { getState: () => ({ handlePaneClosed(){} }) };
`;
  const stubPath = join(workDir, "stubs.ts");
  const storeCopyPath = join(workDir, "store.ts");
  writeFileSync(stubPath, stubs, "utf-8");
  const source = readFileSync(srcPath, "utf-8")
    .replace(
      'import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from "./TerminalSessionManager.ts";',
      `import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from ${JSON.stringify(pathToFileURL(stubPath).href)};`,
    )
    .replace(
      'import { useChatPanes } from "./useChatPanes.ts";',
      `import { useChatPanes } from ${JSON.stringify(pathToFileURL(stubPath).href)};`,
    );
  writeFileSync(storeCopyPath, source, "utf-8");

  const { useTerminalStore } = await import(pathToFileURL(storeCopyPath).href);

  let pass = 0;
  let fail = 0;
  const ok = (name: string, cond: boolean): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
    cond ? pass++ : fail++;
  };
  const groups = () => Object.values(useTerminalStore.getState().groups);
  const byTitle = (t: string): string => {
    const p = Object.values(useTerminalStore.getState().panes).find((x) => x.title === t);
    if (p === undefined) throw new Error(`pane ${t} 不存在`);
    return p.id;
  };

  /* ---- 建栈 ---- */
  useTerminalStore.getState().createTab({ title: "A" });
  useTerminalStore.getState().createTab({ title: "B" });
  useTerminalStore.getState().createTab({ title: "C" });
  const g1 = useTerminalStore.getState().activeGroupId!;
  ok("三标签同组单格（layout=null）", groups().length === 1 && groups()[0]!.tabOrder.length === 3 && useTerminalStore.getState().layout === null);

  /* ---- 同组重排 ---- */
  useTerminalStore.getState().movePaneToGroup(byTitle("A"), g1, 2);
  ok("同组重排：A 移到末尾", groups()[0]!.tabOrder[2] === byTitle("A") && groups()[0]!.tabOrder[0] === byTitle("B"));

  /* ---- 拖标签四边分屏（曾出复制 bug 的路径） ---- */
  useTerminalStore.getState().dropPaneOnGroup(byTitle("A"), g1, "right");
  ok("右缘分屏成两组", groups().length === 2 && useTerminalStore.getState().layout !== null);
  ok("新组只装拖动标签（无整组复制）", groups().find((g) => g.tabOrder.includes(byTitle("A")))!.tabOrder.length === 1);
  const g2 = groups().find((g) => g.id !== g1)!.id;

  /* ---- no-op 守卫 ---- */
  useTerminalStore.getState().dropPaneOnGroup(byTitle("A"), g2, "left");
  ok("自身四边 no-op 拒收", groups().length === 2);

  /* ---- 对话拆分入新组 + 焦点 ---- */
  useTerminalStore.getState().splitPane({ direction: "vertical", chatPaneKey: "chatp_test_1" });
  ok("对话拆分入新组并聚焦", groups().some((g) => g.tabOrder.includes("chatp_test_1")) && useTerminalStore.getState().activePaneId === "chatp_test_1");

  /* ---- 最大化往返 ---- */
  useTerminalStore.getState().toggleMaximize("chatp_test_1");
  const maxSet = useTerminalStore.getState().maximizedPaneId === "chatp_test_1";
  useTerminalStore.getState().toggleMaximize();
  ok("最大化置位/还原", maxSet && useTerminalStore.getState().maximizedPaneId === null);

  /* ---- 关格塌缩 ---- */
  const chatGroup = groups().find((g) => g.tabOrder.includes("chatp_test_1"))!;
  useTerminalStore.getState().closeGroup(chatGroup.id);
  ok("关整格塌缩", groups().length === 2 && !groups().some((g) => g.id === chatGroup.id));

  /* ---- 末标签塌缩回收平 ---- */
  useTerminalStore.getState().closePane(byTitle("A"));
  ok("末标签关掉后单组收平（layout=null）", groups().length === 1 && useTerminalStore.getState().layout === null);

  /* ---- 跨组入栈（center） ---- */
  useTerminalStore.getState().splitPane({ direction: "horizontal" });
  const before = groups().length;
  const lastGroup = groups()[groups().length - 1]!.id;
  useTerminalStore.getState().dropPaneOnGroup(byTitle("B"), lastGroup, "center");
  ok("center 入栈跨组移动", groups().length === before && groups().find((g) => g.id === lastGroup)!.tabOrder.includes(byTitle("B")));

  /* ---- readopt 幂等 ---- */
  await useTerminalStore.getState().readoptTerminal(byTitle("B"));
  const seen = groups().flatMap((g) => [...g.tabOrder]);
  ok("readopt 不双开且激活", seen.filter((t) => t === byTitle("B")).length === 1 && useTerminalStore.getState().activePaneId === byTitle("B"));

  /* ---- 唯一性总检 ---- */
  const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
  const orphan = Object.keys(useTerminalStore.getState().panes).filter((p) => !seen.includes(p));
  if (orphan.length > 0) console.log("ORPHANS:", orphan.map((id) => `${id} (${useTerminalStore.getState().panes[id].title})`).join(", "));
  ok("标签唯一性（无多组挂载）", dup.length === 0);
  ok("无脱组窗格", orphan.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
