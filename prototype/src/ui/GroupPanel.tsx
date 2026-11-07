import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { X, Plus, MessageSquarePlus, Maximize2, ExternalLink, ChevronDown, Zap, Columns2, Rows2, RotateCw, Trash2, History, Combine } from "lucide-react";
import { useTerminalStore, SUPPORTED_TERMINAL_PROFILES, type DropZone, type CanvasPane } from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useCanvasDnd } from "../store/canvasDnd.ts";
import { useCanvasPopouts } from "../store/useCanvasPopouts.ts";
import { dispatchTerminal } from "../adapters/daemon/client.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { terminalSessionRegistry } from "../store/TerminalSessionManager.ts";
import { deriveSessionLight, lightFlagsFromStatus, type SessionLightKind } from "../core/sessionLight.ts";
import { TerminalPaneSlot, ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { ChatPaneSlot } from "./ChatPaneSlot.tsx";
import { SessionLightDot } from "./SessionLightDot.tsx";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";

/** 悬停焦点预览的时长阈值（B，docs/32 §四.4） */
const HOVER_FOCUS_PREVIEW_MS = 300;

/**
 * 拆分某格（组栈语义：该格一分为二，新组承载新标签 —— 焦点标签是 chat → 新格
 * 开草稿对话；是终端 → 开终端）。条尾直出按钮与「选择▾」菜单共用。
 */
function splitGroupPane(groupId: string, direction: "horizontal" | "vertical"): void {
  const ts = useTerminalStore.getState();
  ts.setActiveGroup(groupId);
  const activeKind = ts.panes[ts.groups[groupId]?.activePaneId ?? ""]?.kind;
  if (activeKind === "chat") {
    ts.splitPane({ direction, chatPaneKey: useChatPanes.getState().createDraftRecord() });
    return;
  }
  ts.splitPane({ direction, cwd: useWorkbench.getState().units.find((u) => u.id === useWorkbench.getState().activeUnitId)?.rootPath });
}

/**
 * 分屏格 = 标签组（docs/32 组栈模型）—— 每个格子自带标签条；窗格（终端/
 * 对话）是组栈里的标签，**全部常驻挂载**（A1：仅激活标签可见，display:none +
 * inert 切换，切标签零 remount、xterm/对话状态零迁移）。
 *
 * 拖拽语义（§四）：拖标签经组标签条 = 插入指示（组内重排 / 跨组移动，条上
 * 永不产生分屏）；落到 body 走五向吸附（中央 80% 内圈 = 入栈并激活，四边 =
 * 分出新组）；悬停 ≥300ms 该格获得焦点预览。关标签按 MRU 恢复（A2，store
 * 内 nextActiveAfterClose）。非焦点格内容 dim（A3）。
 */
export function GroupPanel({ groupId }: { groupId: string }) {
  const group = useTerminalStore((s) => s.groups[groupId]);
  const panes = useTerminalStore((s) => s.panes);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const chatPanes = useChatPanes((s) => s.panes);
  const units = useWorkbench((s) => s.units);
  const draggingPaneId = useCanvasDnd((s) => s.draggingPaneId);

  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const [tabMenu, setTabMenu] = useState<QuickMenuState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFocused = activeGroupId === groupId;

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  /** chat 标签显示名：bot 名 · 对话（响应式：注册表/units 变化即刷） */
  const paneTitle = useCallback(
    (pane: CanvasPane): string => {
      if (pane.kind !== "chat") return pane.title;
      const record = chatPanes[pane.id];
      if (record === undefined || record.unitId === "") return "新对话";
      const unitName = units.find((u) => u.id === record.unitId)?.name;
      return `${unitName ?? "对话"} · 对话`;
    },
    [chatPanes, units],
  );

  /* ---- 五向 zone 几何（对齐 orca tab-drop-zone.ts 口径） ---- */
  const resolveZone = useCallback((e: DragEvent<HTMLElement>): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(1, rect.width);
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    // 中央 80% 内圈 = 入栈（center merge zone）
    if (x > 0.1 && x < 0.9 && y > 0.1 && y < 0.9) return "center";
    // 左右各 1/3 宽 = 水平分屏；中 1/3 按上下半 = 垂直分屏
    if (x < 1 / 3) return "left";
    if (x > 2 / 3) return "right";
    return y < 0.5 ? "top" : "bottom";
  }, []);

  const onBodyDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (draggingPaneId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const z = resolveZone(e);
      if (z !== zone) setZone(z);
      // 悬停焦点预览（B）：停在同一格 ≥300ms → 该格成为焦点格（看清落点
      // 上下文）；取消拖拽无需回滚——组激活本身无害
      if (!isFocused && hoverTimer.current === null) {
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          useTerminalStore.getState().setActiveGroup(groupId);
        }, HOVER_FOCUS_PREVIEW_MS);
      }
    },
    [draggingPaneId, groupId, isFocused, resolveZone, zone],
  );

  const clearHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const onBodyDragLeave = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setZone(null);
      clearHover();
    },
    [clearHover],
  );

  const onBodyDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dragId = useCanvasDnd.getState().draggingPaneId;
      setZone(null);
      clearHover();
      if (dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      useCanvasDnd.getState().endDrag();
      useTerminalStore.getState().dropPaneOnGroup(dragId, groupId, resolveZone(e));
    },
    [clearHover, groupId, resolveZone],
  );

  /** 标签条 onDrop（插入重排/跨组移动）——条与标签共用 */
  const onStripDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dragId = useCanvasDnd.getState().draggingPaneId;
      setDropIndex(null);
      if (dragId === null || dropIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      useCanvasDnd.getState().endDrag();
      useTerminalStore.getState().movePaneToGroup(dragId, groupId, dropIndex);
    },
    [dropIndex, groupId],
  );

  if (group === undefined) return null;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas transition-opacity",
        isFocused ? "opacity-100" : "opacity-75", // A3：非焦点格 dim
      )}
      onPointerDown={() => {
        if (!isFocused) useTerminalStore.getState().setActiveGroup(groupId);
      }}
    >
      {/* 组标签条 —— 本格的标签栈；拖拽插入指示在这里，永不产生分屏 */}
      <div
        className="flex h-8 shrink-0 select-none items-stretch gap-0.5 border-b border-line/40 bg-rail px-1"
        onDragOver={(e) => {
          const dragId = useCanvasDnd.getState().draggingPaneId;
          if (dragId === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={onStripDrop}
      >
        {group.tabOrder.map((paneId, i) => {
          const pane = panes[paneId];
          if (pane === undefined) return null;
          const isActive = group.activePaneId === paneId;
          const isDragging = draggingPaneId === paneId;
          const title = paneTitle(pane);
          return (
            <div key={paneId} className="flex shrink-0 items-stretch">
              {dropIndex === i && <div className="my-1.5 w-0.5 shrink-0 rounded-full bg-teal shadow-sm" />}
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", paneId);
                  useCanvasDnd.getState().startDrag(paneId);
                }}
                onDragEnd={() => {
                  useCanvasDnd.getState().endDrag();
                  setDropIndex(null);
                }}
                onDragOver={(e) => {
                  const dragId = useCanvasDnd.getState().draggingPaneId;
                  if (dragId === null || dragId === paneId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropIndex(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
                }}
                onDrop={onStripDrop}
                onClick={() => useTerminalStore.getState().activatePane(paneId)}
                onAuxClick={(e) => {
                  // 中键关闭（浏览器标签习惯）
                  if (e.button === 1) useTerminalStore.getState().closePane(paneId);
                }}
                onContextMenu={(e) =>
                  setTabMenu(
                    quickMenuFromEvent(e, [
                      {
                        label: "关闭",
                        icon: X,
                        onSelect: () => useTerminalStore.getState().closePane(paneId),
                      },
                      {
                        label: "关闭其它（本格）",
                        icon: X,
                        disabled: group.tabOrder.length <= 1,
                        onSelect: () => useTerminalStore.getState().closeOtherPanes(paneId),
                      },
                      {
                        label: "关闭整格",
                        icon: X,
                        onSelect: () => useTerminalStore.getState().closeGroup(groupId),
                      },
                      {
                        label: "弹出为独立窗口",
                        icon: ExternalLink,
                        onSelect: () => useCanvasPopouts.getState().popoutPane(paneId),
                      },
                    ]),
                  )
                }
                title={title}
                className={cn(
                  "group/tab relative m-0.5 flex min-w-0 max-w-[190px] cursor-pointer select-none items-center gap-1.5 rounded px-2 font-mono text-caption transition",
                  isActive
                    ? "bg-canvas text-ink font-medium shadow-sm border border-line/60"
                    : "text-ash/80 hover:bg-line-soft hover:text-ink",
                  isDragging && "opacity-40",
                )}
              >
                {pane.kind === "chat" ? (
                  <MessageSquarePlus size={12} className="shrink-0 text-teal" />
                ) : (
                  <ShellOrAgentIcon icon={pane.icon ?? "pwsh"} />
                )}
                {/* chat 标签的状态灯（chat 的「最小化」形态）：会话在别的标签/
                    格子后台跑着，状态从标签上直接读 —— 转圈=运行中 / 黄=等你
                    交互 / 红=异常；完成未读的绿灯只在侧栏（那里才有严格已读口径） */}
                {pane.kind === "chat" && <ChatTabLight paneId={pane.id} />}
                <span className="truncate">{title}</span>
                {paneId.startsWith("autoterm_") && (
                  <span
                    title="派发终端 —— 经过派发系统，会记入该 bot 的历史会话"
                    className="shrink-0 rounded bg-violet-500/15 px-1 py-0.2 text-[9px] font-semibold text-violet-400 font-sans"
                  >
                    派发
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    useTerminalStore.getState().closePane(paneId);
                  }}
                  title={pane.kind === "chat" ? "关闭标签（不杀会话，历史可回）" : "关闭标签（杀终端进程）"}
                  aria-label={`关闭标签 ${title}`}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded p-0.5 text-ash transition",
                    "hover:bg-line-soft hover:text-rose-400",
                    isActive ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-80",
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          );
        })}
        {/* 拖到条尾的插入指示 */}
        {dropIndex === group.tabOrder.length && (
          <div className="my-1.5 w-0.5 shrink-0 self-center rounded-full bg-teal shadow-sm" />
        )}

        {/* 条尾新建组（docs/32 → 2026-11 调整）：新建对话 / 新建终端 / 选择▾（全菜单）
            —— 原顶栏的左侧新建区整体退役，新建能力归属每个格子的标签尾部（IDE 惯例：
            标签在哪，＋就在哪）；工具条只剩图标化的拆分/最大化等全局动作 */}
        <GroupCreateBar groupId={groupId} />

        {/* 条尾右端：本格动作组（原画布顶栏 2026-11 整行退役，动作下沉到每格 ——
            语义更准：全部作用于**本格**的激活标签，而非全局聚焦） */}
        <GroupTailActions groupId={groupId} />
      </div>

      {/* 窗格层：全部标签常驻挂载（A1），仅激活可见；五向吸附落点也在这一层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
      >
        {group.tabOrder.map((paneId) => {
          const pane = panes[paneId];
          if (pane === undefined) return null;
          const visible = group.activePaneId === paneId;
          return (
            <div
              key={paneId}
              className={cn("absolute inset-0 flex-col", visible ? "flex" : "hidden")}
              // inert：隐藏窗格不参与焦点与无障碍树（对齐 orca display:none+inert）
              {...(visible ? {} : { inert: true })}
              aria-hidden={!visible}
            >
              {pane.kind === "chat" ? (
                <ChatPaneSlot paneKey={paneId} />
              ) : (
                <TerminalPaneSlot pane={pane} />
              )}
            </div>
          );
        })}

        {/* 五向吸附高亮：center=整框内圈（入栈），四边=半幅（分新组） */}
        {draggingPaneId !== null && zone !== null && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {zone === "center" ? (
              <div className="absolute inset-[10%] rounded-panel bg-teal/10 ring-2 ring-teal/50 ring-inset" />
            ) : (
              <div
                className={cn(
                  "absolute bg-teal/15 ring-2 ring-teal/60 ring-inset transition-all duration-75",
                  zone === "left" && "inset-y-0 left-0 w-1/2",
                  zone === "right" && "inset-y-0 right-0 w-1/2",
                  zone === "top" && "inset-x-0 top-0 h-1/2",
                  zone === "bottom" && "inset-x-0 bottom-0 h-1/2",
                )}
              />
            )}
          </div>
        )}
      </div>
      <QuickContextMenu menu={tabMenu} onClose={() => setTabMenu(null)} />
    </div>
  );
}

/* ------------------------------------------------------------- 条尾动作组 */

/**
 * 格子标签条右端的动作组（原画布顶栏退役后下沉）：按**本格激活标签**的种类出钮 ——
 * chat（已选 bot）→ 新对话 / 历史；终端 → 清屏 / 重启；拆分右/下（桌面端）与
 * 最大化（原格已有）恒在。全部图标钮（h-5 w-5），title 悬停说明。
 */
function GroupTailActions({ groupId }: { groupId: string }) {
  const { isMobile } = useIsMobile();
  // 跨 store 订阅拆成原始值链（selector 只依赖自己 store 的状态，异 store 的
  // getState 在 selector 里读了也不会触发重算 —— 草稿格选完 bot 按钮不出现的坑）：
  // 终端 store 出 activePaneId → chat store 出 unitId → workbench 出 unit 元素
  const activePaneIdOfGroup = useTerminalStore((s) => s.groups[groupId]?.activePaneId ?? null);
  const group = useTerminalStore((s) => s.groups[groupId]);
  const activePane = useTerminalStore((s) => (activePaneIdOfGroup === null ? undefined : s.panes[activePaneIdOfGroup]));
  const chatUnitId = useChatPanes((s) => (activePaneIdOfGroup === null ? "" : (s.panes[activePaneIdOfGroup]?.unitId ?? "")));
  const chatUnit = useWorkbench((s) => (chatUnitId === "" ? undefined : s.units.find((u) => u.id === chatUnitId)));
  if (group === undefined) return null;
  const isChat = activePane?.kind === "chat";

  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-0.5">
      {/* chat 动作：本格激活标签是对话且已选 bot */}
      {isChat && activePane !== undefined && chatUnit !== undefined && (
        <>
          <button
            type="button"
            onClick={() => useChatPanes.getState().openChatPane({ unitId: chatUnit.id, sessionId: null })}
            title={`给 ${chatUnit.name} 新开一个对话标签（草稿）`}
            aria-label="新对话"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-line-soft hover:text-ink"
          >
            <MessageSquarePlus size={11} />
          </button>
          <button
            type="button"
            onClick={() => useSidePane.getState().openTab({ unitId: chatUnit.id, unitName: chatUnit.name })}
            title="在右侧面板打开这个 bot 的历史会话列表"
            aria-label="历史会话"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-line-soft hover:text-ink"
          >
            <History size={11} />
          </button>
        </>
      )}

      {/* 终端动作：本格激活标签是终端 */}
      {!isChat && activePane !== undefined && (
        <>
          <button
            type="button"
            onClick={() => terminalSessionRegistry.get(activePane.id)?.clear()}
            title="清空当前窗格屏幕 (Ctrl+L 重绘)"
            aria-label="清屏"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-line-soft hover:text-ink"
          >
            <Trash2 size={11} />
          </button>
          <button
            type="button"
            onClick={() => void terminalSessionRegistry.get(activePane.id)?.restart()}
            title="重启当前终端进程"
            aria-label="重启终端"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-teal-tint hover:text-teal"
          >
            <RotateCw size={11} />
          </button>
        </>
      )}

      {/* 拆分（桌面端）：拆的是本格 */}
      {!isMobile && (
        <>
          <button
            type="button"
            onClick={() => splitGroupPane(groupId, "horizontal")}
            title="向右拆分当前格：新格承载新标签"
            aria-label="向右拆分当前格"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-line-soft hover:text-ink"
          >
            <Columns2 size={11} />
          </button>
          <button
            type="button"
            onClick={() => splitGroupPane(groupId, "vertical")}
            title="向下拆分当前格：新格承载新标签"
            aria-label="向下拆分当前格"
            className="flex h-5 w-5 items-center justify-center rounded text-ash transition hover:bg-line-soft hover:text-ink"
          >
            <Rows2 size={11} />
          </button>
        </>
      )}

      {/* 窗格级最大化（双 kind 通用）：本格激活标签整幅显示（还原入口在最大化态浮动钮） */}
      <button
        type="button"
        onClick={() => {
          const paneId = group.activePaneId;
          if (paneId !== null) useTerminalStore.getState().toggleMaximize(paneId);
        }}
        title="最大化当前标签（整格全幅显示）"
        aria-label="最大化当前标签"
        className="rounded p-0.5 text-ash hover:bg-line-soft hover:text-ink transition"
      >
        <Maximize2 size={11} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- chat 标签灯 */

/**
 * chat 标签的状态灯：窄订阅（只订本标签的会话记录 + 那一个 session 的状态），
 * 任何一个会话翻转状态都不重渲染整条标签条。草稿（sessionId=null）无灯；
 * 完成未读的绿灯不进标签（已确认口径：侧栏历史行才有严格的已读语义）；
 * 也不受理右键消灯覆盖 —— 标签灯是纯状态读数（图例的控制权卡片已注明）。
 */
function ChatTabLight({ paneId }: { paneId: string }) {
  const sessionId = useChatPanes((s) => s.panes[paneId]?.sessionId ?? null);
  const status = useWorkbench((s) =>
    sessionId === null ? undefined : s.sessions.find((x) => String(x.id) === sessionId)?.status,
  );
  if (sessionId === null || status === undefined) return null;
  const flags = lightFlagsFromStatus(status);
  const kind: SessionLightKind = deriveSessionLight({ ...flags, unread: false });
  if (kind === "none" || kind === "unreadDone") return null;
  return <SessionLightDot kind={kind} size="md" />;
}

/* ------------------------------------------------------------- 组内新建 */

/**
 * 条尾新建组：新建对话 | 新建终端 | 选择▾（对话 / Agent CLI 派发 / 系统 Shell / 拆分本格）。
 * 顶栏左侧新建区退役后的唯一新建入口 —— 标签在哪，＋就在哪（每格一份，组内直开、
 * 不跨格）。三个都是图标钮（h-6 w-6），下拉沿用原顶栏菜单结构。
 */
function GroupCreateBar({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const runtimes = useWorkbench((s) => s.runtimes);
  const popoutCount = useCanvasPopouts((s) => s.entries.length);
  // ⚠️ 派生数组绝不能放 selector 里（s.runtimes.filter(...)）：filter 每次返回新
  // 引用，useSyncExternalStore 的 Object.is 快照比较恒不等 → forceStoreRerender
  // 循环 → Maximum update depth exceeded（实测：新建对话即触发）。先选稳定引用，
  // useMemo 派生 —— 原 TerminalPanel 的写法就是这么防的。
  const executorOptions = useMemo(() => runtimes.filter((r) => !r.testOnly), [runtimes]);
  const defaultProfileId = useTerminalStore((s) => s.defaultProfileId);

  const newChat = (): void => {
    const chat = useChatPanes.getState();
    if (unit !== undefined) {
      chat.openChatPane({ unitId: unit.id, sessionId: null });
      return;
    }
    // 无 bot：开「未选 bot」草稿（窗格内嵌选择器）
    useTerminalStore.getState().createChatTab(chat.createDraftRecord());
  };
  const newTerminal = (): void => {
    useTerminalStore.getState().createTab({ profileId: defaultProfileId, cwd: unit?.rootPath });
  };
  /** Agent CLI：全部走派发系统（记历史、免审批、标签带「派发」徽章）；无 bot 退回手动开 */
  const launchExecutor = (execId: string, displayName: string): void => {
    const bareId = execId.replace(/^daemon:/, "").replace(/:yolo$/, "");
    if (unit && bareId !== "") {
      void dispatchTerminal({ unitId: unit.id, unitName: unit.name, rootPath: unit.rootPath, runtimeId: bareId }).catch((err: unknown) => {
        console.error("[GroupPanel] 派发终端失败，退回手动:", err);
        useTerminalStore.getState().createTab({
          profileId: "pwsh",
          cwd: unit.rootPath,
          executorId: bareId,
          unitId: unit.id,
          title: `${unit.name} · ${displayName} (TUI)`,
        });
      });
      return;
    }
    useTerminalStore.getState().createTab({ profileId: "pwsh", cwd: unit?.rootPath, executorId: bareId, title: `${displayName} (TUI)` });
  };
  /** 拆本格（组栈语义：本格一分为二，新格承载新标签）—— 模块级实现，条尾按钮共用 */
  const splitGroup = (direction: "horizontal" | "vertical"): void => splitGroupPane(groupId, direction);

  return (
    <div className="relative flex shrink-0 items-center gap-0.5 pl-0.5">
      <button
        type="button"
        onClick={newChat}
        title={unit ? `新建对话（${unit.name}，新草稿）` : "新建对话（先选 bot）"}
        aria-label="新建对话"
        className="flex h-6 w-6 items-center justify-center rounded text-ash hover:bg-line-soft hover:text-teal transition"
      >
        <MessageSquarePlus size={12} />
      </button>
      <button
        type="button"
        onClick={newTerminal}
        title="新建终端（默认 Shell，新标签进本格）"
        aria-label="新建终端"
        className="flex h-6 w-6 items-center justify-center rounded text-ash hover:bg-line-soft hover:text-teal transition"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="选择要打开的：对话 / Agent CLI（派发）/ 系统 Shell / 拆分本格"
        aria-label="选择对话或终端"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded text-ash/80 hover:bg-line-soft hover:text-ink transition"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 max-h-[480px] min-w-[260px] overflow-y-auto rounded-panel border border-line bg-card p-1.5 shadow-2xl scrollbar-thin">
            {/* 分组 0：对话 */}
            <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal/80">
              <MessageSquarePlus size={11} />
              <span>对话</span>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                newChat();
              }}
              className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint"
            >
              <MessageSquarePlus size={13} className="shrink-0 text-teal" />
              <span className="flex-1 truncate font-mono text-caption font-medium">
                {unit ? `与 ${unit.name} 对话` : "新对话（先选 bot）"}
              </span>
              <span className="shrink-0 rounded bg-line-soft px-1 py-0.2 font-sans text-[9px] text-ash">结构化时间线</span>
            </button>
            <div className="my-1.5 h-px shrink-0 bg-line/50" />

            {/* 分组 1：Agent 执行器（全部经派发系统打开） */}
            <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal/80">
              <Zap size={11} />
              <span>Agent CLI (TUI · 派发)</span>
              <span className="ml-auto font-sans text-[9px] normal-case tracking-normal text-ash/50">记入历史</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {executorOptions.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setOpen(false);
                    launchExecutor(r.id, r.presentation.displayName);
                  }}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint"
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
                  onClick={() => {
                    setOpen(false);
                    useTerminalStore.getState().createTab({ profileId: profile.id, cwd: unit?.rootPath });
                  }}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal active:bg-teal-tint"
                >
                  <ShellOrAgentIcon icon={profile.icon} />
                  <span className="flex-1 truncate font-mono text-caption">{profile.name}</span>
                  {profile.id === defaultProfileId && (
                    <span className="shrink-0 rounded bg-teal/10 px-1 py-0.2 font-sans text-[9px] text-teal/80">默认</span>
                  )}
                </button>
              ))}
            </div>

            {/* 分组 3：拆分本格 */}
            <div className="my-1.5 h-px shrink-0 bg-line/50" />
            <button
              onClick={() => {
                setOpen(false);
                splitGroup("horizontal");
              }}
              className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal"
            >
              <Columns2 size={13} className="text-teal" />
              <span className="font-mono text-caption">向右拆分当前格 (Split Right)</span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                splitGroup("vertical");
              }}
              className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-ink transition hover:bg-teal-tint hover:text-teal"
            >
              <Rows2 size={13} className="text-teal" />
              <span className="font-mono text-caption">向下拆分当前格 (Split Down)</span>
            </button>

            {/* 归拢弹出窗口（全局动作；原顶栏按钮退役后收进菜单 —— 罕见动作不占条内空间） */}
            {popoutCount > 0 && (
              <>
                <div className="my-1.5 h-px shrink-0 bg-line/50" />
                <button
                  onClick={() => {
                    setOpen(false);
                    useCanvasPopouts.getState().recallAll();
                  }}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-body-sm text-teal transition hover:bg-teal-tint"
                >
                  <Combine size={13} />
                  <span className="font-mono text-caption">归拢 {popoutCount} 个弹出窗口回标签栏</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
