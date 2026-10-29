/**
 * 清单（inbox）—— 个人 context 的唯一入口，与待办（backlog）相对的两个层面：
 *
 * - 待办是**任务维度**：状态机、心跳、确认门、验收闭环（core/backlog.ts）。
 * - 清单是**捕获维度**：用户像编辑 Notepad++ 里那个 txt 一样，把任何东西
 *   （想法 / 目标 / 待办 / 资料）写进同一个列表；routing bot 把每条分类，
 *   可执行的沉淀成待办任务（auto 直通闲时自动执行），想法/资料留在清单里归档。
 *
 * 本文件是前后端共享契约：daemon（backend/src）与 UI 引用同一份类型；
 * 信号帧（InboxSignal）经 wsd 的 inbox 帧广播，与 backlog 帧同理是 daemon 级的。
 */

import type { LaunchMode } from "./automation.ts";
import type { BacklogStatus } from "./backlog.ts";

// ---------------------------------------------------------------------------
// 分类目录
// ---------------------------------------------------------------------------

/**
 * 通用分类（内置五个）+ 用户自定义（config.categories 追加）。
 * actionable = 分类后是否沉淀成待办任务（auto 直通闲时自动执行）；
 * 非 actionable 的分类（想法库、资料、以后再说）留在清单里按块归档。
 */
export interface InboxCategoryDef {
  readonly id: string;
  readonly label: string;
  readonly actionable: boolean;
}

export const DEFAULT_INBOX_CATEGORIES: readonly InboxCategoryDef[] = [
  { id: "idea", label: "想法", actionable: false },
  { id: "goal", label: "目标", actionable: true },
  { id: "todo", label: "待办", actionable: true },
  { id: "note", label: "资料", actionable: false },
  { id: "later", label: "以后再说", actionable: false },
];

/** 内置分类的展示顺序（自定义分类跟在后面） */
export const BUILTIN_CATEGORY_ORDER: readonly string[] = ["goal", "todo", "idea", "note", "later"];

export function inboxCategoryLabel(id: string, extra: readonly InboxCategoryDef[] = []): string {
  return DEFAULT_INBOX_CATEGORIES.find((c) => c.id === id)?.label ?? extra.find((c) => c.id === id)?.label ?? id;
}

export function isActionableCategory(id: string, extra: readonly InboxCategoryDef[] = []): boolean {
  return DEFAULT_INBOX_CATEGORIES.find((c) => c.id === id)?.actionable === true || extra.find((c) => c.id === id)?.actionable === true;
}

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

export type InboxStatus = "pending" | "classified" | "failed";

export const INBOX_STATUS_LABEL: Record<InboxStatus, string> = {
  pending: "待分类",
  classified: "已分类",
  failed: "分类失败",
};

/**
 * 用户预置的任务字段 —— 提交时可选展开填，routing 分类时**必须尊重**
 * （填了就不许改；空着的由 routing 建议）。全部可选项，不填全权交给 routing。
 */
export interface InboxHints {
  /** 指定 bot（归属工作单元，继承其工作目录） */
  readonly unitId?: string;
  /** 指定文件夹（覆盖 unit 的工作目录） */
  readonly rootPath?: string;
  /** 指定执行器 */
  readonly runtimeId?: string;
  /** 指定模型 */
  readonly model?: string | null;
  /** 执行方式：terminal / chat / headless（自动执行的任务缺省 headless） */
  readonly launchMode?: LaunchMode;
  /** 指定在某个已有会话里执行（null/缺省 = 新开会话） */
  readonly targetSessionId?: string | null;
}

export interface InboxEntryTaskRef {
  readonly id: number;
  readonly title: string;
  readonly status: BacklogStatus;
}

export interface InboxEntry {
  readonly id: number;
  /** 用户原话 —— 清单上唯一由用户编辑的东西 */
  readonly text: string;
  /** 分类结果；null = 待分类 */
  readonly category: string | null;
  /** routing 的一句话分类理由（悬停/详情可见） */
  readonly categoryNote: string | null;
  /** 用户预置字段（JSON 落库，hints 原样） */
  readonly hints: InboxHints | null;
  /** 分类沉淀出的待办任务（actionable 分类才有） */
  readonly task: InboxEntryTaskRef | null;
  readonly status: InboxStatus;
  readonly createdAt: number;
  readonly classifiedAt: number | null;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface InboxConfig {
  /** 提交后自动触发 routing 分类（关了就只能手动「立即分类」） */
  readonly autoClassify: boolean;
  /** 分类会话的执行器/模型（空 = 跟随 routing bot 的主绑定；bot 设置页可改） */
  readonly classifier: { readonly runtimeId: string; readonly model: string | null };
  /** 用户自定义分类（追加在内置五个之后，id 不可与内置冲突） */
  readonly categories: readonly InboxCategoryDef[];
}

export const DEFAULT_INBOX_CONFIG: InboxConfig = {
  autoClassify: true,
  classifier: { runtimeId: "", model: null },
  categories: [],
};

// ---------------------------------------------------------------------------
// 信号（daemon → 前端的 inbox 帧）
// ---------------------------------------------------------------------------

export type InboxSignal =
  /** 清单数据变了（前端重拉 inbox.list） */
  | { readonly kind: "entries" }
  | { readonly kind: "state"; readonly classifying: boolean; readonly lastOutcome: string | null; readonly runSeq: number }
  | { readonly kind: "notice"; readonly level: "info" | "warn" | "success"; readonly text: string };

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 解析 hints 的白名单归一（脏 JSON 不能掀翻清单页）；字符串按用途钳上限 ——
 * 这些值会被拼进 routing 的分类 prompt，不设防就是存储/上下文注入放大器 */
export function normalizeInboxHints(raw: unknown): InboxHints | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const capped = (v: unknown, max: number): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    return s === "" ? undefined : s.slice(0, max);
  };
  const out: Record<string, unknown> = {};
  const unitId = capped(r["unitId"], 100);
  if (unitId !== undefined) out["unitId"] = unitId;
  const rootPath = capped(r["rootPath"], 1000);
  if (rootPath !== undefined) out["rootPath"] = rootPath;
  const runtimeId = capped(r["runtimeId"], 100);
  if (runtimeId !== undefined) out["runtimeId"] = runtimeId;
  if (typeof r["model"] === "string" && r["model"].trim() !== "") out["model"] = r["model"].trim().slice(0, 200);
  if (r["model"] === null) out["model"] = null;
  const lm = r["launchMode"];
  if (lm === "terminal" || lm === "chat" || lm === "headless") out["launchMode"] = lm;
  const targetSessionId = capped(r["targetSessionId"], 100);
  if (targetSessionId !== undefined) out["targetSessionId"] = targetSessionId;
  return Object.keys(out).length > 0 ? (out as InboxHints) : null;
}

/** hints 的一行摘要（分类 prompt 与条目详情里展示） */
export function hintsSummary(h: InboxHints | null): string {
  if (h === null) return "";
  const parts: string[] = [];
  if (h.unitId !== undefined) parts.push(`bot=${h.unitId}`);
  if (h.rootPath !== undefined) parts.push(`folder=${h.rootPath}`);
  if (h.runtimeId !== undefined) parts.push(`executor=${h.runtimeId}`);
  if (h.model !== undefined && h.model !== null) parts.push(`model=${h.model}`);
  if (h.launchMode !== undefined) parts.push(`mode=${h.launchMode}`);
  if (h.targetSessionId !== undefined && h.targetSessionId !== null) parts.push(`session=${h.targetSessionId}`);
  return parts.join("，");
}
