/**
 * 清单分类纯函数检查 —— 不起 daemon、不烧执行器额度（对齐 check-plan-tools.ts 风格）。
 *
 * 覆盖三块解析/决策面：
 * - parseTask：LLM 输出的 task 字段白名单截断、daemon: 前缀剥离、
 *   launchMode/targetSessionId/rootPath 零信任（解析器不收）
 * - extractJsonArray：前后废话包裹、空数组、非对象元素、无 JSON
 * - pickAutopilotRuntime：余量地板、探针失败放行、未订阅排除、percent null 排序
 *
 * 用法：cd backend && pnpm check:inbox-classify
 */

import { parseTask, extractJsonArray } from "../src/inbox/classifier.ts";
import { pickAutopilotRuntime } from "../src/backlog/heartbeat.ts";
import type { QuotaHeadroom } from "../../prototype/src/core/backlog.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const q = (runtimeId: string, percent: number | null, subscribed = true): QuotaHeadroom => ({
  runtimeId,
  percent,
  subscribed,
  resetsAt: null,
  summary: null,
  source: percent === null ? "unknown" : "probe",
  checkedAt: percent === null ? null : Date.now(),
});

// ---- parseTask ---------------------------------------------------------------

check("task 字段是字符串 → null", parseTask("route only") === null);
check("task 全空白字段 → null", parseTask({ goal: "  ", prompt: "", title: "" }) === null);
check("goal 超 4000 截断", parseTask({ goal: "x".repeat(5000) })?.goal.length === 4000);
check("title 超 80 截断", parseTask({ goal: "g", title: "t".repeat(200) })?.title.length === 80);
check("runtimeId daemon: 前缀剥离", parseTask({ goal: "g", runtimeId: "daemon:zcode" })?.runtimeId === "zcode");
check("model 非字符串 → null", parseTask({ goal: "g", model: 42 })?.model === null);
check("targetSessionId 不收（LLM 零信任字段）", parseTask({ goal: "g", targetSessionId: "sess-x" }) !== null && !("targetSessionId" in (parseTask({ goal: "g", targetSessionId: "sess-x" }) as object)));
check("launchMode 不收（执行方式系统定）", parseTask({ goal: "g", launchMode: "terminal" }) !== null && !("launchMode" in (parseTask({ goal: "g", launchMode: "terminal" }) as object)));
check("rootPath 不收（工作目录只来自单元注册表）", parseTask({ goal: "g", rootPath: "C:/evil" }) !== null && !("rootPath" in (parseTask({ goal: "g", rootPath: "C:/evil" }) as object)));

// ---- extractJsonArray ----------------------------------------------------------

const wrapped = extractJsonArray('好的，分类结果如下：[{"id":1,"category":"idea"}] 以上。');
check("前后废话包裹可解析", Array.isArray(wrapped) && wrapped.length === 1 && wrapped[0]?.["category"] === "idea", wrapped);
check("空数组是有效决策（0/N 分支，非解析失败）", Array.isArray(extractJsonArray("[]")));
check("无 JSON 文本 → null", extractJsonArray("我看了看，都不适合现在做。") === null);
const dirty = extractJsonArray('[null,1,{"id":1}]');
check("非对象元素被过滤", Array.isArray(dirty) && dirty.length === 1, dirty);

// ---- pickAutopilotRuntime --------------------------------------------------------

check("指定执行器余量低于地板 → null", pickAutopilotRuntime("zcode", [q("zcode", 3)], 10) === null);
check("指定执行器余量达地板 → 照跑", pickAutopilotRuntime("zcode", [q("zcode", 30)], 10) === "zcode");
check("指定执行器探针失败（无读数）→ 放行", pickAutopilotRuntime("zcode", [], 10) === "zcode");
check("指定执行器读数未知 → 放行", pickAutopilotRuntime("zcode", [q("zcode", null)], 10) === "zcode");
check("未订阅执行器不参选", pickAutopilotRuntime("", [q("a", 50, false), q("b", 80)], 10) === "b");
check("全低于地板 → null", pickAutopilotRuntime("", [q("a", 1), q("b", 2)], 10) === null);
check("挑剩余最多的订阅执行器", pickAutopilotRuntime("", [q("a", 40), q("b", 80)], 10) === "b");
check("percent null 排在实际余量之后", pickAutopilotRuntime("", [q("a", null), q("b", 5)], 0) === "b");

// ---- classify 单飞（并发手动触发不能起两个分类会话）--------------------------------
//
// 占位必须发生在首个 await 之前：resolveRuntime 挂在 routingBinding 的文件 IO 上时，
// 两个并发的 classify() 若都先过检查再占旗，会各自起一个会话、同一批条目建两份任务。

async function singleFlightChecks(): Promise<void> {
  const { InboxClassifier } = await import("../src/inbox/classifier.ts");
  const { DEFAULT_INBOX_CONFIG } = await import("../../prototype/src/core/inbox.ts");

  let release!: (v: { runtimeId: string; model: string | null }) => void;
  const gate = new Promise<{ runtimeId: string; model: string | null }>((r) => (release = r));
  let starts = 0;
  const c = new InboxClassifier({
    store: {
      listInboxEntries: () => [{ id: 1, text: "x", status: "pending", hints: null }],
      // getSession 返回已结束的会话：awaitTurnEnd 前置检查即刻命中，不用等 3 分钟预算
      getSession: () => ({ endedAt: 1, status: "idle" }),
      getInboxEntry: () => undefined,
      updateInboxEntry: () => true,
      createBacklogItem: () => 1,
      transaction: (fn: () => unknown) => fn(),
    } as never,
    host: {
      startSession: async () => {
        starts += 1;
        return { id: "s1" };
      },
      onSessionEvent: () => () => {},
      listAdapters: async () => [],
    } as never,
    homeDir: "/tmp",
    getConfig: () => DEFAULT_INBOX_CONFIG,
    broadcast: () => {},
    unitsWithRoots: async () => [],
    // 首个 await 挂在这里：占位若不在此之前，并发的第二个调用会漏过单飞检查
    routingBinding: () => gate,
  });
  const p1 = c.classify();
  const p2 = c.classify();
  release({ runtimeId: "zcode", model: null });
  const [r1, r2] = await Promise.all([p1, p2]);
  check("classify 单飞：并发调用恰好起一个分类会话", starts === 1, { starts });
  // 放行的那个走完正常收卷（stub 无事件流 → 沉默收场，attempted 保持 0），
  // 被挡的立即空手而归 —— 两者都不会建任务
  check("放行与被挡的调用都不建任务", r1.tasksCreated === 0 && r2.tasksCreated === 0, { r1, r2 });
}

void singleFlightChecks().then(() => {
  if (failures > 0) {
    console.error(`check: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("check: all checks passed");
});
