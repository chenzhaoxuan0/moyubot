import { create } from "zustand";
import { SESSION_SOURCE_LABEL, type SessionSource } from "../core/units.ts";
import {
  DaemonClient,
  defaultDaemonEndpoint,
  fetchNotifications,
  type DaemonNotificationRow,
} from "../adapters/daemon/client.ts";
import { useWorkbench } from "./useWorkbench.ts";

/**
 * 通知中心的消费面 —— daemon 事实源的客户端投影（docs/21 P4b / ADR 0015）。
 *
 * 聚合（自然键、等级映射、自动化终态取任务名）已上移 daemon（backend/src/notifications.ts），
 * 实时经 WS notifications 帧、历史经 notifications.list 拉取——GUI 与 CLI/agent 消费同一份事实。
 * 留在本层的是纯呈现：
 * - **「你不在它面前」过滤**：workbench 正前方的会话不进通知（审批/报错只豁免正盯着的那个）；
 * - **已读标记**：每客户端本地（readSet + clearedAt 落 localStorage，F5 不清空）。
 * 旧实现的三块前端逻辑（事件聚合、断线对账补拉、自动化台账补偿解析）随上移退役删除。
 */

export type NotificationLevel = "info" | "ok" | "warn" | "loss";
export type NotificationKind =
  | "session"
  | "permission"
  | "error"
  | "notice"
  | "steer"
  | "deliverable"
  | "backlog"
  | "git"
  | "reminder";

/** 提醒深链目标（与 daemon AutomationLink 同形）：点开直达清单条目 / 待办卡片 */
export interface NotificationLink {
  readonly kind: "inbox-entry" | "backlog-item";
  readonly id: number;
}

export interface WorkbenchNotification {
  /** 自然键（去重口径），如 `end:s1` / `git:C:/repo` */
  readonly id: string;
  readonly at: number;
  readonly level: NotificationLevel;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly text: string;
  /** 来源徽标（自动化 / 飞书 / …） */
  readonly sourceLabel?: string;
  /** 可跳转的会话（点击 → 实时监控回放） */
  readonly sessionId?: string;
  /** 待办提议跳待办视图 */
  readonly backlog?: boolean;
  /** 提醒深链（kind=reminder）：点开滚到清单条目 / 待办卡片 */
  readonly link?: NotificationLink;
  readonly read: boolean;
}

const MAX_ITEMS = 100;
const READ_KEY = "agent-workbench:notifications-read-v2";
const CLEARED_KEY = "agent-workbench:notifications-cleared-v2";
const MAX_READ_IDS = 500;

// ---------------------------------------------------------------------------
// 本地呈现状态（已读 / 清空线）
// ---------------------------------------------------------------------------

function readSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    const ids = raw === null ? [] : (JSON.parse(raw) as { ids?: unknown[] }).ids;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let persistReadTimer: ReturnType<typeof setTimeout> | undefined;
function persistRead(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  clearTimeout(persistReadTimer);
  persistReadTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(READ_KEY, JSON.stringify({ ids: ids.slice(0, MAX_READ_IDS) }));
    } catch {
      /* ignore */
    }
  }, 500);
}

function clearedAt(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(CLEARED_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationsStore {
  items: WorkbenchNotification[];
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useNotifications = create<NotificationsStore>((set) => ({
  items: [],
  markRead: (id) => {
    const ids = [...readSet(), id];
    persistRead(ids);
    set((s) => (s.items.some((n) => n.id === id && !n.read) ? { items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)) } : s));
  },
  markAllRead: () => {
    const ids = [...readSet(), ...useNotifications.getState().items.map((n) => n.id)];
    persistRead(ids);
    set((s) => (s.items.some((n) => !n.read) ? { items: s.items.map((n) => ({ ...n, read: true })) } : s));
  },
  clear: () => {
    // 清空是呈现动作：记一条「清空线」，daemon 事实不动，之后的行照常进来
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CLEARED_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
    }
    set({ items: [] });
  },
}));

// ---------------------------------------------------------------------------
// daemon 行 → 通知（呈现过滤在这里）
// ---------------------------------------------------------------------------

/** 「你不在它面前」判据：workbench 来源、或就是当前活跃会话（正看着呢） */
function inForeground(row: Pick<DaemonNotificationRow, "sessionId" | "source">): boolean {
  if (row.source === "workbench") return true;
  return row.sessionId !== undefined && String(useWorkbench.getState().activeSessionId ?? "") === row.sessionId;
}

/** 注意力口径（审批 / 报错用，比 inForeground 严）：只认「现在正盯着的是不是它」 */
function stillWatching(sessionId: string | undefined): boolean {
  return sessionId !== undefined && String(useWorkbench.getState().activeSessionId ?? "") === sessionId;
}

/** Electron 桌面 toast（preload 暴露；Web 模式没有这个方法，自然降级为仅应用内） */
function desktopToast(title: string, body: string): void {
  const api = (window as unknown as { electronAPI?: { notifyDesktop?: (o: { title: string; body: string }) => void } }).electronAPI;
  try {
    api?.notifyDesktop?.({ title, body });
  } catch {
    /* 桥抖一下不影响应用内通知 */
  }
}

function insertRow(row: DaemonNotificationRow): void {
  const line = clearedAt();
  if (row.at <= line) return;
  // 呈现过滤（口径与旧实现逐条一致）：正盯着的会话不通知；审批与报错只豁免
  // stillWatching 那一个（挂着的审批不提醒就无限等，不吃整类豁免）
  if (row.kind === "session" || row.kind === "steer" || row.kind === "deliverable") {
    if (inForeground(row)) return;
  } else if ((row.kind === "permission" || row.kind === "error") && stillWatching(row.sessionId)) {
    return;
  }
  // 提醒是用户亲手挂的（高信号、预期中）—— 强通道：应用内行之外再发桌面 toast。
  // 系统推断类通知不走这里（打断预算原则，docs/30）
  if (row.kind === "reminder") desktopToast(row.title, row.text);
  const source = row.source as SessionSource | undefined;
  const item: WorkbenchNotification = {
    id: row.id,
    at: row.at,
    level: row.level,
    kind: row.kind,
    title: row.title,
    text: row.text,
    sourceLabel: source !== undefined ? (SESSION_SOURCE_LABEL[source] ?? source) : undefined,
    sessionId: row.sessionId,
    backlog: row.backlog,
    link: row.link,
    read: readSet().has(row.id),
  };
  useNotifications.setState((s) => {
    const rest = s.items.filter((n) => n.id !== item.id);
    return { items: [item, ...rest].slice(0, MAX_ITEMS) };
  });
}

/** 通知行的跳转目标（NotificationsPane / B3 的监控入口共用）——会话归属查工作台台账 */
export function sessionTargetOf(
  sessionId: string,
): { unitId: string; runtimeId: string; title: string } | null {
  const s = useWorkbench.getState().sessions.find((x) => String(x.id) === sessionId);
  if (s === undefined || s.unitId === undefined || s.runtimeId === undefined) return null;
  return { unitId: String(s.unitId), runtimeId: String(s.runtimeId), title: s.title ?? "" };
}

// ---------------------------------------------------------------------------
// 安装（WorkspaceShell 挂一次）
// ---------------------------------------------------------------------------

/** 拉历史事实 + 叠本地已读/清空线（boot 与 resync/换代共用——daemon 持久化了，客户端不用再对账） */
function seedFromLedger(): void {
  void fetchNotifications()
    .then((rows) => {
      for (const row of [...rows].reverse()) insertRow(row); // 旧→新插入，新的排前面
    })
    .catch(() => {
      /* 拉不到：实时推流仍在，只损失历史 */
    });
}

export function installNotifications(): () => void {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  const unsubs = [
    client.onNotification(insertRow),
    client.onResync(seedFromLedger),
    client.onGenerationChange(seedFromLedger),
  ];
  seedFromLedger();
  return () => {
    for (const u of unsubs) u();
  };
}
