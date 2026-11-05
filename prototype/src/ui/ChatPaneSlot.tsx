import { memo } from "react";
import {
  Columns2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Rows2,
  SquareTerminal,
  X,
} from "lucide-react";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useShell } from "../store/useShell.ts";
import { Timeline, EmptyState } from "./Timeline.tsx";
import { ChatViewport } from "./chat/ChatViewport.tsx";
import { Composer } from "./Composer.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { ChatTerminalDock } from "./ChatTerminalDock.tsx";
import { useChatAccentStyle } from "./useChatAccentStyle.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { cn } from "./cn.ts";

/**
 * 对话窗格（docs/31 会话画布）—— 结构化对话在画布里的落位，与终端窗格平级。
 *
 * 双态渲染（「单活 + 快照注册表」）：
 * - 焦点态（live）：渲染全局链路 —— Timeline/Composer/PermissionDialog/
 *   ChatTerminalDock 原班人马，一行不改；它们读的全局 activeUnitId/activeSessionId
 *   在焦点同步器里被定义为「本窗格的会话」。
 * - 非焦点态 / 恢复中：渲染注册表快照（ChatViewport 只读投影）——失焦那刻从
 *   全局拍照，之后事件泵实时追加；点击窗格任意处即聚焦（权威重建在后台跑，
 *   restoring 标记落地前一直显示快照，无闪跳）。
 *
 * mini-bar 与 TerminalPaneSlot 同款（分屏 >1 窗格时出现）：拆分按钮造**草稿
 * 对话窗格**（内嵌 bot 选择器），「旁开终端」造混排（对话 | TUI 并排是本方案
 * 的杀手场景）。关窗格不杀会话。
 */
export const ChatPaneSlot = memo(function ChatPaneSlot({
  paneKey,
  totalPanesInGroup,
}: {
  paneKey: string;
  totalPanesInGroup: number;
}) {
  const pane = useChatPanes((s) => s.panes[paneKey]);
  const focusedChatKey = useChatPanes((s) => s.focusedChatKey);
  const maximizedId = useTerminalStore((s) => s.maximizedInstanceId);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === pane?.unitId));
  const sessions = useWorkbench((s) => s.sessions);
  const runtimes = useWorkbench((s) => s.runtimes);
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const accentStyle = useChatAccentStyle();

  if (pane === undefined) return null;
  const isFocused = focusedChatKey === paneKey;
  // 恢复中（openSession 在途）也先渲染快照：全局正被清空/重建，直接读会闪
  const isLive = isFocused && !pane.restoring;
  const isMaximized = maximizedId === paneKey;
  const paneTitle = unit ? `${unit.name} · 对话` : "新对话";

  const splitDraftBeside = (direction: "horizontal" | "vertical"): void => {
    const draftKey = useChatPanes.getState().createDraftRecord();
    useTerminalStore.getState().splitPane({ targetPaneId: paneKey, chatPaneKey: draftKey, direction });
  };

  const splitTerminalBeside = (): void => {
    useTerminalStore.getState().splitPane({
      targetPaneId: paneKey,
      direction: "horizontal",
      cwd: unit?.rootPath,
    });
  };

  return (
    <div
      onMouseDown={() => {
        if (!isFocused) useTerminalStore.getState().focusChatPaneTab(paneKey);
      }}
      className={cn(
        "group/pane flex h-full w-full flex-col overflow-hidden bg-canvas select-none",
        isFocused
          ? "ring-1 ring-teal/50 shadow-sm"
          : "ring-1 ring-line/20 hover:ring-line/60",
      )}
    >
      {/* 窗格顶部 mini-bar（分屏时显示，与 TerminalPaneSlot 同款） */}
      {totalPanesInGroup > 1 && (
        <div
          className={cn(
            "flex h-6 shrink-0 items-center justify-between border-b px-2 text-[11px] font-mono transition-colors",
            isFocused
              ? "border-teal/30 bg-canvas text-ink font-medium"
              : "border-line/30 bg-rail text-ash/70 hover:text-ash",
          )}
        >
          <div className="flex items-center gap-1.5 truncate">
            <MessageSquarePlus size={12} className="shrink-0 text-teal" />
            <span className="truncate">{paneTitle}</span>
            {!isLive && pane.busy && (
              <span className="h-1.5 w-1.5 rounded-full bg-teal animate-pulse" title="后台运行中" />
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                splitDraftBeside("horizontal");
              }}
              title="向右拆分：新建对话窗格（先选 bot）"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-teal transition"
            >
              <Columns2 size={11} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                splitDraftBeside("vertical");
              }}
              title="向下拆分：新建对话窗格（先选 bot）"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-teal transition"
            >
              <Rows2 size={11} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                splitTerminalBeside();
              }}
              title="在右侧开一个终端（对话 | TUI 并排）"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <SquareTerminal size={11} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                useTerminalStore.getState().toggleMaximize(paneKey);
              }}
              title={isMaximized ? "还原窗格布局" : "最大化当前窗格"}
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              {isMaximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                useTerminalStore.getState().closeChatPane(paneKey);
              }}
              title="关闭窗格（不杀会话，历史可回）"
              className="rounded p-0.5 text-ash hover:bg-rose-500/20 hover:text-rose-400 transition"
            >
              <X size={11} />
            </button>
          </div>
        </div>
      )}

      {/* 窗格主体 */}
      {pane.unitId === "" ? (
        <BotChooserInline paneKey={paneKey} />
      ) : isLive ? (
        <LiveChatPane paneKey={paneKey} accentStyle={accentStyle} />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatViewport
            timeline={pane.timeline}
            busy={pane.busy}
            unit={unit}
            sessions={sessions}
            runtimes={runtimes}
            chatColumnWidth={chatColumnWidth}
          />
          {/* F5 后还没聚焦过的窗格没有快照可看：给一个明确的「点这里加载」，
              免得空窗格被误以为会话丢了（点击任意处聚焦 → openSession 重建） */}
          {pane.timeline.length === 0 && pane.sessionId !== null && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-btn border border-line/60 bg-card px-3 py-1.5 text-caption text-ash shadow-sm">
                点击窗格加载会话
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------- 焦点态 */

/** 焦点窗格：全局链路原班人马（Timeline / Composer / 审批 / 小终端 / 空态） */
function LiveChatPane({
  paneKey,
  accentStyle,
}: {
  paneKey: string;
  accentStyle?: React.CSSProperties;
}) {
  // 与 Timeline 同源判空（raw timeline 为空 ⇔ 归并后 items 为空）
  const timelineEmpty = useWorkbench((s) => s.timeline.length === 0);
  return (
    <div
      className="chat-conversation-root relative flex min-h-0 flex-1 flex-col"
      style={accentStyle}
      data-chat-pane={paneKey}
    >
      <Timeline />
      <PermissionDialog />
      <Composer />
      {/* 对话页小终端：只随焦点窗格挂载（全局单份，多窗格不重复挂） */}
      <ChatTerminalDock />
      {timelineEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-32">
          <EmptyState />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- bot 选择器 */

/** 拆分出的「未选 bot」草稿窗格：先选人，选完即成该 bot 的草稿对话 */
function BotChooserInline({ paneKey }: { paneKey: string }) {
  const units = useWorkbench((s) => s.units);
  const avatarFrame = useAppearance((s) => s.avatarFrame);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 overflow-y-auto">
      <MessageSquarePlus size={20} className="text-teal" />
      <p className="text-body-sm text-ink font-medium">选择一个 bot 开始对话</p>
      <div className="flex w-full max-w-[340px] flex-col gap-1">
        {units.map((u) => {
          const avatar = botAvatarStyle(u.name, avatarFrame);
          return (
            <button
              key={u.id}
              onClick={() => useChatPanes.getState().choosePaneUnit(paneKey, u.id)}
              className="flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-left transition text-ink hover:bg-teal-tint hover:text-teal"
            >
              {u.avatar ? (
                <img src={u.avatar} alt="" className={cn("h-6 w-6 shrink-0 object-cover", avatar?.shape)} />
              ) : (
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center bg-line-soft text-caption font-medium text-graphite",
                    avatar?.shape,
                  )}
                >
                  {u.name.slice(0, 1)}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-body-sm">{u.name}</span>
              {u.identity?.role && (
                <span className="shrink-0 truncate max-w-[140px] text-caption text-ash">{u.identity.role}</span>
              )}
            </button>
          );
        })}
        {units.length === 0 && <p className="text-caption text-ash">还没有 bot —— 先在侧栏新建一个。</p>}
      </div>
    </div>
  );
}
