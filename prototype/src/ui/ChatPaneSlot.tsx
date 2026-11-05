import { memo } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { Timeline, EmptyState } from "./Timeline.tsx";
import { ChatViewport } from "./chat/ChatViewport.tsx";
import { Composer } from "./Composer.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { ChatTerminalDock } from "./ChatTerminalDock.tsx";
import { useChatAccentStyle } from "./useChatAccentStyle.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { cn } from "./cn.ts";

/**
 * 对话窗格（docs/32 组栈模型）—— 组栈里的标签内容：无 mini-bar（标题/关闭/
 * 拆分全在组标签条），拖拽吸附在 GroupPanel。双态渲染（「单活+快照注册表」，
 * docs/31 口径不变）：
 * - 焦点态（live）：渲染全局链路 —— Timeline/Composer/PermissionDialog/
 *   ChatTerminalDock 原班人马；全局 activeUnitId/activeSessionId 在焦点同步
 *   器里被定义为「本窗格的会话」。
 * - 非焦点态 / 恢复中：渲染注册表快照（ChatViewport 只读投影）——失焦那刻
 *   从全局拍照，之后事件泵实时追加；点击窗格任意处即聚焦（权威重建在后台
 *   跑，restoring 落地前一直显示快照，无闪跳）。
 *
 * 常驻挂载（A1）由 GroupPanel 控制；后台运行中的呼吸灯移到组标签条（busy 由
 * GroupPanel 经注册表订阅显示——这里保留数据面给标签用）。
 */
export const ChatPaneSlot = memo(function ChatPaneSlot({ paneKey }: { paneKey: string }) {
  const pane = useChatPanes((s) => s.panes[paneKey]);
  const focusedChatKey = useChatPanes((s) => s.focusedChatKey);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === pane?.unitId));
  const sessions = useWorkbench((s) => s.sessions);
  const runtimes = useWorkbench((s) => s.runtimes);
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const accentStyle = useChatAccentStyle();

  if (pane === undefined) return null;
  const isFocused = focusedChatKey === paneKey;
  // 恢复中（openSession 在途）也先渲染快照：全局正被清空/重建，直接读会闪
  const isLive = isFocused && !pane.restoring;

  return (
    <div
      onMouseDown={() => {
        if (!isFocused) useTerminalStore.getState().activatePane(paneKey);
      }}
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas select-none",
        isFocused ? "ring-1 ring-teal/50" : "ring-1 ring-line/20",
      )}
    >
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
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-4">
      <MessageSquarePlus size={20} className="text-teal" />
      <p className="text-body-sm font-medium text-ink">选择一个 bot 开始对话</p>
      <div className="flex w-full max-w-[340px] flex-col gap-1">
        {units.map((u) => (
          <button
            key={u.id}
            onClick={() => useChatPanes.getState().choosePaneUnit(paneKey, u.id)}
            className="flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-left text-ink transition hover:bg-teal-tint hover:text-teal"
          >
            <BotAvatar unit={u} size="sm" />
            <span className="min-w-0 flex-1 truncate text-body-sm">{u.name}</span>
            {u.identity?.role && (
              <span className="max-w-[140px] shrink-0 truncate text-caption text-ash">{u.identity.role}</span>
            )}
          </button>
        ))}
        {units.length === 0 && <p className="text-caption text-ash">还没有 bot —— 先在侧栏新建一个。</p>}
      </div>
    </div>
  );
}
