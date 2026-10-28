/**
 * 待办（backlog）配置 —— kv 单键 JSON（`backlog.config`），读写都过一遍归一：
 * bot.json 手可编辑是这个项目的哲学，配置文件同理 —— 半行脏数据不能掀翻心跳。
 */

import type { BacklogConfig } from "../../../prototype/src/core/backlog.ts";
import { DEFAULT_BACKLOG_CONFIG } from "../../../prototype/src/core/backlog.ts";
import type { Store } from "../store/db.ts";

const KEY = "backlog.config";

/** 数值钳到 [min, max]（保边界不保默认：用户要 1 分钟就给下界 5，不静默换成默认 30）；非数回落默认 */
const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

/** 深合并 + 钳制：未知字段丢弃，越界值回落默认 */
export function normalizeBacklogConfig(raw: unknown): BacklogConfig {
  const d = DEFAULT_BACKLOG_CONFIG;
  if (raw === null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const hb = (r["heartbeat"] ?? {}) as Record<string, unknown>;
  const co = (r["consolidate"] ?? {}) as Record<string, unknown>;
  const fs = (r["feishu"] ?? {}) as Record<string, unknown>;
  const qr = (r["quotaResume"] ?? {}) as Record<string, unknown>;
  const ap = (r["autopilot"] ?? {}) as Record<string, unknown>;
  const runtimes: Record<string, BacklogConfig["runtimes"][string]> = {};
  if (r["runtimes"] !== null && typeof r["runtimes"] === "object") {
    for (const [id, v] of Object.entries(r["runtimes"] as Record<string, unknown>)) {
      if (v === null || typeof v !== "object") continue;
      const q = v as Record<string, unknown>;
      const fmt = q["probeFormat"];
      runtimes[id] = {
        subscribed: q["subscribed"] === true,
        probeCmd: typeof q["probeCmd"] === "string" && q["probeCmd"].trim() !== "" ? q["probeCmd"] : null,
        probeFormat: fmt === "zcode-quota" || fmt === "mmx-json" || fmt === "raw" ? fmt : "raw",
        windowHours: clampInt(q["windowHours"], 1, 24 * 30, 5),
        limit: q["limit"] === null || q["limit"] === undefined ? null : clampInt(q["limit"], 1, 1_000_000, 100),
      };
    }
  }
  return {
    heartbeat: {
      enabled: hb["enabled"] === true,
      intervalMinutes: clampInt(hb["intervalMinutes"], 5, 24 * 60, d.heartbeat.intervalMinutes),
      idleMinutes: clampInt(hb["idleMinutes"], 1, 24 * 60, d.heartbeat.idleMinutes),
      proposalTimeoutMinutes: clampInt(hb["proposalTimeoutMinutes"], 1, 120, d.heartbeat.proposalTimeoutMinutes),
      maxIgnoreCount: clampInt(hb["maxIgnoreCount"], 1, 10, d.heartbeat.maxIgnoreCount),
      runtimeId: str(hb["runtimeId"], ""),
      model: typeof hb["model"] === "string" && hb["model"] !== "" ? hb["model"] : null,
    },
    runtimes,
    quotaResume: {
      // 缺省 enabled=true（跟默认配置同向）：只写了一半的旧配置不该把续跑悄悄关掉
      enabled: qr["enabled"] !== false,
      exhaustedPercent: clampInt(qr["exhaustedPercent"], 0, 100, d.quotaResume.exhaustedPercent),
      delayMinutes: clampInt(qr["delayMinutes"], 0, 24 * 60, d.quotaResume.delayMinutes),
      message: typeof qr["message"] === "string" && qr["message"].trim() !== "" ? qr["message"] : d.quotaResume.message,
      runtimes: Array.isArray(qr["runtimes"])
        ? qr["runtimes"].filter((x): x is string => typeof x === "string" && x !== "")
        : null,
    },
    consolidate: {
      enabled: co["enabled"] !== false,
      atMinutes: clampInt(co["atMinutes"], 0, 24 * 60 - 1, d.consolidate.atMinutes),
    },
    autopilot: {
      // 缺省 enabled=true（跟默认配置同向）：只写了一半的旧配置不该把闲时执行悄悄关掉
      enabled: ap["enabled"] !== false,
      maxConcurrent: clampInt(ap["maxConcurrent"], 1, 4, d.autopilot.maxConcurrent),
      headroomFloorPercent: clampInt(ap["headroomFloorPercent"], 0, 100, d.autopilot.headroomFloorPercent),
      autoReview: ap["autoReview"] !== false,
    },
    feishu: {
      enabled: fs["enabled"] === true,
      botId: str(fs["botId"], d.feishu.botId),
      accountId: str(fs["accountId"], d.feishu.accountId),
      receiveId: str(fs["receiveId"], ""),
    },
  };
}

export function getBacklogConfig(store: Store): BacklogConfig {
  const raw = store.kvGet(KEY);
  if (raw === undefined) return DEFAULT_BACKLOG_CONFIG;
  try {
    return normalizeBacklogConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_BACKLOG_CONFIG;
  }
}

/** patch 是部分对象；heartbeat/consolidate/feishu 按一层深合并（部分 patch 不丢既有字段），runtimes 按 id 合并 */
export function setBacklogConfig(store: Store, patch: unknown): BacklogConfig {
  const prev = getBacklogConfig(store);
  const p = (patch ?? {}) as Record<string, unknown>;
  const section = (name: "heartbeat" | "quotaResume" | "consolidate" | "feishu" | "autopilot"): Record<string, unknown> => {
    const base = prev[name] as unknown as Record<string, unknown>;
    const over = p[name];
    return over !== null && typeof over === "object" ? { ...base, ...(over as Record<string, unknown>) } : base;
  };
  const merged: Record<string, unknown> = { ...p };
  if (p["heartbeat"] !== undefined) merged["heartbeat"] = section("heartbeat");
  if (p["consolidate"] !== undefined) merged["consolidate"] = section("consolidate");
  if (p["feishu"] !== undefined) merged["feishu"] = section("feishu");
  if (p["quotaResume"] !== undefined) merged["quotaResume"] = section("quotaResume");
  if (p["autopilot"] !== undefined) merged["autopilot"] = section("autopilot");
  // runtimes 单独按 id 合并（prev 的保留，patch 的覆盖同名项）
  if (p["runtimes"] !== null && typeof p["runtimes"] === "object") {
    merged["runtimes"] = { ...prev.runtimes, ...(p["runtimes"] as Record<string, unknown>) };
  }
  const next = normalizeBacklogConfig({ ...(prev as unknown as Record<string, unknown>), ...merged });
  store.kvSet(KEY, JSON.stringify(next));
  return next;
}
