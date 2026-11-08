import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDot,
  Clock,
  EyeOff,
  FolderGit2,
  FolderPlus,
  GitBranch,
  History,
  ImagePlus,
  Inbox,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Radio,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Share2,
  SquareTerminal,
  X,
} from "lucide-react";
import { useWorkbench, type ViewMode, type BotWriteGuards } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useGit } from "../store/useGit.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { deriveSessionLight, lightFlagsFromStatus, type SessionLightKind } from "../core/sessionLight.ts";
import { SessionLightDot } from "./SessionLightDot.tsx";
import { BrandLogo } from "./BrandLogo.tsx";
import { detectQuestionnaireFromTimeline } from "./chat/items/QuestionnaireCard.tsx";
import type { AvatarFrame } from "../core/appearance.ts";
import { describeRule, formatAbsolute, formatAbsoluteHuman, formatRelative, type Automation } from "../core/automation.ts";
import { DaemonClient, defaultDaemonEndpoint, dispatchTerminal, exportSession, renameHistoryEntry, type UnitHistoryEntry } from "../adapters/daemon/client.ts";
import { saveTextFile, sanitizeFileName } from "./fileSave.ts";
import { hasUnseenUpdates, useExecutorUpdates } from "../store/useExecutorUpdates.ts";
import {
  asModelId,
  asRuntimeId,
  asSessionId,
  asUnitId,
  type UnitId,
  type WorkUnit,
  isProjectUnit,
  isResidentUnit,
  isSyntheticUnit,
  normalizeContextManifest,
  orderUnitsLikeSidebar,
  reorderUnitIds,
  SESSION_SOURCE_LABEL,
  type SessionSource,
} from "../core/units.ts";

export { isResidentUnit, isSyntheticUnit };

import { UNIT_VIEWS, UnitViewSegment } from "./UnitViewSegment.tsx";
import { ChannelMark, channelIdentityLabel } from "./ChannelMark.tsx";
import { resumeArgsFor } from "./HistoryPane.tsx";
import { collapseForkVersions } from "./forkHistory.ts";
import { executorIconSrc } from "./executorIcon.ts";
import { entryKeys, useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useSidebarSelection } from "../store/useSidebarSelection.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useChatPanes } from "../store/useChatPanes.ts";
import { EMPTY_HISTORY_ENTRY, useUnitHistory } from "../store/useUnitHistory.ts";
import { openNewTuiForUnit as sessionOpenOpenNewTui } from "../store/sessionOpen.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";
import { cn } from "./cn.ts";

/**
 * 左侧栏 —— 对齐 ZCode 的 `WorkspaceSidebar` 完整功能集。
 *
 * ## 两条原则，不是冲突的两条
 *
 * 1. **功能不能因为「当前为空」就消失。**
 *    ZCode 里每一项都有对应的 message id，说明它们都是常驻能力：
 *
 *      projectsSection / addProject / noProjects
 *      conversationsSection / newConversation / noConversations
 *      organize / organizeGrouped / viewByWorkspace / organizeChronologicalList
 *      sortBy / sortByUpdated / sortByCreated
 *      toggleArchivedTasks / reorderSection / unavailableLocalDirectory
 *
 *    之前我把这些做成了「有数据才渲染」，于是新增功能在页面上根本看不见。
 *
 *    ⚠ 2026-10-02：任务分组（taskGroup）已从这条清单里**删掉**。
 *    它当时是纯 UI 壳——按钮无 onClick、无 store 状态、无过滤逻辑，
 *    样例数组从没被 import。留着它只是让「常驻可见」这条原则被架空成形式主义。
 *    真要做分组时，数据模型和渲染层一起加回来。
 *
 * 2. **但「不消失」不等于「永久占版面」**（渐进披露，第二批引入）。
 *    区分标准只有一条 —— **用户多久会用到它**：
 *      - 高频（工作单元切换、新建任务）→ 常驻可见；
 *      - 低频偏好（组织方式、排序）→ 收进浮层，当前值带在 title / 折叠行里；
 *      - 低频导航（搜索、出图、自动化）→ 去掉文字留图标，不藏进浮层。
 *
 *    判据是「多久用一次」，不是「功能重不重要」。自动化很重要，
 *    但没人一天点八次自动化 —— 重要性决定它**不能消失**，不决定它要**占多大版面**。
 */

/**
 * `[bot|项目]` 双视图分段器（docs/04「切换器收在分区行」；ADR 0011 复活为过滤器式）。
 * 组件与视图表移至 UnitViewSegment.tsx（单元切换器弹层共用）。同一批 WorkUnit、
 * 两种消费视图：项目 tab 只显示手动标注 `kind === "project"` 的单元，bot tab 显示
 * 其余（kind 缺省按 bot 算）；常驻节归 bot tab。只过滤列表，不碰 activeUnitId。
 */

/** 分段器选择持久化键 —— 命名风格同 `agent-workbench:active-unit` */
const UNIT_VIEW_KEY = "agent-workbench:unit-view";

/** localStorage 不可用（隐私模式等）时降级为会话内记忆，默认 bot 视图（数字 bot 是默认态） */
function readPersistedUnitView(): ViewMode {
  try {
    return localStorage.getItem(UNIT_VIEW_KEY) === "project" ? "project" : "bot";
  } catch {
    return "bot";
  }
}

/* ------------------------------------------- 历史子列表的预取节奏（orca 同款参数） */

/** daemon 连上、bot 列表就绪后多久开始空闲预热（让启动期那一波 RPC 先过去） */
const HISTORY_WARM_DELAY_MS = 2000;
/** 悬停驻留多久才算「有意图」：指针扫过一排 bot 时不逐个发请求 */
const HISTORY_HOVER_DWELL_MS = 120;
/** 展开时缓存新于这个窗口就不重拉（悬停预取刚落地）；更旧的先显示、后台校准 */
const HISTORY_EXPAND_FRESH_MS = 5000;
/** 无缓存时「加载中」延迟出现：快响应不闪 */
const HISTORY_LOADING_DELAY_MS = 200;
/** 待触发行的数据（useWorkbench.automations）在这个窗口内刷过就不再刷 */
const SCHED_REFRESH_FRESH_MS = 15_000;

/**
 * 待触发行（docs/23）的数据刷新：多个展开行共用 useWorkbench.automations 一份数据，
 * 在途合并 + 节流 —— 此前每个展开行各自拉全量 automation.list 并每 30s 轮询一次，
 * 且首开时这些行要等那次 RPC 才在列表顶部跳出来。
 */
let schedRefreshInflight: Promise<void> | null = null;
let schedRefreshedAt = 0;
function refreshScheduledTasks(maxAgeMs: number): void {
  if (schedRefreshInflight !== null || Date.now() - schedRefreshedAt < maxAgeMs) return;
  const job = useWorkbench
    .getState()
    .refreshAutomations()
    .finally(() => {
      schedRefreshedAt = Date.now();
      schedRefreshInflight = null;
    });
  // refreshAutomations 的动态 import 在 try 外，chunk 加载失败会拒绝（review P3）：
  // 状态在 finally 里已复位，这里吞掉，别让它变成 unhandled rejection
  schedRefreshInflight = job.catch(() => undefined) as Promise<void>;
}

/** 收起行的待触发数据：常量引用（收起的行不随 automations 刷新重渲染） */
const NO_AUTOMATIONS: readonly Automation[] = [];


export function Sidebar() {
  const units = useWorkbench((s) => s.units);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  // 多选模式的 Esc 出口：有选择集时按 Esc 只清选择，不冒泡去触发别的 Esc 行为。
  // 目标是可编辑元素时让行——重命名输入框的 Esc 取消优先于清选择（否则第一次
  // Esc 被这里吃掉，重命名取消要按两次）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      const t = ev.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")
      ) {
        return;
      }
      if (useSidebarSelection.getState().selected.size > 0) {
        ev.stopPropagation();
        useSidebarSelection.getState().clear();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  /** [bot|项目] 视图过滤（过滤器式，见 UNIT_VIEWS 注释）：本地 state 即可，无需 store 层改动 */
  const [unitView, setUnitView] = useState<ViewMode>(readPersistedUnitView);
  const switchUnitView = (v: ViewMode): void => {
    setUnitView(v);
    try {
      localStorage.setItem(UNIT_VIEW_KEY, v);
    } catch {
      // 读不到的存储环境写也会抛 —— 过滤本身不依赖持久化成功
    }
  };
  /** 历史子列表展开集合：每个 bot 独立展开，再次点击才收起（不再互斥自动关上） */
  const [openHistoryUnits, setOpenHistoryUnits] = useState<Set<string>>(() => new Set());
  const toggleHistoryUnit = (id: string) => {
    setOpenHistoryUnits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---- 闲时托管任务的观察性（打勾门配套）------------------------------------
  //
  // 打勾任务派发出来的是 source=automation 的后台会话，用户不在场也可能在跑。
  // 要求：会话一开跑，所属 bot 的历史子列表自动展开（看得见）；bot 行亮脉动蓝点
  // （子列表收起也看得见）。只做一次性展开 —— 用户手动收起后不追着弹开。

  /** 每个 unit 只自动展开一次（本次 Sidebar 生命周期内），之后的开合全归用户 */
  const autoExpandedUnits = useRef<Set<string>>(new Set());
  const expandUnitHistoryOnce = (unitId: string): void => {
    if (unitId === "" || autoExpandedUnits.current.has(unitId)) return;
    autoExpandedUnits.current.add(unitId);
    setOpenHistoryUnits((prev) => {
      if (prev.has(unitId)) return prev;
      const next = new Set(prev);
      next.add(unitId);
      return next;
    });
  };

  /** 托管会话启动（autopilot/心跳派发）→ 展开所属 bot 的历史 */
  useEffect(() => {
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const unsub = client.onEvent((e) => {
      if (e.type !== "session.started" || e.source !== "automation") return;
      expandUnitHistoryOnce(String(e.unitId));
    });
    return unsub;
  }, []);

  /** 应用打开时已经在跑的任务（app 没开着时被派发的场景）也展开 */
  const backlogItems = useBacklog((s) => s.items);
  useEffect(() => {
    for (const item of backlogItems) {
      if (item.status === "executing") expandUnitHistoryOnce(item.unitId);
    }
  }, [backlogItems]);

  const addUnit = useWorkbench((s) => s.addUnit);
  const mainView = useShell((s) => s.mainView);

  /** 普通节拖拽排序：store 持有（单元切换器弹层共享同一份顺序，两侧同序） */
  const unitOrder = useWorkbench((s) => s.unitOrder);
  const setUnitOrder = useWorkbench((s) => s.setUnitOrder);
  /** 常驻节拖拽排序：同一条共享链路（localStorage 持久化，重启后顺序还在） */
  const residentOrder = useWorkbench((s) => s.residentOrder);
  const setResidentOrder = useWorkbench((s) => s.setResidentOrder);
  const [dragUnit, setDragUnit] = useState<string | null>(null);
  /** 拖拽悬停的分区（常驻/普通）——drop zone 高亮用 */
  const [zoneHover, setZoneHover] = useState<"resident" | "normal" | null>(null);
  // 新建 bot 与 bot 设置均已归拢右栏面板（2026-10-23）：＋/空态开「新建 bot」tab，齿轮开「bot 设置」tab
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const settingsActive = useShell((s) => s.settingsOpen);
  // 执行器新版本红点（docs/27）：启动检测一次，落后未消隐即亮；进「执行器与模型」分区即消隐
  const updatesReport = useExecutorUpdates((s) => s.report);
  const updatesDismissed = useExecutorUpdates((s) => s.dismissed);
  const updatesDot = hasUnseenUpdates(updatesReport, updatesDismissed);

  const allUnits = units;

  // 视图过滤（ADR 0011）：项目 tab 只看 kind === "project"，bot tab 看其余（含 kind 缺省）
  const visibleUnits = useMemo(
    () =>
      unitView === "project"
        ? allUnits.filter((u) => isProjectUnit(u))
        : allUnits.filter((u) => !isProjectUnit(u)),
    [allUnits, unitView],
  );
  const activeView = UNIT_VIEWS.find((v) => v.id === unitView) ?? UNIT_VIEWS[0]!;

  // 侧栏分支标记的自愈轮询：冷启动时 UnitRow 挂载可能早于 daemon WS 就绪，
  // 首次拉取静默失败 —— 每 60s 补一轮（TTL 内的单元不会重复起 git 进程）
  useEffect(() => {
    const timer = setInterval(() => {
      for (const u of useWorkbench.getState().units) void useGit.getState().refreshBranchBadge(u.rootPath);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // 常驻 / 普通两节（排序逻辑在 core/units.ts 的 orderUnitsLikeSidebar，
  // 单元切换器弹层用同一函数）：常驻节天然归 bot tab（常驻的是服务型 bot）
  const { residentUnits, normalUnits } = useMemo(
    () => orderUnitsLikeSidebar(visibleUnits, unitOrder, residentOrder),
    [visibleUnits, unitOrder, residentOrder],
  );

  // 历史子列表空闲预热（orca「展开只翻 UI 态」）：daemon 连上、bot 列表就绪后，按
  // 侧栏显示顺序把各 bot 的历史逐个拉进缓存（单并发、浏览器空闲时取下一条，调度在
  // useUnitHistory）—— 首次展开就是纯 UI 翻转。切 [bot|项目] 视图 / 拖拽换序时对
  // 新的可见集同样入队，已新鲜的自动跳过
  const daemonStatus = useWorkbench((s) => s.daemonStatus);
  const historyWarmKey = useMemo(
    () => [...residentUnits, ...normalUnits].map((u) => String(u.id)).join("\n"),
    [residentUnits, normalUnits],
  );
  useEffect(() => {
    if (daemonStatus !== "connected" || historyWarmKey === "") return;
    const timer = setTimeout(() => useUnitHistory.getState().warm(historyWarmKey.split("\n")), HISTORY_WARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [daemonStatus, historyWarmKey]);

  /** 拖进常驻区：普通 bot 升为常驻（resident 写穿 bot.json，冲突由 updateUnit 回滚并抛） */
  const makeResident = (u: WorkUnit): void => {
    void updateUnit({ ...u, resident: true }, guardsOf(u)).catch((err: unknown) =>
      console.warn("[Sidebar] 拖入常驻失败（盘上已被外部修改？重新进入后再试）", err),
    );
  };

  /** 移出常驻区：取消常驻（resident: false 写穿 bot.json） */
  const makeNormal = (u: WorkUnit): void => {
    void updateUnit({ ...u, resident: false }, guardsOf(u)).catch((err: unknown) =>
      console.warn("[Sidebar] 取消常驻失败（盘上已被外部修改？重新进入后再试）", err),
    );
  };

  const onDropZone = (zone: "resident" | "normal"): void => {
    const id = dragUnit;
    setZoneHover(null);
    setDragUnit(null);
    if (id === null) return;
    const u = allUnits.find((x) => x.id === id);
    if (u === undefined) return;
    if (zone === "resident" && !isResidentUnit(u)) makeResident(u);
    if (zone === "normal" && isResidentUnit(u)) makeNormal(u);
    // 普通 bot 落普通区 = 区内排序，由行级 onDrop 处理，这里不重复
  };

  return (
    <div className="aw-rail flex h-full min-h-0 flex-col bg-rail">
      {/* 顶部 48px 区域：在出图/自动化时顶掉 A 标渲染返回工作台；在正常对话时渲染 A 图标与全局独立动作。
          桌面端无边框窗口：这一行同时是左列的窗口拖拽热区（titlebar-drag） */}
      {mainView !== "chat" ? (
        <div className="titlebar-drag flex h-12 shrink-0 items-center border-b border-line/60 px-2.5">
          <button
            onClick={() => useShell.getState().setMainView("chat")}
            className="flex h-8 w-full items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 text-body-sm font-medium text-teal transition hover:bg-teal/15"
          >
            <ChevronLeft size={14} />
            <span>返回工作台</span>
          </button>
        </div>
      ) : (
        <div className="titlebar-drag flex h-12 shrink-0 items-center justify-between border-b border-line/60 px-2.5">
          {/* 侧栏开关：新品牌 icon ↔ 收起图标 hover 变形 */}
          <button
            onClick={() => useShell.getState().toggleSidebar()}
            aria-label="收起侧栏"
            title="收起侧栏 · ⌘B"
            className="group relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-btn text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            <BrandLogo
              className="h-5 w-5 rounded-sm object-cover transition-opacity duration-150 group-hover:opacity-0"
            />
            <PanelLeftClose
              size={14}
              className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
          </button>

          {/* 全局动作区：新建会话 / 搜索 / 自动化 / 出图 */}
          <div className="flex items-center gap-0.5">
            <IconNavBtn
              icon={Search}
              label="搜索"
              hint="⌘K"
              onClick={() => useShell.getState().setCommandOpen(true)}
            />
            <IconNavBtn
              icon={AlarmClock}
              label="自动化"
              onClick={() => useShell.getState().setMainView("automations")}
            />
            <IconNavBtn
              icon={Inbox}
              label="清单"
              hint="左清单 · 右待办"
              onClick={() => useShell.getState().setMainView("backlog")}
            />
            <IconNavBtn
              icon={ImagePlus}
              label="出图"
              onClick={() => useShell.getState().setMainView("image")}
            />
            <IconNavBtn
              icon={Settings}
              label="设置"
              hint="⌘,"
              active={settingsActive}
              dot={updatesDot}
              onClick={() => useShell.getState().openSettings()}
            />
          </div>
        </div>
      )}

      {/* 单元列表标题行 —— h-9 与右侧终端工具栏同高，横向对齐。
          [bot|项目] 分段即标题：最左侧点击即切视图（docs/04 + ADR 0011），
          右侧只留新建。收窄时的取舍（容器查询）：先藏计数，三个按钮
          （bot/项目/新建）永不折行、永不挤压——要按的东西必须可按。
          新建＝新建＋认领单轨：指向已存在的文件夹时 daemon 只注册不搬动、
          不覆盖其中的 AGENTS.md（详见 AddBotDialog 的探测预填），
          所以不再需要第二个「认领」按钮。 */}
      <div className="@container flex h-9 shrink-0 items-center justify-between gap-1 px-2.5">
        <div className="flex shrink-0 items-center gap-1.5">
          <UnitViewSegment value={unitView} onChange={switchUnitView} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => useSidePane.getState().openNewBot()  /* 弹窗归拢：新建 bot 走右栏 */}
            aria-label="新建 bot"
            title="新建 bot —— 新文件夹自动创建；指向已有文件夹即为认领（原地注册，不动里面的文件）"
            className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink cursor-pointer"
          >
            <Plus size={11} />
            <span>新建</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* 空态引导卡 */}
        {allUnits.length === 0 && (
          <button
            onClick={() => useSidePane.getState().openNewBot()  /* 弹窗归拢：新建 bot 走右栏 */}
            className="flex w-full flex-col items-center gap-1.5 rounded-input border border-dashed border-line px-3 py-6 text-center hover:bg-line-soft"
          >
            <FolderPlus size={18} className="text-ash" />
            <span className="text-body-sm font-medium text-graphite">还没有 bot</span>
            <span className="text-caption text-ash">新建第一个 bot，从 AGENTS.md 岗位说明书开始</span>
          </button>
        )}

        {/* 项目 tab 空态：kind 是手动标注的弱标签（ADR 0011），标注入口在单元设置的「单元形态」 */}
        {unitView === "project" && visibleUnits.length === 0 && (
          <div className="rounded-input border border-dashed border-line px-3 py-6 text-center">
            <FolderGit2 size={18} className="mx-auto mb-1.5 text-ash" />
            <p className="text-body-sm font-medium text-graphite">还没有项目</p>
            <p className="mt-1 text-caption leading-relaxed text-ash">
              打开单元设置，把「单元形态」标为项目，它就会出现在这里
            </p>
          </div>
        )}

        {/* 常驻节：总管/心跳/用户拖入的后台服务型 bot。整节是「升为常驻」的 drop zone（归 bot tab） */}
        {residentUnits.length > 0 && (
          <section
            aria-label="常驻 bot"
            onDragOver={(e) => {
              e.preventDefault();
              // 「松手设为常驻」提示只给普通 bot 的升级拖拽：常驻拖常驻是区内
              // 排序（与普通节区内排序不亮提示同口径），亮提示反而误导
              const dragged = allUnits.find((x) => x.id === dragUnit);
              if (dragUnit !== null && dragged !== undefined && !isResidentUnit(dragged)) {
                setZoneHover("resident");
              } else {
                setZoneHover((z) => (z === "resident" ? null : z));
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setZoneHover((z) => (z === "resident" ? null : z));
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDropZone("resident");
            }}
            className={cn(
              "rounded-input transition-colors",
              zoneHover === "resident" && dragUnit !== null && "bg-teal-tint/50 ring-1 ring-inset ring-teal/40",
            )}
          >
            {zoneHover === "resident" && dragUnit !== null && (
              <p className="px-1.5 pb-0.5 pt-1 text-[10px] text-teal">松手设为常驻</p>
            )}
            {residentUnits.map((u) => {
              const active = u.id === activeUnitId;
              const isSynthetic = isSyntheticUnit(u);
              const unitId = u.id as UnitId;
              return (
                <div
                  key={u.id}
                  draggable
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement).closest("button, a, input, [data-no-drag]")) {
                      e.preventDefault();
                      return;
                    }
                    setDragUnit(u.id);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={() => {
                    setDragUnit(null);
                    setZoneHover(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragUnit && dragUnit !== unitId) {
                      const dragged = allUnits.find((x) => x.id === dragUnit);
                      if (dragged !== undefined && isResidentUnit(dragged)) {
                        // 常驻行落到常驻行 = 区内排序（reorderUnitIds 单源，与普通节同口径）
                        const next = reorderUnitIds(
                          residentUnits.map((x) => String(x.id)),
                          residentOrder,
                          dragUnit,
                          unitId,
                          new Set(allUnits.map((x) => String(x.id))),
                        );
                        if (next !== null) setResidentOrder(next);
                      } else {
                        // 普通 bot 落到常驻行上 = 升为常驻（落空白区走 section 的 onDropZone）
                        onDropZone("resident");
                        return;
                      }
                    }
                    setDragUnit(null);
                    setZoneHover(null);
                  }}
                  className={cn("mb-1", dragUnit === u.id && "opacity-40")}
                >
                  <UnitRow
                    unit={u}
                    active={active}
                    onOpenSettings={() => {
                    // 设置面归拢（2026-10-23）：bot 设置不再弹窗，右栏 bot 设置面板承载
                    useWorkbench.getState().selectUnit(u.id);
                    useSidePane.getState().openContext({ unitId: u.id as UnitId, unitName: u.name });
                  }}
                    onToggleResident={() => makeNormal(u)}
                    isResident={true}
                    schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                    historyOpen={openHistoryUnits.has(u.id)}
                    onToggleHistory={() => toggleHistoryUnit(u.id)}
                  />
                </div>
              );
            })}
          </section>
        )}

        {/* 分割线：常驻与普通 bot 的分界 */}
        {residentUnits.length > 0 && normalUnits.length > 0 && (
          <div className="my-2 flex items-center gap-2 px-1" aria-hidden>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {/* 普通节：既是常驻 bot 的「取消常驻」drop zone，区内行间拖拽排序照旧 */}
        <section
          aria-label={`${activeView.label} 列表`}
          onDragOver={(e) => {
            e.preventDefault();
            const dragged = allUnits.find((x) => x.id === dragUnit);
            if (dragUnit !== null && isResidentUnit(dragged) && !isSyntheticUnit(dragged)) {
              setZoneHover("normal");
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setZoneHover((z) => (z === "normal" ? null : z));
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDropZone("normal");
          }}
          className={cn(
            "min-h-16 rounded-input transition-colors",
            zoneHover === "normal" && dragUnit !== null && "bg-teal-tint/50 ring-1 ring-inset ring-teal/40",
          )}
        >
          {zoneHover === "normal" && dragUnit !== null && (
            <p className="px-1.5 pb-0.5 pt-1 text-[10px] text-teal">松手取消常驻</p>
          )}
          {normalUnits.map((u) => {
            const active = u.id === activeUnitId;
            const unitId = u.id as UnitId;
            return (
              <div
                key={u.id}
                draggable
                onDragStart={(e) => {
                  if ((e.target as HTMLElement).closest("button, a, input, [data-no-drag]")) {
                    e.preventDefault();
                    return;
                  }
                  setDragUnit(u.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                // 拖到列表空白处 / 按 Esc 取消时不会触发 drop：
                // 没有 onDragEnd 的话 dragUnit 一直留着，那一行会永久停在 opacity-40
                onDragEnd={() => {
                  setDragUnit(null);
                  setZoneHover(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragUnit && dragUnit !== unitId) {
                    const visible = normalUnits.map((x) => String(x.id));
                    if (!visible.includes(dragUnit)) {
                      // 拖的是常驻 bot：落到普通区某行上，降级为普通 bot
                      onDropZone("normal");
                      return;
                    }
                    // 区内排序：写回全量序（只写可见子集会清掉另一视图的自定义序）
                    const next = reorderUnitIds(visible, unitOrder, dragUnit, unitId, new Set(allUnits.map((x) => String(x.id))));
                    if (next !== null) setUnitOrder(next);
                  }
                  setDragUnit(null);
                  setZoneHover(null);
                }}
                className={cn("group/u mb-1", dragUnit === u.id && "opacity-40")}
              >
                <UnitRow
                  unit={u}
                  active={active}
                  onOpenSettings={() => {
                    // 设置面归拢（2026-10-23）：bot 设置不再弹窗，右栏 bot 设置面板承载
                    useWorkbench.getState().selectUnit(u.id);
                    useSidePane.getState().openContext({ unitId: u.id as UnitId, unitName: u.name });
                  }}
                  onToggleResident={() => makeResident(u)}
                  isResident={false}
                  schedule={u.schedule?.enabled ? u.schedule.description : undefined}
                  historyOpen={openHistoryUnits.has(u.id)}
                  onToggleHistory={() => toggleHistoryUnit(u.id)}
                />
              </div>
            );
          })}
        </section>
      </div>

      {/* 导入已有文件夹（docs/09 §七）已并入新建对话框（单轨）：文件夹已存在时
          daemon 原地注册、保留既有 AGENTS.md；重复注册被 root_taken 拦下。 */}
    </div>
  );
}

/**
 * 打开设置页那一刻的盘上真值 → 保存时当乐观锁基线。
 * revision 抓「另一个窗口/别的设备改过 bot.json」，agentsMd hash 抓「用户在 VS Code
 * 里改了 AGENTS.md」。两者任一不符 daemon 就拒写，由对话框让用户选谁赢。
 */
function guardsOf(u: WorkUnit): BotWriteGuards {
  return { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash, ifSoulMdHash: u.soulMdMeta?.hash };
}

/* --------------------------------------------------- 历史会话的打开与状态灯 */

/**
 * 在画布里打开一条历史会话的对话窗格（ADR 0012 resume-in-chat + docs/31）。
 * 侧栏子列表直点与右键菜单共用。幂等口径：按段/会话线找窗格，找到就聚焦
 * （窗格内切到那段），没有就开新标签 —— 不再有「对话/终端」视图切换。
 * unitId 由调用方传行所属 bot 而不是读 entry.unitId：后者是 daemon 的可选
 * 字段（TS 契约 unitId?），且跨单元展示的行（别的 bot 的历史折进本列表）条目
 * 归属与行归属可以不同 —— 点击语义是「在这个 bot 的语境里打开它」，行所属
 * bot 永远是确定答案。
 */
function openEntryInChat(e: UnitHistoryEntry, ownerUnitId: string): void {
  if (e.sessionId === null) return;
  const sid = e.sessionId;
  // 只要用户点开该会话，立即标为已读消除完成未读灯
  useHistoryPrefs.getState().markViewed(entryKeys(e));
  useChatPanes.getState().openChatPane({ unitId: ownerUnitId, sessionId: sid, runtimeId: e.runtimeId });
}

/**
 * 在 TUI 中重现一条历史会话（各家 --resume 口径见 HistoryPane 的 RESUME_ARGS）。
 * TUI 本身还开着（前端有它的标签）时**不发 resume** —— 直接切到那个标签；
 * 此时 resume 会双开同一原生会话（存储锁冲突），且切标签才是用户要的「回到它」。
 */
function openEntryInTui(e: UnitHistoryEntry, unit: WorkUnit): void {
  const markOpened = (): void => {
    useHistoryPrefs.getState().markViewed(entryKeys(e));
  };
  const st = useTerminalStore.getState();
  if (e.terminalId != null && e.terminalId !== "") {
    const live = st.panes[e.terminalId];
    if (live !== undefined) {
      // docs/32：activatePane = 组内激活 + 焦点组切换一步到位
      st.activatePane(live.id);
      useShell.getState().setMainView("chat");
      markOpened();
      return;
    }
  }
  const args = resumeArgsFor(e.runtimeId, e.resumeRef);
  if (args === null) return;
  const wb = useWorkbench.getState();
  // 仅在切 bot 时才 selectUnit —— 对当前 bot 点 TUI 行不该顺手清掉正在看的
  // 聊天时间线（selectUnit 会清空 timeline / activeSessionId）。
  if (String(wb.activeUnitId) !== String(unit.id)) wb.selectUnit(asUnitId(unit.id));
  void dispatchTerminal({
    unitId: unit.id,
    unitName: unit.name,
    rootPath: unit.rootPath,
    runtimeId: e.runtimeId,
    args,
    // 带着原生引用派发 —— daemon 落库后这条新运行重启也能继续「回到它」
    resumeRef: e.resumeRef,
  })
    .then(() => {
      useShell.getState().setMainView("chat");
      markOpened();
    })
    .catch((err: unknown) => console.error("[Sidebar] TUI 恢复失败:", err));
}

/** 在该 bot 的工作空间直接起一个绑定执行器的全新 TUI —— 单源实现在 store/sessionOpen.ts */
function openNewTuiForUnit(unit: WorkUnit): void {
  sessionOpenOpenNewTui(unit);
}

/** 给该 bot 开一个**全新草稿**对话窗格（bot 行右键「新建会话」——每次都是新的） */
function openNewChatForUnit(unit: WorkUnit): void {
  useChatPanes.getState().openChatPane({ unitId: unit.id, sessionId: null });
}

/** 状态灯的五种形态 —— 态集与判定优先级在 core/sessionLight.ts 单源（2026-11-06 注意力提纯重构） */
type HistoryLight = SessionLightKind;

/**
 * 历史行灯判定：把行级事实（台账 status、store 实时状态、未读、决策卡在挂）
 * 折算成 core 的纯输入。五态语义见 core/sessionLight 头注释：
 * 失败=红 / 等你交互=黄 / 运行中=转圈 / 完成未读=灯色 / 存活空闲与已读已结束=无灯
 * （旧模型的存活浅蓝灯、蓝色呼吸灯已退役）。
 */
function deriveHistoryLight(
  entry: UnitHistoryEntry,
  sessionStatusById: ReadonlyMap<string, string>,
  unread: boolean,
  lightOverride?: HistoryLight | null,
  isCurrentAwaitingDecision?: boolean,
  /** 当前行即活跃会话且有轮次在飞（busy 镜像，store 登记滞后时的 running 兜底） */
  isCurrentRunning?: boolean,
): HistoryLight {
  const storeStatus = entry.sessionId !== null ? sessionStatusById.get(entry.sessionId) : undefined;
  const flags = lightFlagsFromStatus(storeStatus);
  return deriveSessionLight({
    failed: entry.status === "failed" || flags.failed,
    awaiting: isCurrentAwaitingDecision === true || flags.awaiting,
    // 台账的 running 兜底只在 store 还不认识这个会话时启用（重载后/外部端起的
    // 会话）：store 已有状态（如轮结束翻 idle）时以它为准 —— 否则侧栏 30s 才
    // 重拉一次历史，转圈会赖到下一轮轮询才灭
    running:
      flags.running ||
      isCurrentRunning === true ||
      (storeStatus === undefined && entry.status === "running" && entry.endedAt === null),
    unread,
    override: lightOverride,
  });
}

/** macOS 判定：Ctrl+点击在 mac 上产生 contextmenu 而不是 click（多选分流要转译） */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);

/* ------------------------------------------------------------- 单元行 */

/**
 * bot 头像的身份色 —— 颜色是**身份数据**（与执行器徽标的 accent 同类例外），
 * 不是 UI 装饰；由单元名哈希出稳定颜色，同一个 bot 永远长一样。
 * 外框**全员统一**（圆角档=正圆，方形档=无圆角），个性化交给自定义头像本身。
 */
const BOT_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#6366f1"];

export function botAvatarStyle(name: string, frame: AvatarFrame = "rounded"): { color: string; shape: string } {
  const hash = [...name].reduce((a, c) => a + c.codePointAt(0)!, 0);
  return {
    color: BOT_COLORS[hash % BOT_COLORS.length]!,
    shape: frame === "square" ? "rounded-none" : "rounded-full",
  };
}

function UnitRow({
  unit,
  active,
  onOpenSettings,
  onToggleResident,
  isResident,
  schedule,
  historyOpen,
  onToggleHistory,
}: {
  unit: WorkUnit;
  active: boolean;
  onOpenSettings: () => void;
  onToggleResident?: () => void;
  isResident?: boolean;
  schedule?: string;
  /** 行下历史子列表是否展开（手风琴：Sidebar 持有，一次只开一个） */
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const isSynthetic = isSyntheticUnit(unit);
  const hideFailedInSidebar = useHistoryPrefs((s) => s.prefs.hideFailedInSidebar);
  /** 已读/未读灯起算/打开方式覆盖（灯与默认打开方式都从这里读，订阅 prefs 即随写随刷） */
  const historyPrefs = useHistoryPrefs((s) => s.prefs);
  const isEntryUnread = useHistoryPrefs((s) => s.isUnread);
  const setEntryOpenMode = useHistoryPrefs((s) => s.setEntryOpenMode);
  const togglePinned = useHistoryPrefs((s) => s.togglePinned);
  // 多选（T3code 式管理选择）：订阅选择集让选中态随写随刷；点击分流在 handleRowClick
  const selection = useSidebarSelection((s) => s.selected);
  /**
   * 打开右栏 bot 设置面板（2026-10-23 归拢后）：齿轮 / 右键菜单走 onOpenSettings
   * （父级传入，先切 bot 再开面板——右栏 tab 按 owner 过滤可见，不切的话点别人的
   * 面板「开了却看不见」，SidePaneHome 跨单元历史的同一处理）。
   */
  /** 会话实时状态（turn 进行中 = 转圈灯的事实来源） */
  const sessions = useWorkbench((s) => s.sessions);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  /**
   * 焦点对话窗格的会话 —— 行高亮的即时口径（orca use-active-row 同款）：
   * focusedChatKey 在 focus() 里同步置位，点击当帧就翻；activeSessionId 要等
   * 冷启动回放落位才变，单靠它高亮会滞后整段 RPC。焦点窗格优先，没有焦点
   * 窗格（初始态 / 焦点窗格刚关）才回落全局——取或会在回放在途时新旧两行同亮。
   */
  const focusedPaneSessionId = useChatPanes((s) =>
    s.focusedChatKey !== null ? (s.panes[s.focusedChatKey]?.sessionId ?? null) : null,
  );
  const highlightedSessionId =
    focusedPaneSessionId ?? (activeSessionId !== null ? String(activeSessionId) : null);
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const mainView = useShell((s) => s.mainView);
  /** 该 bot 名下有闲时托管任务正在执行（打勾任务跑起来，bot 行亮灯） */
  const hasExecutingTask = useBacklog((s) => s.items.some((i) => i.status === "executing" && i.unitId === unit.id));
  /** 终端标签（TUI 还开着的历史行 → 点行直切那个标签，不发 resume） */
  const terminalPanes = useTerminalStore((s) => s.panes);
  const sessionStatusById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of sessions) m.set(String(x.id), x.status);
    return m;
  }, [sessions]);
  /** 右键菜单（bot 行与历史行共用一个状态，同屏只会开一个） */
  const [quickMenu, setQuickMenu] = useState<QuickMenuState | null>(null);
  /** 分支标记（源代码管理的缓存；TTL 节流，非 git 仓库为 null 不显示） */
  const branchName = useGit((s) => s.badgeByRoot[unit.rootPath]?.branch);
  useEffect(() => {
    void useGit.getState().refreshBranchBadge(unit.rootPath);
  }, [unit.rootPath]);
  /**
   * 历史子列表数据在 useUnitHistory（不在组件 state）：空闲预热 / 悬停预取会在展开
   * 之前把它焐热，[bot|项目] 切换 / 常驻移动导致的重挂也不丢 —— 展开即见。
   * 历史详情走右侧标签页（点子列表条目预展开那一条）—— 状态在 useSidePane
   */
  const histCache = useUnitHistory((s) => s.byUnit[unit.id] ?? EMPTY_HISTORY_ENTRY);
  const histEntries = histCache.entries;
  const histErr = histCache.error;
  /**
   * 待触发的定时任务（docs/23）：子列表顶部的「将要发生什么」，与历史行的
   * 「发生过什么」上下互补 —— 可追溯性的另一半。数据取 useWorkbench.automations
   * （启动即加载，变更点会刷新）：展开时与历史行同帧出现，不再等一次 RPC 后从
   * 列表顶部跳进来。收起的行取常量（不随刷新重渲染）
   */
  const automations = useWorkbench((s) => (historyOpen ? s.automations : NO_AUTOMATIONS));
  const schedTasks = useMemo(
    () =>
      automations
        .filter((a) => a.unitId === String(unit.id) && a.enabled && a.nextRunAt !== undefined)
        .sort((x, y) => (x.nextRunAt ?? 0) - (y.nextRunAt ?? 0)),
    [automations, unit.id],
  );
  const openAutomationDialog = useShell((s) => s.openAutomationDialog);
  /** 历史列表分页：每轮显示 6 条，超过 6 条折叠成「更多」 */
  const [visibleCount, setVisibleCount] = useState(6);
  /** 行内重命名中的 entry key（右键「重命名」进入，Enter/失焦保存、Esc 取消） */
  const [renamingKey, setRenamingKey] = useState<string | null>(null);

  const { filteredEntries, hiddenFailedCount, hiddenArchivedCount } = useMemo(() => {
    // 置顶行排最前（稳定排序：组内保持原时间序）—— 「垂直标签页」的 pin 语义
    const pinned = new Set(historyPrefs.pinnedKeys);
    const byPin = (list: readonly UnitHistoryEntry[]): UnitHistoryEntry[] =>
      [...list].sort((a, b) => Number(pinned.has(b.key)) - Number(pinned.has(a.key)));
    if (!histEntries) return { filteredEntries: null, hiddenFailedCount: 0, hiddenArchivedCount: 0 };
    const archivedSet = new Set(historyPrefs.archivedKeys);
    const filtered: UnitHistoryEntry[] = [];
    let hidden = 0;
    let archived = 0;
    for (const e of histEntries) {
      if (archivedSet.has(e.key) || (e.sessionId && archivedSet.has(`session-${e.sessionId}`))) {
        archived++;
        continue;
      }
      if (hideFailedInSidebar && e.status === "failed") {
        hidden++;
        continue;
      }
      filtered.push(e);
    }
    return { filteredEntries: byPin(filtered), hiddenFailedCount: hidden, hiddenArchivedCount: archived };
  }, [histEntries, hideFailedInSidebar, historyPrefs.pinnedKeys, historyPrefs.archivedKeys]);

  /**
   * 范围选（Shift）的有序口径 = **实际渲染的可见行**：fold 折叠掉 revision 家族
   * 成员、分页截断到 visibleCount —— 用未折叠的 filteredEntries 会把看不见的
   * 行无声纳入批量归档/置顶（review M3）。
   */
  const visibleOrderedEntries = useMemo(
    () => collapseForkVersions(filteredEntries ?? []).slice(0, visibleCount).map((s) => s.entry),
    [filteredEntries, visibleCount],
  );

  useEffect(() => {
    if (!historyOpen) setVisibleCount(6);
  }, [historyOpen]);

  // 展开：有缓存先显示（预热/预取早已拉好），旧于几秒才后台校准（SWR）；开着期间
  // **保持实时**：派发终端的 created/exit 帧、会话起止事件都会改写历史（新条目
  // 出现 / 状态收口），命中即去抖强刷；30s 轮询兜底覆盖其余路径（如待办状态迁移、
  // 别处触发的派发）。请求经 useUnitHistory 在途合并：多个触发点同时到也只发一次
  useEffect(() => {
    if (!historyOpen) return;
    let alive = true;
    void useUnitHistory.getState().ensure(unit.id, { maxAgeMs: HISTORY_EXPAND_FRESH_MS });
    refreshScheduledTasks(SCHED_REFRESH_FRESH_MS);
    const load = (): void => {
      if (alive) void useUnitHistory.getState().ensure(unit.id);
    };
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = (): void => {
      if (!alive) return;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(load, 300);
    };
    const poll = setInterval(() => {
      load();
      refreshScheduledTasks(SCHED_REFRESH_FRESH_MS);
    }, 30_000);
    const client = DaemonClient.get(defaultDaemonEndpoint());
    const unsubFrame = client.onTerminalFrame((f) => {
      if (f.kind === "created" || f.kind === "exit") scheduleLoad();
    });
    const unsubEvent = client.onEvent((e) => {
      if (e.type === "session.started" || e.type === "session.ended") scheduleLoad();
    });
    // 导入外部会话完成（设置页/bot 设置里）的即时刷新：导入的那一刻用户就
    // 指望在子列表最顶上看到它，等 30s 轮询等于没导入（缓存失效由 store 统一处理）
    const onImported = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ unitId?: string }>).detail;
      if (detail?.unitId === undefined || String(detail.unitId) === String(unit.id)) scheduleLoad();
    };
    window.addEventListener("awb:history-refresh", onImported as EventListener);
    return () => {
      alive = false;
      clearInterval(poll);
      if (debounce !== null) clearTimeout(debounce);
      unsubFrame();
      unsubEvent();
      window.removeEventListener("awb:history-refresh", onImported as EventListener);
    };
  }, [historyOpen, unit.id]);

  // 自动归档只作用于用户**看得到**的列表（展开行的数据每次落地都过一遍）：预热 /
  // 预取是投机拉取，不该替用户做归档决定
  useEffect(() => {
    if (historyOpen && histEntries !== null) useHistoryPrefs.getState().runAutoArchive(histEntries);
  }, [historyOpen, histEntries]);

  // 「加载中…」只在无缓存且在途超过 200ms 时出现（orca 同款）：缓存命中直接出列表，
  // 快响应不闪一下
  const histPending = historyOpen && histEntries === null && histErr === null;
  const [showHistLoading, setShowHistLoading] = useState(false);
  useEffect(() => {
    if (!histPending) {
      setShowHistLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowHistLoading(true), HISTORY_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [histPending]);

  // 意图预取（orca 行级 hover 同款）：悬停驻留 120ms 才算有意图、滚轮重置驻留（滚过
  // 不预取）、按下 / 键盘聚焦立即预取。调度与单槽「最新者胜」在 useUnitHistory
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const prefetchHistory = (): void => {
    clearHoverTimer();
    if (!historyOpen) useUnitHistory.getState().prefetch(String(unit.id));
  };
  const armHistoryPrefetch = (): void => {
    clearHoverTimer();
    if (!historyOpen) hoverTimer.current = setTimeout(prefetchHistory, HISTORY_HOVER_DWELL_MS);
  };
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );
  // ZCode: unavailableLocalDirectory —— 路径不可用要显式说出来，不能当成正常单元
  // **兜底 ?? []**：bot.json 是手可编辑的（见 useWorkbench 的合并守卫注释），
  // 一个字段缺失不该让整个界面白屏。管家 bot 一度就因为没写 tags 把整页搞崩了。
  const unavailable = (unit.tags ?? []).includes("目录不可用");
  // 只数启用的渠道：声明了但停用的不算「找得到我」
  // 飞书要**逐账号**画标记——一个 bot 可以挂几个飞书机器人，合并成一个图标
  // 就又回到「看不出是哪个」了
  const enabledChannels = (unit.channels ?? [])
    .filter((c) => c.enabled === true)
    .map((c) => ({
      kind: c.kind,
      label: c.kind === "feishu" ? "飞书" : c.kind === "telegram" ? "Telegram" : c.kind === "webhook" ? "Webhook" : c.kind,
      profiles:
        c.kind === "feishu"
          ? (c.accounts ?? []).map((a) => (a.profile ?? "").trim()).filter((p) => p !== "")
          : ([] as readonly string[]),
    }));
  // 「哪个 bot 接的是哪个飞书机器人」——头像 + 应用名。这是这枚标记存在的全部理由
  const identities = useWorkbench((s) => s.channelIdentity);
  // 与分段器同一判据：kind 缺省按 bot 算（bot.json 手可编辑，缺字段不该把 bot 画成项目）
  const isBot = !isProjectUnit(unit);

  // 副标题：身份角色，缺省回落到路径
  const subtitle = unit.identity?.role ?? "";
  const avatarFrame = useAppearance((st) => st.avatarFrame);
  const avatar = botAvatarStyle(unit.name, avatarFrame);

  const openHistoryTab = (focusKey?: string): void => {
    // 同款切 bot 守卫：openTab 只切 chat 视图不动 activeUnitId，
    // 开别人的详情 tab 不切 bot 同样会「点了没反应」
    const wb = useWorkbench.getState();
    if (String(wb.activeUnitId) !== String(unit.id)) wb.selectUnit(asUnitId(unit.id));
    useSidePane.getState().openTab({
      unitId: unit.id,
      unitName: unit.name,
      ...(focusKey !== undefined ? { focusKey } : {}),
    });
  };

  return (
    // 整行是 button，button 里再套 button 是非法 HTML —— 设置入口做成
    // 绝对定位的兄弟节点，和时间戳抢同一个位置、hover 时交叉淡入淡出。
    <div className="group/row relative">
      <button
        onClick={() => {
          // 切单元视角 = 离开当前列表的管理上下文，残留的选择集一并清掉
          if (useSidebarSelection.getState().selected.size > 0) useSidebarSelection.getState().clear();
          onToggleHistory();
        }}
        onPointerEnter={armHistoryPrefetch}
        onPointerLeave={clearHoverTimer}
        onWheel={() => {
          if (hoverTimer.current !== null) armHistoryPrefetch();
        }}
        onPointerDown={prefetchHistory}
        onFocus={prefetchHistory}
        onContextMenu={(e) =>
          setQuickMenu(
            quickMenuFromEvent(e, [
              ...(onToggleResident
                ? [
                    {
                      label: isResident ? "取消常驻" : "设为常驻",
                      icon: Pin,
                      onSelect: onToggleResident,
                    },
                  ]
                : []),
              { label: "历史详情", icon: History, onSelect: openHistoryTab },
              { label: "bot 设置", icon: Settings, onSelect: onOpenSettings },
              { label: "新建 TUI 会话", icon: SquareTerminal, onSelect: () => openNewTuiForUnit(unit) },
              { label: "新建会话", icon: Plus, onSelect: () => openNewChatForUnit(unit) },
            ]),
          )
        }
        aria-current={active}
        aria-expanded={historyOpen}
        title={`${unit.name} —— 点击${historyOpen ? "收起" : "展开"}历史会话（右键：常驻 / 历史详情 / bot 设置 / 新建会话）`}
        className={cn(
          "flex w-full items-start gap-2 rounded-input px-2 py-1.5 text-left",
          active ? "bg-teal-tint" : "hover:bg-line-soft",
          unavailable && "opacity-60",
        )}
      >
        {isBot ? (
          /* 自定义头像优先；缺省是彩色底 + 双眼（GrokBot 式吉祥物形态），右下角日程角标 */
          <span
            aria-hidden
            className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden", avatar.shape)}
            style={unit.avatar ? undefined : { background: avatar.color }}
          >
            {unit.avatar ? (
              <img src={unit.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="mt-0.5 flex gap-0.5">
                <span className="h-1.5 w-0.5 rounded-full bg-white/90" />
                <span className="h-1.5 w-0.5 rounded-full bg-white/90" />
              </span>
            )}
            {schedule && (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-rail bg-teal"
                title={schedule}
              />
            )}
          </span>
        ) : (
          /* 项目保持方形字母文件夹标 */
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-line-soft text-body-sm font-medium text-graphite"
          >
            {unit.name.slice(0, 1)}
          </span>
        )}

        <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-body-sm font-medium text-ink">{unit.name}</span>
            {/* 闲时托管任务执行中：子列表收起也看得见（点击行展开历史可盯实时状态）。
                同款 running 转圈（灯色跟随用户的运行中偏好，见 core/sessionLight） */}
            {hasExecutingTask && (
              <span
                className="flex shrink-0 items-center"
                title="有闲时托管任务正在执行 —— 点击行展开历史可盯实时状态"
              >
                <SessionLightDot kind="running" />
              </span>
            )}
            {/* 上下文注入标签已移至 bot 设置页面查看，侧栏不再显示 */}
            {/* 渠道徽标 */}
            {enabledChannels.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10px] text-ash"
                title={enabledChannels
                  .map((c) => {
                    if (c.profiles.length === 0) return `已接渠道：${c.label}`;
                    return c.profiles
                      .map((p) => channelIdentityLabel(c.label, identities[p], p))
                      .join("；");
                  })
                  .join("；")}
              >
                {enabledChannels.map((c, ci) =>
                  c.profiles.length === 0 ? (
                    <ChannelMark key={`${c.kind}-${ci}`} kind={c.kind} label={c.label} />
                  ) : (
                    c.profiles.map((p, pi) => (
                      <ChannelMark
                        key={`${c.kind}-${ci}-${pi}`}
                        kind={c.kind}
                        identity={identities[p]}
                        label={channelIdentityLabel(c.label, identities[p], p)}
                      />
                    ))
                  ),
                )}
              </span>
            )}
          </span>
          <span className="truncate text-[11px] text-graphite">
            {subtitle || <span className="text-ash">{unit.rootPath}</span>}
            {branchName != null && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-ash" title={`当前分支 ${branchName}`}>
                <GitBranch size={9} className="shrink-0" />
                {branchName}
              </span>
            )}
          </span>
          {unavailable && (
            <span className="mt-0.5 w-fit rounded-chip bg-loss/10 px-1 py-0.2 text-[10px] text-loss">目录不可用</span>
          )}
        </span>
      </button>

      {/* 历史子列表：bot 行下的可折叠执行时间轴。点条目 = 直达对应视图
          （对话页建的 → 聊天页，TUI 建的 → TUI 重现）—— 左侧栏即垂直标签页 */}
      {historyOpen && (
        <div data-no-drag draggable={false} onMouseDown={(e) => e.stopPropagation()} className="space-y-px py-0.5 px-0.5">
          {histErr !== null && <p className="px-1.5 py-1 text-[10px] text-loss">读取失败：{histErr}</p>}
          {/* 待触发定时任务行（docs/23）：排在一切历史行之前 —— 子列表先答「将要
              发生什么」，再列「发生过什么」。点击直接打开该任务的编辑弹窗 */}
          {schedTasks.map((t) => (
            <ScheduledTaskRow
              key={`sched-${t.id}`}
              task={t}
              onOpen={() => openAutomationDialog({ mode: "edit", automation: t })}
            />
          ))}
          {showHistLoading && histPending && <p className="px-1.5 py-1 text-[10px] text-ash">加载中…</p>}
          {histEntries !== null && histEntries.length === 0 && (
            <p className="px-1.5 py-1 text-[10px] text-ash">还没有执行记录 —— 自动化、待办或会话跑过之后出现在这里</p>
          )}
          {histEntries !== null && histEntries.length > 0 && filteredEntries !== null && filteredEntries.length === 0 && (
            <button
              type="button"
              data-no-drag
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                if (hiddenArchivedCount > 0) {
                  useShell.getState().openSettings("archivedTasks");
                } else {
                  openHistoryTab();
                }
              }}
              className="w-full cursor-pointer rounded-btn px-1.5 py-1 text-left text-[10px] text-ash hover:bg-line-soft hover:text-graphite"
            >
              {hiddenArchivedCount > 0 && hiddenFailedCount > 0
                ? `已归档 ${hiddenArchivedCount} 条、隐藏 ${hiddenFailedCount} 条失败（点击查看详情）`
                : hiddenArchivedCount > 0
                  ? `已归档 ${hiddenArchivedCount} 条任务（点击在设置抽屉中查看）`
                  : `已隐藏 ${hiddenFailedCount} 条失败会话（点击打开详情）`}
            </button>
          )}
          {collapseForkVersions(filteredEntries ?? []).slice(0, visibleCount).map((slot) => {
            const e = slot.entry;
            // unitId 用行所属 bot（entry.unitId 是可选字段且可能指向别的单元，见 openEntryInChat 注释）
            const canChat = e.sessionId !== null;
            // TUI 还开着（前端有它的标签）也算「可在 TUI 打开」——点击会直切那个标签
            const hasLiveTab =
              e.terminalId != null && e.terminalId !== "" && terminalPanes[e.terminalId] !== undefined;
            const canTui = hasLiveTab || resumeArgsFor(e.runtimeId, e.resumeRef) !== null;
            // 默认打开方式：用户覆盖优先，缺省按来源（对话页建 → 聊天页，TUI 建 → TUI）；
            // 来源不可用才交叉回落（headless 无 cli_ref → TUI；TUI 无 resumeRef → 聊天页），
            // 两者皆不可用时保留来源展示、点击落详情弹窗
            const originMode: "chat" | "tui" = e.launchMode === "terminal" ? "tui" : "chat";
            const override = historyPrefs.entryOpenMode[e.key];
            const effective: "chat" | "tui" =
              override === "chat" && canChat
                ? "chat"
                : override === "tui" && canTui
                  ? "tui"
                  : originMode === "chat" && canChat
                    ? "chat"
                    : originMode === "tui" && canTui
                      ? "tui"
                      : canChat
                        ? "chat"
                        : canTui
                          ? "tui"
                          : originMode;
            const lightOverride = entryKeys(e)
              .map((k) => historyPrefs.lightOverrides[k])
              .find((v) => v !== undefined && v !== null);
            const rowActive = mainView === "chat" && e.sessionId !== null && highlightedSessionId === e.sessionId;
            // 灯的本地兜底只认「全局链路此刻就是这一行」：timeline/busy 是全局活跃
            // 会话的镜像，冷启动回放在途时高亮已先翻到新行、全局还属于旧会话 ——
            // 拿它推新行的灯会把旧会话的转圈/待交互串过来
            const rowOwnsGlobal =
              mainView === "chat" && e.sessionId !== null && String(activeSessionId) === e.sessionId;
            // 等你交互：只认挂在时间线上**未答**的问卷/决策卡（检测只认 pending，
            // 已答即出清）。注意 busy 不进这里——它是「活跃会话在跑」的本地镜像
            // （见 useWorkbench 的 busy 注释），在灯模型拆分后属于 running。
            const isRowAwaitingDecision =
              Boolean(rowOwnsGlobal && detectQuestionnaireFromTimeline(
                timeline.filter((t) => "sessionId" in t.event && t.event.sessionId === activeSessionId)
              ) !== null);
            // running 的本地兜底：store 的会话状态登记可能滞后一拍，busy 是
            // 「当前活跃会话有轮次在飞」的前端镜像，行持有全局链路时以它为准
            const isRowActiveRunning = Boolean(rowOwnsGlobal && busy);
            const light = deriveHistoryLight(
              e,
              sessionStatusById,
              // entry key 与 session key 任一打开过即算已读（自动化行与 session 行共享）
              isEntryUnread(entryKeys(e), e.endedAt),
              lightOverride,
              isRowAwaitingDecision,
              isRowActiveRunning,
            );
            const openDefault = (): void => {
              // 1. 符合直觉：只要点击该会话，立即消除完成未读灯（标为已查看）
              useHistoryPrefs.getState().markViewed(entryKeys(e));

              if (effective === "chat" && canChat) openEntryInChat(e, String(unit.id));
              else if (effective === "tui" && canTui) openEntryInTui(e, unit);
              else if (canChat) openEntryInChat(e, String(unit.id));
              else if (canTui) openEntryInTui(e, unit);
              else {
                // 2. 既无活跃进程也无法 resume：这是一条已归档的历史终端记录，
                // 直接帮用户展开右侧栏的「历史对话详情」查看记录与产物，而不是弹窗拒绝
                openHistoryTab(e.key);
                useWorkbench.getState().pushNotice(
                  "已打开历史记录详情",
                  "该会话属于已归档的历史终端记录（执行器未保留原生会话句柄），已为你展开对话详情查看运行记录与产物。",
                );
              }
            };
            const isEntryArchived =
              historyPrefs.archivedKeys.includes(e.key) ||
              (e.sessionId !== null && historyPrefs.archivedKeys.includes(`session-${e.sessionId}`));
            // 多选分流：Ctrl/Cmd = 增删选择集；Shift = 锚点起范围选；普通点击 =
            // 先清掉残留选择再按原逻辑打开（选择 ≠ 打开，两层语义靠修饰键区分）
            const handleRowClick = (ev: React.MouseEvent): void => {
              const sel = useSidebarSelection.getState();
              if (ev.metaKey || ev.ctrlKey) {
                ev.preventDefault();
                sel.toggle(e);
                return;
              }
              if (ev.shiftKey) {
                ev.preventDefault();
                sel.selectRange(visibleOrderedEntries, e.key);
                return;
              }
              if (sel.selected.size > 0) sel.clear();
              openDefault();
            };
            return (
              <HistoryListRow
                key={e.key}
                entry={e}
                versionCount={slot.family?.length}
                light={light}
                active={rowActive}
                mode={{ effective, canChat, canTui }}
                pinned={historyPrefs.pinnedKeys.includes(e.key)}
                selected={selection.has(e.key)}
                onTogglePin={() => togglePinned(e.key)}
                archived={isEntryArchived}
                onToggleArchive={() => useHistoryPrefs.getState().toggleArchived(e)}
                renaming={renamingKey === e.key}
                onRenameCommit={(title) => {
                  setRenamingKey(null);
                  // null = Esc 取消，不落盘；空串 = 恢复原名（daemon 侧同义）。
                  // 保存后走既有刷新广播，子列表 300ms 去抖重拉即见新名
                  if (title === null) return;
                  void renameHistoryEntry(e.key, title).then(() => {
                    window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId: String(unit.id) } }));
                  });
                }}
                onOpenDefault={handleRowClick}
                onToggleMode={() => {
                  const other: "chat" | "tui" = effective === "chat" ? "tui" : "chat";
                  const feasible = other === "chat" ? canChat : canTui;
                  if (feasible) setEntryOpenMode(e.key, other);
                }}
                onOpenDetail={() => {
                  openHistoryTab(e.key);
                }}
                onContextMenu={(ev) => {
                  // macOS 的 Ctrl+点击发 contextmenu 而不是 click：转译成选择集
                  // 增删（与 Win/Linux 的 Ctrl+click 同一语义），别弹菜单
                  if (IS_MAC && ev.ctrlKey && !ev.metaKey) {
                    ev.preventDefault();
                    useSidebarSelection.getState().toggle(e);
                    return;
                  }
                  // 有选择集且右键点的是成员行 → 批量菜单（T3code 多选管理同款）；
                  // 否则维持单行菜单。批量动作一次落盘、执行完清空选择
                  const sel = useSidebarSelection.getState();
                  if (sel.selected.size > 0 && sel.selected.has(e.key)) {
                    const n = sel.selected.size;
                    const entries = [...sel.selected.values()];
                    const keys = [...sel.selected.keys()];
                    setQuickMenu(
                      quickMenuFromEvent(ev, [
                        {
                          label: `归档 ${n} 条任务`,
                          icon: Archive,
                          onSelect: () => {
                            useHistoryPrefs.getState().archiveEntriesBatch(entries);
                            sel.clear();
                          },
                        },
                        {
                          label: `取消归档 ${n} 条`,
                          icon: ArchiveRestore,
                          onSelect: () => {
                            useHistoryPrefs.getState().unarchiveKeysBatch(keys);
                            sel.clear();
                          },
                        },
                        { separator: true },
                        {
                          label: `置顶 ${n} 条`,
                          icon: Pin,
                          onSelect: () => {
                            useHistoryPrefs.getState().pinKeys(keys);
                            sel.clear();
                          },
                        },
                        {
                          label: `取消置顶 ${n} 条`,
                          icon: Pin,
                          onSelect: () => {
                            useHistoryPrefs.getState().unpinKeys(keys);
                            sel.clear();
                          },
                        },
                        { separator: true },
                        {
                          label: "全部标为已读（消灯）",
                          icon: EyeOff,
                          onSelect: () => {
                            useHistoryPrefs
                              .getState()
                              .clearLightsBatch(entries.map((x) => ({ key: x.key, sessionId: x.sessionId })));
                            sel.clear();
                          },
                        },
                        { separator: true },
                        { label: "清除选择", icon: X, onSelect: () => sel.clear() },
                      ]),
                    );
                    return;
                  }
                  setQuickMenu(
                    quickMenuFromEvent(ev, [
                      {
                        label: historyPrefs.pinnedKeys.includes(e.key) ? "取消置顶" : "置顶",
                        icon: Pin,
                        onSelect: () => togglePinned(e.key),
                      },
                      {
                        label: "重命名",
                        icon: Pencil,
                        onSelect: () => setRenamingKey(e.key),
                      },
                      {
                        label: "分享 / 导出",
                        icon: Share2,
                        disabled: e.sessionId === null,
                        onSelect: () => {
                          if (e.sessionId === null) return;
                          // docs/26 会话分享：整条执行历史（消息/工具卡/思考/用量）打包成
                          // .awb.json —— 桌面端走系统另存为，浏览器走下载；文件传到别的
                          // 机器后在 设置 → 历史会话 → 从分享文件导入 完整回放
                          const wb = useWorkbench.getState();
                          const day = new Date(e.startedAt).toISOString().slice(0, 10);
                          void exportSession(e.sessionId)
                            .then((bundle) =>
                              saveTextFile(`${sanitizeFileName(e.title) || "session"}-${day}.awb.json`, JSON.stringify(bundle), {
                                title: "导出会话分享文件",
                              }),
                            )
                            .then((out) => {
                              if (out.canceled) return;
                              wb.pushNotice(
                                "已导出会话",
                                out.path !== null
                                  ? `已保存到 ${out.path} —— 传到别的机器后，在 设置 → 历史会话 → 从分享文件导入 即可完整回放`
                                  : "浏览器已开始下载分享文件 —— 传到别的机器后，在 设置 → 历史会话 → 从分享文件导入 即可完整回放",
                                { level: "success" },
                              );
                            })
                            .catch((err: unknown) => {
                              wb.pushNotice("导出失败", err instanceof Error ? err.message : String(err), { level: "warn" });
                            });
                        },
                      },
                      {
                        label: "实时监控此会话",
                        icon: Radio,
                        disabled: e.sessionId === null,
                        onSelect: () => {
                          if (e.sessionId === null) return;
                          // 历史 sublist 展开不切 bot：在 B 的行上开监控而 A 还
                          // 活跃时，tab 归 B、按 owner 过滤后不可见 →「点了没
                          // 反应」。先切到行所属 bot 再开（openTab 的 others
                          // 入口同款守卫）
                          const wb = useWorkbench.getState();
                          if (String(wb.activeUnitId) !== String(unit.id)) wb.selectUnit(asUnitId(unit.id));
                          useSidePane.getState().openLiveSession({
                            unitId: unit.id,
                            sessionId: e.sessionId,
                            runtimeId: e.runtimeId,
                            title: e.title,
                          });
                        },
                      },
                      {
                        label: "在聊天页打开（设为默认）",
                        icon: MessageSquare,
                        disabled: !canChat,
                        onSelect: () => {
                          if (canChat) setEntryOpenMode(e.key, "chat");
                          openEntryInChat(e, String(unit.id));
                        },
                      },
                      {
                        label: "在 TUI 中重现（设为默认）",
                        icon: SquareTerminal,
                        disabled: !canTui,
                        onSelect: () => {
                          if (canTui) setEntryOpenMode(e.key, "tui");
                          openEntryInTui(e, unit);
                        },
                      },
                      {
                        label: isEntryArchived ? "取消归档" : "归档任务",
                        icon: isEntryArchived ? ArchiveRestore : Archive,
                        onSelect: () => useHistoryPrefs.getState().toggleArchived(e),
                      },
                      { separator: true },
                      ...(light !== "none"
                        ? [
                            {
                              label: "取消此会话状态灯（消灯）",
                              icon: EyeOff,
                              onSelect: () => {
                                const hp = useHistoryPrefs.getState();
                                for (const k of entryKeys(e)) hp.clearLight(k);
                                hp.markViewed(entryKeys(e));
                              },
                            },
                          ]
                        : []),
                      ...(light === "unreadDone"
                        ? [
                            {
                              label: "标为已读（熄灭未读灯）",
                              icon: CheckCircle2,
                              onSelect: () => {
                                const hp = useHistoryPrefs.getState();
                                hp.markViewed(entryKeys(e));
                                for (const k of entryKeys(e)) hp.setLightOverride(k, "none");
                              },
                            },
                          ]
                        : [
                            {
                              label: "标为未读（点亮未读灯）",
                              icon: CircleDot,
                              onSelect: () => {
                                const hp = useHistoryPrefs.getState();
                                for (const k of entryKeys(e)) hp.setLightOverride(k, "unreadDone");
                              },
                            },
                          ]),
                      ...(light === "running" || light === "attention" || light === "error"
                        ? [
                            {
                              label: "标为已完成（熄灭运行 / 待交互 / 异常灯）",
                              icon: Check,
                              onSelect: () => {
                                const hp = useHistoryPrefs.getState();
                                for (const k of entryKeys(e)) hp.clearLight(k);
                              },
                            },
                          ]
                        : []),
                      ...(lightOverride !== undefined && lightOverride !== null
                        ? [
                            {
                              label: "恢复系统自动灯",
                              icon: RotateCcw,
                              onSelect: () => {
                                const hp = useHistoryPrefs.getState();
                                for (const k of entryKeys(e)) hp.setLightOverride(k, null);
                              },
                            },
                          ]
                        : []),
                      { separator: true },
                      {
                        label: "对话详情",
                        icon: History,
                        onSelect: () => {
                          openHistoryTab(e.key);
                        },
                      },
                      ]),
                    );
                  }}
              />
            );
          })}
          {filteredEntries !== null && filteredEntries.length > visibleCount && (
            <button
              type="button"
              data-no-drag
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                setVisibleCount((v) => v + 6);
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-btn px-1.5 py-1 text-left text-[10px] text-ash transition hover:bg-line-soft hover:text-graphite"
            >
              <span>更多</span>
              <span className="text-[9px] text-ash/70">剩余 {filteredEntries.length - visibleCount} 条</span>
            </button>
          )}
        </div>
      )}

      {/* 悬浮快捷操作：常驻 / 设置 / 新建会话（历史切换整行可点，不占这里；打开目录统一走头部的工作区路径弹层） */}
      <div
        data-no-drag
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-btn bg-canvas/95 p-0.5 shadow-xs opacity-0 backdrop-blur-xs transition hover:opacity-100 focus-within:opacity-100 group-hover/row:opacity-100 cursor-default"
      >
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (onToggleResident) onToggleResident();
          }}
          aria-label={
            isResident
              ? `取消 ${unit.name} 常驻`
              : `设为 ${unit.name} 常驻`
          }
          title={
            isResident
              ? "取消常驻（移回下方列表）"
              : "设为常驻（固定在顶部）"
          }
          className={cn(
            "rounded-btn p-1 transition cursor-pointer active:scale-90",
            isResident
              ? "text-teal hover:bg-teal-tint/60"
              : "text-ash hover:bg-line-soft hover:text-ink",
          )}
        >
          <Pin
            size={12}
            className={cn(isResident && "fill-teal text-teal rotate-45")}
          />
        </button>
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openHistoryTab();
          }}
          aria-label={`${unit.name} 完整历史对话详情`}
          title="查看完整历史对话详情"
          className="cursor-pointer rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
        >
          <History size={12} />
        </button>
        {/* 上下文清单悬浮钮已并入齿轮（2026-10-23 设置面归拢）：齿轮开的右栏 bot 设置
            面板里就有完整上下文设置，两个入口冗余 */}
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          aria-label={`${unit.name} 设置`}
          title="设置 —— 改 AGENTS.md、人设、主执行器"
          className="cursor-pointer rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
        >
          <Settings size={12} />
        </button>
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openNewTuiForUnit(unit);
          }}
          aria-label={`在 ${unit.name} 中新建 TUI 会话`}
          title="新建 TUI 会话 —— 在终端里直接起这个 bot 绑定执行器的交互界面（免审批、记入历史）"
          className="cursor-pointer rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
        >
          <SquareTerminal size={12} />
        </button>
        <button
          type="button"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openNewChatForUnit(unit);
          }}
          aria-label={`在 ${unit.name} 中新建会话`}
          title="新建会话 —— 在这个 bot 的工作空间开一个全新对话页"
          className="cursor-pointer rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink active:scale-90 transition"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* 右键菜单（bot 行：常驻 / 设置 / 新建会话；历史行：打开方式 / 详情） */}
      <QuickContextMenu menu={quickMenu} onClose={() => setQuickMenu(null)} />
    </div>
  );
}

/** 精简相对时间展示（侧栏紧凑宽度优化，如 刚刚/5m/2h/1d/14d） */
function formatHistoryTime(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "刚刚";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 365) return `${diffDay}d`;
  return `${Math.floor(diffDay / 365)}y`;
}

/**
 * 历史子列表的单行 —— 左侧栏的「垂直标签页」条目：
 * 点击 = 按默认方式直达（对话页建的 → 聊天页；TUI 建的 → TUI 重现），
 * 打开方式徽标可一键切换（也是来源标签），右键菜单可换打开方式 / 置顶 / 看详情。
 * 行内：执行器图标（hover 淡入为置顶钮；已置顶恒显实心 pin）+ 状态灯
 * （仅异常/执行/未读时出现）+ 标题 + 分叉徽标 + 打开方式徽标 + 时间（固定最右，对齐）。
 */
/**
 * 历史行的来源标签 —— 这条会话怎么来的：
 * - 定时（automation）：trigger=manual 是用户点的「立即运行」，标「定时·手跑」；
 * - 待办（backlog）：trigger=autopilot 是闲时自动执行（免确认门），标「待办·闲时」；
 *   心跳/GTD 提议确认后自动执行标「待办」；手动点的一次执行标「待办·手动」；
 * - 手动（manual）：对话页手动派发的 TUI；
 * - 会话（session）：非工作台来源（飞书/手机端/自动化…）标来源；工作台自己的
 *   普通对话是默认形态，不带标签（颜色口径与 HistoryPane 的 KIND_META 一致）。
 */
function historyOriginTag(entry: UnitHistoryEntry): { label: string; cls: string; tip: string } | null {
  if (entry.kind === "automation") {
    return entry.trigger === "manual"
      ? { label: "定时·手跑", cls: "bg-teal-tint text-teal", tip: "定时任务 · 手动点的一次「立即运行」" }
      : { label: "定时", cls: "bg-teal-tint text-teal", tip: "定时任务到点自动触发" };
  }
  if (entry.kind === "backlog") {
    if (entry.trigger === "autopilot") {
      return { label: "待办·闲时", cls: "bg-gain/10 text-gain", tip: "清单任务 · 工作台空闲时自动执行（免确认门，跑完自动验收）" };
    }
    return entry.trigger === "manual"
      ? { label: "待办·手动", cls: "bg-amber-500/10 text-amber-600", tip: "待办任务 · 手动点的一次执行" }
      : { label: "待办", cls: "bg-amber-500/10 text-amber-600", tip: "待办任务自动触发（心跳提议、确认后执行）" };
  }
  if (entry.kind === "manual") {
    return { label: "手动", cls: "bg-violet-500/10 text-violet-500", tip: "在对话页手动派发的 TUI 会话" };
  }
  if (entry.kind === "session" && entry.source != null && entry.source !== "" && entry.source !== "workbench") {
    const label = SESSION_SOURCE_LABEL[entry.source as SessionSource] ?? entry.source;
    return { label, cls: "bg-line-soft text-graphite", tip: `这条会话从${label}发起` };
  }
  return null;
}

function HistoryListRow({
  entry,
  versionCount,
  light,
  active,
  mode,
  pinned,
  selected = false,
  onTogglePin,
  archived,
  onToggleArchive,
  renaming,
  onRenameCommit,
  onOpenDefault,
  onToggleMode,
  onOpenDetail,
  onContextMenu,
}: {
  entry: UnitHistoryEntry;
  /** revision 家族成员数（ADR 0013 版本折叠摘要；undefined = 非家族行） */
  versionCount?: number;
  /** 状态灯形态（态集见 core/sessionLight；none 不渲染灯） */
  light: SessionLightKind;
  /** 这条会话正显示在聊天页里（垂直标签页的「当前标签」高亮） */
  active: boolean;
  /** 默认打开方式与可行性（chat 需要 sessionId，tui 需要 resumeRef） */
  mode: { effective: "chat" | "tui"; canChat: boolean; canTui: boolean };
  /** 是否已置顶（置顶行排在子列表最前） */
  pinned: boolean;
  /** 批量管理选择态（Ctrl/Shift 点击进入选择集；与 active 的「当前标签」区分） */
  selected?: boolean;
  onTogglePin: () => void;
  /** 是否已归档 */
  archived?: boolean;
  onToggleArchive?: () => void;
  /** 行内重命名态（右键「重命名」进入） */
  renaming: boolean;
  /** 保存（含空串 = 恢复原名）或取消（null） */
  onRenameCommit: (title: string | null) => void;
  /** 行点击（含修饰键信息：Ctrl/Shift 在这里分流为多选，不打开会话） */
  onOpenDefault: (e: React.MouseEvent) => void;
  onToggleMode: () => void;
  onOpenDetail: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}): ReactElement {
  const kindLabel = entry.kind === "automation" ? "定时" : entry.kind === "backlog" ? "待办" : entry.kind === "manual" ? "手动" : "会话";
  const iconSrc = executorIconSrc(entry.runtimeId);
  const bareExec = entry.runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");
  const canToggle = mode.effective === "chat" ? mode.canTui : mode.canChat;
  const neither = !mode.canChat && !mode.canTui;
  const openDesc = neither
    ? "点击查看对话详情 —— 这条会话既接不回聊天页、也无法在 TUI 重现（执行器没留原生会话引用）"
    : `点击＝在${mode.effective === "chat" ? "聊天页" : "TUI"}打开`;
  const modeLabel = mode.effective === "chat" ? "聊天" : "TUI";
  const otherLabel = mode.effective === "chat" ? "TUI" : "聊天页";
  const modeTip = !mode.canChat && !mode.canTui
    ? "这条会话既接不回聊天页，也无法在 TUI 重现"
    : mode.effective === "chat" && !mode.canTui
      ? "只能在聊天页打开（没有执行器原生会话引用）"
      : mode.effective === "tui" && !mode.canChat
        ? "只能在 TUI 重现（没有聊天页会话记录）"
        : `当前默认：在${modeLabel === "聊天" ? "聊天页" : "TUI"}打开。点击切换为在${otherLabel}打开（右键菜单同款）`;
  const launchTip = entry.launchMode === "terminal" ? " · TUI 创建" : " · 对话页创建";
  const originTag = historyOriginTag(entry);

  // 重命名态：整行换成输入框（行根是 button，输入框不能嵌在 button 里）
  if (renaming) {
    return (
      <div
        data-no-drag
        draggable={false}
        className="flex min-h-[30px] w-full items-center gap-1.5 rounded-btn bg-line-soft px-2 py-1"
      >
        <Pencil size={10} className="shrink-0 text-teal" />
        <input
          autoFocus
          defaultValue={entry.title}
          aria-label="重命名会话"
          title="Enter 保存 · Esc 取消 · 清空后保存 = 恢复原名"
          onFocus={(ev) => ev.currentTarget.select()}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") onRenameCommit(ev.currentTarget.value.trim());
            else if (ev.key === "Escape") onRenameCommit(null);
          }}
          onBlur={(ev) => onRenameCommit(ev.currentTarget.value.trim())}
          onMouseDown={(ev) => ev.stopPropagation()}
          className="min-w-0 flex-1 rounded-btn border border-teal/40 bg-canvas px-1.5 py-0.5 text-[11px] text-ink outline-none"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      data-no-drag
      draggable={false}
      onClick={onOpenDefault}
      onContextMenu={onContextMenu}
      aria-current={active}
      title={`${kindLabel} · ${entry.runtimeId}${launchTip}${entry.detail !== null && entry.detail !== "" ? `\n${entry.detail}` : ""}\n${entry.title}\n${formatRelative(entry.startedAt)}\n${openDesc}${active ? "（当前显示中）" : ""}`}
      className={cn(
        "group/hrow flex min-h-[30px] w-full cursor-pointer items-center gap-1 rounded-btn px-2 py-1.5 text-left transition",
        active ? "bg-teal-tint" : "hover:bg-line-soft",
        selected && !active && "bg-teal-tint/60",
        selected && "ring-1 ring-inset ring-teal/50",
      )}
    >
      {/* 1. 状态灯槽：位于每个会话的最前面（最左边），先于执行器图标。
          正常情况下空出形成子列表退格效果，仅亮灯时（未读/待交互/异常/运行中转圈）才显示。
          灯形与灯色的唯一渲染入口是 SessionLightDot（灯色可自定义，见 store/useSessionLights） */}
      <span className="flex h-3.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
        <SessionLightDot kind={light} />
      </span>

      {/* 2. 执行器图标 ↔ 置顶钮同位交叉淡入：平时显示执行器（品牌图片或 2 字母徽标），
          hover 时淡入 pin（点击置顶）；已置顶恒显实心 pin。行根是 button，
          pin 用 span 承载（button 套 button 非法） */}
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span
          title={`执行器：${entry.runtimeId}`}
          className={cn(
            "flex h-3.5 w-3.5 items-center justify-center transition-opacity group-hover/hrow:opacity-0",
            pinned && "opacity-0",
          )}
        >
          {iconSrc ? (
            <img src={iconSrc} alt={entry.runtimeId} className="h-3.5 w-3.5 object-contain" />
          ) : (
            <span className="flex h-3 w-3 items-center justify-center rounded-[2px] bg-line-soft text-[8px] font-semibold uppercase text-ash">
              {bareExec.slice(0, 2)}
            </span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          data-no-drag
          aria-label={pinned ? "取消置顶" : "置顶这条会话"}
          title={pinned ? "取消置顶" : "置顶：这条会话将固定在子列表最前"}
          onClick={(ev) => {
            ev.stopPropagation();
            onTogglePin();
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.stopPropagation();
              onTogglePin();
            }
          }}
          className={cn(
            "absolute inset-0 flex cursor-pointer items-center justify-center rounded-[2px] transition-opacity",
            pinned ? "opacity-100" : "opacity-0 group-hover/hrow:opacity-100",
          )}
        >
          <Pin size={10} className={pinned ? "fill-teal text-teal" : "text-graphite"} />
        </span>
      </span>

      {/* 3. 标题：正常情况下直接跟在执行器后面，横向独占剩余所有空间，保证最完整展示。
              自动化产生的行常显一枚小时钟（对齐 ZCode 的 cron task 图标）：不 hover
              也能认出「这条是定时任务跑出来的」，来源 tag 只是 hover 补充说明 */}
      {(entry.kind === "automation" || entry.source === "automation") && (
        <Clock size={9} className="shrink-0 text-teal/80" aria-label="定时任务产生" />
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-graphite">{entry.title}</span>

      {/* 4. 悬停元信息标签组（手动/定时/待办来源、分叉血缘、打开方式切换）：
          正常情况下隐藏不挤压标题空间，鼠标移上去时才在靠后位置展示 */}
      <span className="hidden shrink-0 items-center gap-1 group-hover/hrow:flex">
        {originTag !== null && (
          <span
            className={cn("shrink-0 rounded-full px-1 py-px text-[9px] font-medium", originTag.cls)}
            title={originTag.tip}
          >
            {originTag.label}
          </span>
        )}
        {((versionCount !== undefined && versionCount > 1) || entry.forkKind === "branch" || entry.forkKind === "revision") && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-teal-tint px-1 py-px text-[9px] text-teal"
            title={
              versionCount !== undefined && versionCount > 1
                ? `同一轮的 ${versionCount} 个重发版本（历史弹窗里可展开导航）`
                : "这段是从更早的对话分叉出来的"
            }
          >
            <GitBranch size={8} />
            {versionCount !== undefined && versionCount > 1 ? `×${versionCount}` : "分叉"}
          </span>
        )}
        <span
          role={canToggle ? "button" : undefined}
          tabIndex={canToggle ? 0 : undefined}
          data-no-drag
          onClick={(ev) => {
            if (!canToggle) return;
            ev.stopPropagation();
            onToggleMode();
          }}
          onKeyDown={(ev) => {
            if (!canToggle) return;
            if (ev.key === "Enter" || ev.key === " ") {
              ev.stopPropagation();
              onToggleMode();
            }
          }}
          title={modeTip}
          className={cn(
            "flex shrink-0 items-center gap-0.5 rounded-full px-1 py-px text-[9px] font-medium",
            mode.effective === "chat" ? "bg-teal-tint text-teal" : "bg-violet-500/15 text-violet-500",
            canToggle ? "cursor-pointer transition hover:opacity-75" : "cursor-default opacity-80",
          )}
        >
          {mode.effective === "chat" ? <MessageSquare size={8} /> : <SquareTerminal size={8} />}
          {modeLabel}
        </span>
      </span>
      {/* 会话时间 ↔ 归档钮同位交叉淡入：
          平时固定 22px 紧凑宽度显示相对时间（居中对齐、等宽数字保证整个子列表整齐划一，不挤占标题），
          hover 时时间淡出、归档按钮同位淡入，节省左侧栏宝贵空间 */}
      <span className="relative flex h-4 w-[22px] shrink-0 items-center justify-center">
        <span
          className={cn(
            "w-full text-center font-mono text-[9px] tnum text-ash/70 transition-opacity truncate",
            "group-hover/hrow:opacity-0",
            archived && "opacity-0",
          )}
        >
          {formatHistoryTime(entry.startedAt)}
        </span>
        {onToggleArchive && (
          <span
            role="button"
            tabIndex={0}
            data-no-drag
            aria-label={archived ? "取消归档" : "归档任务"}
            title={archived ? "取消归档：恢复至左侧栏" : "归档任务：移入已完成抽屉，不在左侧栏占用空间"}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggleArchive();
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.stopPropagation();
                onToggleArchive();
              }
            }}
            className={cn(
              "absolute inset-0 flex cursor-pointer items-center justify-center rounded-[2px] transition-opacity",
              archived ? "opacity-100 text-teal" : "opacity-0 text-ash group-hover/hrow:opacity-100 hover:text-teal",
            )}
          >
            {archived ? <ArchiveRestore size={11} /> : <Archive size={11} />}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * 待触发的定时任务行（docs/23）—— 与 HistoryListRow 同构（同高度 / 同 hover /
 * 同左缘退格），排在子列表最顶部。与历史行的分工：这里答「将要发生什么」
 * （时钟图标 + 下次触发时间），历史行答「发生过什么」。点击打开编辑弹窗。
 */
function ScheduledTaskRow({ task, onOpen }: { task: Automation; onOpen: () => void }): ReactElement {
  const next = task.nextRunAt ?? null;
  const modeLabel = task.launchMode === "terminal" ? "TUI" : task.launchMode === "chat" ? "对话页" : "后台";
  const sendLabel = task.dispatchTarget === "existing_session" ? "发到已有对话" : "新对话";
  // 下次时间显示口径对齐 ZCode：30 天内相对时间，更远绝对日期
  const withinMonth = next !== null && next - Date.now() <= 30 * 86_400_000;
  return (
    <button
      type="button"
      data-no-drag
      draggable={false}
      onClick={onOpen}
      title={[
        `待触发 · ${task.name}`,
        `${describeRule(task.rule)} · ${modeLabel} · ${sendLabel}`,
        next !== null ? `下次：${formatAbsolute(next)}` : null,
        task.lastFailure ? `最近失败：${task.lastFailure.reason}` : null,
        "点击编辑这条定时任务",
      ]
        .filter((line) => line !== null)
        .join("\n")}
      className="group/srow flex min-h-[30px] w-full cursor-pointer items-center gap-1 rounded-btn px-2 py-1.5 text-left transition hover:bg-line-soft"
    >
      {/* 灯槽：仅最近失败亮异常灯（对齐历史行灯位与用户配置的异常灯色，正常待触发不亮灯） */}
      <span className="flex h-3.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
        {task.lastFailure ? <SessionLightDot kind="error" /> : null}
      </span>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title="定时任务（待触发）">
        <CalendarClock size={13} className="text-teal" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-graphite">{task.name}</span>
      <span className="hidden shrink-0 items-center gap-1 group-hover/srow:flex">
        <span className="shrink-0 rounded-full bg-teal-tint px-1 py-px text-[9px] font-medium text-teal" title="到点将自动执行">
          待触发
        </span>
      </span>
      <span
        className="w-[54px] shrink-0 truncate text-right font-mono text-[9px] tnum text-teal/80"
        title={next !== null ? formatAbsolute(next) : undefined}
      >
        {next === null ? "—" : withinMonth ? formatRelative(next) : formatAbsoluteHuman(next)}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- 小组件 */

/**
 * 侧栏动作图标钮 —— 搜索 / 自动化 / 出图 共用。
 *
 * 三个入口的共同点：低频但需要**看得见**。所以只去掉文字（title 与
 * aria-label 保留，键盘和读屏用户不受影响），不收进浮层 ——
 * 浮层是给「偶尔才改的偏好」用的，导航入口收进去就等于藏起来了。
 */
function IconNavBtn({
  icon: Icon,
  label,
  hint,
  active,
  dot,
  onClick,
}: {
  icon: typeof Search;
  label: string;
  hint?: string;
  active?: boolean;
  /** 右上角红点（docs/27 执行器新版本：进设置页「执行器与模型」即消隐） */
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={hint ? `${label} · ${hint}` : label}
      aria-pressed={active}
      className={cn(
        "relative flex h-7 w-7 items-center justify-center rounded-btn",
        active ? "bg-teal-tint text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      <Icon size={14} className="shrink-0" />
      {dot && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-1 ring-rail" aria-hidden />}
    </button>
  );
}

