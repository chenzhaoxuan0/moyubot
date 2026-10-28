import { useMemo, useState } from "react";
import { Menu } from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../../store/useWorkbench.ts";
import { useAppearance } from "../../store/useAppearance.ts";
import { deriveChatAccentVariables, isValidColor } from "../../core/appearance.ts";
import { useShell } from "../../store/useShell.ts";
import { Timeline } from "../Timeline.tsx";
import { Composer } from "../Composer.tsx";
import { ChatTerminalDock } from "../ChatTerminalDock.tsx";
import { TerminalPanel } from "../TerminalPanel.tsx";
import { ProposalBanner } from "../ProposalBanner.tsx";
import { SettingsPage } from "../SettingsPage.tsx";
import { ConversationViewSwitch } from "../ConversationViewSwitch.tsx";
import { onTitleBarContextMenu } from "../WindowControls.tsx";
import { MobileConfirmationGate } from "./MobileConfirmationGate.tsx";
import { MobileVirtualKeyBar } from "./MobileVirtualKeyBar.tsx";
import { MobileDrawer } from "./MobileDrawer.tsx";
import { type LayoutPreference } from "./useIsMobile.ts";
import { cn } from "../cn.ts";

export function MobileLayout({
  preference,
  onSetPreference,
}: {
  preference: LayoutPreference;
  onSetPreference: (p: LayoutPreference) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const unit = useWorkbench(selectActiveUnit);
  const busy = useWorkbench((s) => s.busy);
  const conversationView = useShell((s) => s.conversationView);
  const settingsOpen = useShell((s) => s.settingsOpen);
  // 本 bot 对话强调色：与桌面 ConversationSlot 同款（内联覆盖对话子树的 accent 变量）
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  const chatAccentStyle = useMemo(() => {
    const accent = unit?.themeAccent;
    if (!accent || !isValidColor(accent)) return undefined;
    return deriveChatAccentVariables(accent, resolvedTheme === "dark");
  }, [unit?.themeAccent, resolvedTheme]);

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-canvas text-ink select-none">
      {/* 1. 移动端顶栏 —— 与 PC 顶栏统一使用 bg-rail 与 border-line/60 主题色阶。
          titlebar-drag：手机布局下右上角三钮已隐藏，这一行是无边框窗口唯一的
          拖拽热区（缺了它窗口就移动不了）；行内按钮由全局选择器自动回退
          no-drag。右键弹原生系统菜单（最小化/最大化/关闭，纯浏览器无操作） */}
      <header
        onContextMenu={onTitleBarContextMenu}
        className="titlebar-drag flex h-12 shrink-0 items-center justify-between border-b border-line/60 bg-rail px-3 text-ink z-30 select-none"
      >
        {/* 左侧：抽屉菜单按钮 + Agent 名字 */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="打开导航抽屉"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card/80 text-graphite transition active:scale-95 hover:text-ink hover:bg-line-soft"
          >
            <Menu size={16} />
          </button>

          {unit ? (
            <span className="truncate text-body-sm font-semibold text-ink">
              {unit.name}
            </span>
          ) : (
            <span className="text-caption text-ash">未选择单元</span>
          )}
        </div>

        {/* 右侧：形态切换 (对话/终端 TUI) —— 与 PC 头部同一组件、同一规格，
            跨版式切换时位置（行尾）与外观（字号/内距/激活态）都不变 */}
        <ConversationViewSwitch />
      </header>

      {/* 2. 主内容展示区 */}
      <main className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* 对话视图 */}
        <div
          style={chatAccentStyle}
          className={cn(
            "flex h-full min-h-0 flex-1 flex-col",
            conversationView === "chat" ? "flex" : "hidden",
          )}
        >
          <div className="flex flex-1 min-h-0 flex-col">
            <Timeline />
          </div>

          {/* 底部输入框（防键盘顶起，100dvh） */}
          <div className="shrink-0 border-t border-line/40 bg-canvas">
            <Composer onOpenDrawer={() => setDrawerOpen(true)} />
          </div>

          {/* 对话页小终端：输入框下方（与桌面同款） */}
          <ChatTerminalDock />

          {/* 底部手势审批确认门浮层 */}
          <MobileConfirmationGate />
        </div>

        {/* 终端视图 */}
        <div
          className={cn(
            "flex h-full min-h-0 flex-1 flex-col",
            conversationView === "terminal" ? "flex" : "hidden",
          )}
        >
          <div className="flex-1 min-h-0 relative bg-black">
            <TerminalPanel variant="canvas" />
          </div>

          {/* 终端虚拟辅助键行 */}
          <MobileVirtualKeyBar />
        </div>
      </main>

      {/* 3. 抽屉与全屏模态 */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        preference={preference}
        onSetPreference={onSetPreference}
      />

      {/* 待办提议横幅 */}
      <ProposalBanner />

      {/* 设置页 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 bg-canvas-solid">
          <SettingsPage />
        </div>
      )}
    </div>
  );
}
