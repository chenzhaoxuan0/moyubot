import { useEffect, useMemo, useRef, useState } from "react";
import {
  SquareTerminal,
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
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import {
  useTerminalStore,
  SUPPORTED_TERMINAL_PROFILES,
  collectLeafIds,
  collectChatPaneKeys,
  countLeaves,
} from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { TerminalSplitTree } from "./TerminalSplitTree.tsx";
import { TerminalPaneSlot, ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { NewSessionPage } from "./NewSessionPage.tsx";
import { useAppearance } from "../store/useAppearance.ts";
import { dispatchTerminal } from "../adapters/daemon/client.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";

/**
 * 会话画布（docs/31）—— 终端与对话窗格的统一标签容器。
 *
 * 由旧「终端画布」泛化而来：标签组（groups）× 递归分屏树（rootLayout）里
 * 的叶子可以是终端（leaf.instanceId）或对话（chatLeaf.paneKey）。「＋」下拉
 * 的分组顺序：对话 → Agent CLI (TUI·派发) → 原生系统终端 → 自由分屏。
 * 空态是新建会话页（选 bot × 选形态）。
 *
 * 旧「终端跟随 bot 自动派发 TUI」已随 conversationView 互斥开关一起退役：
 * 画布常驻后「进入终端视图」这个触发点不存在了，终端窗格只由显式动作
 * （＋下拉 / 拆分 / 侧栏 TUI 恢复 / 派发认领 / F5 重挂）创建。
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
  // 会话历史/终端抽屉已移除（见 useShell.ts 顶部注释）：非画布变体当前无人渲染，
  // 关闭动作只能由调用方显式传 onClose。
  const closeTerminal = onClose ?? (() => {});

  // 多终端自由分屏树与标签组状态
  const {
    instances,
    groups,
    activeGroupId,
    activeInstanceId,
    activeChatPaneKey,
    maximizedInstanceId,
    defaultProfileId,
    createTab,
    splitPane,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    setActiveGroup,
    setActiveInstance,
    toggleMaximize,
  } = useTerminalStore();

  // chat 窗格注册表（标签标题 / 工具条自适应用）
  const chatPanes = useChatPanes((s) => s.panes);
  const units = useWorkbench((s) => s.units);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 标签右键三件套（ZCode SidePaneTabTrigger 同款）
  const [tabMenu, setTabMenu] = useState<QuickMenuState | null>(null);

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

  // 清屏当前活跃窗格（终端语义）
  const handleClear = () => {
    if (activeInstanceId) {
      terminalSessionRegistry.get(activeInstanceId)?.clear();
    }
  };

  // 重启当前活跃窗格（终端语义）
  const handleRestart = () => {
    if (activeInstanceId) {
      void terminalSessionRegistry.get(activeInstanceId)?.restart();
    }
  };

  // 新建默认终端标签页
  const handleNewDefault = () => {
    createTab({
      profileId: defaultProfileId,
      cwd: unit?.rootPath,
    });
  };

  // 新建对话标签（「＋」下拉第一组）：当前 bot 直开；没选 bot 开未选态窗格
  const handleNewChat = () => {
    setMenuOpen(false);
    if (unit) {
      useChatPanes.getState().openUnitChatPane(unit.id);
      return;
    }
    const draftKey = useChatPanes.getState().createDraftRecord();
    useTerminalStore.getState().createChatTab(draftKey);
  };

  // 选择 Profile 新建系统终端
  const handleCreateProfile = (profileId: string) => {
    setMenuOpen(false);
    createTab({
      profileId,
      cwd: unit?.rootPath,
    });
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

  // 工具条「向右/向下拆分」：焦点是 chat 窗格 → 拆一个草稿对话窗格在旁边；
  // 焦点是终端 → 原行为（终端兄弟窗格）
  const handleSplit = (direction: "horizontal" | "vertical") => {
    if (activeChatPaneKey !== null) {
      const draftKey = useChatPanes.getState().createDraftRecord();
      splitPane({ targetPaneId: activeChatPaneKey, chatPaneKey: draftKey, direction });
      return;
    }
    splitPane({ direction });
  };

  // 获取可用的 Agent 执行器列表
  const executorOptions = useMemo(() => {
    return runtimes.filter((r) => !r.testOnly);
  }, [runtimes]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0];
  const activeLeaves = useMemo(() => {
    return activeGroup ? countLeaves(activeGroup.rootLayout) : 0;
  }, [activeGroup]);

  const maximizedInst = useMemo(() => {
    return instances.find((i) => i.id === maximizedInstanceId);
  }, [instances, maximizedInstanceId]);
  /** 最大化游标落在 chat 窗格上（toggleMaximize 对任意窗格 id 通用） */
  const maximizedChatPaneKey =
    maximizedInstanceId !== null && maximizedInst === undefined ? maximizedInstanceId : null;

  /** 标签标题：显式命名 → 单窗格（终端实例名 / 对话 bot 名）→ 分屏摘要 */
  const tabTitleOf = (groupId: string): { title: string; isSplit: boolean; chatPaneKey: string | null } => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return { title: "终端", isSplit: false, chatPaneKey: null };
    const paneCount = countLeaves(g.rootLayout);
    const isSplit = paneCount > 1;
    if (g.title) return { title: g.title, isSplit, chatPaneKey: null };
    if (isSplit) return { title: `分屏 (${paneCount} 窗格)`, isSplit: true, chatPaneKey: null };
    const termId = collectLeafIds(g.rootLayout)[0];
    if (termId !== undefined) {
      return { title: instances.find((i) => i.id === termId)?.title || "终端", isSplit: false, chatPaneKey: null };
    }
    const chatKey = collectChatPaneKeys(g.rootLayout)[0] ?? null;
    if (chatKey !== null) {
      const pane = chatPanes[chatKey];
      const unitName = pane ? units.find((u) => u.id === pane.unitId)?.name : undefined;
      return { title: unitName ? `${unitName} · 对话` : "新对话", isSplit: false, chatPaneKey: chatKey };
    }
    return { title: "终端", isSplit: false, chatPaneKey: null };
  };

  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  /** 焦点窗格类型：chat → 工具条收起终端专属动作（清屏/重启），其余照旧 */
  const focusedIsChat = activeChatPaneKey !== null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col",
        isCanvas ? undefined : "bg-card",
        !isCanvas && !isPage && "border-t border-line",
      )}
    >
      {/* VS Code 同款终端多标签栏与自由分屏工具条 */}
      <div className="relative z-30 flex h-9 shrink-0 items-center border-b border-line/40 bg-rail px-2 select-none">
        {/* 左侧：多终端 Tabs 标签页列表 */}
        <div
          className={cn(
            "flex h-full items-center gap-1 overflow-x-auto no-scrollbar py-1 scroll-smooth touch-pan-x",
            isMobile ? "flex-1 min-w-0 pr-1" : "max-w-[calc(100%-280px)]",
          )}
        >
          {groups.map((group) => {
            const isGroupActive = group.id === activeGroupId;
            const { title: tabTitle, isSplit: isSplitGroup, chatPaneKey } = tabTitleOf(group.id);

            return (
              <div
                key={group.id}
                onClick={() => setActiveGroup(group.id)}
                onContextMenu={(e) =>
                  setTabMenu(
                    quickMenuFromEvent(e, [
                      { label: "关闭", icon: X, onSelect: () => closeTab(group.id) },
                      {
                        label: "关闭其它",
                        icon: X,
                        disabled: groups.filter((g) => g.id !== group.id).length === 0,
                        onSelect: () => closeOtherTabs(group.id),
                      },
                      {
                        label: "关闭全部",
                        icon: X,
                        disabled: groups.length === 0,
                        onSelect: () => closeAllTabs(),
                      },
                    ]),
                  )
                }
                className={cn(
                  "group relative flex h-7 items-center gap-1.5 rounded font-mono cursor-pointer transition select-none shrink-0",
                  isMobile
                    ? "px-2 text-[11px] max-w-[150px] min-w-[70px]"
                    : "px-2.5 text-caption max-w-[210px]",
                  isGroupActive
                    ? "bg-canvas text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-line-soft hover:text-ink",
                  isSplitGroup && "ring-1 ring-teal/30",
                )}
                title={tabTitle}
              >
                {isSplitGroup ? (
                  <Columns2 size={12} className="shrink-0 text-teal" />
                ) : chatPaneKey !== null ? (
                  <MessageSquarePlus size={12} className="shrink-0 text-teal" />
                ) : (
                  <ShellOrAgentIcon
                    icon={
                      instances.find((i) => i.id === collectLeafIds(group.rootLayout)[0])?.icon || "pwsh"
                    }
                  />
                )}

                <span className="truncate flex-1 min-w-0">{tabTitle}</span>

                {/* 派发徽章：autoterm_ 前缀 = 经派发系统（自动化/待办/手动派发），
                    会进该 bot 的历史；普通标签没有它 */}
                {collectLeafIds(group.rootLayout)[0]?.startsWith("autoterm_") && (
                  <span
                    title="派发终端 —— 经过派发系统，会记入该 bot 的历史会话"
                    className="shrink-0 rounded bg-violet-500/15 px-1 py-0.2 text-[9px] font-semibold text-violet-400 font-sans"
                  >
                    派发
                  </span>
                )}

                {/* 分屏窗格数量小徽章 */}
                {isSplitGroup && (
                  <span className="shrink-0 rounded bg-teal/10 px-1 py-0.2 text-[9px] text-teal font-sans">
                    {countLeaves(group.rootLayout)}P
                  </span>
                )}

                {/* 关闭单标签按钮（手机端常驻可见且易于点击，避免无 hover 导致无法关闭） */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(group.id);
                  }}
                  title="关闭标签页（对话标签不杀会话）"
                  aria-label={`关闭标签页 ${tabTitle}`}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded text-ash transition",
                    "hover:bg-line-soft hover:text-rose-400 active:bg-rose-500/20 active:text-loss",
                    isMobile
                      ? "h-5 w-5 opacity-70 active:opacity-100 -mr-1"
                      : cn(
                          "ml-1 p-0.5",
                          isGroupActive
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover:opacity-80",
                        ),
                  )}
                >
                  <X size={isMobile ? 12 : 11} />
                </button>
              </div>
            );
          })}
        </div>

        {/* 新建终端按钮与下拉菜单（对话 / Agent 执行器 / 系统 Shell / 分屏操作） */}
        <div className="relative flex items-center ml-1.5 shrink-0" ref={menuRef}>
          <div className="flex items-center rounded-btn bg-line-soft/40 hover:bg-line-soft text-ash hover:text-ink transition">
            {/* 移动端不放「对话」快捷钮：手机有自己的对话视图分支
                （MobileLayout 的 conversationView），画布内开对话窗格会双头 */}
            {!isMobile && (
              <button
                type="button"
                onClick={handleNewChat}
                title="新建对话（当前 bot）"
                className="flex items-center p-1 hover:text-teal transition"
              >
                <MessageSquarePlus size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={handleNewDefault}
              title="新建终端 (PowerShell 7)"
              className="flex items-center border-l border-line/30 p-1 hover:text-teal transition"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              title="选择对话 / Agent 执行器 / 系统 Shell (ZCode, Claude, Codex, WSL, CMD...)"
              className="flex items-center px-1 py-1 text-ash/80 hover:text-ink border-l border-line/30 transition"
            >
              <ChevronDown size={11} />
            </button>
          </div>

          {/* 移动端全屏半透明遮罩（点按背景关闭） */}
          {menuOpen && isMobile && (
            <div
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150"
              onClick={() => setMenuOpen(false)}
            />
          )}

          {/* 下拉弹出菜单（移动端支持平滑上下滑动、触控滚动及 UI 压缩） */}
          {menuOpen && (
            <div
              className={cn(
                "z-50 rounded-panel border border-line bg-card shadow-2xl backdrop-blur flex flex-col",
                isMobile
                  ? "fixed inset-x-3 top-12 max-h-[72dvh] p-2.5 animate-in fade-in zoom-in-95 duration-150"
                  : "absolute left-0 top-full mt-1.5 min-w-[260px] max-h-[480px] p-1.5",
              )}
            >
              {/* 移动端顶部标题栏与关闭叉号 */}
              {isMobile && (
                <div className="flex items-center justify-between pb-2 mb-1.5 border-b border-line/50 px-1 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Zap size={13} className="text-teal" />
                    <span className="text-body-sm font-semibold text-ink">新建会话窗格</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    className="p-1 rounded text-ash hover:text-ink hover:bg-line-soft active:scale-90 transition"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {/* 滚动容器：添加 touch-pan-y 与 iOS 原生平滑滚动 */}
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y scrollbar-thin flex flex-col pr-0.5"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {/* 分组 0：对话会话（docs/31：画布的第一等窗格；移动端隐藏——
                    手机的对话入口是顶栏形态切换，画布内开对话窗格会双头） */}
                {!isMobile && (
                  <>
                    <div className="px-2 py-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase flex items-center gap-1 shrink-0">
                      <MessageSquarePlus size={11} />
                      <span>对话</span>
                    </div>
                    <button
                      onClick={handleNewChat}
                      className="flex w-full items-center rounded text-left text-ink hover:bg-teal-tint hover:text-teal active:bg-teal-tint transition gap-2.5 px-2.5 py-1.5 text-body-sm"
                    >
                      <MessageSquarePlus size={13} className="shrink-0 text-teal" />
                      <span className="flex-1 text-caption font-mono font-medium truncate">
                        {unit ? `与 ${unit.name} 对话` : "新对话（先选 bot）"}
                      </span>
                      <span className="rounded bg-line-soft px-1 py-0.2 text-[9px] font-sans text-ash shrink-0">
                        结构化时间线
                      </span>
                    </button>

                    <div className="my-1.5 h-px bg-line/50 shrink-0" />
                  </>
                )}

                {/* 分组 1：Agent 执行器 —— 全部经派发系统打开 */}
                <div className="px-2 py-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase flex items-center gap-1 shrink-0">
                  <Zap size={11} />
                  <span>Agent CLI (TUI · 派发)</span>
                  <span className="ml-auto text-[9px] normal-case tracking-normal text-ash/50">
                    记入历史
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {executorOptions.map((r) => {
                    return (
                      <button
                        key={r.id}
                        onClick={() => handleLaunchExecutor(r.id, r.presentation.displayName)}
                        className={cn(
                          "flex w-full items-center rounded text-left text-ink hover:bg-teal-tint hover:text-teal active:bg-teal-tint transition",
                          isMobile
                            ? "gap-2 px-2 py-1.5 min-h-8.5"
                            : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                        )}
                      >
                        <ShellOrAgentIcon icon={r.id} />
                        <div className="flex flex-1 items-center justify-between min-w-0 gap-1.5">
                          <span className="text-caption font-mono font-medium truncate">
                            {r.presentation.displayName}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {activeRuntimeId === r.id && (
                              <span className="rounded bg-teal/15 px-1 py-0.2 text-[9px] font-sans font-medium text-teal">
                                当前
                              </span>
                            )}
                            <span className="rounded bg-line-soft px-1 py-0.2 text-[9px] font-sans text-ash">
                              TUI 派发
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="my-1.5 h-px bg-line/50 shrink-0" />

                {/* 分组 2：原生系统 Shell */}
                <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase shrink-0">
                  原生系统终端
                </div>
                <div className="flex flex-col gap-0.5">
                  {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
                    <button
                      key={profile.id}
                      onClick={() => handleCreateProfile(profile.id)}
                      className={cn(
                        "flex w-full items-center rounded text-left text-ink hover:bg-teal-tint hover:text-teal active:bg-teal-tint transition",
                        isMobile
                          ? "gap-2 px-2 py-1.5 min-h-8"
                          : "gap-2.5 px-2.5 py-1.5 text-body-sm",
                      )}
                    >
                      <ShellOrAgentIcon icon={profile.icon} />
                      <span className="flex-1 text-caption font-mono truncate">{profile.name}</span>
                      {profile.id === defaultProfileId && (
                        <span className="text-[9px] text-teal/80 bg-teal/10 px-1 py-0.2 rounded font-sans shrink-0">
                          默认
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* 分组 3：自由分屏操作（仅在桌面端显示，手机屏幕过窄拆分分屏体验不佳） */}
                {!isMobile && (
                  <>
                    <div className="my-1.5 h-px bg-line/50 shrink-0" />
                    <div className="px-2 py-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase shrink-0">
                      自由分屏操作
                    </div>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        handleSplit("horizontal");
                      }}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
                    >
                      <Columns2 size={13} className="text-teal" />
                      <span className="text-caption font-mono">向右拆分当前窗格 (Split Right)</span>
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        handleSplit("vertical");
                      }}
                      className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink hover:bg-teal-tint hover:text-teal transition"
                    >
                      <Rows2 size={13} className="text-teal" />
                      <span className="text-caption font-mono">向下拆分当前窗格 (Split Down)</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：全局终端操作工具条 */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 桌面端才展示向右拆分、向下拆分与最大化，移动端直接隐藏节省横向空间 */}
          {!isMobile && (
            <>
              {/* 向右拆分 */}
              <button
                type="button"
                onClick={() => handleSplit("horizontal")}
                title="向右拆分当前窗格 (Split Right)"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
              >
                <Columns2 size={12} />
                <span className="hidden xl:inline">向右拆分</span>
              </button>

              {/* 向下拆分 */}
              <button
                type="button"
                onClick={() => handleSplit("vertical")}
                title="向下拆分当前窗格 (Split Down)"
                className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
              >
                <Rows2 size={12} />
                <span className="hidden xl:inline">向下拆分</span>
              </button>

              {/* 最大化 / 还原 */}
              <button
                type="button"
                onClick={() => toggleMaximize()}
                title={maximizedInstanceId ? "还原分屏窗格" : "最大化当前聚焦窗格"}
                className={cn(
                  "flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption transition",
                  maximizedInstanceId
                    ? "bg-teal-tint text-teal"
                    : "text-ash hover:bg-line-soft hover:text-ink",
                )}
              >
                {maximizedInstanceId ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                <span className="hidden sm:inline">
                  {maximizedInstanceId ? "还原" : "最大化"}
                </span>
              </button>
            </>
          )}

          {/* 清屏（终端语义：焦点在 chat 窗格时隐藏） */}
          {!focusedIsChat && (
            <button
              type="button"
              onClick={handleClear}
              title="清空当前窗格屏幕 (Ctrl+L 重绘)"
              className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <Trash2 size={12} />
              <span className="hidden sm:inline">清屏</span>
            </button>
          )}

          {/* 重启当前终端进程（终端语义：焦点在 chat 窗格时隐藏） */}
          {!focusedIsChat && (
            <button
              type="button"
              onClick={handleRestart}
              title="重启当前终端进程"
              className="flex items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-ash hover:bg-teal-tint hover:text-teal transition"
            >
              <RotateCw size={12} />
              <span className="hidden sm:inline">重启</span>
            </button>
          )}

          {/* 关闭终端（非画布态） */}
          {!isCanvas && (
            <button
              type="button"
              onClick={closeTerminal}
              aria-label={isPage ? "关闭终端窗格" : "关闭终端"}
              title={isPage ? undefined : "关闭终端"}
              className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 画布内容区：无标签 = 新建会话页；有标签 = 最大化窗格或递归分屏树 */}
      {groups.length === 0 ? (
        <NewSessionPage />
      ) : maximizedInst ? (
        /* 当前终端窗格最大化展示 */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          <TerminalPaneSlot
            key={maximizedInst.id}
            inst={maximizedInst}
            totalPanesInGroup={1}
          />
        </div>
      ) : maximizedChatPaneKey !== null ? (
        /* 当前对话窗格最大化展示 */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          <ChatPaneSlot key={maximizedChatPaneKey} paneKey={maximizedChatPaneKey} totalPanesInGroup={1} />
        </div>
      ) : activeGroup ? (
        /* 自由递归分屏树展示 */
        <div className="min-h-0 flex-1 relative overflow-hidden">
          <TerminalSplitTree
            key={activeGroup.id}
            node={activeGroup.rootLayout}
            totalPanesInGroup={activeLeaves}
          />
        </div>
      ) : null}
      <QuickContextMenu menu={tabMenu} onClose={() => setTabMenu(null)} />
    </div>
  );
}
