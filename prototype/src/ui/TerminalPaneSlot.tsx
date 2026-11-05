import { useEffect, useRef, memo } from "react";
import {
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
  X,
  Terminal,
  SquareTerminal,
  Zap,
  Sparkles,
  Bot,
  Wand2,
  Feather,
  MoonStar,
  MessageSquarePlus,
} from "lucide-react";
import {
  useTerminalStore,
  type TerminalInstanceItem,
} from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useShell } from "../store/useShell.ts";
import { usePaneDropZone } from "./usePaneDropZone.tsx";
import { cn } from "./cn.ts";
import { executorIconSrc } from "./executorIcon.ts";
import { QuickContextMenu } from "./QuickContextMenu.tsx";
import { useTerminalContextMenu } from "./terminalContextMenu.ts";

export function ShellOrAgentIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const brandSrc = executorIconSrc(icon);
  if (brandSrc) {
    return <img src={brandSrc} alt="" className={cn("h-3.5 w-3.5 shrink-0 object-contain", className)} aria-hidden />;
  }
  switch (icon.replace(/:yolo$/, "")) {
    case "zcode":
      return <Zap className={cn("text-teal", className)} size={12} />;
    case "claude":
      return <Sparkles className={cn("text-amber-400", className)} size={12} />;
    case "codex":
      return <Bot className={cn("text-emerald-400", className)} size={12} />;
    case "hermes":
      return <Feather className={cn("text-violet-400", className)} size={12} />;
    case "kimi":
      return <MoonStar className={cn("text-cyan-400", className)} size={12} />;
    case "agy":
    case "antigravity":
      return <Wand2 className={cn("text-indigo-400", className)} size={12} />;
    case "grok":
      return <Sparkles className={cn("text-sky-300", className)} size={12} />;
    case "cursor":
    case "cursor-agent":
      return <Bot className={cn("text-blue-400", className)} size={12} />;
    case "openclaw":
      return <Zap className={cn("text-rose-400", className)} size={12} />;
    case "pwsh":
      return <Terminal className={cn("text-teal", className)} size={12} />;
    case "powershell":
      return <SquareTerminal className={cn("text-sky-400", className)} size={12} />;
    case "cmd":
      return <Terminal className={cn("text-zinc-400", className)} size={12} />;
    case "wsl":
      return <Terminal className={cn("text-amber-400", className)} size={12} />;
    case "bash":
      return <Terminal className={cn("text-emerald-400", className)} size={12} />;
    default:
      return <Terminal className={cn("text-ash", className)} size={12} />;
  }
}

export const TerminalPaneSlot = memo(function TerminalPaneSlot({
  inst,
  totalPanesInGroup,
}: {
  inst: TerminalInstanceItem;
  totalPanesInGroup: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const activeInstanceId = useTerminalStore((s) => s.activeInstanceId);
  const maximizedInstanceId = useTerminalStore((s) => s.maximizedInstanceId);
  const setActiveInstance = useTerminalStore((s) => s.setActiveInstance);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  const terminalTransparency = useAppearance((s) => s.activeProfile.terminalTransparency);
  const settingsOpen = useShell((s) => s.settingsOpen);
  // 终端右键：复制（xterm canvas 选区）/ 粘贴 —— 原生文本菜单对终端无效
  const { menu: ctxMenu, onContextMenu: onTerminalContextMenu, closeMenu } =
    useTerminalContextMenu(inst.id);
  // 拖标签吸附分屏（二期）：本窗格的四向吸附区
  const { dropHandlers, zoneOverlay } = usePaneDropZone(inst.id);

  const isActive = inst.id === activeInstanceId;
  const isMaximized = inst.id === maximizedInstanceId;

  // 将会话的物理 DOM 容器挂载到当前 Slot
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const session = terminalSessionRegistry.getOrCreate({
      terminalId: inst.id,
      shell: inst.shell,
      cwd: inst.cwd,
      executorId: inst.executorId,
      unitId: inst.unitId,
      // 重挂标签带回的输出快照：只在会话首次创建时消费一次
      attachScrollback: inst.attachScrollback,
    });

    session.attachTo(container);

    return () => {
      session.detach();
    };
  }, [inst.id, inst.shell, inst.cwd, inst.executorId, inst.unitId]);

  // 当处于活跃状态时聚焦
  useEffect(() => {
    if (isActive) {
      terminalSessionRegistry.get(inst.id)?.focus();
    }
  }, [isActive, inst.id]);

  // 当外观主题切换、或从设置页面退出返回工作台时，立即同步激活窗格的主题与画布重绘
  useEffect(() => {
    const session = terminalSessionRegistry.get(inst.id);
    if (!session) return;
    session.applyTheme(resolvedTheme === "dark");
    if (isActive && !settingsOpen) {
      session.focus();
    }
  }, [resolvedTheme, terminalTransparency, settingsOpen, inst.id, isActive]);

  return (
    <div
      onClick={() => setActiveInstance(inst.id)}
      {...dropHandlers}
      className={cn(
        "group/pane relative flex h-full w-full flex-col overflow-hidden select-none",
        isActive
          ? "ring-1 ring-teal/50 shadow-sm"
          : "ring-1 ring-line/20 hover:ring-line/60",
      )}
    >
      {zoneOverlay}
      {/* 窗格顶部 mini-bar（分屏时显示，单窗格时简化） */}
      {totalPanesInGroup > 1 && (
        <div
          className={cn(
            "flex h-6 shrink-0 items-center justify-between border-b px-2 text-[11px] font-mono transition-colors",
            isActive
              ? "border-teal/30 bg-canvas text-ink font-medium"
              : "border-line/30 bg-rail text-ash/70 hover:text-ash",
          )}
        >
          {/* 左侧：标题与图标 */}
          <div className="flex items-center gap-1.5 truncate">
            <ShellOrAgentIcon icon={inst.icon} />
            <span className="truncate">{inst.title}</span>
            {isActive && (
              <span className="h-1.5 w-1.5 rounded-full bg-teal animate-pulse" />
            )}
          </div>

          {/* 右侧：自由分屏与窗格操作栏 */}
          <div className="flex items-center gap-1">
            {/* 向右拆分 (Split Right) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                splitPane({ targetPaneId: inst.id, direction: "horizontal" });
              }}
              title="向右拆分窗格 (Split Right)"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-teal transition"
            >
              <Columns2 size={11} />
            </button>

            {/* 向下拆分 (Split Down) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                splitPane({ targetPaneId: inst.id, direction: "vertical" });
              }}
              title="向下拆分窗格 (Split Down)"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-teal transition"
            >
              <Rows2 size={11} />
            </button>

            {/* 在旁边开对话窗格（docs/31：对话 | TUI 并排的另一半入口） */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const draftKey = useChatPanes.getState().createDraftRecord();
                splitPane({ targetPaneId: inst.id, chatPaneKey: draftKey, direction: "horizontal" });
              }}
              title="在右侧开一个对话窗格（先选 bot）"
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-teal transition"
            >
              <MessageSquarePlus size={11} />
            </button>

            {/* 最大化 / 还原 */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleMaximize(inst.id);
              }}
              title={isMaximized ? "还原窗格布局" : "最大化当前窗格"}
              className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              {isMaximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>

            {/* 关闭当前分屏窗格 */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closePane(inst.id);
              }}
              title="关闭当前窗格"
              className="rounded p-0.5 text-ash hover:bg-rose-500/20 hover:text-rose-400 transition"
            >
              <X size={11} />
            </button>
          </div>
        </div>
      )}

      {/* xterm 实体挂载容器 */}
      <div
        ref={mountRef}
        onContextMenu={onTerminalContextMenu}
        className="min-h-0 min-w-0 flex-1 overflow-hidden relative"
      />
      <QuickContextMenu menu={ctxMenu} onClose={closeMenu} />
    </div>
  );
});
