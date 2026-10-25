import { useMemo, useRef, useState } from "react";
import {
  Bot,
  Laptop,
  Moon,
  Pin,
  Plus,
  RefreshCw,
  Settings,
  Smartphone,
  Sun,
  X,
} from "lucide-react";
import { useWorkbench } from "../../store/useWorkbench.ts";
import { useShell } from "../../store/useShell.ts";
import { useAppearance } from "../../store/useAppearance.ts";
import { isResidentUnit, orderUnitsLikeSidebar } from "../../core/units.ts";
import { type LayoutPreference } from "./useIsMobile.ts";
import { cn } from "../cn.ts";

export function MobileDrawer({
  open,
  onClose,
  preference,
  onSetPreference,
}: {
  open: boolean;
  onClose: () => void;
  preference: LayoutPreference;
  onSetPreference: (p: LayoutPreference) => void;
}) {
  const units = useWorkbench((s) => s.units);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const selectUnit = useWorkbench((s) => s.selectUnit);
  const refreshUnits = useWorkbench((s) => s.refreshUnits);
  /** PC 侧栏普通节的拖拽顺序 —— 手机端同一份，两端列表同序 */
  const unitOrder = useWorkbench((s) => s.unitOrder);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const openSettings = useShell((s) => s.openSettings);
  const resolvedAppearance = useAppearance((s) => s.resolvedAppearance);
  const setMode = useAppearance((s) => s.setMode);

  // 与 PC 侧栏同一套排序（core/units.ts 的 orderUnitsLikeSidebar，单一口径）：
  // 常驻（pin）节整体置前、总管恒在首位，普通节按 PC 端拖拽顺序排 —— 手机抽屉
  // 不再按 daemon 返回的原始顺序裸列，和 PC 端对不上的错位感就出在这里
  const orderedUnits = useMemo(() => {
    const { residentUnits, normalUnits } = orderUnitsLikeSidebar(units, unitOrder);
    return [...residentUnits, ...normalUnits];
  }, [units, unitOrder]);

  // 原生手势左滑退出状态
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  if (!open) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startPosRef.current = { x: touch.clientX, y: touch.clientY };
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!startPosRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = touch.clientX - startPosRef.current.x;
    const deltaY = touch.clientY - startPosRef.current.y;
    // 主要是横向滑动且向左滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < 0) {
      setDragX(deltaX);
    }
  };

  const handleTouchEnd = () => {
    if (dragX < -70) {
      // 达到阈值：收起侧边栏
      onClose();
    }
    setDragX(0);
    setIsDragging(false);
    startPosRef.current = null;
  };

  return (
    <>
      {/* 遮罩（透明度跟随拖拽衰减） */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        style={{ opacity: Math.max(0.1, 1 - Math.abs(dragX) / 250) }}
        onClick={onClose}
        aria-hidden
      />

      {/* 抽屉侧栏（支持触控阻尼跟随与弹性回弹） */}
      <div
        className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line/80 bg-canvas text-ink shadow-2xl animate-in slide-in-from-left duration-300"
        style={{
          transform: `translateX(${dragX}px)`,
          transition: isDragging ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-line/60 bg-rail/50 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal text-white font-bold text-xs shadow-xs">
              MY
            </div>
            <div>
              <h2 className="text-body-sm font-semibold text-ink">MoyuBot</h2>
              <span className="text-[10px] text-teal font-medium">移动端控制台</span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭侧栏"
            className="rounded-btn p-1 text-graphite hover:bg-line-soft hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {/* 机器人列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-semibold text-ash uppercase tracking-wider">
              bot 列表
            </span>
            <button
              type="button"
              onClick={async () => {
                setIsRefreshing(true);
                try {
                  await refreshUnits();
                } finally {
                  setTimeout(() => setIsRefreshing(false), 500);
                }
              }}
              disabled={isRefreshing}
              title="从 PC 端同步 bot 列表"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-teal hover:bg-teal-tint transition disabled:opacity-50"
            >
              <RefreshCw size={11} className={cn(isRefreshing && "animate-spin")} />
              <span>{isRefreshing ? "同步中" : "从PC同步"}</span>
            </button>
          </div>

          {units.length === 0 ? (
            <div className="my-6 rounded-2xl border border-dashed border-line p-4 text-center bg-card/40">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-teal-tint text-teal mb-2">
                <Bot size={20} />
              </div>
              <p className="text-body-sm font-semibold text-ink">暂未发现 bot</p>
              <p className="mt-1 text-[11px] text-ash leading-relaxed">
                数据正从桌面端同步。若列表未出现，请确保手机与电脑在同一局域网并点击重试。
              </p>
              <button
                type="button"
                onClick={async () => {
                  setIsRefreshing(true);
                  try {
                    await refreshUnits();
                  } finally {
                    setTimeout(() => setIsRefreshing(false), 500);
                  }
                }}
                disabled={isRefreshing}
                className="mt-3.5 inline-flex items-center gap-1.5 rounded-xl bg-teal px-3.5 py-1.5 text-caption font-medium text-white shadow-xs active:scale-95 transition disabled:opacity-50"
              >
                <RefreshCw size={12} className={cn(isRefreshing && "animate-spin")} />
                <span>立即同步数据</span>
              </button>
            </div>
          ) : (
            orderedUnits.map((u) => {
              const isSelected = u.id === activeUnitId;
              const isSteward = u.id === "steward";
              const pinned = isResidentUnit(u);
              return (
                <button
                  key={u.id}
                  onClick={() => {
                    selectUnit(u.id);
                    onClose();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition",
                    isSelected
                      ? "bg-teal/15 text-teal font-semibold shadow-xs"
                      : "text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm",
                      isSelected ? "bg-teal text-white shadow-xs" : "bg-line-soft text-graphite",
                    )}
                  >
                    <Bot size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm">{u.name}</span>
                    <span className="block truncate text-[11px] text-ash">
                      {isSteward ? "系统总管" : u.identity?.role || "bot"}
                    </span>
                  </div>
                  {/* 常驻（pin）标识：与 PC 侧栏「常驻节置顶」同一语义的可见凭证 */}
                  {pinned && !isSteward && (
                    <Pin size={12} className="shrink-0 fill-teal text-teal" aria-label="已置顶" />
                  )}
                  {isSelected && <span className="h-2 w-2 rounded-full bg-teal" />}
                </button>
              );
            })
          )}
        </div>

        {/* 底部工具操作区 */}
        <div className="border-t border-line/60 bg-rail/40 p-3 space-y-2">

          {/* 布局切换 */}
          <div className="rounded-xl border border-line bg-card p-2 space-y-1">
            <span className="block px-1 text-[10px] text-ash font-medium">显示视图模式</span>
            <div className="grid grid-cols-3 gap-1 text-[11px]">
              <button
                onClick={() => onSetPreference("auto")}
                className={cn(
                  "rounded-lg py-1 transition text-center",
                  preference === "auto" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                自动
              </button>
              <button
                onClick={() => onSetPreference("mobile")}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-lg py-1 transition text-center",
                  preference === "mobile" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                <Smartphone size={11} />
                <span>手机</span>
              </button>
              <button
                onClick={() => onSetPreference("desktop")}
                className={cn(
                  "flex items-center justify-center gap-1 rounded-lg py-1 transition text-center",
                  preference === "desktop" ? "bg-teal text-white font-medium" : "text-graphite hover:bg-line-soft",
                )}
              >
                <Laptop size={11} />
                <span>电脑</span>
              </button>
            </div>
          </div>

          {/* 底部设置与主题 */}
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => {
                onClose();
                openSettings();
              }}
              className="flex items-center gap-1.5 text-caption text-graphite hover:text-ink"
            >
              <Settings size={14} />
              <span>设置</span>
            </button>
            <button
              onClick={() => setMode(resolvedAppearance === "dark" ? "light" : "dark")}
              className="flex items-center gap-1 text-caption text-graphite hover:text-ink"
            >
              {resolvedAppearance === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              <span>{resolvedAppearance === "dark" ? "明亮" : "暗黑"}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
