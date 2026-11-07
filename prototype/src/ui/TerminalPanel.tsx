import {
  Terminal,
  X,
  RotateCw,
  Trash2,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  History,
  Combine,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useCanvasPopouts } from "../store/useCanvasPopouts.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { TerminalSplitTree } from "./TerminalSplitTree.tsx";
import { TerminalPaneSlot } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { NewSessionPage } from "./NewSessionPage.tsx";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";

/**
 * 会话画布容器（docs/32 组栈模型）—— 顶栏全局标签条**退役**：标签生活在
 * 每个分屏格的组标签条（GroupPanel）里，这里只剩工具栏（＋菜单 / 拆分 /
 * 最大化 / 归拢 / chat 动作 / 终端专属动作）+ 分屏树 + 空态（新建会话页）。
 *
 * 「拆分」语义变更：分的是**激活组**（新组承载新标签）——组栈模型里分屏的
 * 原子是组，不再是窗格（docs/32 §一）。
 */
export function TerminalPanel({
  variant = "dock",
  onClose,
  label,
}: {
  variant?: "dock" | "page" | "canvas";
  onClose?: () => void;
  label?: string;
} = {}) {
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const { isMobile } = useIsMobile();

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  const closeTerminal = onClose ?? (() => {});

  const panes = useTerminalStore((s) => s.panes);
  const groups = useTerminalStore((s) => s.groups);
  const layout = useTerminalStore((s) => s.layout);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const maximizedPaneId = useTerminalStore((s) => s.maximizedPaneId);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);

  const popoutCount = useCanvasPopouts((s) => s.entries.length);

  const activePane = activePaneId !== null ? panes[activePaneId] : undefined;
  const focusedIsChat = activePane?.kind === "chat";
  const focusedChatPane = useChatPanes((s) =>
    s.focusedChatKey !== null ? s.panes[s.focusedChatKey] : undefined,
  );
  const focusedChatUnit = useWorkbench((s) =>
    s.units.find((u) => u.id === focusedChatPane?.unitId),
  );

  const groupCount = Object.keys(groups).length;

  // 清屏当前激活终端窗格（终端语义）
  const handleClear = () => {
    if (activePaneId !== null) terminalSessionRegistry.get(activePaneId)?.clear();
  };

  // 重启当前激活终端窗格（终端语义）
  const handleRestart = () => {
    if (activePaneId !== null) void terminalSessionRegistry.get(activePaneId)?.restart();
  };

  // 工具条「向右/向下拆分」：组栈语义 = 把激活组一分为二，新组承载新标签
  // （焦点在 chat → 新组开草稿对话；焦点在终端 → 开终端）
  const handleSplit = (direction: "horizontal" | "vertical") => {
    if (focusedIsChat) {
      splitPane({ direction, chatPaneKey: useChatPanes.getState().createDraftRecord() });
      return;
    }
    splitPane({ direction, cwd: unit?.rootPath });
  };

  const maximizedPane = maximizedPaneId !== null ? panes[maximizedPaneId] : undefined;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col",
        isCanvas ? undefined : "bg-card",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* 画布工具栏（顶栏全局标签条已随组栈模型退役——标签在分屏格里；新建入口
          2026-11 起也归属格子标签尾部（GroupCreateBar），这里只剩全局图标动作） */}
      <div className="relative z-30 flex h-9 shrink-0 select-none items-center border-b border-line/40 bg-rail px-2">
        {/* 右侧：全局操作工具条（图标化 —— 悬停 title 说明，省条内空间） */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 一键归拢（三期）：有弹出窗口时出现（图标 + 角标计数） */}
          {popoutCount > 0 && (
            <button
              type="button"
              onClick={() => useCanvasPopouts.getState().recallAll()}
              title={`把 ${popoutCount} 个弹出窗口归拢回标签栏`}
              className="flex items-center gap-1 rounded-btn bg-teal-tint px-1.5 py-0.5 text-caption text-teal transition hover:bg-teal hover:text-white"
            >
              <Combine size={12} />
              <span className="text-[10px] font-medium">{popoutCount}</span>
            </button>
          )}

          {!isMobile && (
            <>
              {/* 向右拆分（组栈语义：激活组一分为二） */}
              <button
                type="button"
                onClick={() => handleSplit("horizontal")}
                title="向右拆分当前格：新格承载新标签"
                aria-label="向右拆分当前格"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Columns2 size={12} />
              </button>

              {/* 向下拆分 */}
              <button
                type="button"
                onClick={() => handleSplit("vertical")}
                title="向下拆分当前格：新格承载新标签"
                aria-label="向下拆分当前格"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Rows2 size={12} />
              </button>

              {/* 最大化 / 还原 */}
              <button
                type="button"
                onClick={() => toggleMaximize()}
                title={maximizedPaneId ? "还原分屏" : "最大化当前聚焦标签"}
                aria-label={maximizedPaneId ? "还原分屏" : "最大化当前聚焦标签"}
                className={cn(
                  "flex items-center rounded-btn p-1 transition",
                  maximizedPaneId ? "bg-teal-tint text-teal" : "text-ash hover:bg-line-soft hover:text-ink",
                )}
              >
                {maximizedPaneId ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </>
          )}

          {/* chat 动作（焦点在对话标签时出现） */}
          {focusedIsChat && focusedChatPane !== undefined && focusedChatPane.unitId !== "" && (
            <>
              <button
                type="button"
                onClick={() =>
                  useChatPanes.getState().openChatPane({ unitId: focusedChatPane.unitId, sessionId: null })
                }
                title={`给 ${focusedChatUnit?.name ?? "这个 bot"} 新开一个对话标签（草稿）`}
                aria-label="新对话"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <MessageSquarePlus size={12} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (focusedChatUnit === undefined) return;
                  useSidePane.getState().openTab({ unitId: focusedChatUnit.id, unitName: focusedChatUnit.name });
                }}
                title="在右侧面板打开这个 bot 的历史会话列表"
                aria-label="历史会话"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <History size={12} />
              </button>
            </>
          )}

          {/* 清屏 / 重启（终端语义） */}
          {!focusedIsChat && (
            <>
              <button
                type="button"
                onClick={handleClear}
                title="清空当前窗格屏幕 (Ctrl+L 重绘)"
                aria-label="清屏"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Trash2 size={12} />
              </button>
              <button
                type="button"
                onClick={handleRestart}
                title="重启当前终端进程"
                aria-label="重启终端"
                className="flex items-center rounded-btn p-1 text-ash transition hover:bg-teal-tint hover:text-teal"
              >
                <RotateCw size={12} />
              </button>
            </>
          )}

          {/* 关闭终端（非画布态） */}
          {!isCanvas && (
            <button
              type="button"
              onClick={closeTerminal}
              aria-label={isPage ? "关闭终端窗格" : "关闭终端"}
              title={isPage ? undefined : "关闭终端"}
              className="rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 画布内容区：无格 = 新建会话页；最大化 = 单标签全幅；否则 = 组栈分屏树 */}
      {groupCount === 0 ? (
        <NewSessionPage />
      ) : maximizedPane !== undefined ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {maximizedPane.kind === "chat" ? (
            <ChatPaneSlot key={maximizedPane.id} paneKey={maximizedPane.id} />
          ) : (
            <TerminalPaneSlot key={maximizedPane.id} pane={maximizedPane} />
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <TerminalSplitTree node={layout} />
        </div>
      )}
    </div>
  );
}
