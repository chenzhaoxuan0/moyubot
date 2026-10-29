/**
 * 清单（inbox）配置 —— kv 单键 JSON（`inbox.config`），与 backlog.config 同一套
 * 哲学：半行脏数据不能掀翻清单；读写都过一遍归一钳制。
 */

import type { InboxCategoryDef, InboxConfig } from "../../../prototype/src/core/inbox.ts";
import { DEFAULT_INBOX_CATEGORIES, DEFAULT_INBOX_CONFIG } from "../../../prototype/src/core/inbox.ts";
import type { Store } from "../store/db.ts";

const KEY = "inbox.config";

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const BUILTIN_IDS = new Set(DEFAULT_INBOX_CATEGORIES.map((c) => c.id));

/** 自定义分类：id 归一（去掉空白/非法字符，与内置冲突的丢弃），label 必须非空 */
function normalizeCategories(raw: unknown): InboxCategoryDef[] {
  if (!Array.isArray(raw)) return [];
  const out: InboxCategoryDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = typeof r["label"] === "string" ? r["label"].trim() : "";
    if (label === "") continue;
    const rawId = typeof r["id"] === "string" && r["id"].trim() !== "" ? r["id"].trim() : label;
    const id = rawId.replaceAll(/\s+/g, "-").toLowerCase();
    if (BUILTIN_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, actionable: r["actionable"] === true });
  }
  return out;
}

export function normalizeInboxConfig(raw: unknown): InboxConfig {
  const d = DEFAULT_INBOX_CONFIG;
  if (raw === null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const cl = (r["classifier"] ?? {}) as Record<string, unknown>;
  return {
    autoClassify: r["autoClassify"] !== false,
    classifier: {
      // trim：' zcode ' 这种手滑空格会让 startSession 找不到适配器
      runtimeId: typeof cl["runtimeId"] === "string" ? cl["runtimeId"].trim() : "",
      model: typeof cl["model"] === "string" && cl["model"].trim() !== "" ? cl["model"].trim() : null,
    },
    categories: normalizeCategories(r["categories"]),
  };
}

export function getInboxConfig(store: Store): InboxConfig {
  const raw = store.kvGet(KEY);
  if (raw === undefined) return DEFAULT_INBOX_CONFIG;
  try {
    return normalizeInboxConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_INBOX_CONFIG;
  }
}

/** patch 部分合并：classifier 一层深合并，categories 整组替换（管理语义） */
export function setInboxConfig(store: Store, patch: unknown): InboxConfig {
  const prev = getInboxConfig(store);
  const p = (patch ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(prev as unknown as Record<string, unknown>), ...p };
  if (p["classifier"] !== null && typeof p["classifier"] === "object") {
    merged["classifier"] = { ...prev.classifier, ...(p["classifier"] as Record<string, unknown>) };
  }
  const next = normalizeInboxConfig(merged);
  store.kvSet(KEY, JSON.stringify(next));
  return next;
}
