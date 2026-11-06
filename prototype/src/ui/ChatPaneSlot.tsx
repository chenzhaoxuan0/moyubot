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
 * - live 态（本窗格持有全局对话链路）：渲染 Timeline/Composer/PermissionDialog/
 *   ChatTerminalDock 原班人马。**live 归属 ≠ 画布焦点**：焦点移到终端窗格时
 *   对话格仍是 live（终端从不争用全局对话链路，见 installChatPaneSync）——
 *   只有另一个对话格聚焦才交接。
 * - 快照态（另一个对话格持有链路 / 恢复中）：ChatViewport 只读投影 + 本窗格
 *   bot 的空态头像 + 休眠输入框（点击即接管）——外观保持完整，不随焦点塌成
 *   空白（用户实测反馈：并排时失焦一侧输入框/头像消失、草稿一片空白）。
 *
 * 常驻挂载（A1）由 GroupPanel 控制。
 */
export const ChatPaneSlot = memo(function ChatPaneSlot({ paneKey }: { paneKey: string }) {
  const pane = useChatPanes((s) => s.panes[paneKey]);
  const focusedChatKey = useChatPanes((s) => s.focusedChatKey);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === pane?.unitId));
  const sessions = useWorkbench((s) => s.sessions);
  const runtimes = useWorkbench((s) => s.runtimes);
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const accentStyle = useChatAccentStyle();

  if (pane === undefined) return null;
  /** 本窗格持有全局对话链路（live 归属，跨终端焦点保持） */
  const ownsLive = focusedChatKey === paneKey;
  /** 画布焦点（视觉高亮用；与 live 归属解耦） */
  const hasCanvasFocus = activePaneId === paneKey;
  // 恢复中（openSession 在途）也先渲染快照：全局正被清空/重建，直接读会闪
  const isLive = ownsLive && !pane.restoring;
  const activate = (): void => {
    if (!hasCanvasFocus) useTerminalStore.getState().activatePane(paneKey);
  };

  return (
    <div
      onMouseDown={activate}
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas select-none",
        hasCanvasFocus ? "ring-1 ring-teal/50" : "ring-1 ring-line/20",
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
          {/* 休眠输入框：占住输入区的位置与外观，点击即接管 live（焦点链
              openSession 回放后换成真 Composer）——并排时两侧版式一致 */}
          <DormantComposer chatColumnWidth={chatColumnWidth} unitName={unit?.name} onActivate={activate} />
          {pane.timeline.length === 0 &&
            (pane.sessionId === null ? (
              /* 草稿：本窗格 bot 的空态头像与问候（全局此刻属于别的对话格） */
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-32">
                <EmptyState unit={unit} />
              </div>
            ) : (
              /* F5 后还没聚焦过的窗格没有快照：明确的「点这里加载」，免得
                 空窗格被误以为会话丢了（点击任意处聚焦 → openSession 重建） */
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-32">
                <span className="rounded-btn border border-line/60 bg-card px-3 py-1.5 text-caption text-ash shadow-sm">
                  点击窗格加载会话
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------- 快照态输入区 */

/**
 * 休眠输入框 —— 快照态对话格的输入区占位：与 Composer 同列宽同圆角，文案提示
 * 点击接管。不承载输入（全局 Composer 属于 live 的那个对话格）。
 */
function DormantComposer({
  chatColumnWidth,
  unitName,
  onActivate,
}: {
  chatColumnWidth: number;
  unitName: string | undefined;
  onActivate: () => void;
}) {
  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <button
        type="button"
        onClick={onActivate}
        className="mx-auto flex w-full items-center rounded-panel border border-line/70 bg-card px-4 py-3 text-left text-body-sm text-ash shadow-subtle transition hover:border-teal/40 hover:text-graphite"
        style={{ maxWidth: chatColumnWidth }}
      >
        {unitName ? `点击继续与「${unitName}」对话…` : "点击继续对话…"}
      </button>
    </div>
  );
}

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
