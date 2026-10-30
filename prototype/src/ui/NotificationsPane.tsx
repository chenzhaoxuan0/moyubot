import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Bell,
  BellRing,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  GitBranch,
  Info,
  ListTodo,
  MessageSquareWarning,
  Package,
  Radio,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { NotificationKind, NotificationLevel, WorkbenchNotification } from "../store/useNotifications.ts";
import { sessionTargetOf, useNotifications } from "../store/useNotifications.ts";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useTaskJump } from "../store/useTaskJump.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { UnitId } from "../core/units.ts";
import { cn } from "./cn.ts";

/**
 * 通知中心页（workspace 级 tab 的内容）—— store/useNotifications 聚合出的
 * 「你不在它面前」事件流：后台会话终态、审批请求、错误、系统通知、待办信号、
 * 仓库变更。
 *
 * 交互：行点击按 kind 跳转（有会话目标 → 实时监控回放；待办 → 待办视图），
 * 顶部全部已读 / 清空。打开面板即全部已读 —— 未读点的职责是「把你拉过来」，
 * 人到了就别再亮着。不做 toast：项目没有全局 toast 基建，本轮不建。
 */

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  session: Radio,
  permission: MessageSquareWarning,
  error: CircleAlert,
  notice: Info,
  steer: MessageSquareWarning,
  deliverable: Package,
  backlog: ListTodo,
  git: GitBranch,
  reminder: BellRing,
};

const LEVEL_CLS: Record<NotificationLevel, string> = {
  info: "text-ash",
  ok: "text-gain",
  warn: "text-amber-600",
  loss: "text-loss",
};

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function NotificationsPane({ shown }: { shown: boolean }): ReactElement {
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clear = useNotifications((s) => s.clear);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  // 打开即全部已读：未读点的职责是把人拉过来，人到了就熄灯
  useEffect(() => {
    if (shown) markAllRead();
  }, [shown, markAllRead]);

  const visible = useMemo(
    () => (filter === "unread" ? items.filter((n) => !n.read) : items),
    [items, filter],
  );
  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <Bell size={13} className="shrink-0 text-teal" />
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink">通知中心</span>
        <button
          type="button"
          onClick={() => setFilter((f) => (f === "all" ? "unread" : "all"))}
          aria-label={filter === "all" ? "只看未读" : "看全部"}
          className={cn(
            "shrink-0 rounded-chip px-1.5 py-0.5 text-[10px] transition",
            filter === "unread" ? "bg-teal-tint text-teal" : "bg-line-soft text-ash hover:text-ink",
          )}
        >
          {filter === "unread" ? `未读 ${unread}` : "全部"}
        </button>
        <button
          type="button"
          onClick={markAllRead}
          aria-label="全部已读"
          title="全部标为已读"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <CheckCheck size={12} />
        </button>
        <button
          type="button"
          onClick={() => clear()}
          aria-label="清空通知"
          title="清空全部通知"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* 通知列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-8 text-center">
            <BellRing size={18} className="mx-auto text-ash" />
            <p className="mt-2 text-caption font-medium text-graphite">
              {filter === "unread" ? "没有未读通知" : "还没有通知"}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-ash">
              自动化 / IM 渠道 / 手机端发起的后台会话有动静（结束、出错、等审批）
              会出现在这里；工作台正前方的会话不通知 —— 它就在你眼前。
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {visible.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationRow({ n }: { n: WorkbenchNotification }): ReactElement {
  const Icon = n.level === "ok" ? CircleCheck : n.level === "warn" ? TriangleAlert : n.level === "loss" ? CircleAlert : KIND_ICON[n.kind];
  const jump = useNotificationJump(n);

  return (
    <button
      type="button"
      onClick={jump === null ? undefined : jump}
      disabled={jump === null}
      title={jump === null ? undefined : "点击跳转"}
      className={cn(
        "flex w-full items-start gap-2 rounded-btn px-2 py-1.5 text-left transition",
        jump !== null ? "cursor-pointer hover:bg-line-soft" : "cursor-default",
      )}
    >
      <Icon size={13} className={cn("mt-0.5 shrink-0", LEVEL_CLS[n.level])} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink">{n.title}</span>
          {n.sourceLabel !== undefined && (
            <span className="shrink-0 rounded-chip bg-line-soft px-1 py-px text-[9px] text-ash">{n.sourceLabel}</span>
          )}
          {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-label="未读" />}
        </span>
        {n.text !== "" && <span className="mt-0.5 block break-all text-[11px] leading-relaxed text-graphite">{n.text}</span>}
        <span className="mt-0.5 block text-[10px] text-ash">{relativeTime(n.at)}</span>
      </span>
    </button>
  );
}

/** 行点击的跳转目标：提醒深链 → 清单页滚到条目/卡片；有会话归属 → 实时监控回放；待办提议 → 待办视图 */
function useNotificationJump(n: WorkbenchNotification): (() => void) | null {
  const selectUnit = useWorkbench((s) => s.selectUnit);
  return useMemo(() => {
    // 提醒深链（docs/30）：通知把人送回那条清单条目 / 待办卡片 —— 「送回」必须
    // 走完最后一步，只切页面不滚动等于送了一半
    if (n.kind === "reminder" && n.link !== undefined) {
      return () => {
        useShell.getState().setMainView("backlog");
        useTaskJump.getState().jump({ kind: n.link!.kind === "backlog-item" ? "backlog" : "inbox", id: n.link!.id });
      };
    }
    if (n.backlog === true) {
      return () => useShell.getState().setMainView("backlog");
    }
    if (n.sessionId === undefined) return null;
    const target = sessionTargetOf(n.sessionId);
    if (target === null) return null;
    return () => {
      // 监控 tab 按 owner 过滤可见：归属不是当前 bot 时先切过去（SidePaneHome
      // 「其他单元历史」同款约定）
      const scope = useSidePane.getState().scopeUnitId;
      if (scope === null || String(scope) !== target.unitId) selectUnit(target.unitId as UnitId);
      useSidePane.getState().openLiveSession({
        unitId: target.unitId as UnitId,
        sessionId: n.sessionId!,
        runtimeId: target.runtimeId,
        title: target.title !== "" ? target.title : n.title,
      });
    };
  }, [n.kind, n.link, n.backlog, n.sessionId, n.title, selectUnit]);
}
