/**
 * 清单准入闸（docs/33 §1 Gate）—— inbox.add 落库前的三步判定：
 *
 *  1. 幂等：同 thread_key + 归一文本相等的近期条目已存在 → duplicate（不建条目）
 *  2. 订阅直通：thread_key 命中任务 subscriptions → fanout —— 建 followup 壳条目
 *     链到该任务并直通投递（pendingInput 暂存），**不进分类器**（省一次 routing
 *     会话，也避免同话题拆出第二个任务）
 *  3. 其余 → new（原路走分类队列）
 *
 * thread_key 为空（手动一次性输入）跳过前两步。dsh-superagent 原型 Intake 的同款
 * 顺序：Source 先丢弃自己的消息与域外 Trigger，订阅 fan-out 优先于 Eval。
 */

import type { InboxSignal } from "../../../prototype/src/core/inbox.ts";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

/** 幂等窗口：同话题同文本在这窗口内只收一条（GTD 未勾行每轮统合都重现的兜底） */
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** 归一比较基线：去全部空白后小写（比 consolidate 的 normalizeGoal 更宽 ——
 *  gate 面对的是用户原话重发，标点差异不该放行重复） */
function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, "").toLowerCase().slice(0, 500);
}

export interface GateDeps {
  readonly store: Store;
  /** 订阅直通的投递器 —— BacklogEngine.deliverFollowup（queued=暂存 pendingInput，woken=唤醒 done 任务） */
  readonly deliver: (itemId: number, text: string) => "queued" | "woken";
  /** 壳条目落库后广播（时间轴即时可见） */
  readonly broadcast: (signal: InboxSignal) => void;
}

export type GateVerdict =
  | { readonly kind: "new" }
  | { readonly kind: "duplicate"; readonly entryId: number }
  | { readonly kind: "fanout"; readonly entryId: number; readonly itemId: number };

/**
 * 判定并落地：fanout/duplicate 的副作用（壳条目、投递）在本函数内完成 ——
 * 调用方（inbox.add）按 kind 决定是否继续原路 createInboxEntry + schedule。
 */
export function gateAdmit(deps: GateDeps, text: string, threadKey: string | null): GateVerdict {
  if (threadKey === null || threadKey === "") return { kind: "new" };

  // 1. 幂等：同话题近期同文本 —— 不建条目（GTD 重复收录 / 渠道重发）
  const dup = deps.store
    .listInboxEntries()
    .find((e) => e.threadKey === threadKey && normalizeText(e.text) === normalizeText(text) && Date.now() - e.createdAt <= DEDUP_WINDOW_MS);
  if (dup !== undefined) {
    log.info("inbox gate duplicate", { threadKey, entryId: dup.id });
    return { kind: "duplicate", entryId: dup.id };
  }

  // 2. 订阅直通：找订阅了该话题的任务 —— 活跃态优先（多命中取最新更新的）；
  //    没有活跃的再看 done（追加唤醒，deliverFollowup 内处理 sleeping 不唤醒）
  const items = deps.store.listBacklogItems();
  const subscribed = items.filter((i) => i.subscriptions.includes(threadKey));
  const active = subscribed
    .filter((i) => i.status !== "done" && i.status !== "sleeping")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const target = active[0] ?? subscribed.find((i) => i.status === "done");
  if (target === undefined) return { kind: "new" };

  // 壳条目 = 投递回执（followup 分类 + task 链接），时间轴上「这条追加挂到了任务 X」
  const entryId = deps.store.createInboxEntry({ text, category: "followup", status: "classified", threadKey });
  const outcome = deps.deliver(target.id, text);
  deps.store.updateInboxEntry(entryId, { taskId: target.id });
  deps.broadcast({ kind: "entries" });
  log.info("inbox gate fanout", { threadKey, entryId, itemId: target.id, outcome, taskStatus: target.status });
  return { kind: "fanout", entryId, itemId: target.id };
}
