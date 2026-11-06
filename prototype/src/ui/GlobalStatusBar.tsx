import { useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, Info, X } from "lucide-react";
import { BackgroundGuardianBadge, SessionLightLegendBadge, WorkPhaseBadge } from "./StatusIndicators.tsx";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useNotifications } from "../store/useNotifications.ts";
import { notifyTabId, sidePaneOccupies } from "../core/sidePaneTabs.ts";
import { cn } from "./cn.ts";

/**
 * 全局底栏 —— 纯状态条，横贯窗口底部，固定 28px（h-7）。
 *
 * 任务栏会话折叠机制（「正在播放」chips / 切走自动压缩进底栏 / 折叠对话 /
 * 压缩 ghost 动画 / 为 chip 详情服务的拉高手柄与高度锁定）已整体退役
 * （docs/32 §九）：会话全量由画布标签管理，切换焦点时自动折叠导致闪烁、
 * 与标签模型职责重叠。后台会话的可见性由侧栏历史状态灯 + 通知中心承担。
 *
 * 分区镜像上方三列（宽度同源、拖拽跟手）：
 * - 左下角（侧栏正下方）：会话指示灯说明 / 工作状态 / 后台守护（纯文字）；
 * - 中段（主画布正下方）：留空；
 * - 右段（右侧面板正下方）：底栏 toast + 通知铃。
 * 侧栏收起时左下角由徽标自然占住（min-width: fit-content）。弹层朝上开
 * （popoverUp）且左锚定（徽标在窗口左缘）。
 */
export function GlobalStatusBar() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const sidebarWidth = useShell((s) => s.sidebarWidth);
  const mainView = useShell((s) => s.mainView);
  const paneCollapsed = useSidePane((s) => s.collapsed);
  const paneWidth = useSidePane((s) => s.paneWidth);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const paneOpen = sidePaneOccupies(scopeUnitId, paneCollapsed, mainView === "chat");
  const leftZone = sidebarCollapsed ? 0 : sidebarWidth;
  const rightZone = paneOpen ? paneWidth : 0;

  return (
    <footer
      aria-label="全局状态栏"
      className="aw-statusbar relative flex h-7 shrink-0 items-stretch border-t border-line/60 bg-rail"
    >
      {/* 左下角：会话灯说明、工作状态、后台守护（纯文字，无彩灯） */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-2.5"
        style={{ width: leftZone, minWidth: "fit-content" }}
      >
        <SessionLightLegendBadge popoverUp align="left" />
        <span className="h-3 w-px bg-line/60" />
        <WorkPhaseBadge popoverUp align="left" />
        <span className="h-3 w-px bg-line/60" />
        <BackgroundGuardianBadge popoverUp align="left" />
      </div>
      {/* 中段留空（原任务栏折叠区已退役） */}
      <div className={cn("min-w-0 flex-1", leftZone > 0 && "border-l border-line/40")} />
      {/* 右侧面板正下方：底栏 toast + 通知铃 */}
      <div className="flex shrink-0 items-center justify-end gap-2 px-2.5" style={{ minWidth: rightZone > 0 ? rightZone : "fit-content" }}>
        <BottomToastBar />
        <span className="h-3 w-px bg-line/60" />
        <NotificationStatusItem />
      </div>
    </footer>
  );
}

function NotificationStatusItem() {
  const unreadCount = useNotifications((s) => s.items.filter((n) => !n.read).length);
  const activeTabId = useSidePane((s) => s.activeTabId);
  const tabs = useSidePane((s) => s.tabs);
  const paneCollapsed = useSidePane((s) => s.collapsed);
  const isNotificationsOpen =
    !paneCollapsed &&
    (activeTabId === notifyTabId || tabs.find((t) => t.id === activeTabId)?.type === "notify");

  const handleClick = () => {
    const sidePane = useSidePane.getState();
    const isNowOpen =
      !sidePane.collapsed &&
      (sidePane.activeTabId === notifyTabId ||
        sidePane.tabs.find((t) => t.id === sidePane.activeTabId)?.type === "notify");

    if (isNowOpen) {
      sidePane.closeTab(notifyTabId);
      if (!useSidePane.getState().collapsed) {
        sidePane.toggleCollapsed();
      }
    } else {
      sidePane.openNotifications();
    }
  };

  const hasUnread = unreadCount > 0;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="通知中心"
      title={hasUnread ? `通知 (${unreadCount} 条未读)` : "通知 - 无新通知"}
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded transition cursor-pointer select-none",
        isNotificationsOpen
          ? "bg-teal/15 text-teal"
          : hasUnread
            ? "text-ink hover:bg-line-soft hover:text-ink"
            : "text-ash hover:bg-line-soft hover:text-ink",
      )}
    >
      <Bell size={13} className="shrink-0" />
      {hasUnread && (
        <span
          className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-teal ring-2 ring-rail animate-pulse"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function BottomToastBar() {
  const toast = useWorkbench((s) => s.bottomToast);
  const dismiss = useWorkbench((s) => s.dismissBottomToast);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      dismiss();
    }, 6000);
    return () => clearTimeout(timer);
  }, [toast?.id, dismiss]);

  if (!toast) return null;

  const isWarn = toast.level === "warn";
  const isSuccess = toast.level === "success";

  return (
    <div className="relative flex items-center">
      {detailOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-card border border-line bg-card p-3 shadow-lg z-50 text-left">
          <div className="flex items-center justify-between pb-1.5 border-b border-line/60">
            <span className="text-body-sm font-semibold text-ink">{toast.title}</span>
            <button onClick={() => setDetailOpen(false)} className="rounded p-0.5 text-ash hover:text-ink cursor-pointer">
              <X size={12} />
            </button>
          </div>
          <p className="mt-1.5 text-caption text-graphite leading-relaxed whitespace-pre-wrap">{toast.text}</p>
        </div>
      )}
      <div
        onClick={() => setDetailOpen(!detailOpen)}
        title="点击查看通知详情"
        className={cn(
          "flex max-w-[280px] cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition shadow-2xs border",
          isWarn
            ? "border-amber-500/40 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
            : isSuccess
              ? "border-teal/40 bg-teal-tint text-teal hover:bg-teal/20"
              : "border-line bg-line-soft text-graphite hover:text-ink hover:bg-line",
        )}
      >
        {isWarn ? (
          <AlertTriangle size={11} className="shrink-0" />
        ) : isSuccess ? (
          <CheckCircle2 size={11} className="shrink-0" />
        ) : (
          <Info size={11} className="shrink-0" />
        )}
        <span className="font-medium shrink-0">{toast.title}</span>
        <span className="truncate text-ash/90">{toast.text}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className="ml-1 rounded p-0.5 text-ash/80 hover:text-ink shrink-0 cursor-pointer"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  );
}
