/**
 * 收件箱统合（ADR-0002）—— 各工作空间的 GTD.md 是待办捕获的通用入口：
 * 任何执行器的任何会话、以及用户本人用编辑器，都能往里追加一行。
 * 文件是收件箱不是调度权威：统合进 backlog_items（state.db）后，
 * 已收录条目在文件里原地勾选并带上待办 id，防止重复导入。
 *
 * 文件格式（播种模板就长这样）：
 *   # GTD 收件箱
 *   > 任何 agent 会话和用户本人都可以在这里追加待办，每日统合进待办清单。
 *
 *   ## 收件箱
 *   - [ ] 把 README 翻新一遍
 *
 *   ## 已收录
 *   - [x] 旧条目（已收录 #12）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { draftPromptOf } from "../../../prototype/src/core/backlog.ts";
import type { Store } from "../store/db.ts";
import { log } from "../log.ts";

const INBOX_FILE = "GTD.md";

const TEMPLATE = `# GTD 收件箱

> 任何 agent 会话和用户本人都可以在这里追加待办（一行一条），每日统合进待办清单。

## 收件箱

## 已收录
`;

export interface ConsolidateResult {
  scanned: number;
  created: number;
  duplicates: number;
  /** 收件箱文件不存在、目录缺失等被跳过的 root */
  skipped: number;
}

/** 归一化目标文本：去空白与标点后小写 —— 精确/包含判重的比较基线 */
function normalizeGoal(text: string): string {
  return text.replaceAll(/\s+/g, "").replace(/[，。！？、,.!?;；:：“”"()（）\-_/]/g, "").toLowerCase();
}

interface InboxEntry {
  readonly line: string;
  readonly goal: string;
}

/** 解析「## 收件箱」节内未勾选的 checklist 行（其他节一概不认，包括已收录区） */
function parseInbox(content: string): InboxEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: InboxEntry[] = [];
  let inInbox = false;
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      inInbox = heading[1]!.trim() === "收件箱";
      continue;
    }
    if (!inInbox) continue;
    const item = /^- \[ \]\s*(.+)$/.exec(line.trim());
    if (item !== null && item[1]!.trim() !== "") entries.push({ line, goal: item[1]!.trim() });
  }
  return entries;
}

/** 统合一个 root 的收件箱；返回新收录条目的行号标记（写回用） */
async function consolidateRoot(
  rootPath: string,
  unit: { unitId: string; unitName: string },
  store: Store,
  activeGoals: Set<string>,
): Promise<{ created: number; duplicates: number; touched: boolean }> {
  const file = path.join(rootPath, INBOX_FILE);
  if (!existsSync(file)) {
    // 目录在就播种模板（收件箱能力可见），统合数为 0
    try {
      writeFileSync(file, TEMPLATE, "utf8");
      log.info("backlog inbox seeded", { file });
    } catch {
      /* 目录只读等：下次再试 */
    }
    return { created: 0, duplicates: 0, touched: false };
  }
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { created: 0, duplicates: 0, touched: false };
  }
  const entries = parseInbox(content);
  if (entries.length === 0) return { created: 0, duplicates: 0, touched: false };

  let created = 0;
  let duplicates = 0;
  const collected: Array<{ entry: InboxEntry; id: number }> = [];
  for (const e of entries) {
    const norm = normalizeGoal(e.goal);
    // 去重口径 v1 = 归一化相等或互相包含（语义去重是 steward 的活，列为后续增强）
    const dup = [...activeGoals].some((g) => g === norm || (g.length > 6 && norm.includes(g)) || (norm.length > 6 && g.includes(norm)));
    if (dup) {
      duplicates++;
      collected.push({ entry: e, id: -1 }); // 重复的也勾掉，并标「重复」—— 否则每轮统合都再报一次
      continue;
    }
    // 任务必有源（docs/30 单列时间轴）：收录也生成壳条目——时间轴上留下
    // 「今天从 GTD.md 收了什么」的痕迹，任务挂在壳下。任务+壳+链接同生共死。
    const id = store.transaction(() => {
      const taskId = store.createBacklogItem({
        title: e.goal.split(/\r?\n/)[0]!.slice(0, 40),
        goal: e.goal,
        prompt: draftPromptOf(e.goal),
        unitId: unit.unitId,
        unitName: unit.unitName,
        rootPath,
        source: "inbox",
      });
      const shellId = store.createInboxEntry({ text: e.goal.slice(0, 8000), category: "todo", status: "classified" });
      store.updateInboxEntry(shellId, { taskId });
      return taskId;
    });
    activeGoals.add(norm);
    created++;
    collected.push({ entry: e, id });
  }

  // 回写：已收录行原地勾选 + 尾注（带 id 或「重复」），最少惊动文件其余部分
  let out = content;
  for (const c of collected) {
    const mark = c.id > 0 ? `（已收录 #${c.id}）` : "（重复，未收录）";
    const checked = c.entry.line.trim().replace(/^-\s*\[\s*\]/, "- [x]");
    // 该行可能被复写多次（同名行）—— 只替换第一处未处理的原行
    out = out.replace(c.entry.line, `${checked}${mark}`);
  }
  try {
    writeFileSync(file, out, "utf8");
  } catch (err: unknown) {
    log.warn("backlog inbox write-back failed", { file, error: err instanceof Error ? err.message : String(err) });
  }
  return { created, duplicates, touched: true };
}

export async function consolidateInboxes(opts: {
  store: Store;
  roots: ReadonlyArray<{ rootPath: string; unitId: string; unitName: string }>;
}): Promise<ConsolidateResult> {
  const result: ConsolidateResult = { scanned: 0, created: 0, duplicates: 0, skipped: 0 };
  const activeGoals = new Set<string>();
  for (const item of opts.store.listBacklogItems()) {
    if (item.status === "done") continue;
    activeGoals.add(normalizeGoal(item.goal));
    activeGoals.add(normalizeGoal(item.title));
  }
  const seen = new Set<string>();
  for (const r of opts.roots) {
    if (r.rootPath === "" || seen.has(r.rootPath)) continue;
    seen.add(r.rootPath);
    if (!existsSync(r.rootPath)) {
      result.skipped++;
      continue;
    }
    result.scanned++;
    const r2 = await consolidateRoot(r.rootPath, r, opts.store, activeGoals);
    result.created += r2.created;
    result.duplicates += r2.duplicates;
  }
  return result;
}
