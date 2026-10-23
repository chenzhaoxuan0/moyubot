import { TitleBarClearance } from "./WindowControls.tsx";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { LayoutGrid, Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { useShell } from "../store/useShell.ts";
import { useSidePane, SIDE_PANE_MIN } from "../store/useSidePane.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useNotifications } from "../store/useNotifications.ts";
import { sidePaneOccupies, visibleTabsForUnit, type SidePaneTab } from "../core/sidePaneTabs.ts";
import type { WorkUnit } from "../core/units.ts";
import { fetchUnitHistory } from "../adapters/daemon/client.ts";
import { SIDE_PANE_HOME_ENTRIES, SIDE_PANE_TAB_META, type SidePaneLiveTarget } from "./sidePaneTabMeta.tsx";
import { SidePaneTabOverview } from "./SidePaneTabOverview.tsx";
import { cn } from "./cn.ts";
import {
  QuickContextMenu,
  type QuickMenuItem,
  type QuickMenuState,
} from "./QuickContextMenu.tsx";

/**
 * 右侧标签页面板 —— 工作台第三列（对齐 ZCode 的 AnimatedSidePanePanel，按本产品体量裁剪）。
 *
 * 关键行为（都不是样式问题）：
 * - **与左侧栏同款布局逻辑**：面板就是窗口内的一列 Panel —— 展开/收起/拖宽只是
 *   三列（左栏 / 对话列 / 面板）内部的宽度重新分配，**不碰 Electron 窗口尺寸**。
 *   此前「面板占位 = 整窗加宽一块」的插块机制已移除：窗口最大化时加宽不生效、
 *   主对话列被面板硬挤到出横向滚动条；拖宽面板时高频 setBounds 让整窗剧烈
 *   抖动甚至持续变高。对话列内容的压缩改由它自己的容器宽度驱动（见
 *   WorkspaceShell 的 @container 与 Composer 等的容器查询）。
 * - **bot 作用域**：tab 条只画当前 bot 的 tab（workspace 级 tab 恒可见），但内容区
 *   挂载**全量** tab —— 切 bot 隐藏不销毁，A 的展开态/滚动位置在切回时原样恢复。
 * - **只在 chat 主视图展开**（ZCode：workspaceMainView === "chat" && isSidePaneOpen）：
 *   自动化/出图/待办/源代码管理是全局页，不属于任何 bot，旁边挂当前 bot 的
 *   历史面板是错位的。切走时面板**收起但保持挂载** —— 保活不因换视图丢失；
 *   openTab 会顺带切回 chat（见 useSidePane.openTab）。
 * - **展开即有内容**：无可见 tab 时面板显示**功能主页**（SidePaneHome）—— 直接在
 *   面板里点选要开的功能，而不是空壳或整列消失；用户收起才归零（含分隔条不占空间）。
 *   开合入口与左栏对称：面板展开时收起钮在 tab 条最右（本组件内，镜像左栏顶部的
 *   开关）；收起后的重开走右上浮层钮（WorkspaceShell 的 SidePaneTopOverlay，与
 *   左侧栏折叠浮层互为镜像）以及各业务入口的 openTab（永远展开面板）。
 * - tab 关闭语义见 core/sidePaneTabs.ts（关激活落右邻）。tab 交互三件套：
 *   手写 pointer 拖拽排序（moveTab 只重排可见子集）、中键关闭、右键三件套；
 *   ⌄ 总览弹层（搜索 + 最近关闭重开）在 tab 条最左，＋ 新增下拉在 tab 条行尾。
 *   快捷键（Ctrl+Alt+B / Alt+1..9 / Ctrl+Tab）在 store/sidePaneShortcuts.ts。
 */

/** 分隔条拖拽手势登记（模块级：Handle 与 PanelSlot 是兄弟节点，共享这份状态）。
 *  宽度的**落盘**只发生在真实手势上 —— 程序性 resize（重试应用的持久宽、窗口
 *  缩放的重分配、晚挂载时 Group 的自动分配宽）没有写回通道，「一打开非常宽」
 *  的错宽从此不可能进 localStorage（见 SidePanePanelSlot 的 onResize） */
const resizeGesture = { dragging: false };

/** 工作台 Group 的第三列。收起/切主视图只折叠不卸载（保活），无 tab 可保才卸载。 */
export function SidePaneColumn(): ReactElement | null {
  const tabs = useSidePane((s) => s.tabs);
  const activeTabId = useSidePane((s) => s.activeTabId);
  const collapsed = useSidePane((s) => s.collapsed);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const mainView = useShell((s) => s.mainView);
  const visibleTabs = useMemo(() => visibleTabsForUnit(tabs, scopeUnitId), [tabs, scopeUnitId]);

  // 面板真实占位（口径见 core/sidePaneTabs.sidePaneOccupies —— 列卸载/切主视图都算让位；
  // 无可见 tab 时也占位，显示功能主页）
  const open = sidePaneOccupies(scopeUnitId, collapsed, mainView === "chat");

  // 卸载判据只有「无 tab 可保活」：收起/切主视图时保持挂载、面板 collapse 到 0 ——
  // 全量 tab（含其他 bot 的）的展开态/滚动位置在重开时原样恢复。
  if (tabs.length === 0 && !open) return null;
  return (
    <>
      {/* 收起时不保留分隔条（ZCode：收起即归零，不为隐藏面板留空隙） */}
      {open ? <SidePaneResizeHandle /> : null}
      <SidePanePanelSlot open={open} visibleTabs={visibleTabs} activeTabId={activeTabId} />
    </>
  );
}

function SidePaneResizeHandle(): ReactElement {
  const commitPaneWidth = useSidePane((s) => s.commitPaneWidth);
  // 手势结束（含指针移出窗口/被系统取消）落定宽度；监听挂 window 才接得住
  // 分隔条之外的 pointerup
  useEffect(() => {
    const finish = (): void => {
      if (!resizeGesture.dragging) return;
      resizeGesture.dragging = false;
      commitPaneWidth();
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [commitPaneWidth]);
  return (
    <Separator
      className="group relative w-px bg-line cursor-col-resize transition-colors data-[separator=active]:bg-teal hover:bg-teal/50"
      style={{ cursor: "col-resize" }}
    >
      {/* 16px 宽的命中区域，带明确的 col-resize 光标与 hover/active 激活高亮条。
          pointerdown 冒泡到 Separator 驱动库的拖拽，这里只登记手势开始 */}
      <span
        onPointerDown={() => {
          resizeGesture.dragging = true;
        }}
        className="absolute inset-y-0 -left-2 -right-2 z-20 cursor-col-resize transition-colors group-hover:bg-teal/20 group-data-[separator=active]:bg-teal/30"
        aria-hidden
      />
    </Separator>
  );
}

function SidePanePanelSlot({
  open,
  visibleTabs,
  activeTabId,
}: {
  open: boolean;
  visibleTabs: readonly SidePaneTab[];
  activeTabId: string;
}): ReactElement {
  const setPaneWidth = useSidePane((s) => s.setPaneWidth);
  // ⚠ initialWidth 只在挂载时读取一次持久化宽度作为 defaultSize。
  const [initialWidth] = useState(() => useSidePane.getState().paneWidth);
  const ref = useRef<PanelImperativeHandle>(null);

  // 折叠/展开 + 展开时的持久化宽度应用。**刚挂载的条件节点当帧不能直接调
  // imperative API**：react-resizable-panels 的 Group 还没把这个新 Panel 登记
  // 进布局，立即 resize/expand 会抛 "Layout not found"（侧栏不炸是因为它跟
  // Group 同帧挂载、带初始布局；本列是点开才挂载）。
  // 只推迟一帧不够稳：登记偶尔更晚，面板被留在 Group 的自动分配宽度上（可到
  // maxSize 50% —— 「一打开非常宽」的来源）。改成有限帧重试（12 帧 ≈ 200ms，
  // 覆盖常规登记延迟）：expand/resize 幂等，登记完成后剩余帧是空转。极端情况下
  // 登记晚于重试耗尽仍会暂时显示错宽，但 onResize 只认分隔条手势（resizeGesture），
  // 错宽既进不了 localStorage 也覆盖不了内存值 —— 下一次展开重新应用正确宽，
  // 自愈且无残留。
  useEffect(() => {
    if (!open) {
      // 拖拽途中面板被收起（切主视图 / 点关闭）时 Handle 已卸载、收不到
      // pointerup —— 手势标志必须在这里复位，否则重开后程序性 resize 会被
      // 误判成手势、把布局宽写进状态
      resizeGesture.dragging = false;
      ref.current?.collapse();
      return;
    }
    let raf = 0;
    let attempts = 0;
    const apply = (): void => {
      const p = ref.current;
      if (p === null) return;
      try {
        p.expand();
        p.resize(`${useSidePane.getState().paneWidth}px`);
      } catch {
        /* 布局尚未登记 —— 下一帧再试 */
      }
      if (attempts++ < 12) raf = requestAnimationFrame(apply);
    };
    raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <Panel
      panelRef={ref}
      defaultSize={`${initialWidth}px`}
      minSize={`${SIDE_PANE_MIN}px`}
      maxSize="50%"
      collapsedSize="0px"
      collapsible
      onResize={(size) => {
        // 状态只在分隔条手势中跟随（拖拽实时进内存，pointerup 由 Handle 落盘）；
        // 程序性 resize 一律不写 —— 折叠过程的 0、自动分配的错宽都没有写回通道
        if (open && resizeGesture.dragging) setPaneWidth(size.inPixels);
      }}
      className="min-w-0 overflow-hidden"
    >
      <SidePanePanelBody open={open} visibleTabs={visibleTabs} activeTabId={activeTabId} />
    </Panel>
  );
}

function SidePanePanelBody({
  open,
  visibleTabs,
  activeTabId,
}: {
  /** 面板当前实际可见（未收起且在 chat 主视图）—— 内容保活协议的开关 */
  open: boolean;
  visibleTabs: readonly SidePaneTab[];
  activeTabId: string;
}): ReactElement {
  // 全量 tabs：内容区跨 bot / 跨主视图保活，隐藏的不卸载
  const tabs = useSidePane((s) => s.tabs);
  const activateTab = useSidePane((s) => s.activateTab);
  const closeTab = useSidePane((s) => s.closeTab);
  const closeOtherTabs = useSidePane((s) => s.closeOtherTabs);
  const closeVisibleTabs = useSidePane((s) => s.closeVisibleTabs);
  const scopeUnitId = useSidePane((s) => s.scopeUnitId);
  const units = useWorkbench((s) => s.units);
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId) ? activeTabId : "";
  const current = units.find((u) => String(u.id) === String(scopeUnitId));

  // 实时监控的默认目标（功能主页与 ＋ 菜单共用一份解析）：在跑的会话优先，
  // 否则最近一条有 id 的会话（回放也成立）。只在面板展开时拉 —— 收起期间
  // tab 条被裁剪、两个消费方都不可达，白拉；换 bot 先清旧值 —— 面板跨 scope
  // 常驻，不清会拿着上个 bot 的会话标题冒充本 bot 的目标
  const currentUnitId = current?.id;
  const [liveTarget, setLiveTarget] = useState<SidePaneLiveTarget | null>(null);
  useEffect(() => {
    setLiveTarget(null);
    if (currentUnitId === undefined || !open) return;
    let alive = true;
    void fetchUnitHistory(currentUnitId, 30)
      .then((list) => {
        if (!alive) return;
        const withId = list.filter((e) => e.sessionId !== null && e.sessionId !== "");
        const running = withId.find((e) => e.status === "running");
        const pick = running ?? withId[0];
        setLiveTarget(
          pick !== undefined && pick.sessionId !== null
            ? { sessionId: pick.sessionId, runtimeId: pick.runtimeId, title: pick.title, running: pick.status === "running" }
            : null,
        );
      })
      .catch(() => {
        if (alive) setLiveTarget(null);
      });
    return () => {
      alive = false;
    };
  }, [currentUnitId, open]);

  // tab 右键三件套（ZCode SidePaneTabTrigger 同款）：关闭 / 关闭其它 / 关闭全部
  const [tabMenu, setTabMenu] = useState<QuickMenuState | null>(null);
  const openTabMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      setTabMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "关闭", icon: X, onSelect: () => closeTab(tabId) },
          {
            label: "关闭其它",
            icon: X,
            disabled: visibleTabs.filter((t) => t.id !== tabId).length === 0,
            onSelect: () => closeOtherTabs(tabId),
          },
          {
            label: "关闭全部",
            icon: X,
            disabled: visibleTabs.length === 0,
            onSelect: () => closeVisibleTabs(),
          },
        ],
      });
      e.preventDefault();
    },
    [closeTab, closeOtherTabs, closeVisibleTabs, visibleTabs],
  );

  // ＋ 新增下拉：分组「会话类（跟 bot）/ 工作区类」，条目从 SIDE_PANE_HOME_ENTRIES
  // 生成（与功能主页真正同源 —— 新增 tab 类型只改 sidePaneTabMeta 一处，这里
  // 自动跟班）。历史会话是主页的大卡不在该清单里，菜单单独补第一项。
  // toggle 语义：菜单开着时点 ＋ 是「关闭」—— 但 QuickContextMenu 的外部
  // mousedown 关闭先于 click 到达，闭包里的 addMenu 已不可信，用刚关闭的
  // 时间戳压制 150ms 内的重开（QuickMenu 自身选中项后关闭也走同一路径）
  const [addMenu, setAddMenu] = useState<QuickMenuState | null>(null);
  const addMenuClosedAtRef = useRef(0);
  useEffect(() => {
    // 面板收起时菜单一并关（portal 弹层不会被列裁剪，留着就是悬浮孤儿）
    if (!open) setAddMenu(null);
  }, [open]);
  const openAddMenu = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (Date.now() - addMenuClosedAtRef.current < 150) return;
      const r = e.currentTarget.getBoundingClientRect();
      const items: QuickMenuItem[] = [];
      if (current !== undefined) {
        const args = { unitId: current.id, unitName: current.name };
        items.push({
          label: "历史会话",
          icon: SIDE_PANE_TAB_META.history.icon,
          onSelect: () => useSidePane.getState().openTab(args),
        });
        for (const entry of SIDE_PANE_HOME_ENTRIES) {
          if (entry.group !== "companion") continue;
          items.push({
            label: entry.label,
            icon: entry.icon,
            disabled: entry.requiresLiveTarget === true && liveTarget === null,
            onSelect: () => entry.open({ ...args, liveTarget }),
          });
        }
        items.push({ separator: true });
      }
      for (const entry of SIDE_PANE_HOME_ENTRIES) {
        if (entry.group !== "workspace") continue;
        items.push({
          label: entry.label,
          icon: entry.icon,
          onSelect: () => entry.open({ unitId: null, unitName: "", liveTarget }),
        });
      }
      setAddMenu({ x: r.left, y: r.bottom + 4, items });
    },
    [current, liveTarget],
  );

  /* ---- 手写 pointer 拖拽排序（零依赖）：4px 阈值区分点击；拖动中按 tab 中点
     命中实时换位（moveTab 只重排可见子集，隐藏 tab 原位保序） ---- */
  const tabStripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ tabId: string; moved: boolean; startX: number } | null>(null);
  /** 拖拽刚结束的标记（带 tabId）：pointerup 先于 click 到达，压制**同一条**
   *  tab 上拖拽尾部的误激活 —— 记 tabId 是因为全局时间戳会把 200ms 内对另一
   *  条 tab 的正常点击也吞掉 */
  const dragJustEndedRef = useRef<{ tabId: string; at: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useEffect(() => {
    const onMove = (ev: PointerEvent): void => {
      const st = dragRef.current;
      if (st === null) return;
      if (ev.buttons === 0) {
        // titlebar-drag 热区（chip 间隙 / 条尾空白）会吞掉那里的 pointerup ——
        // 收不到 onUp 时靠这里自愈：没按键还能收到 move，说明拖拽早已结束
        dragJustEndedRef.current = { tabId: st.tabId, at: Date.now() };
        dragRef.current = null;
        setDraggingId(null);
        return;
      }
      if (!st.moved) {
        if (Math.abs(ev.clientX - st.startX) < 4) return;
        st.moved = true;
        setDraggingId(st.tabId);
      }
      const strip = tabStripRef.current;
      if (strip === null) return;
      const chips = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'));
      if (chips.length === 0) return;
      let target = chips.length - 1;
      for (let i = 0; i < chips.length; i++) {
        const rect = chips[i]!.getBoundingClientRect();
        if (ev.clientX < rect.left + rect.width / 2) {
          target = i;
          break;
        }
      }
      const from = chips.findIndex((c) => c.dataset.tabId === st.tabId);
      if (from < 0) return;
      // 命中测试是 insert-before 语义（指针落在第 target 个 chip 中点左侧），
      // moveTab 的参数是「移动后的最终下标」—— 右向拖（from < target）时被
      // 越过的 chip 会在移除后前移一位，换算 -1 才不超前；左向两者同义
      const drop = target > from ? target - 1 : target;
      if (from !== drop) useSidePane.getState().moveTab(st.tabId, drop);
    };
    const onUp = (): void => {
      const st = dragRef.current;
      if (st !== null && st.moved) dragJustEndedRef.current = { tabId: st.tabId, at: Date.now() };
      dragRef.current = null;
      setDraggingId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // 方向键漫游（ARIA tablist 的 roving 惯例）：←/→ 聚焦并激活相邻 tab
  const focusNeighborTab = useCallback((fromTabId: string, dir: 1 | -1): void => {
    const strip = tabStripRef.current;
    if (strip === null) return;
    const chips = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'));
    const idx = chips.findIndex((c) => c.dataset.tabId === fromTabId);
    if (idx < 0) return;
    const next = chips[(idx + dir + chips.length) % chips.length];
    if (next === undefined || next.dataset.tabId === undefined) return;
    next.focus();
    useSidePane.getState().activateTab(next.dataset.tabId);
  }, []);

  // clear-on-shown：面板可见且聚焦某 tab = 用户正在看它，未读点熄灭 —— 覆盖
  // 「收起期间积累、展开不走 activateTab」的路径（activateTab 自身的清点也归一到这）
  const clearUnread = useSidePane((s) => s.clearUnread);
  useEffect(() => {
    if (open && visibleActiveTabId !== "") clearUnread(visibleActiveTabId);
  }, [open, visibleActiveTabId, clearUnread]);

  return (
    /* 列底色与左侧栏同源（bg-rail）：此前用 bg-card 比左栏浅一档，两栏并排时
       右列像是浮起来的；tab 条（本列头部）也因此与工作台头部（bg-rail）同色 */
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-rail">
      {/* tab 条：⌄ 总览（最左）→ 横向滚动的 tab → ＋ 新增 → 关闭钮。
          无可见 tab 时标「功能」，此时内容区就是功能主页。关闭钮与左栏顶部开关
          镜像（右侧栏自己的开关在自己身上）；桌面端无边框窗口下 tab 条是右列顶部
          的窗口拖拽热区，最右让出系统窗口控制按钮条（--wco-w，浏览器为 0）。
          高度 h-12 与工作台头部 / 左栏头部 / 窗口控制钮条同高 —— 矮一档（旧 h-10）
          会让右上角三个窗口钮的下缘压进 tab 条、视觉上被压扁。
          role=tablist 放在滚动容器上 —— tab 必须是 tablist 的直接归属后代，
          外层这行还混着总览/新增/关闭按钮，不该算进 tablist */}
      <div className="titlebar-drag flex h-12 shrink-0 items-center gap-1 border-b border-line pl-1 pr-1">
        <SidePaneTabOverview />
        <div
          ref={tabStripRef}
          role="tablist"
          aria-label="右侧面板标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {visibleTabs.length === 0 && (
            /* 功能主页的占位「标签」—— 像普通标签一样带关闭钮（hover 淡入）：
                用户在功能页想关面板，X 就该长在标签旁边，而不是条尾 */
            <span className="group/chip flex h-7 shrink-0 select-none items-center gap-1.5 rounded-btn border border-teal/40 bg-teal-tint/60 pl-2 pr-1 text-caption text-ink">
              <LayoutGrid size={11} className="shrink-0 text-teal" />
              功能
              <span
                role="button"
                tabIndex={0}
                aria-label="关闭右侧面板"
                title="关闭右侧面板"
                onClick={(e) => {
                  e.stopPropagation();
                  useSidePane.getState().toggleFromHeader();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    useSidePane.getState().toggleFromHeader();
                  }
                }}
                className="rounded p-0.5 text-ash opacity-0 transition hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover/chip:opacity-100"
              >
                <X size={11} />
              </span>
            </span>
          )}
          {visibleTabs.map((tab) => (
            <SidePaneTabChip
              key={tab.id}
              tab={tab}
              active={tab.id === visibleActiveTabId}
              dragging={draggingId === tab.id}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                dragRef.current = { tabId: tab.id, moved: false, startX: e.clientX };
              }}
              onActivate={() => {
                const d = dragJustEndedRef.current;
                if (d !== null && d.tabId === tab.id && Date.now() - d.at < 200) return;
                activateTab(tab.id);
              }}
              onAuxClose={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                closeTab(tab.id);
              }}
              onArrow={(dir) => focusNeighborTab(tab.id, dir)}
              onContextMenu={(e) => openTabMenu(e, tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={openAddMenu}
          aria-label="新增标签页"
          title="选择要在面板中打开的功能"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <Plus size={14} />
        </button>
        {/* 条尾关闭钮常驻：功能页有「功能」标签旁的 X，有标签页时有各标签的 X，
            但「快速开合面板」的固定锚点只在这一处 —— 两种形态都得能一眼找到它 */}
        <button
          type="button"
          onClick={() => useSidePane.getState().toggleFromHeader()}
          aria-label="关闭右侧面板"
          title="关闭右侧面板（对话列随之展宽；右上浮层钮与侧栏历史入口可重新打开）"
          className="shrink-0 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <X size={15} />
        </button>
        {/* 本行顶到窗口右缘：no-drag 占位让出窗口控制钮带（--wco-w）。
            必须是 drag 行的行内子元素 —— 兄弟悬浮元素的 no-drag 不参与拖拽区减法 */}
        <TitleBarClearance width="calc(var(--wco-w, 0px) + 4px)" />
      </div>

      {/* 内容区：全量 tab 挂载（保活），仅「面板可见且激活」的那个显示；
          无可见 tab（或聚焦缺失）时落功能主页 —— 面板展开永远有东西可点。
          状态徽标（工作中 / 后台守护）已迁左侧栏底部，移动端远控已迁设置页
          remoteControl 分区 —— 面板底部不再有状态条 */}
      <QuickContextMenu menu={tabMenu} onClose={() => setTabMenu(null)} />
      <QuickContextMenu
        menu={addMenu}
        onClose={() => {
          addMenuClosedAtRef.current = Date.now();
          setAddMenu(null);
        }}
      />
      <div className="relative min-h-0 flex-1">
        {visibleActiveTabId === "" && (
          <SidePaneHome current={current ?? null} liveTarget={liveTarget} units={units} />
        )}        {tabs.map((tab) => {
          const shown = open && tab.id === visibleActiveTabId;
          return (
            <div
              key={tab.id}
              aria-hidden={!shown}
              className={cn("absolute inset-0 min-h-0", shown ? "block" : "hidden")}
            >
              <SidePaneTabContent tab={tab} shown={shown} closeTab={closeTab} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** tab 条上的单个标签：图标 / 标题 / 未读点（live 事件 / 通知中心新通知）自订阅 */
function SidePaneTabChip({
  tab,
  active,
  dragging,
  onPointerDown,
  onActivate,
  onAuxClose,
  onArrow,
  onContextMenu,
  onClose,
}: {
  tab: SidePaneTab;
  active: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onActivate: () => void;
  onAuxClose: (e: React.MouseEvent) => void;
  onArrow: (dir: 1 | -1) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClose: () => void;
}): ReactElement {
  const liveUnread = useSidePane((s) => s.unreadTabIds[tab.id] === true);
  const notifyUnread = useNotifications((s) => (tab.type === "notify" ? s.items.some((n) => !n.read) : false));
  const unread = liveUnread || notifyUnread;
  const meta = SIDE_PANE_TAB_META[tab.type];
  const Icon = meta.icon;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      data-tab-id={tab.id}
      onPointerDown={onPointerDown}
      // 中键的自动滚动图钉在 mousedown 默认行为里，auxclick 拦不住 —— 这里拦
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onClick={onActivate}
      onAuxClick={onAuxClose}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
        else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onArrow(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onArrow(1);
        }
      }}
      className={cn(
        "group flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-btn border px-2 text-caption transition",
        active
          ? "border-teal/40 bg-teal-tint/60 text-ink"
          : "border-transparent text-graphite hover:bg-line-soft hover:text-ink",
        dragging && "cursor-grabbing opacity-70 ring-1 ring-teal/50",
      )}
    >
      <Icon
        size={11}
        className={cn("shrink-0", active ? "text-teal" : "text-ash", active && tab.type === "live" && "animate-pulse")}
      />
      <span className="max-w-44 truncate">{meta.title(tab)}</span>
      {unread && !active && (
        <span role="img" aria-label="有未读" className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />
      )}
      {/* 行根承担 tab 切换，关闭用 span 实现（button 套 button 非法） */}
      <span
        role="button"
        tabIndex={0}
        aria-label={`关闭 ${meta.title(tab)}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="rounded p-0.5 text-ash opacity-0 transition hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={11} />
      </span>
    </div>
  );
}

/**
 * 单个 tab 的内容宿主。memo 挡住两类无关重渲染：
 * 别的 bot 开/关 tab（tabs 数组变了但这个 tab 对象没动）、面板收起时的
 * open 翻转（shown 不变时 HistoryPane 的整棵列表树不重算）。
 * isActive 翻转（切 tab）本身仍会重渲染 —— 那是保活协议的必要代价。
 */
const SidePaneTabContent = memo(function SidePaneTabContent({
  tab,
  shown,
  closeTab,
}: {
  tab: SidePaneTab;
  shown: boolean;
  closeTab: (tabId: string) => void;
}) {
  // 稳定引用：否则 memo 挡不住 —— 每次父渲染生成的新箭头函数都会击穿比较
  const onFinished = useCallback(() => closeTab(tab.id), [closeTab, tab.id]);
  return SIDE_PANE_TAB_META[tab.type].render(tab, { shown, closeTab, onFinished });
});

/* ------------------------------------------------------------- 功能主页 */

/**
 * 面板功能主页 —— 展开时若无可见 tab（或聚焦缺失），面板直接列出当前可点的功能
 * 入口，点选后才把对应内容以 tab 形式打开。
 *
 * 分组只讲两条真实的语义轴（docs/19 后续调整：原「伴随视角/其他单元」四组收敛）：
 * - **当前单元**（标题即 bot 名）：历史会话大卡 + 监控/计划/变更行 —— 内容随 bot；
 * - **工作区**：通知中心 —— 不随 bot 切换。
 * 「其他单元的历史」不是独立功能，是历史会话的跨单元参数 —— 折进历史大卡的
 * 卡脚（「其他单元 ▾」），切 bot 的副作用也因此离「历史」这个语境更近。
 * 入口清单消费 sidePaneTabMeta 的 SIDE_PANE_HOME_ENTRIES（与 ＋ 新增下拉同源）。
 */
function SidePaneHome({
  current,
  liveTarget,
  units,
}: {
  current: WorkUnit | null;
  liveTarget: SidePaneLiveTarget | null;
  units: readonly WorkUnit[];
}): ReactElement {
  const others = units.filter((u) => String(u.id) !== String(current?.id));
  const companion = SIDE_PANE_HOME_ENTRIES.filter((e) => e.group === "companion");
  const workspace = SIDE_PANE_HOME_ENTRIES.filter((e) => e.group === "workspace");
  const [othersOpen, setOthersOpen] = useState(false);
  const HistoryIcon = SIDE_PANE_TAB_META.history.icon;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <p className="text-body-sm font-medium text-ink" title="点选要打开的功能，它将以标签页入驻本面板">
        面板功能
      </p>

      {current !== null && (
        <div className="mt-3 overflow-hidden rounded-card border border-line bg-canvas">
          <button
            type="button"
            onClick={() => useSidePane.getState().openTab({ unitId: current.id, unitName: current.name })}
            title={`${current.name} 的自动化任务、待办、心跳与手动会话时间轴`}
            className="flex w-full cursor-pointer items-center gap-2.5 p-3 text-left transition hover:bg-teal-tint/40"
          >
            <HistoryIcon size={16} className="shrink-0 text-teal" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium text-ink">历史会话</span>
            </span>
          </button>
          {others.length > 0 && (
            <div className="border-t border-line-soft">
              <button
                type="button"
                onClick={() => setOthersOpen(!othersOpen)}
                aria-expanded={othersOpen}
                className="flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-[10px] text-ash transition hover:text-ink"
              >
                {othersOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                其他单元的历史（{others.length}）
              </button>
              {othersOpen && (
                <div className="pb-1">
                  {others.map((u) => (
                    <button
                      key={String(u.id)}
                      type="button"
                      onClick={() => {
                        // 开别人的历史要顺带切 bot：tab 按 owner 过滤可见，不切就「点了没反应」
                        useWorkbench.getState().selectUnit(u.id);
                        useSidePane.getState().openTab({ unitId: u.id, unitName: u.name });
                      }}
                      title={`切换到 ${u.name} 并打开它的历史`}
                      className="flex w-full cursor-pointer items-center gap-1.5 rounded-btn px-3 py-1 text-left text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
                    >
                      <HistoryIcon size={11} className="shrink-0 text-ash" />
                      <span className="min-w-0 truncate">{u.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 兜底：bot 还没激活（或已注销）但台账里有单元 —— 大卡没挂靠点，历史入口降级为平铺 */}
      {current === null && others.length > 0 && (
        <div className="mt-3 space-y-1">
          {others.map((u) => (
            <button
              key={String(u.id)}
              type="button"
              onClick={() => {
                useWorkbench.getState().selectUnit(u.id);
                useSidePane.getState().openTab({ unitId: u.id, unitName: u.name });
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-btn px-2 py-1.5 text-left text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
            >
              <HistoryIcon size={12} className="shrink-0 text-ash" />
              <span className="min-w-0 truncate">{u.name} 的历史</span>
            </button>
          ))}
        </div>
      )}

      {/* 当前单元的跟随面：标题即作用域（bot 名），不再用「伴随视角」这类走查黑话 */}
      {current !== null && (
        <>
          <p className="mt-4 text-[10px] font-medium tracking-wide text-ash">{current.name}</p>
          <div className="mt-1.5 space-y-1">
            {companion.map((entry) => {
              const Icon = entry.icon;
              const disabled = entry.requiresLiveTarget === true && liveTarget === null;
              return (
                <button
                  key={entry.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => entry.open({ unitId: current.id, unitName: current.name, liveTarget })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-btn px-2 py-2 text-left transition hover:bg-line-soft disabled:cursor-default disabled:opacity-50"
                  title={
                    entry.requiresLiveTarget === true && liveTarget === null
                      ? "还没有可监控的会话"
                      : entry.requiresLiveTarget === true
                        ? `跟随会话 ${liveTarget!.sessionId} 的事件流`
                        : entry.desc
                  }
                >
                  <Icon
                    size={13}
                    className={cn(
                      "shrink-0",
                      entry.key === "live"
                        ? liveTarget?.running
                          ? "animate-pulse text-teal"
                          : "text-ash"
                        : "text-ash",
                    )}
                  />
                  {/* 单行入口：静态说明收进悬停；live 的实时状态是数据，保留为行内后缀 */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="shrink-0 text-caption text-graphite">{entry.label}</span>
                    {entry.key === "live" && (
                      <span className="min-w-0 flex-1 truncate text-[10px] text-ash">
                        {liveTarget === null
                          ? "还没有可监控的会话"
                          : liveTarget.running
                            ? `正在跑：${liveTarget.title}`
                            : `最近：${liveTarget.title}（回放）`}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 工作区级入口（不跟 bot，任何视角常驻） */}
      <p className="mt-4 text-[10px] font-medium tracking-wide text-ash">工作区</p>
      <div className="mt-1.5 space-y-1">
        {workspace.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => entry.open({ unitId: current?.id ?? null, unitName: current?.name ?? "", liveTarget })}
              title={entry.desc}
              className="flex w-full cursor-pointer items-center gap-2 rounded-btn px-2 py-2 text-left transition hover:bg-line-soft"
            >
              <Icon size={13} className="shrink-0 text-ash" />
              <span className="min-w-0 flex-1 truncate text-caption text-graphite">{entry.label}</span>
            </button>
          );
        })}
      </div>

      {units.length === 0 && (
        <p className="mt-3 text-caption text-ash">还没有单元 —— 左侧栏添加单元后面板功能会在这里列出。</p>
      )}

      <p className="mt-4 border-t border-line-soft pt-2 text-[10px] leading-relaxed text-ash">
        Ctrl+Alt+B 开合面板 · Alt+1-9 切换标签 · ⌄ 总览搜索与重开最近关闭
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- 状态条（已迁出） */

/**
 * 面板底部状态条（PaneStatusStrip）已移除：工作中 / 后台守护迁左侧栏底部
 * （Sidebar，全局状态跟左栏全局动作区同级），移动端远控迁设置页 remoteControl
 * 分区（低频设置项归设置页）。面板回归纯「按需查看的内容区」。
 */
