import { useEffect, useRef, useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { AutomationsPage } from "./ui/AutomationsPage.tsx";
import { AutomationDialog } from "./ui/AutomationDialog.tsx";
import { BacklogPage } from "./ui/BacklogPage.tsx";
import { ProposalBanner } from "./ui/ProposalBanner.tsx";
import { ImageStudioPage } from "./ui/ImageStudioPage.tsx";
import { CommandCenter } from "./ui/CommandCenter.tsx";
import { Composer } from "./ui/Composer.tsx";
import { DesktopTopOverlay } from "./ui/DesktopTopOverlay.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SourceControlPage } from "./ui/SourceControlPage.tsx";
import { PermissionDialog } from "./ui/PermissionDialog.tsx";
import { QuestionnaireCard } from "./ui/chat/items/QuestionnaireCard.tsx";
import { Timeline, EmptyState } from "./ui/Timeline.tsx";
import { ChatTerminalDock } from "./ui/ChatTerminalDock.tsx";
import { useWorkbench } from "./store/useWorkbench.ts";
import { useTerminalStore } from "./store/useTerminalStore.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { TerminalPanel } from "./ui/TerminalPanel.tsx";
import { WorkspaceHeader } from "./ui/WorkspaceHeader.tsx";
import { WindowControls } from "./ui/WindowControls.tsx";
import { bindShellShortcuts, useShell, SIDEBAR_MIN } from "./store/useShell.ts";
import { bindSidePaneShortcuts } from "./store/sidePaneShortcuts.ts";
import { installNotifications } from "./store/useNotifications.ts";
import { SidePaneColumn } from "./ui/SidePanePanel.tsx";
import { useSidePane } from "./store/useSidePane.ts";
import { sidePaneOccupies } from "./core/sidePaneTabs.ts";
import { GlobalStatusBar } from "./ui/GlobalStatusBar.tsx";
import { CompressGhost } from "./ui/taskbar/CompressGhost.tsx";
import { MobileLayout } from "./ui/mobile/MobileLayout.tsx";
import { useIsMobile } from "./ui/mobile/useIsMobile.ts";
import { cn } from "./ui/cn.ts";

/**
 * 工作台外壳 —— 布局结构对齐 ZCode 的 WorkspaceShellLayout。
 *
 * 照搬的 ZCode 约定：
 *   - 侧栏默认 264px 起，min 240（顶部动作行不溢出），max 视口 50%，宽度持久化
 *   - **面板收起即归零**：左栏收起不留窄条，重开的唯一入口是
 *     工作区头部那颗状态感知的开关按钮
 *     —— ZCode 的 DesktopTopOverlay / WorkspaceHeaderActionSection 同款约定
 *
 * 会话区形态（docs/13 统一 Web 化）：结构化对话（默认）与终端画布可切换，
 * 终端画布持久挂载（隐藏不卸载）。
 *
 * 与 ZCode 的差异：ZCode 右侧是内嵌浏览器，本项目右侧换成标签页面板
 * —— 因为「多工具平等切换 + 能力对比」比内嵌浏览器更核心。
 *
 * 注：react-resizable-panels v4 的 API 与 v2/v3 不同
 * （Group / Separator / PanelSize{inPixels,asPercentage}）。
 */
export function WorkspaceShell() {
  const settingsOpen = useShell((s) => s.settingsOpen);
  const automationDialog = useShell((s) => s.automationDialog);
  const closeAutomationDialog = useShell((s) => s.closeAutomationDialog);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const { isMobile, preference, setPreference } = useIsMobile();
  useEffect(() => {
    const un1 = bindShellShortcuts();
    const un2 = bindSidePaneShortcuts();
    return () => {
      un1();
      un2();
    };
  }, []);
  // 通知中心的数据面：订阅 daemon 原始广播（后台会话终态/审批/系统通知/待办/
  // git 变更）。移动端不渲染右侧栏，但通知照常聚合 —— 桌面回到面板前就有账。
  useEffect(() => installNotifications(), []);

  // 切 bot 联动：右侧面板按当前 bot 过滤可见 tab（隐藏不销毁、记忆恢复聚焦）。
  // 用 effect 而不是订阅回调 —— selectUnit 与 openTab 可能同帧相邻发生
  //（CommandCenter 先切 bot 再开 tab），effect 保证按 render 顺序收敛到最终值。
  useEffect(() => {
    useSidePane.getState().handleUnitChange(activeUnitId);
  }, [activeUnitId]);

  // 首载重挂：F5 后把 daemon 里还活着的终端进程找回成标签（带最近输出回放）。
  // 不找回的话那些 PTY 就是界面再也关不掉的孤儿进程。
  useEffect(() => {
    void useTerminalStore.getState().reattachFromDaemon();
    // created 帧推送认领：定时任务的 TUI 派发一到点就自动弹标签，不等刷新
    useTerminalStore.getState().installTerminalCreatedClaim();
  }, []);

  // 手机布局下右上角三钮整体隐藏：与头部的会话形态切换（对话/终端 TUI）重叠、
  // 点不到。关窗改走头部右键菜单（useWindowOpsMenu，MobileLayout / WorkspaceHeader
  // 都挂了）。aw-wco-hidden 让 --wco-w 归零 —— 各顶行让位带与右上浮层偏移跟着
  // 收缩，移动端设置页等仍引用该变量的行不再留 132px 空白。
  useEffect(() => {
    document.documentElement.classList.toggle("aw-wco-hidden", isMobile);
    return () => document.documentElement.classList.remove("aw-wco-hidden");
  }, [isMobile]);

  if (isMobile) {
    return <MobileLayout preference={preference} onSetPreference={setPreference} />;
  }

  return (
    /* 画布底色只由 body 刷一次（开壁纸时它就是唯一的全局半透明层），
       这里不再叠 bg-canvas —— 嵌套重复刷会让壁纸被多层 70% 黑乘到不可见 */
    <div className="relative flex h-screen flex-col">
      {/* 左上 / 右上浮层 —— 侧栏与右侧面板折叠时常驻角上的重开入口（互为镜像：
          左上 = 侧栏展开钮，右上 = 面板展开钮）。悬浮在对应列上方，主视图切换不消失 */}
      <DesktopTopOverlay />
      <SidePaneTopOverlay />
      {/* 桌面端无边框窗口的右上角控制钮 —— 常驻所有视图（含设置页），浏览器不渲染 */}
      <WindowControls />
      {/* 三列主体（左栏 + 主对话流 + 右侧标签面板）。包一层 flex-1 容器：
          下方还要放全局底栏，Group 的高度由这层约束 */}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" id="workbench-shell">
          <SidebarSlot />
          <ResizeHandle />
          <ConversationSlot />
          <SidePaneColumn />
        </Group>
      </div>
      {/* 全局底栏 —— 状态显示类功能的专席（工作状态 / 后台守护）。横贯全窗，
          弹层有足够的水平空间向上展开，不再受任何一列的宽度钳制 */}
      <GlobalStatusBar />
      {/* 任务栏动画层（渲染为 null）：订阅底栏信号播「压缩进底栏/展开回对话」
          的 ghost —— 挂在 shell 层保证设置页覆盖之下也常驻 */}
      <CompressGhost />

      {/* 设置覆盖层 —— 对齐 ZCode 的 WorkspaceSettingsLayer：absolute inset-0 压在
          shell 之上，shell 不卸载；Esc / 返回工作台退出（useShell.closeSettings） */}
      {settingsOpen && (
        <div className="absolute inset-0 z-40 bg-canvas-solid">
          <SettingsPage />
        </div>
      )}

      {/* 待办提议横幅 —— 确认门的载体，跨主视图常驻（任何视图下都能确认/拒绝） */}
      <ProposalBanner />

      {/* 自动化编辑弹窗（docs/23）—— 全局唯一挂载点：侧栏待触发行与自动化页
          共用 useShell.automationDialog 这一份状态，任何主视图下都能弹 */}
      {automationDialog !== null && (
        <AutomationDialog
          key={automationDialog.mode === "edit" ? automationDialog.automation.id : (automationDialog.prefill?.name ?? "new")}
          initial={automationDialog.mode === "edit" ? automationDialog.automation : null}
          prefill={automationDialog.mode === "create" ? automationDialog.prefill : undefined}
          onClose={closeAutomationDialog}
        />
      )}

      <CommandCenter />
    </div>
  );
}
function ResizeHandle() {
  return (
    <Separator
      className="group relative w-px bg-line cursor-col-resize transition-colors data-[separator=active]:bg-teal hover:bg-teal/50"
      style={{ cursor: "col-resize" }}
    >
      {/* 16px 宽的命中区域，带明确的 col-resize 光标与 hover/active 激活高亮条 */}
      <span
        className="absolute inset-y-0 -left-2 -right-2 z-20 cursor-col-resize transition-colors group-hover:bg-teal/20 group-data-[separator=active]:bg-teal/30"
        aria-hidden
      />
    </Separator>
  );
}

/* ------------------------------------------------------------- 侧栏 */

function SidebarSlot() {
  const collapsed = useShell((s) => s.sidebarCollapsed);
  const setWidth = useShell((s) => s.setSidebarWidth);
  // ⚠ initialWidth 只在挂载时读取一次持久化宽度作为 defaultSize。
  const [initialWidth] = useState(() => useShell.getState().sidebarWidth);
  const ref = useRef<PanelImperativeHandle>(null);
  const isMountedRef = useRef(false);

  // 首帧挂载后显式应用 initialWidth 像素值，并仅在稳定后接收真实用户手势更新
  useEffect(() => {
    if (!collapsed && ref.current) {
      ref.current.resize(`${initialWidth}px`);
    }
    const timer = setTimeout(() => {
      isMountedRef.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, [initialWidth, collapsed]);

  // WP-7 窄屏（手机局域网）：<900px 自动收侧栏，主列全宽——收起即归零语义复用。
  // 自动收起会打上 sidebarAutoCollapsed 标记：宽回来时跟着自动展开（否则用户
  // 每次缩放窗口都要手动点开一次）。手动收起（toggleSidebar / ⌘B）会清掉标记，
  // 宽回来不替用户做主——那是显式选择。
  useEffect(() => {
    let wasWide = true;
    const onResize = (): void => {
      const wide = window.innerWidth >= 900;
      if (wasWide === wide) return;
      wasWide = wide;
      if (!wide) {
        if (!useShell.getState().sidebarCollapsed) {
          useShell.setState({ sidebarCollapsed: true, sidebarAutoCollapsed: true });
        }
      } else if (useShell.getState().sidebarAutoCollapsed) {
        useShell.setState({ sidebarCollapsed: false, sidebarAutoCollapsed: false });
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 折叠/展开走 panelRef，保证 Group 的子节点结构始终是 Panel / Separator
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (collapsed) p.collapse();
    else p.expand();
  }, [collapsed]);

  return (
    <Panel
      panelRef={ref}
      // 注意：数字会被当成百分比，所以宽度必须写成带单位的字符串。
      // minSize 与 store 的 SIDEBAR_MIN 同源 —— 顶部动作行的固定内容宽度是下限
      defaultSize={`${initialWidth}px`}
      minSize={`${SIDEBAR_MIN}px`}
      maxSize="50%"
      // ZCode：收起即归零（web 侧为 0，桌面端 4px 是它的窗口内缩需求），不留常驻窄条
      collapsedSize="0px"
      collapsible
      onResize={(size) => {
        // 仅在真实交互/挂载就绪后，且未折叠时才持久化宽度
        if (isMountedRef.current && !collapsed) {
          setWidth(size.inPixels);
        }
      }}
      className="overflow-hidden"
    >
      {/* 内容保持挂载、由 Panel 裁剪 —— 对齐 ZCode 的 opacity-0 + pointer-events-none 策略 */}
      <Sidebar />
    </Panel>
  );
}

/* ------------------------------------------------------------- 右上面板浮层 */

/**
 * 右上浮层 —— 右侧面板收起时的常驻重开入口，与左侧栏的 DesktopTopOverlay
 * 互为镜像（左栏折叠 → 左上出展开钮；面板收起 → 右上出展开钮）。面板自己的
 * 收起钮在 tab 条最右（SidePanePanel），开合入口各自跟人走。
 * 只在 chat 主视图出现：面板是 bot 作用域的，全局页（自动化 / 出图 / 待办 /
 * 源代码管理）不挂它；头部相应让出右侧 pr-12 的对齐带。
 */
function SidePaneTopOverlay() {
  const mainView = useShell((s) => s.mainView);
  const paneOpen = useSidePane((s) =>
    sidePaneOccupies(s.scopeUnitId, s.collapsed, mainView === "chat"),
  );
  if (paneOpen || mainView !== "chat") return null;
  return (
    /* 桌面端无边框窗口：浮层钮要让出右上角窗口控制按钮条（--wco-w，浏览器为 0）。
       titlebar-no-drag：它悬浮在下方的 titlebar-drag 头部之上，必须显式打洞才可点击 */
    <div
      className="pointer-events-none absolute top-0 z-30 flex h-12 items-center"
      style={{ right: "var(--wco-w, 0px)" }}
    >
      <div className="titlebar-no-drag pointer-events-auto flex items-center gap-1 pr-3">
        <button
          onClick={() => useSidePane.getState().toggleFromHeader()}
          aria-label="展开右侧面板"
          title="展开右侧面板（从对话列右侧让出一列；没有标签时显示功能主页，面板里点选要开的功能）"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
        >
          <PanelRightOpen size={14} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 对话区 */

function ConversationSlot() {
  const mainView = useShell((s) => s.mainView);
  const conversationView = useShell((s) => s.conversationView);
  // 与 Timeline 同源判空（raw timeline 为空 ⇔ 归并后 items 为空 —— 归并只在
  // 既有事件间插 divider，不会无中生有）
  const timelineEmpty = useWorkbench((s) => s.timeline.length === 0);

  return (
    <Panel minSize="30%" className="min-w-0">
      {/* 主视图：chat / automations / image / backlog */}
      {mainView === "automations" ? (
        <main className="h-full min-h-0" aria-label="自动化">
          <AutomationsPage />
        </main>
      ) : mainView === "image" ? (
        /* 出图工作台（独立主视图） */
        <main className="h-full min-h-0" aria-label="出图">
          <ImageStudioPage />
        </main>
      ) : mainView === "backlog" ? (
        /* 待办清单（独立主视图） */
        <main className="h-full min-h-0" aria-label="待办">
          <BacklogPage />
        </main>
      ) : mainView === "sourceControl" ? (
        /* 源代码管理（独立主视图）：分支 / 工作树 */
        <main className="h-full min-h-0" aria-label="源代码管理">
          <SourceControlPage />
        </main>
      ) : (
        <main className="@container flex h-full min-h-0 flex-col" aria-label="会话">
          {/* 工作区头部：Agent 身份卡 + 会话形态切换（对话/终端） */}
          <WorkspaceHeader />

          {/* 结构化对话视图（docs/13：默认形态）—— 归一化事件流渲染 */}
          {conversationView === "chat" && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <Timeline />
              <PermissionDialog />
              <QuestionnaireCard />
              <Composer />
              {/* 对话页小终端：在输入框下方（ZCode 同款），与 TUI 终端页互相独立 */}
              <ChatTerminalDock />
              {/* 空态主角：绝对居中于本列（减固定预留 pb-32 ≈ 输入区常态高）。
                  此前它挂在 Timeline 滚动区里 min-h-full 居中，居中参考是「输入区
                  之上的剩余空间」—— 列宽收窄时输入区工具栏先换行（变高，主角上移），
                  随标签按 640/560/480 收纳总宽回落后又解除换行（变矮，主角下移），
                  图标过 480 容器档再缩一号，主角就被推着跳了两段。固定预留让位置
                  只跟列高走，与输入区/终端坞的一切高度变化解耦；pointer-events-none
                  不挡交互（纯展示内容）。 */}
              {timelineEmpty && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-32">
                  <EmptyState />
                </div>
              )}
            </div>
          )}

          {/* 终端画布持久挂载：切换视图时不杀进程、不丢缓冲，切回瞬间即达 */}
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              conversationView === "terminal" ? "flex" : "hidden",
            )}
          >
            <TerminalPanel variant="canvas" />
          </div>
        </main>
      )}
    </Panel>
  );
}



