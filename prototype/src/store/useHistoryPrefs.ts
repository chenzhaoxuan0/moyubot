import { create } from "zustand";
import type { UnitHistoryEntry } from "../adapters/daemon/client.ts";

/**
 * 历史会话展示偏好。
 *
 * 失败会话（status === "failed"，红点）由于无法交互且无法重现，
 * 默认在侧边栏和详情弹窗中隐藏，保留随时重新开启的能力。
 *
 * 归档会话（archivedKeys）：将已完成的任务放进抽屉里，
 * 内容和历史全部保留，仅从左侧栏隐藏以释放空间；
 * 可在设置页面或侧栏归档抽屉中随时查看与取消归档。
 */

export interface HistoryPrefs {
  /** 在左侧栏中隐藏失败会话（默认 true） */
  hideFailedInSidebar: boolean;
  /** 在点开后的历史会话弹窗中隐藏失败会话（默认 true） */
  hideFailedInDialog: boolean;
  /**
   * 已查看的会话标记（entry key 与 `session-<id>` 混存，cap 500 淘汰最旧）。
   * 「完成任务但未查看 → 绿灯」的已读依据：被打开过（聊天页 / TUI）即视为已读。
   */
  viewedKeys: string[];
  /**
   * 绿灯的起算时刻（首次使用本功能的时间）：之前的存量历史一律视为已读，
   * 否则上线瞬间每条历史都挂绿灯，灯就失去「有新完成」的信号意义了。
   */
  lightsSinceTs: number;
  /**
   * 单条会话的默认打开方式覆盖（entry key → 覆盖值）。
   * 缺省按来源：对话页创建（headless）→ 聊天页打开，TUI 创建 → TUI 重现。
   */
  entryOpenMode: Record<string, "chat" | "tui">;
  /** 用户置顶的历史会话（entry key 列表，cap 50）—— 侧栏子列表里排在最前 */
  pinnedKeys: string[];
  /** 用户手动归档的历史任务（entry key 列表）—— 移入已完成抽屉，不在左侧栏占用空间 */
  archivedKeys: string[];
  /** 已归档任务的元数据快照缓存（key -> UnitHistoryEntry），用于抽屉与设置页直出 */
  archivedEntries: Record<string, UnitHistoryEntry>;
  /** 是否开启自动归档旧任务（默认 false，对齐 ZCode taskAutoArchiveEnabled） */
  autoArchiveEnabled: boolean;
  /** 自动归档保留时长天数（默认 7，选项 3/7/14/30，对齐 ZCode taskAutoArchiveOlderThanDays） */
  autoArchiveOlderThanDays: number;
  /**
   * 用户手动覆盖的会话状态灯（entry key -> 状态值）。
   * 允许用户强制消灯（"none"）或手动标为绿灯（"unread"）/蓝灯/红灯，赋予用户对灯的完全控制权。
   */
  lightOverrides: Record<string, "none" | "unread" | "alive" | "executing" | "failed">;
}

export const AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const;

const DEFAULTS: HistoryPrefs = {
  hideFailedInSidebar: true,
  hideFailedInDialog: true,
  viewedKeys: [],
  lightsSinceTs: 0,
  entryOpenMode: {},
  pinnedKeys: [],
  archivedKeys: [],
  archivedEntries: {},
  autoArchiveEnabled: false,
  autoArchiveOlderThanDays: 7,
  lightOverrides: {},
};

/** 已读标记容量上限：超出后丢最旧的（FIFO），防止 localStorage 无限膨胀 */
const VIEWED_CAP = 500;
/** 置顶容量上限：置顶是稀缺的手动标记，多了「置顶区」就失去意义 */
const PINNED_CAP = 50;
/** 归档容量上限：防止极端情况下无限制堆积 */
const ARCHIVED_CAP = 1000;

const STORAGE_KEY = "agent-workbench:history-prefs";

function load(): HistoryPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      // 首次使用：绿灯从现在起算（存量历史视为已读，见 lightsSinceTs 注释）
      return { ...DEFAULTS, lightsSinceTs: Date.now() };
    }
    const p = JSON.parse(raw) as Partial<HistoryPrefs>;
    return {
      hideFailedInSidebar: typeof p.hideFailedInSidebar === "boolean" ? p.hideFailedInSidebar : DEFAULTS.hideFailedInSidebar,
      hideFailedInDialog: typeof p.hideFailedInDialog === "boolean" ? p.hideFailedInDialog : DEFAULTS.hideFailedInDialog,
      viewedKeys: Array.isArray(p.viewedKeys) ? p.viewedKeys.filter((k): k is string => typeof k === "string") : [],
      lightsSinceTs: typeof p.lightsSinceTs === "number" && p.lightsSinceTs > 0 ? p.lightsSinceTs : Date.now(),
      entryOpenMode:
        p.entryOpenMode !== null && typeof p.entryOpenMode === "object"
          ? Object.fromEntries(
              Object.entries(p.entryOpenMode as Record<string, unknown>).filter(
                (entry): entry is [string, "chat" | "tui"] => entry[1] === "chat" || entry[1] === "tui",
              ),
            )
          : {},
      pinnedKeys: Array.isArray(p.pinnedKeys) ? p.pinnedKeys.filter((k): k is string => typeof k === "string") : [],
      archivedKeys: Array.isArray(p.archivedKeys) ? p.archivedKeys.filter((k): k is string => typeof k === "string") : [],
      archivedEntries:
        p.archivedEntries !== null && typeof p.archivedEntries === "object"
          ? (p.archivedEntries as Record<string, UnitHistoryEntry>)
          : {},
      autoArchiveEnabled:
        typeof p.autoArchiveEnabled === "boolean" ? p.autoArchiveEnabled : DEFAULTS.autoArchiveEnabled,
      autoArchiveOlderThanDays:
        typeof p.autoArchiveOlderThanDays === "number" && p.autoArchiveOlderThanDays > 0
          ? p.autoArchiveOlderThanDays
          : DEFAULTS.autoArchiveOlderThanDays,
      lightOverrides:
        p.lightOverrides !== null && typeof p.lightOverrides === "object"
          ? (p.lightOverrides as Record<string, "none" | "unread" | "alive" | "executing" | "failed">)
          : {},
    };
  } catch {
    return { ...DEFAULTS, lightsSinceTs: Date.now() };
  }
}

function persist(prefs: HistoryPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略 localStorage 写入异常
  }
}

function notifyHistoryRefresh(unitId?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId } }));
  } catch {
    // 忽略事件派发异常
  }
}

export interface HistoryPrefsStore {
  prefs: HistoryPrefs;
  setPrefs: (patch: Partial<HistoryPrefs>) => void;
  resetDefaults: () => void;
  /** 标记已查看（entry key 或 `session-<id>`；重复幂等，超容量淘汰最旧） */
  markViewed: (keys: string | readonly string[]) => void;
  /** 会话是否未读：绿灯 = 完成于起算时刻之后 && 从未打开过 */
  isUnread: (keys: string | readonly string[], finishedAt: number | null) => boolean;
  /** 覆盖某条会话的默认打开方式；传 null 清除覆盖（回落按来源判定） */
  setEntryOpenMode: (key: string, mode: "chat" | "tui" | null) => void;
  /** 置顶 / 取消置顶一条历史会话（entry key；幂等切换） */
  togglePinned: (key: string) => void;
  /** 批量置顶（导入会话用） */
  pinKeys: (keys: string[]) => void;
  /** 批量取消置顶（左栏多选管理） */
  unpinKeys: (keys: readonly string[]) => void;
  /** 用户手动覆盖会话灯状态：传 "none" 彻底消灯，传 null 恢复系统自动判定 */
  setLightOverride: (key: string, light: "none" | "unread" | "alive" | "executing" | "failed" | null) => void;
  /** 彻底清除某条会话的灯（消灯且标记已读） */
  clearLight: (key: string) => void;
  /** 归档一条任务/会话：移入抽屉，不再显示在左侧栏占用空间 */
  archiveEntry: (entry: UnitHistoryEntry) => void;
  /** 取消归档任务（恢复显示在左侧栏） */
  unarchiveKey: (key: string) => void;
  /** 切换归档态 */
  toggleArchived: (entry: UnitHistoryEntry) => void;
  /** 批量归档（左栏多选管理）：一次 set + 一次落盘 */
  archiveEntriesBatch: (entries: readonly UnitHistoryEntry[]) => void;
  /** 批量取消归档（左栏多选管理） */
  unarchiveKeysBatch: (keys: readonly string[]) => void;
  /** 批量消灯并标已读（左栏多选管理）：viewedKeys 并入 + lightOverrides 置 none，一次落盘 */
  clearLightsBatch: (pairs: readonly { key: string; sessionId: string | null }[]) => void;
  /** 检查任务是否处于归档状态 */
  isArchived: (key: string, sessionId?: string | null) => boolean;
  /** 全部取消归档（一键还原抽屉内的所有任务） */
  unarchiveAll: () => void;
  /** 更新/同步已归档任务的最新快照（从 daemon 轮询拉取时丰富字段） */
  updateArchivedEntries: (entries: readonly UnitHistoryEntry[]) => void;
  /**
   * 运行自动归档检查（对齐 ZCode archiveStaleTasks）：
   * 若启用了 autoArchiveEnabled，自动归档结束/更新时间早于设定天数的已完成且未置顶任务。
   */
  runAutoArchive: (entries: readonly UnitHistoryEntry[]) => number;
}

export const useHistoryPrefs = create<HistoryPrefsStore>((set, get) => ({
  prefs: load(),
  setPrefs: (patch) =>
    set((state) => {
      const next = { ...state.prefs, ...patch };
      persist(next);
      return { prefs: next };
    }),
  resetDefaults: () => {
    persist({ ...DEFAULTS, lightsSinceTs: get().prefs.lightsSinceTs || Date.now() });
    set((state) => ({ prefs: { ...DEFAULTS, lightsSinceTs: state.prefs.lightsSinceTs || Date.now() } }));
  },
  setLightOverride: (key, light) => {
    set((state) => {
      const nextMap = { ...state.prefs.lightOverrides };
      if (light === null) {
        delete nextMap[key];
      } else {
        nextMap[key] = light;
      }
      const next = { ...state.prefs, lightOverrides: nextMap };
      persist(next);
      return { prefs: next };
    });
  },
  clearLight: (key) => {
    get().setLightOverride(key, "none");
    get().markViewed(key);
  },
  markViewed: (keys) => {
    const incoming = Array.isArray(keys) ? [...keys] : [keys];
    set((state) => {
      const known = new Set(state.prefs.viewedKeys);
      const fresh = incoming.filter((k) => k !== "" && !known.has(k));
      if (fresh.length === 0) return {};
      const nextViewed = [...state.prefs.viewedKeys, ...fresh].slice(-VIEWED_CAP);
      const next = { ...state.prefs, viewedKeys: nextViewed };
      persist(next);
      return { prefs: next };
    });
  },
  isUnread: (keys, finishedAt) => {
    const p = get().prefs;
    if (finishedAt === null || finishedAt < p.lightsSinceTs) return false;
    const list = Array.isArray(keys) ? keys : [keys];
    return list.every((k) => !p.viewedKeys.includes(k));
  },
  setEntryOpenMode: (key, mode) =>
    set((state) => {
      const nextModes = { ...state.prefs.entryOpenMode };
      if (mode === null) delete nextModes[key];
      else nextModes[key] = mode;
      const next = { ...state.prefs, entryOpenMode: nextModes };
      persist(next);
      return { prefs: next };
    }),
  togglePinned: (key) =>
    set((state) => {
      if (key === "") return {};
      const has = state.prefs.pinnedKeys.includes(key);
      const nextPinned = has
        ? state.prefs.pinnedKeys.filter((k) => k !== key)
        : [...state.prefs.pinnedKeys, key].slice(-PINNED_CAP);
      const next = { ...state.prefs, pinnedKeys: nextPinned };
      persist(next);
      return { prefs: next };
    }),
  /** 批量置顶（导入会话用：导入的那一刻就是想立刻在侧栏最顶上看到它们） */
  pinKeys: (keys) =>
    set((state) => {
      const fresh = keys.filter((k) => k !== "" && !state.prefs.pinnedKeys.includes(k));
      if (fresh.length === 0) return {};
      const next = { ...state.prefs, pinnedKeys: [...state.prefs.pinnedKeys, ...fresh].slice(-PINNED_CAP) };
      persist(next);
      return { prefs: next };
    }),
  unpinKeys: (keys) =>
    set((state) => {
      const drop = new Set(keys);
      const nextPinned = state.prefs.pinnedKeys.filter((k) => !drop.has(k));
      if (nextPinned.length === state.prefs.pinnedKeys.length) return {};
      const next = { ...state.prefs, pinnedKeys: nextPinned };
      persist(next);
      return { prefs: next };
    }),
  archiveEntry: (entry) => {
    set((state) => {
      if (!entry.key) return {};
      const key = entry.key;
      const has = state.prefs.archivedKeys.includes(key);
      const nextKeys = has ? state.prefs.archivedKeys : [...state.prefs.archivedKeys, key].slice(-ARCHIVED_CAP);
      const nextEntries = { ...state.prefs.archivedEntries, [key]: entry };
      const next = { ...state.prefs, archivedKeys: nextKeys, archivedEntries: nextEntries };
      persist(next);
      notifyHistoryRefresh(entry.unitId);
      return { prefs: next };
    });
  },
  unarchiveKey: (key) => {
    set((state) => {
      if (!key) return {};
      const targetUnitId = state.prefs.archivedEntries[key]?.unitId;
      const nextKeys = state.prefs.archivedKeys.filter((k) => k !== key && k !== `session-${key}`);
      const nextEntries = { ...state.prefs.archivedEntries };
      delete nextEntries[key];
      if (key.startsWith("session-")) {
        delete nextEntries[key.replace(/^session-/, "")];
      }
      const next = { ...state.prefs, archivedKeys: nextKeys, archivedEntries: nextEntries };
      persist(next);
      notifyHistoryRefresh(targetUnitId);
      return { prefs: next };
    });
  },
  toggleArchived: (entry) => {
    const isArch = get().isArchived(entry.key, entry.sessionId);
    if (isArch) {
      get().unarchiveKey(entry.key);
    } else {
      get().archiveEntry(entry);
    }
  },
  archiveEntriesBatch: (entries) => {
    set((state) => {
      const nextKeys = [...state.prefs.archivedKeys];
      const nextEntries = { ...state.prefs.archivedEntries };
      const unitIds = new Set<string>();
      let added = false;
      for (const e of entries) {
        if (!e.key) continue;
        if (!nextKeys.includes(e.key)) {
          nextKeys.push(e.key);
          added = true;
        }
        if (e.sessionId && !nextKeys.includes(`session-${e.sessionId}`)) {
          nextKeys.push(`session-${e.sessionId}`);
          added = true;
        }
        nextEntries[e.key] = e;
        if (e.sessionId) nextEntries[`session-${e.sessionId}`] = e;
        if (e.unitId) unitIds.add(e.unitId);
      }
      if (!added) return {};
      const next = {
        ...state.prefs,
        archivedKeys: nextKeys.slice(-ARCHIVED_CAP),
        archivedEntries: nextEntries,
      };
      persist(next);
      for (const id of unitIds) notifyHistoryRefresh(id);
      return { prefs: next };
    });
  },
  unarchiveKeysBatch: (keys) => {
    set((state) => {
      const drop = new Set<string>();
      for (const k of keys) {
        drop.add(k);
        if (k.startsWith("session-")) drop.add(k.replace(/^session-/, ""));
        else drop.add(`session-${k}`);
      }
      const nextKeys = state.prefs.archivedKeys.filter((k) => !drop.has(k));
      const nextEntries = { ...state.prefs.archivedEntries };
      for (const k of drop) delete nextEntries[k];
      if (nextKeys.length === state.prefs.archivedKeys.length) return {};
      const next = { ...state.prefs, archivedKeys: nextKeys, archivedEntries: nextEntries };
      persist(next);
      notifyHistoryRefresh();
      return { prefs: next };
    });
  },
  clearLightsBatch: (pairs) => {
    set((state) => {
      const viewed = new Set(state.prefs.viewedKeys);
      const overrides = { ...state.prefs.lightOverrides };
      let changed = false;
      for (const p of pairs) {
        for (const k of p.sessionId !== null ? [p.key, `session-${p.sessionId}`] : [p.key]) {
          if (k !== "" && !viewed.has(k)) {
            viewed.add(k);
            changed = true;
          }
          if (overrides[k] !== "none") {
            overrides[k] = "none";
            changed = true;
          }
        }
      }
      if (!changed) return {};
      const next = {
        ...state.prefs,
        viewedKeys: [...viewed].slice(-VIEWED_CAP),
        lightOverrides: overrides,
      };
      persist(next);
      return { prefs: next };
    });
  },
  isArchived: (key, sessionId) => {
    const p = get().prefs;
    if (p.archivedKeys.includes(key)) return true;
    if (sessionId && (p.archivedKeys.includes(sessionId) || p.archivedKeys.includes(`session-${sessionId}`))) {
      return true;
    }
    return false;
  },
  unarchiveAll: () => {
    set((state) => {
      const next = { ...state.prefs, archivedKeys: [], archivedEntries: {} };
      persist(next);
      notifyHistoryRefresh();
      return { prefs: next };
    });
  },
  updateArchivedEntries: (entries) => {
    set((state) => {
      const archivedSet = new Set(state.prefs.archivedKeys);
      let changed = false;
      const nextEntries = { ...state.prefs.archivedEntries };
      for (const e of entries) {
        if (archivedSet.has(e.key) || (e.sessionId && archivedSet.has(`session-${e.sessionId}`))) {
          nextEntries[e.key] = e;
          changed = true;
        }
      }
      if (!changed) return {};
      const next = { ...state.prefs, archivedEntries: nextEntries };
      persist(next);
      return { prefs: next };
    });
  },
  runAutoArchive: (entries) => {
    const { prefs } = get();
    if (!prefs.autoArchiveEnabled || !entries || entries.length === 0) return 0;
    const days = Math.max(1, prefs.autoArchiveOlderThanDays || 7);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const pinnedSet = new Set(prefs.pinnedKeys);
    const archivedSet = new Set(prefs.archivedKeys);
    const toArchive: UnitHistoryEntry[] = [];

    for (const e of entries) {
      if (archivedSet.has(e.key) || (e.sessionId && archivedSet.has(`session-${e.sessionId}`))) {
        continue;
      }
      if (pinnedSet.has(e.key)) {
        continue;
      }
      if (e.status === "running" || e.status === "active") {
        continue;
      }
      const time = e.endedAt ?? e.startedAt;
      if (time > 0 && time < cutoff) {
        toArchive.push(e);
      }
    }

    if (toArchive.length === 0) return 0;

    const nextArchivedKeys = [...prefs.archivedKeys];
    const nextArchivedEntries = { ...prefs.archivedEntries };

    for (const e of toArchive) {
      if (!nextArchivedKeys.includes(e.key)) {
        nextArchivedKeys.push(e.key);
      }
      if (e.sessionId && !nextArchivedKeys.includes(`session-${e.sessionId}`)) {
        nextArchivedKeys.push(`session-${e.sessionId}`);
      }
      nextArchivedEntries[e.key] = e;
      if (e.sessionId) {
        nextArchivedEntries[`session-${e.sessionId}`] = e;
      }
    }

    const finalArchivedKeys =
      nextArchivedKeys.length > ARCHIVED_CAP ? nextArchivedKeys.slice(-ARCHIVED_CAP) : nextArchivedKeys;

    const nextPrefs: HistoryPrefs = {
      ...prefs,
      archivedKeys: finalArchivedKeys,
      archivedEntries: nextArchivedEntries,
    };

    set({ prefs: nextPrefs });
    persist(nextPrefs);
    notifyHistoryRefresh();
    return toArchive.length;
  },
}));

