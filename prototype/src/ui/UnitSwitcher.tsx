/**
 * 对话输入框顶栏的单元切换器 —— 芯片点击弹出的专属 bot / 项目切换面板。
 *
 * 与 ⌘K 搜索（CommandCenter）分家：这里只做高频浅操作「现在跟谁对话」，
 * 搜索 / 命令 / 会话历史仍是 CommandCenter 的地盘。
 *
 * bot 与项目并列等价：面板顶部 [bot|项目] 分段一点即切（打开时自动落在
 * 当前单元所在的形态），不再纵向堆两组把项目沉底。列表顺序与侧栏完全
 * 同序（orderUnitsLikeSidebar：常驻/置顶在前、普通节跟用户拖拽序）——
 * 侧栏里排在哪，这里就排在哪。底部「新建 bot」直通既有（新建＝认领单轨）
 * 入口。移动端不走这里——芯片点开的是移动抽屉，那本来就是单元切换器。
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, FolderGit2, Plus } from "lucide-react";
import { useWorkbench, type ViewMode } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { isProjectUnit, orderUnitsLikeSidebar, type WorkUnit } from "../core/units.ts";
import { UnitViewSegment } from "./UnitViewSegment.tsx";
import { cn } from "./cn.ts";

function UnitRow({
  unit,
  active,
  onSelect,
}: {
  unit: WorkUnit;
  active: boolean;
  onSelect: () => void;
}) {
  const project = isProjectUnit(unit);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-body-sm transition",
        active ? "bg-teal-tint" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      {unit.avatar ? (
        <img src={unit.avatar} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
      ) : project ? (
        <FolderGit2 size={13} className={cn("shrink-0", active ? "text-teal" : "text-ash")} />
      ) : (
        <Bot size={13} className={cn("shrink-0", active ? "text-teal" : "text-ash")} />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", active && "font-medium text-ink")}>{unit.name}</span>
        {unit.identity?.role && <span className="block truncate text-caption text-ash">{unit.identity.role}</span>}
      </span>
      {active && <Check size={12} className="shrink-0 text-teal" />}
    </button>
  );
}

export function UnitSwitcher(props: {
  current: WorkUnit | null | undefined;
  isMobile: boolean;
  onOpenDrawer?: () => void;
}) {
  const { current, isMobile, onOpenDrawer } = props;
  const units = useWorkbench((s) => s.units);
  const unitOrder = useWorkbench((s) => s.unitOrder);
  const residentOrder = useWorkbench((s) => s.residentOrder);
  const selectUnit = useWorkbench((s) => s.selectUnit);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("bot");
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭（BranchPicker 同款口径）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 面板向上弹（芯片在屏幕底部的输入卡片顶栏）。当前分段跟随当前单元的
  // 形态：正在项目里说话，打开就是要切项目——不用先找到底部的项目组。
  // bot / 项目两侧的列表都算好：显示的一侧照常渲染，另一侧不可见地叠在
  // 同一网格单元里撑住面板高度——两侧取最高，切分段时高度不跳变。
  const botList = (() => {
    const { residentUnits, normalUnits } = orderUnitsLikeSidebar(
      units.filter((u) => !isProjectUnit(u)),
      unitOrder,
      residentOrder,
    );
    return [...residentUnits, ...normalUnits];
  })();
  const projectList = (() => {
    const { residentUnits, normalUnits } = orderUnitsLikeSidebar(
      units.filter((u) => isProjectUnit(u)),
      unitOrder,
      residentOrder,
    );
    return [...residentUnits, ...normalUnits];
  })();

  const renderRows = (v: ViewMode) => {
    const list = v === "project" ? projectList : botList;
    if (list.length === 0) {
      return (
        <p className="px-2 py-3 text-caption text-ash">
          {v === "project" ? "还没有项目——打开单元设置，把「单元形态」标为项目" : "还没有 bot——新建第一个 bot"}
        </p>
      );
    }
    return list.map((u) => (
      <UnitRow
        key={u.id}
        unit={u}
        active={u.id === current?.id}
        onSelect={() => {
          selectUnit(u.id);
          setOpen(false);
        }}
      />
    ));
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open && !isMobile}
        onClick={() => {
          if (isMobile) {
            onOpenDrawer?.();
          } else {
            if (!open) setView(isProjectUnit(current) ? "project" : "bot");
            setOpen(!open);
          }
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-lg bg-line-soft/80 px-2.5 py-1 text-xs text-ink font-semibold truncate hover:bg-line-soft active:scale-95 transition",
          "max-w-[150px] sm:max-w-[240px]",
        )}
        title="点击切换 bot 或项目"
      >
        <FolderGit2 size={13} className="text-teal shrink-0" />
        <span className="truncate">{current?.name || "agent-workbench"}</span>
        <ChevronDown size={10} className="text-ash shrink-0" />
      </button>

      {open && !isMobile && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-card border border-line bg-card shadow-subtle">
          {/* bot 与项目并列等价：一分段一切换，打开时自动落在当前单元的形态 */}
          <div className="flex items-center justify-center border-b border-line-soft p-1.5">
            <UnitViewSegment value={view} onChange={setView} />
          </div>
          {/* 面板宽度固定（w-80），横向永不滚动：列宽钉死 minmax(0,1fr)、
              子项 min-w-0，超宽的名字/角色走 truncate 截断——选择时看清是
              谁就够，不需要读全称 */}
          <div className="max-h-72 overflow-y-auto overflow-x-hidden p-1">
            {/* 两份列表同叠一个网格单元：单元高度 = 两侧最高者，切分段面板
                不跳变；不可见那份只撑高度，visibility:hidden 已移出无障碍树与
                Tab 序，不会被误点 */}
            <div
              className="grid"
              style={{ gridTemplateAreas: '"stack"', gridTemplateColumns: "minmax(0, 1fr)" }}
            >
              <div aria-hidden className="invisible min-w-0" style={{ gridArea: "stack" }}>
                {renderRows(view === "project" ? "bot" : "project")}
              </div>
              <div className="min-w-0" style={{ gridArea: "stack" }}>
                {renderRows(view)}
              </div>
            </div>
          </div>
          {/* 新建＝新建＋认领单轨：指向已有文件夹即为认领，不再另设入口 */}
          <div className="flex items-center gap-1.5 border-t border-line-soft p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                // 弹窗归拢（2026-10-23）：新建 bot 走右栏面板
                useSidePane.getState().openNewBot();
              }}
              className="flex flex-1 items-center justify-center gap-1 rounded-btn px-2 py-1.5 text-caption font-medium text-graphite transition hover:bg-line-soft hover:text-ink"
            >
              <Plus size={12} />
              新建 bot…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
