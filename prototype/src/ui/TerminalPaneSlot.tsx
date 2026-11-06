import { useEffect, useRef, memo } from "react";
import {
  Terminal,
  SquareTerminal,
  Zap,
  Sparkles,
  Bot,
  Wand2,
  Feather,
  MoonStar,
} from "lucide-react";
import { useTerminalStore, type CanvasPane } from "../store/useTerminalStore.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useShell } from "../store/useShell.ts";
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

/**
 * 终端窗格（docs/32 组栈模型）—— 只是组栈里的标签内容：无 mini-bar（标题/
 * 关闭/拆分/最大化全在组标签条），本体专注 xterm 挂载 + 主题 + 聚焦 + 右键。
 * 常驻挂载（A1）由 GroupPanel 控制（display:none + inert），本组件不卸载。
 */
export const TerminalPaneSlot = memo(function TerminalPaneSlot({ pane }: { pane: CanvasPane }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const activate = useTerminalStore((s) => s.activatePane);
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  const terminalTransparency = useAppearance((s) => s.activeProfile.terminalTransparency);
  const settingsOpen = useShell((s) => s.settingsOpen);
  // 终端右键：复制（xterm canvas 选区）/ 粘贴 —— 原生文本菜单对终端无效
  const { menu: ctxMenu, onContextMenu: onTerminalContextMenu, closeMenu } =
    useTerminalContextMenu(pane.id);

  const isActive = pane.id === activePaneId;

  // 将会话的物理 DOM 容器挂载到当前窗格
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const session = terminalSessionRegistry.getOrCreate({
      terminalId: pane.id,
      shell: pane.shell ?? "pwsh.exe",
      cwd: pane.cwd ?? "",
      executorId: pane.executorId,
      unitId: pane.unitId,
      // 重挂标签带回的输出快照：只在会话首次创建时消费一次
      attachScrollback: pane.attachScrollback,
    });

    session.attachTo(container);

    return () => {
      session.detach();
    };
  }, [pane.id, pane.shell, pane.cwd, pane.executorId, pane.unitId, pane.attachScrollback]);

  // 当处于活跃状态时聚焦
  useEffect(() => {
    if (isActive) {
      terminalSessionRegistry.get(pane.id)?.focus();
    }
  }, [isActive, pane.id]);

  // 当外观主题切换、或从设置页面退出返回工作台时，立即同步窗格主题与画布重绘。
  // 不依赖 isActive：此前每次切标签，新旧两个活跃终端各跑一遍 applyTheme（12 个
  // CSS 变量读取 + 3 次全量 refresh + 强制 fit），切换路径白白多出两轮重绘。
  // 切标签的聚焦由上面那条 isActive effect 负责；这里的 focus 只服务「设置页关闭」，
  // 运行时读的是当次渲染的 isActive，不是陈旧闭包
  useEffect(() => {
    const session = terminalSessionRegistry.get(pane.id);
    if (!session) return;
    session.applyTheme(resolvedTheme === "dark");
    if (isActive && !settingsOpen) {
      session.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isActive 刻意不进依赖：切标签不该触发主题重绘（见上）
  }, [resolvedTheme, terminalTransparency, settingsOpen, pane.id]);

  return (
    <div
      onClick={() => activate(pane.id)}
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas select-none"
    >
      {/* xterm 实体挂载容器 */}
      <div
        ref={mountRef}
        onContextMenu={onTerminalContextMenu}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      />
      <QuickContextMenu menu={ctxMenu} onClose={closeMenu} />
    </div>
  );
});
