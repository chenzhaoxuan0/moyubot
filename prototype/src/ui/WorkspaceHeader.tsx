import { useEffect, useRef, useState, type ComponentType } from "react";
import { Check, ChevronDown, FolderOpen, PanelBottom, RotateCw, Smartphone, X } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useTaskbar } from "../store/useTaskbar.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { sidePaneOccupies } from "../core/sidePaneTabs.ts";
import { listEditors, openInEditor, type DaemonEditorInfo } from "../adapters/daemon/client.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { ConversationViewSwitch } from "./ConversationViewSwitch.tsx";
import { TitleBarClearance, onTitleBarContextMenu } from "./WindowControls.tsx";
import { cn } from "./cn.ts";

/**
 * 工作区头部 —— 只留高频操作：单元身份卡（左）＋ 会话形态切换（右）。
 *
 * 低频状态项（工作中 / 历史会话 / 移动端远控 / 后台守护通道）已迁往右侧栏的
 * 底部状态条（见 StatusIndicators.tsx）：它们是「想看时去看」的信息，不是每一步
 * 都要用的操作，常驻头部只会挤占身份与切换的空间。右侧面板的开合钮也不在
 * 这里：展开时在面板 tab 条最右，收起后是右上浮层钮（WorkspaceShell 的
 * SidePaneTopOverlay，与左侧栏折叠浮层镜像）—— 头部只在面板收起时让出
 * 3rem 的对齐带给它。
 *
 * 溢出阶梯（@container，宽→窄依次让位）：① 一句话角色（<1100）② 文件夹
 * （<560）③ 手机切换钮短标签 + 切换器标签图标化（<560）④ 折叠到底栏钮
 * （<480 隐）⑤ 名称硬裁（overflow-hidden 无省略号）⑥ 右区左缘裁切兜底
 * （min-w-0 + overflow-hidden —— 行尾窗口控制钮让位带 shrink-0 永不被侵占，
 * 极限压缩时宁可裁左缘也绝不滑进控制钮带）。「切回手机视图」是唯一回手机
 * 布局的出口，出现即常驻（仅图标化，不消失）。
 */
export function WorkspaceHeader() {
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const [isSyncing, setIsSyncing] = useState(false);
  /** 同步完成的就地确认态（✓ 2 秒）：RPC 常在几十 ms 内完成，转圈一闪而过
   *  等于没有反馈——通知中心有事实源行，按钮自身也要有看得见的收尾 */
  const [syncDone, setSyncDone] = useState(false);

  const { preference, setPreference, windowIsMobile } = useIsMobile();
  const unit = useWorkbench(selectActiveUnit);
  const isSteward = unit?.id === "steward";
  const mainView = useShell((s) => s.mainView);
  // 面板是否占位决定右侧内边距：收起时让出右上浮层重开钮的对齐带（pr-12）
  const paneOpen = useSidePane(
    (s) => sidePaneOccupies(s.scopeUnitId, s.collapsed, mainView === "chat"),
  );

  return (
    <header
      onContextMenu={onTitleBarContextMenu}
      className={cn(
        "aw-topbar titlebar-drag @container flex h-12 shrink-0 items-center gap-2 border-b border-line/60 bg-rail transition-[padding] duration-300",
        "pl-4",
        paneOpen ? "pr-4" : "pr-0",
      )}
      aria-label="单元"
    >
      {/* 左上浮层钮（侧栏收起时）的 no-drag 让位：占位必须是 drag 行的子元素，
          拖拽区减法才生效（pl-4 + 2rem = 原 pl-12 的几何），见 TitleBarClearance */}
      {sidebarCollapsed && <TitleBarClearance width="2rem" />}

      {/* ---- 左区：单元身份卡片。shrink-[999]：负空间几乎全由它先吸收
          （名称硬裁），右区直到最后才动 —— 优先级阶梯见组件头注释 ---- */}
      {unit ? (
        <div className="flex min-w-0 shrink-[999] items-center gap-2">
          {/* 可点击的单元头衔（点击打开单元设置）。
              名称不压缩、不省略号：空间真不够时硬裁（overflow-hidden，无 "…"）；
              一句话角色徽标最先让位（<1100 隐藏，可见时仍有 280px 上限截断） */}
          <button
            onClick={() => {
              // 设置面归拢（2026-10-23）：单元设置走右栏 bot 设置面板
              useWorkbench.getState().selectUnit(unit.id);
              useSidePane.getState().openContext({ unitId: unit.id, unitName: unit.name });
            }}
            title="查看与编辑 bot 设置（身份 / 执行器 / 模型 / 上下文 / 技能 / 渠道——右栏打开）"
            className="group flex min-w-0 items-center gap-2 rounded-btn px-2 py-1 transition hover:bg-line-soft"
          >
            {/* 名字 */}
            <span className="overflow-hidden whitespace-nowrap text-body font-medium text-ink group-hover:text-teal">
              {unit.name}
            </span>
            {/* 身份/角色徽标：最先让位 */}
            <span
              title={isSteward ? undefined : unit.identity?.role || undefined}
              className="hidden @min-[1100px]:block min-w-0 max-w-[280px] shrink-[999] truncate rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite group-hover:bg-teal-tint group-hover:text-teal"
            >
              {isSteward ? "总管" : unit.identity?.role || "bot"}
            </span>
          </button>

          {/* 单元目录：主钮单击用上次选择的打开方式（默认资源管理器），
              箭头切换资源管理器 / VS Code（<560 隐藏——移动端不需要） */}
          {unit && (
            <span className="hidden shrink-0 @min-[560px]:inline-flex">
              <OpenWorkspaceWith path={unit.rootPath} />
            </span>
          )}
        </div>
      ) : (
        <span className="text-body-sm text-ash">未选择单元</span>
      )}

      {/* ---- 右区：手机切换出口 + 会话形态切换，整块锚定行尾。
          min-w-0 + shrink + overflow-hidden：身份卡吸收完仍不够时（极限压缩）
          本区才收缩并从**左缘**裁切（justify-end 保右缘锚定）—— 行尾的窗口
          控制钮让位带（shrink-0 spacer）因此永不被挤开，切换钮与最小化/最大
          化/关闭不可能重叠，两边永远可点 ---- */}
      <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-2 overflow-hidden">
        {(preference === "desktop" || windowIsMobile) && (
          <button
            onClick={() => setPreference(windowIsMobile ? "auto" : "mobile")}
            aria-label="切回手机视图"
            title="当前处于电脑视图，点击切回手机触控布局"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-btn px-2 text-caption font-medium transition text-teal border border-teal/40 bg-teal-tint/40 hover:bg-teal hover:text-white"
          >
            <Smartphone size={13} className="shrink-0" />
            {/* 标签随容器档收放（阶梯③）：<560 只剩图标 —— 强制桌面模式把窗口
                压窄时它是右区最大的可让位项 */}
            <span className="hidden @min-[560px]:inline">切回手机视图</span>
          </button>
        )}

        {/* 折叠对话到底栏（任务栏最小化的对位）：有活跃会话才出现。折叠后对话列
            回到空白态可开新对话，被折叠的会话停靠在底栏（运行中则任务转后台
            跟踪），点底栏条目随时切回 —— 时间线由 openSession 谱系回放重建。
            <480 隐（阶梯④）：极窄时让位给切换器；底栏入口仍可从运行中的对话
            压缩动画到达，宽度恢复即回 */}
        {activeSessionId !== null && (
          <>
            <button
              onClick={() => {
                if (isSyncing) return;
                setIsSyncing(true);
                setSyncDone(false);
                import("../adapters/daemon/client.ts").then(({ DaemonClient, defaultDaemonEndpoint }) => {
                  const client = DaemonClient.get(defaultDaemonEndpoint());
                  client
                    .rpc<{ changed: boolean; newMessages: number }>("session.syncNative", { sessionId: String(activeSessionId) })
                    .then((res: { changed: boolean; newMessages: number }) => {
                      if (res.changed && res.newMessages > 0) {
                        useWorkbench.getState().pushNotice("同步完成", `成功从外部源文件同步了 ${res.newMessages} 条新消息。`, { level: "success" });
                      } else {
                        useWorkbench.getState().pushNotice("已是最新", "当前会话与外部源文件已保持一致。", { level: "success" });
                      }
                      // 通知中心的事实源行由 daemon 侧落（WS notifications 帧推回），
                      // 这里只做按钮的就地确认态
                      setSyncDone(true);
                      setTimeout(() => setSyncDone(false), 2000);
                      window.dispatchEvent(new CustomEvent("awb:history-refresh"));
                    })
                    .catch((err: unknown) => {
                      useWorkbench.getState().pushNotice("同步失败", err instanceof Error ? err.message : String(err), { level: "warn" });
                    })
                    .finally(() => setIsSyncing(false));
                });
              }}
              aria-label="从源文件同步"
              title="从外部源文件（如 messages.jsonl）实时同步最新消息"
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-btn text-graphite transition hover:bg-line-soft hover:text-ink @min-[480px]:flex cursor-pointer"
            >
              {syncDone ? (
                <Check size={13} className="text-teal" />
              ) : (
                <RotateCw size={13} className={isSyncing ? "animate-spin text-teal" : ""} />
              )}
            </button>
            <button
              onClick={() => useTaskbar.getState().minimize()}
              aria-label="折叠对话到底栏"
              title="折叠当前对话到底栏（最小化，任何状态可用）：运行中的任务转后台继续、空闲对话停靠为「已折叠」，对话列回到空白可开新对话；从底栏条目随时点回"
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-btn text-graphite transition hover:bg-line-soft hover:text-ink @min-[480px]:flex"
            >
              <PanelBottom size={13} />
            </button>
          </>
        )}

        {/* 会话形态切换（结构化对话 | 终端 TUI）—— 最高优先级，任何宽度都在
            （<560 标签图标化，阶梯③，见该组件注释）。面板收起时它是头部最右
            （让位带里是右上浮层的重开钮）；面板展开时右侧是隔壁面板列。挤压
            全由左侧身份卡按阶梯吸收 */}
        <ConversationViewSwitch />
      </div>

      {/* 面板收起时本列顶到窗口右缘：no-drag 占位让出窗口控制钮带 + 浮层钮
          对齐带。shrink-0 + 前方全部可收缩 = 让位带在任意宽度下都完整保有
          （右区极限压缩时从自身左缘裁切，绝不越过这里把切换钮压进控制钮带） */}
      {!paneOpen && <TitleBarClearance width="calc(var(--wco-w, 0px) + 3rem)" />}
    </header>
  );
}

/* ------------------------------------------------------------- 工作区直达 */

/** VS Code 官方 logo（品牌蓝 #007ACC 的官方剪影轮廓，小尺寸下与原版无差） */
function VscodeBrandIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#007ACC"
        d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261a1 1 0 0 0-.002 1.479L3.899 12 .325 15.26a1 1 0 0 0 .002 1.479l1.322 1.201a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 19.89V4.1a1.5 1.5 0 0 0-.85-1.513zM17.996 15.448 10.818 12l7.178-5.448v10.896z"
      />
    </svg>
  );
}

/** 资源管理器文件夹：深黄背板 + 亮黄前板的两片式，对齐 Windows 系统观感 */
function ExplorerFolderBrandIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#D9A13B"
        d="M3.75 3.5h5.52c.43 0 .84.19 1.12.51l1.49 1.74h8.37c.97 0 1.75.78 1.75 1.75v10.75c0 .97-.78 1.75-1.75 1.75H3.75c-.97 0-1.75-.78-1.75-1.75V5.25c0-.97.78-1.75 1.75-1.75z"
      />
      <path
        fill="#FFC84A"
        d="M4.02 7.5h18.17c.78 0 1.33.73 1.15 1.49l-1.91 8.02c-.17.71-.8 1.21-1.54 1.21H1.73c-.78 0-1.33-.73-1.15-1.49l2.12-8.02c.17-.71.8-1.21 1.54-1.21z"
      />
    </svg>
  );
}

/**
 * 打开方式图标映射 —— 留存的两个入口都用真实应用图标（daemon 只回 id/name，
 * 应用图标是 Electron nativeImage 能力，Web UI 内联官方 SVG 代替）；未知 id
 * 兜底成 lucide FolderOpen
 */
const OPEN_WITH_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  explorer: ExplorerFolderBrandIcon,
  vscode: VscodeBrandIcon,
};

/** daemon 不可达时的回退清单：结构与 RPC 结果一致，点击时由后端兜底报错 */
const FALLBACK_OPEN_WITH: DaemonEditorInfo[] = [
  { id: "explorer", name: "资源管理器" },
  { id: "vscode", name: "VS Code" },
];

const OPEN_WITH_STORAGE_KEY = "awb.header.openWith";

/** 合法打开方式集合（偏好读取时归一：早期版本存过后来砍掉的 IDE id） */
const SUPPORTED_OPEN_WITH_IDS = new Set(["explorer", "vscode"]);

function readPreferredOpenWith(): string {
  try {
    const saved = localStorage.getItem(OPEN_WITH_STORAGE_KEY);
    return saved !== null && SUPPORTED_OPEN_WITH_IDS.has(saved) ? saved : "explorer";
  } catch {
    return "explorer";
  }
}

function writePreferredOpenWith(editorId: string): void {
  try {
    localStorage.setItem(OPEN_WITH_STORAGE_KEY, editorId);
  } catch {
    // 隐私模式等场景写不进就算了，本次会话内仍生效（state 里记着）
  }
}

/**
 * 工作区打开按钮 —— 分裂式（对齐 ZCode WorkspaceEditorButtonGroup）：
 * 主钮用「上次选择的打开方式」直接打开（默认资源管理器），箭头钮下拉切换
 * 打开方式（资源管理器 / VS Code，daemon 检测已安装者），
 * 选择即打开并持久化。路径放 title 里悬停可见；成功短暂打勾、失败短暂打叉。
 */
function OpenWorkspaceWith({ path }: { path: string }) {
  const [preferredId, setPreferredId] = useState(readPreferredOpenWith);
  const [editors, setEditors] = useState<DaemonEditorInfo[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "ok" | "fail">("idle");
  const rootRef = useRef<HTMLDivElement>(null);

  // 清单懒加载：首次展开下拉才探测（ZCode onOpenChange → loadEditors 同款）
  useEffect(() => {
    if (!menuOpen || editors !== null) return;
    let disposed = false;
    void listEditors()
      .then((res) => {
        if (!disposed && res.editors.length > 0) setEditors(res.editors);
      })
      .catch((err: unknown) =>
        console.warn("[WorkspaceHeader] 拉取打开方式清单失败，回退静态清单:", err),
      );
    return () => {
      disposed = true;
    };
  }, [menuOpen, editors]);

  // 外点 / Escape 关下拉（ReasoningEffortPicker 同款）
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const flash = (state: "ok" | "fail") => {
    setFeedback(state);
    window.setTimeout(() => setFeedback("idle"), 1500);
  };

  const openWith = (editorId: string) => {
    setPreferredId(editorId);
    writePreferredOpenWith(editorId);
    setMenuOpen(false);
    void openInEditor({ path, editorId })
      .then((res) => {
        if (res.ok) {
          flash("ok");
        } else {
          flash("fail");
          console.error(`[WorkspaceHeader] 用 ${editorId} 打开失败:`, res.error);
        }
      })
      .catch((err: unknown) => {
        flash("fail");
        console.error(`[WorkspaceHeader] 用 ${editorId} 打开失败:`, err);
      });
  };

  const options = editors ?? FALLBACK_OPEN_WITH;
  const preferred = options.find((o) => o.id === preferredId);
  const PreferredIcon = OPEN_WITH_ICONS[preferredId] ?? FolderOpen;
  const preferredName = preferred?.name ?? "资源管理器";

  return (
    <div ref={rootRef} className="relative inline-flex items-center">
      {/* 主钮：上次选择的打开方式直开 */}
      <button
        onClick={() => openWith(preferredId)}
        aria-label={`用${preferredName}打开单元文件夹`}
        title={`单元路径：${path}
单击用${preferredName}打开（箭头可切换打开方式）`}
        className={cn(
          "rounded-btn rounded-r-none p-1.5 pr-1 text-graphite hover:bg-line-soft hover:text-ink",
          feedback === "ok" && "text-gain",
          feedback === "fail" && "text-loss",
        )}
      >
        {feedback === "ok" ? (
          <Check size={14} className="text-gain" />
        ) : feedback === "fail" ? (
          <X size={14} className="text-loss" />
        ) : (
          <PreferredIcon size={14} />
        )}
      </button>
      {/* 箭头钮：展开打开方式下拉 */}
      <button
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="选择打开方式"
        aria-expanded={menuOpen}
        aria-haspopup="listbox"
        title="选择打开方式（资源管理器 / VS Code）"
        className={cn(
          "rounded-btn rounded-l-none py-1.5 pl-0.5 pr-1 text-graphite hover:bg-line-soft hover:text-ink",
          menuOpen && "bg-line-soft text-ink",
        )}
      >
        <ChevronDown size={11} className="opacity-70" />
      </button>

      {menuOpen && (
        <div
          role="listbox"
          aria-label="打开方式"
          className="absolute left-0 top-full z-40 mt-1.5 w-44 overflow-hidden rounded-input border border-line bg-canvas py-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
        >
          {options.map((opt) => {
            const Icon = OPEN_WITH_ICONS[opt.id] ?? FolderOpen;
            const active = opt.id === preferredId;
            return (
              <button
                key={opt.id}
                role="option"
                aria-selected={active}
                onClick={() => openWith(opt.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-body-sm transition",
                  active ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                <Icon size={14} className="shrink-0" />
                <span className={cn("flex-1", active && "font-medium")}>{opt.name}</span>
                {active && <Check size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
