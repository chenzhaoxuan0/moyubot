import { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal,
  X,
  RotateCw,
  Trash2,
  Zap,
  Plus,
  ChevronDown,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  History,
  Combine,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import {
  useTerminalStore,
  SUPPORTED_TERMINAL_PROFILES,
} from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useCanvasPopouts } from "../store/useCanvasPopouts.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { TerminalSplitTree } from "./TerminalSplitTree.tsx";
import { TerminalPaneSlot, ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { NewSessionPage } from "./NewSessionPage.tsx";
import { dispatchTerminal } from "../adapters/daemon/client.ts";
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
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const runtimes = useWorkbench((s) => s.runtimes);
  const { isMobile } = useIsMobile();

  const isCanvas = variant === "canvas";
  const isPage = variant === "page";
  const closeTerminal = onClose ?? (() => {});

  const panes = useTerminalStore((s) => s.panes);
  const groups = useTerminalStore((s) => s.groups);
  const layout = useTerminalStore((s) => s.layout);
  const activePaneId = useTerminalStore((s) => s.activePaneId);
  const maximizedPaneId = useTerminalStore((s) => s.maximizedPaneId);
  const defaultProfileId = useTerminalStore((s) => s.defaultProfileId);
  const createTab = useTerminalStore((s) => s.createTab);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
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

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // 清屏当前激活终端窗格（终端语义）
  const handleClear = () => {
    if (activePaneId !== null) terminalSessionRegistry.get(activePaneId)?.clear();
  };

  // 重启当前激活终端窗格（终端语义）
  const handleRestart = () => {
    if (activePaneId !== null) void terminalSessionRegistry.get(activePaneId)?.restart();
  };

  // 新建终端标签：没有格就开新格，有格进激活格
  const handleNewDefault = () => {
    createTab({ profileId: defaultProfileId, cwd: unit?.rootPath });
  };

  // 新建对话标签：每次都开新草稿（session 级粒度）；没选 bot 开未选态窗格
  const handleNewChat = () => {
    setMenuOpen(false);
    if (unit) {
      useChatPanes.getState().openChatPane({ unitId: unit.id, sessionId: null });
      return;
    }
    useTerminalStore.getState().createChatTab(useChatPanes.getState().createDraftRecord());
  };

  // 选择 Profile 新建系统终端
  const handleCreateProfile = (profileId: string) => {
    setMenuOpen(false);
    createTab({ profileId, cwd: unit?.rootPath });
  };

  // 选择 Agent 执行器 —— 全部走派发系统打开（记入历史、免审批、标签带「派发」徽章）；
  // 没选中 bot 时派发无处归属，退回手动开（旧行为）
  const handleLaunchExecutor = (execId: string, displayName: string) => {
    setMenuOpen(false);
    const bareId = execId.replace(/^daemon:/, "").replace(/:yolo$/, "");
    if (unit && bareId !== "") {
      void dispatchTerminal({ unitId: unit.id, unitName: unit.name, rootPath: unit.rootPath, runtimeId: bareId })
        .catch((err: unknown) => {
          console.error("[TerminalPanel] 派发终端失败，退回手动:", err);
          createTab({
            profileId: "pwsh",
            cwd: unit.rootPath,
            executorId: execId,
            unitId: unit.id,
            title: `${unit.name} · ${displayName} (TUI)`,
          });
        });
      return;
    }
    createTab({
      profileId: "pwsh",
      cwd: unit?.rootPath,
      executorId: execId,
      title: `${displayName} (TUI)`,
    });
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

  // 获取可用的 Agent 执行器列表
  const executorOptions = useMemo(() => runtimes.filter((r) => !r.testOnly), [runtimes]);

  const maximizedPane = maximizedPaneId !== null ? panes[maximizedPaneId] : undefined;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col",
        isCanvas ? undefined : "bg-card",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* 画布工具栏（顶栏全局标签条已随组栈模型退役——标签在分屏格里） */}
      <div className="relative z-30 flex h-9 shrink-0 select-none items-center border-b border-line/40 bg-rail px-2">
        {/* 新建菜单（对话 / Agent 执行器 / 系统 Shell / 分屏操作） */}
        <div className="relative flex shrink-0 items-center" ref={menuRef}>
          <div className="flex items-center rounded-btn bg-line-soft/40 text-ash transition hover:bg-line-soft hover:text-ink">
            {/* 移动端不放「对话」快捷钮：手机有自己的对话视图分支
                （MobileLayout 的 conversationView），画布内开对话窗格会双头 */}
            {!isMobile && (
              <button
                type="button"
                onClick={handleNewChat}
                title="新建对话（当前 bot）"
                className="flex items-center p-1 transition hover:text-teal"
              >
                <MessageSquarePlus size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={handleNewDefault}
              title="新建终端 (PowerShell 7)"
              className="flex items-center border-l border-line/30 p-1 transition hover:text-teal"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              title="选择对话 / Agent 执行器 / 系统 Shell (ZCode, Claude, Codex, WSL, CMD...)"
              className="flex items-center border-l border-line/30 px-1 py-1 text-ash/80 transition hover:text-ink"
            >
              <ChevronDown size={11} />
            </button>
          </div>

          {/* 移动端全屏半透明遮罩（点按背景关闭） */}
          {menuOpen && isMobile && (
            <div
              className="fixed inset-0 z-40 animate-in bg-black/50 backdrop-blur-xs duration-150"
              onClick={() => setMenuOpen(false)}
            />
          )}

          {/* 下拉弹出菜单 */}
          {menuOpen && (
            <div
              className={cn(
                "z-50 flex flex-col rounded-panel border border-line bg-card shadow-2xl backdrop-blur",
                isMobile
                  ? "fixed inset-x-3 top-12 max-h-[72dvh] animate-in fade-in zoom-in-95 p-2.5 duration-150"
                  : "absolute left-0 top-full mt-1.5 max-h-[480px] min-w-[260px] p-1.5",
              )}
            >
              {isMobile && (
                <div className="mb-1.5 flex shrink-0 items-center justify-between border-b border-line/50 px-1 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Zap size={13} className="text-teal" />
                    <span className="text-body-sm font-semibold text-ink">新建会话标签</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    className="rounded p-1 text-ash transition hover:bg-line-soft hover:text-ink active:scale-90"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              <div
                className="flex min-h-0 flex-1 flex-col touch-pan-y overflow-y-auto overscroll-contain pr-0.5 scrollbar-thin"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {/* 分组 0：对话会话（移动端隐藏——手机的对话入口是顶栏形态切换） */}
                {!isMobile && (
                  <>
                    <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal/80">
                      <MessageSquarePlus size={11} />
                      <span>对话</span>
                    </div>
                    <button
                      onClick={handleNewChat}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint"
                    >
                      <MessageSquarePlus size={13} className="shrink-0 text-teal" />
                      <span className="flex-1 truncate font-mono text-caption font-medium">
                        {unit ? `与 ${unit.name} 对话` : "新对话（先选 bot）"}
                      </span>
                      <span className="shrink-0 rounded bg-line-soft px-1 py-0.2 font-sans text-[9px] text-ash">
                        结构化时间线
                      </span>
                    </button>
                    <div className="my-1.5 h-px shrink-0 bg-line/50" />
                  </>
                )}

                {/* 分组 1：Agent 执行器 —— 全部经派发系统打开 */}
                <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal/80">
                  <Zap size={11} />
                  <span>Agent CLI (TUI · 派发)</span>
                  <span className="ml-auto font-sans text-[9px] normal-case tracking-normal text-ash/50">记入历史</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {executorOptions.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => handleLaunchExecutor(r.id, r.presentation.displayName)}
                      className={cn(
                        "flex w-full items-center rounded text-left text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint",
                        isMobile ? "gap-2 px-2 py-1.5 min-h-8.5" : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                      )}
                    >
                      <ShellOrAgentIcon icon={r.id} />
                      <div className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
                        <span className="truncate font-mono text-caption font-medium">{r.presentation.displayName}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          {activeRuntimeId === r.id && (
                            <span className="rounded bg-teal/15 px-1 py-0.2 font-sans text-[9px] font-medium text-teal">当前</span>
                          )}
                          <span className="rounded bg-line-soft px-1 py-0.2 font-sans text-[9px] text-ash">TUI 派发</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="my-1.5 h-px shrink-0 bg-line/50" />

                {/* 分组 2：原生系统 Shell */}
                <div className="shrink-0 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ash/70">原生系统终端</div>
                <div className="flex flex-col gap-0.5">
                  {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
                    <button
                      key={profile.id}
                      onClick={() => handleCreateProfile(profile.id)}
                      className={cn(
                        "flex w-full items-center rounded text-left text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint",
                        isMobile ? "gap-2 px-2 py-1.5 min-h-8" : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                      )}
                    >
                      <ShellOrAgentIcon icon={profile.icon} />
                      <span className="flex-1 truncate font-mono text-caption">{profile.name}</span>
                      {profile.id === defaultProfileId && (
                        <span className="shrink-0 rounded bg-teal/10 px-1 py-0.2 font-sans text-[9px] text-teal/80">默认</span>
                      )}
                    </button>
                  ))}
                </div>

                {/* 分组 3：自由分屏操作（桌面端） */}
                {!isMobile && (
                  <>
                    <div className="my-1.5 h-px shrink-0 bg-line/50" />
                    <div className="shrink-0 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ash/70">自由分屏操作</div>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        handleSplit("horizontal");
                      }}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal"
                    >
                      <Columns2 size={13} className="text-teal" />
                      <span className="font-mono text-caption">向右拆分当前格 (Split Right)</span>
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        handleSplit("vertical");
                      }}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal"
                    >
                      <Rows2 size={13} className="text-teal" />
                      <span className="font-mono text-caption">向下拆分当前格 (Split Down)</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：全局操作工具条 */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 一键归拢（三期）：有弹出窗口时出现 */}
          {popoutCount > 0 && (
            <button
              type="button"
              onClick={() => useCanvasPopouts.getState().recallAll()}
              title={`把 ${popoutCount} 个弹出窗口归拢回标签栏`}
              className="flex items-center gap-1 rounded-btn bg-teal-tint px-2 py-0.5 text-caption text-teal transition hover:bg-teal hover:text-white"
            >
              <Combine size={12} />
              <span className="hidden sm:inline">归拢 ({popoutCount})</span>
            </button>
          )}

          {!isMobile && (
            <>
              {/* 向右拆分（组栈语义：激活组一分为二） */}
              <button
                type="button"
                onClick={() => handleSplit("horizontal")}
                title="向右拆分当前格：新格承载新标签"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Columns2 size={12} />
                <span className="hidden xl:inline">向右拆分</span>
              </button>

              {/* 向下拆分 */}
              <button
                type="button"
                onClick={() => handleSplit("vertical")}
                title="向下拆分当前格：新格承载新标签"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Rows2 size={12} />
                <span className="hidden xl:inline">向下拆分</span>
              </button>

              {/* 最大化 / 还原 */}
              <button
                type="button"
                onClick={() => toggleMaximize()}
                title={maximizedPaneId ? "还原分屏" : "最大化当前聚焦标签"}
                className={cn(
                  "flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption transition",
                  maximizedPaneId ? "bg-teal-tint text-teal" : "text-ash hover:bg-line-soft hover:text-ink",
                )}
              >
                {maximizedPaneId ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                <span className="hidden sm:inline">{maximizedPaneId ? "还原" : "最大化"}</span>
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
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <MessageSquarePlus size={12} />
                <span className="hidden sm:inline">新对话</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (focusedChatUnit === undefined) return;
                  useSidePane.getState().openTab({ unitId: focusedChatUnit.id, unitName: focusedChatUnit.name });
                }}
                title="在右侧面板打开这个 bot 的历史会话列表"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <History size={12} />
                <span className="hidden sm:inline">历史</span>
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
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <Trash2 size={12} />
                <span className="hidden sm:inline">清屏</span>
              </button>
              <button
                type="button"
                onClick={handleRestart}
                title="重启当前终端进程"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash transition hover:bg-teal-tint hover:text-teal"
              >
                <RotateCw size={12} />
                <span className="hidden sm:inline">重启</span>
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
