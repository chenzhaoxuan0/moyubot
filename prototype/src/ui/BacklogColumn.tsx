import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlarmClockCheck,
  ArrowDown,
  ArrowUp,
  BellOff,
  CircleAlert,
  CircleCheck,
  CircleDot,
  HeartPulse,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Play,
  Settings2,
  Trash2,
  Zap,
} from "lucide-react";
import {
  BACKLOG_STATUS_LABEL,
  formatBacklogRelative,
  isActiveStatus,
  WORK_PHASE_LABEL,
  type BacklogConfig,
  type BacklogItem,
  type BacklogStatus,
  type WorkPhase,
} from "../core/backlog.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { asUnitId } from "../core/units.ts";
import { BacklogDialog } from "./BacklogDialog.tsx";
import { BacklogSettings } from "./BacklogSettings.tsx";
import { HeaderBtn, MenuRow } from "./WorklistBits.tsx";
import { Toggle } from "./Toggle.tsx";
import { cn } from "./cn.ts";

/**
 * 清单页右栏 —— 待办任务状态机（原待办页主体）。WorkPhase 状态行 + 过滤 chips +
 * 卡片列表；左栏点任务链接时 highlightId 命中的卡片滚动进入视野并短暂高亮。
 *
 * 栏头是待办这一侧的功能钮：「闲时执行」总开关（关 = 空闲不再派发 auto 任务，
 * 手动「立即执行」不受影响）、待办设置、强制忙碌、跳一跳、新建。
 */

type Filter = "active" | BacklogStatus;

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "active", label: "活跃" },
  { id: "ready", label: "就绪" },
  { id: "awaiting_confirm", label: "待确认" },
  { id: "executing", label: "执行中" },
  { id: "awaiting_review", label: "待验收" },
  { id: "sleeping", label: "休眠" },
  { id: "done", label: "已完成" },
];

const PHASE_DOT: Record<WorkPhase, string> = {
  busy: "bg-line-strong",
  idle: "bg-gain animate-pulse",
  beating: "bg-teal animate-pulse",
  awaiting_confirm: "bg-amber-500 animate-pulse",
  executing: "bg-blue-500 animate-pulse",
  awaiting_review: "bg-violet-500",
};

export function BacklogColumn({ highlightId }: { highlightId: number | null }): ReactElement {
  const items = useBacklog((s) => s.items);
  const state = useBacklog((s) => s.state);
  const config = useBacklog((s) => s.config);
  const reorder = useBacklog((s) => s.reorder);

  const [filter, setFilter] = useState<Filter>("active");
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; item: BacklogItem } | null>(null);

  // 左栏「定位任务」：滚到命中卡片（高亮 ring 由 highlightId 传进卡片渲染）
  useEffect(() => {
    if (highlightId === null) return;
    document.getElementById(`backlog-card-${highlightId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightId]);

  const visible = useMemo(
    () => items.filter((i) => (filter === "active" ? isActiveStatus(i.status) : i.status === filter)),
    [items, filter],
  );
  const activeCount = items.filter((i) => isActiveStatus(i.status)).length;
  const autopilotOn = config?.autopilot.enabled ?? false;

  const move = (id: number, dir: -1 | 1): void => {
    const order = items.filter((i) => isActiveStatus(i.status)).map((i) => i.id);
    const from = order.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    void reorder(order);
  };

  return (
    <section className="min-w-0" aria-label="待办任务">
      {/* 栏头两行，与左栏同构同高（行1 标题+总开关、行2 状态+动作），下方列表起点对齐。
          HEAD 不放控件，窄窗口不撞窗口钮 */}
      <header className="mb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-body-sm font-medium text-ink">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", PHASE_DOT[state?.phase ?? "busy"])} />
            <span className="truncate">{WORK_PHASE_LABEL[state?.phase ?? "busy"]}</span>
            <span className="shrink-0 text-caption font-normal text-ash">待办 · {activeCount} 条活跃</span>
          </h2>
          {/* 总开关：关了空闲不再派发 auto 任务（20s tick 自查生效），手动执行不受影响 */}
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-caption text-graphite"
            title="总开关：工作台空闲时是否自动执行勾了「闲时执行」的待办。关闭后不再派发新任务（20 秒内生效）；手动「立即执行」与心跳确认不受影响。"
          >
            <Toggle
              on={autopilotOn}
              ariaLabel="闲时执行总开关"
              onChange={(v) => {
                const cfg = useBacklog.getState().config;
                if (cfg !== null) void useBacklog.getState().saveConfig({ autopilot: { ...cfg.autopilot, enabled: v } });
              }}
            />
            闲时执行
          </label>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p
            className="min-w-0 flex-1 truncate text-caption text-graphite"
            title={
              `${state?.reason ?? "总状态计算中……"}` +
              (state?.nextBeatAt != null && state.heartbeatEnabled ? ` · 下次心跳 ${formatBacklogRelative(state.nextBeatAt)}` : "") +
              (state?.lastBeatOutcome != null ? ` · 上跳：${state.lastBeatOutcome}` : "")
            }
          >
            {state?.reason ?? "总状态计算中……"}
            {state?.nextBeatAt != null && state.heartbeatEnabled && ` · 下次心跳 ${formatBacklogRelative(state.nextBeatAt)}`}
            {state?.lastBeatOutcome != null && ` · 上跳：${state.lastBeatOutcome}`}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <HeaderBtn icon={Settings2} label="待办设置（心跳与余量）" onClick={() => setSettingsOpen((v) => !v)} active={settingsOpen} />
            <HeaderBtn icon={HeartPulse} label={state?.forceBusy ? "解除强制忙碌" : "强制忙碌"} onClick={() => void useBacklog.getState().setForceBusy(!(state?.forceBusy ?? false))} active={state?.forceBusy} />
            <HeaderBtn icon={Zap} label="跳一跳" onClick={() => void useBacklog.getState().forceBeat()} />
            {/* h-8 与图标钮同高：动作带整行 32px，与左栏行2 对齐 */}
            <button
              onClick={() => setDialog({ mode: "create" })}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
            >
              <ListTodo size={12} />
              新建
            </button>
          </div>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="ml-auto flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn(
                "rounded-chip px-2.5 py-1 text-caption",
                filter === f.id ? "bg-line-soft font-medium text-ink" : "text-ash hover:text-graphite",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyPanel filter={filter} onCreate={() => setDialog({ mode: "create" })} config={config} />
      ) : (
        /* 两栏布局下右栏本就半宽 —— 卡片单列排布，原两列网格由合页取代 */
        <div className="flex flex-col gap-3">
          {visible.map((item) => (
            <BacklogCard
              key={item.id}
              item={item}
              onEdit={() => setDialog({ mode: "edit", item })}
              confirmingDelete={confirmingDelete}
              setConfirmingDelete={setConfirmingDelete}
              onMove={move}
              highlighted={highlightId === item.id}
            />
          ))}
        </div>
      )}

      {dialog !== null && (
        <BacklogDialog key={dialog.mode === "edit" ? dialog.item.id : "new"} initial={dialog.mode === "edit" ? dialog.item : null} onClose={() => setDialog(null)} />
      )}
      {settingsOpen && <BacklogSettings onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}

/* ------------------------------------------------------------------ 卡片 */

const STATUS_CHIP: Record<BacklogStatus, string> = {
  draft: "bg-line-soft text-graphite",
  ready: "bg-teal-tint text-teal",
  awaiting_confirm: "bg-amber-500/10 text-amber-600",
  executing: "bg-blue-500/10 text-blue-500",
  awaiting_review: "bg-violet-500/10 text-violet-500",
  done: "bg-gain/10 text-gain",
  sleeping: "bg-line-soft text-ash",
};

function BacklogCard({
  item,
  onEdit,
  confirmingDelete,
  setConfirmingDelete,
  onMove,
  highlighted,
}: {
  item: BacklogItem;
  onEdit: () => void;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  onMove: (id: number, dir: -1 | 1) => void;
  highlighted: boolean;
}): ReactElement {
  const runNow = useBacklog((s) => s.runNow);
  const wake = useBacklog((s) => s.wake);
  const sleep = useBacklog((s) => s.sleep);
  const review = useBacklog((s) => s.review);
  const remove = useBacklog((s) => s.deleteItem);
  const updateItem = useBacklog((s) => s.updateItem);
  const units = useWorkbench((s) => s.units);

  const [menuOpen, setMenuOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState<string | null>(null);

  const unitName = units.find((u) => u.id === item.unitId)?.name ?? item.unitName;
  const lastRun = item.lastRun;
  const autoCheckable = item.status === "ready" || item.status === "sleeping";

  return (
    <div
      id={`backlog-card-${item.id}`}
      className={cn(
        "relative flex flex-col gap-2.5 rounded-card border border-line bg-card px-4 py-3 transition-shadow",
        item.status === "sleeping" && "opacity-60",
        highlighted && "ring-2 ring-teal",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-medium text-ink">{item.title}</p>
          <p className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-graphite">{item.goal}</p>
        </div>
        <div className="relative shrink-0">
          <button
            aria-label={`${item.title} 更多操作`}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v);
              setConfirmingDelete(null);
            }}
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 top-6 z-50 flex w-40 flex-col rounded-card border border-line bg-card p-1 shadow-subtle">
                <MenuRow icon={<Pencil size={12} />} label="编辑" onClick={() => { setMenuOpen(false); onEdit(); }} />
                {item.status === "ready" && (
                  <MenuRow icon={<ArrowUp size={12} />} label="上移（更优先）" onClick={() => { setMenuOpen(false); onMove(item.id, -1); }} />
                )}
                {item.status === "ready" && (
                  <MenuRow icon={<ArrowDown size={12} />} label="下移" onClick={() => { setMenuOpen(false); onMove(item.id, 1); }} />
                )}
                {item.status === "sleeping" && (
                  <MenuRow icon={<CircleCheck size={12} />} label="唤醒" onClick={() => { setMenuOpen(false); void wake(item.id); }} />
                )}
                {isActiveStatus(item.status) && item.status !== "executing" && item.status !== "awaiting_confirm" && (
                  <MenuRow icon={<BellOff size={12} />} label="休眠（不再提议）" onClick={() => { setMenuOpen(false); void sleep(item.id); }} />
                )}
                <MenuRow
                  icon={<Trash2 size={12} />}
                  label={confirmingDelete === item.id ? "确认删除？" : "删除"}
                  danger
                  onClick={() => {
                    if (confirmingDelete !== item.id) {
                      setConfirmingDelete(item.id);
                      return;
                    }
                    setMenuOpen(false);
                    void remove(item.id);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("shrink-0 whitespace-nowrap rounded-chip px-2 py-0.5 text-caption", STATUS_CHIP[item.status])}>
          {BACKLOG_STATUS_LABEL[item.status]}
        </span>
        {item.size !== null && (
          <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">{item.size === "big" ? "大" : "小"}</span>
        )}
        {item.source === "inbox" && <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">收件箱</span>}
        {/* 打勾门：勾 = 闲时自动执行。done 收档不显示；ready/sleeping 可操作；
            其余状态（执行中/待验收/提议挂起）显示但禁用，等回到可操作态再勾 */}
        {item.status !== "done" && (
          <label
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-chip px-2 py-0.5 text-caption",
              item.auto ? "bg-gain/10 text-gain" : "bg-line-soft text-ash",
              autoCheckable ? "cursor-pointer" : "cursor-not-allowed opacity-70",
            )}
            title="闲时执行（打勾门）：勾上 = 工作台空闲且余量足够时自动派发，跑完自动验收；取消 = 不再自动执行，只能手动跑或重新勾选。任何编辑保存后会自动取消勾，需重新勾选才会再进闲时队列。总开关在本栏头部「闲时执行」。"
          >
            <input
              type="checkbox"
              checked={item.auto}
              disabled={!autoCheckable}
              onChange={(e) => void updateItem(item.id, { auto: e.target.checked })}
              className="accent-teal"
            />
            闲时执行
          </label>
        )}
        {/* != null（不是 !== null）：旧 daemon 的条目没有 targetSessionId 字段，
            undefined 漏过严格不等会让 .slice 直接掀翻整页渲染 */}
        {item.targetSessionId != null && item.targetSessionId !== "" && (
          <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 font-mono text-caption text-ash" title="指定在已有会话里执行（接不上回落新开）">
            会话 {item.targetSessionId.slice(0, 10)}
          </span>
        )}
        {item.status === "sleeping" && item.ignoreCount > 0 && (
          <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">忽略 {item.ignoreCount} 次</span>
        )}
      </div>

      {item.lastError !== null && (
        <p className="flex items-start gap-1.5 rounded-btn bg-loss/5 px-2 py-1.5 text-caption text-loss">
          <CircleAlert size={12} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{item.lastError}</span>
        </p>
      )}
      {item.reviewNote !== null && (
        <p className="rounded-btn bg-rail px-2 py-1.5 text-caption text-graphite">验收备注：{item.reviewNote}</p>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line-soft pt-2.5 text-caption">
        <div className="min-w-0">
          <dt className="text-ash">归属</dt>
          <dd className="truncate text-graphite">{unitName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">执行器</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-graphite">{item.runtimeId === "" ? "—" : item.runtimeId}</span>
            <span
              className={cn(
                "shrink-0 rounded-chip px-1.5 py-px text-caption",
                item.launchMode === "headless" ? "bg-line-soft text-ash" : "bg-teal-tint text-teal",
              )}
              title={
                item.launchMode === "headless"
                  ? "纯后台 headless 会话执行"
                  : item.launchMode === "chat"
                    ? "确认后把会话开在主聊天页前台（可看可插话）"
                    : "确认后在前端拉起执行器 TUI（免审批）"
              }
            >
              {item.launchMode === "headless" ? "后台" : item.launchMode === "chat" ? "对话页" : "TUI"}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">最近运行</dt>
          <dd className="truncate text-graphite">
            {lastRun === undefined || lastRun === null
              ? "从未"
              : `${lastRun.status === "done" ? "完成" : lastRun.status === "failed" ? "失败" : "运行中"} · ${formatBacklogRelative(lastRun.startedAt)}`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">上次提议</dt>
          <dd className="truncate text-graphite">{item.lastProposedAt === null ? "—" : formatBacklogRelative(item.lastProposedAt)}</dd>
        </div>
      </dl>

      {/* 状态化动作带：可换行，按钮/状态一律不内折（窄窗口宁可整枚换行） */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line-soft pt-2.5">
        {item.status === "ready" && (
          <button
            onClick={() => void runNow(item.id)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <Play size={12} />
            立即执行
          </button>
        )}
        {item.status === "sleeping" && (
          <button
            onClick={() => void wake(item.id)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <CircleCheck size={12} />
            唤醒
          </button>
        )}
        {item.status === "awaiting_review" && (
          <div className="flex w-full items-center gap-1.5">
            {rejectNote !== null ? (
              <>
                <input
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  placeholder="打回原因（可选）"
                  className="min-w-0 flex-1 rounded-input border border-transparent bg-rail px-2 py-1 text-caption text-ink outline-none focus:border-teal"
                />
                <button
                  onClick={() => {
                    void review(item.id, false, rejectNote.trim() === "" ? undefined : rejectNote.trim());
                    setRejectNote(null);
                  }}
                  className="shrink-0 rounded-btn bg-ink px-2 py-1 text-caption text-canvas hover:opacity-90"
                >
                  确认打回
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => void review(item.id, true)}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn bg-gain/10 px-2 py-1 text-caption text-gain hover:bg-gain/20"
                >
                  <CircleCheck size={12} />
                  验收通过
                </button>
                <button
                  onClick={() => setRejectNote("")}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-2 py-1 text-caption text-loss hover:bg-loss/10"
                >
                  <CircleAlert size={12} />
                  打回重跑
                </button>
              </>
            )}
          </div>
        )}
        {item.status === "executing" && (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-blue-500">
            <CircleDot size={12} className="animate-pulse" />
            长任务执行中（{lastRun?.runtimeId ?? item.runtimeId}）
            {lastRun?.sessionId != null && (
              <button
                onClick={() => {
                  // 监控 tab 按 owner 过滤可见：任务可能属于别的 bot，先切过去再开
                  const w = useWorkbench.getState();
                  if (String(w.activeUnitId) !== String(item.unitId)) w.selectUnit(asUnitId(item.unitId));
                  useSidePane.getState().openLiveSession({
                    unitId: asUnitId(item.unitId),
                    sessionId: lastRun.sessionId!,
                    runtimeId: lastRun.runtimeId ?? item.runtimeId,
                    title: item.title,
                  });
                }}
                className="ml-1 rounded-btn px-1.5 py-0.5 text-caption text-teal underline-offset-2 hover:bg-line-soft hover:underline"
                title="在右侧实时监控此会话（执行器挂死/卡住一眼可见）"
              >
                查看会话
              </button>
            )}
          </span>
        )}
        {item.status === "awaiting_confirm" && (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-amber-600">
            <AlarmClockCheck size={12} />
            提议挂起 —— 看右下角横幅确认
          </span>
        )}
        {item.status === "done" && <span className="shrink-0 whitespace-nowrap text-caption text-ash">已关闭 · {formatBacklogRelative(item.updatedAt)}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 空态 */

function EmptyPanel({ filter, onCreate, config }: { filter: Filter; onCreate: () => void; config: BacklogConfig | null }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
      <ListTodo size={16} className="mb-2 text-ash" />
      <p className="text-body-sm font-medium text-ink">{filter === "active" ? "还没有待办" : `没有「${FILTERS.find((f) => f.id === filter)?.label}」的待办`}</p>
      <p className="mt-1 max-w-[460px] text-body-sm leading-relaxed text-graphite">
        左栏写下的目标会被 routing 沉淀成这里的任务 —— 也可以直接新建，或在每个单元的 GTD.md
        里追加一行，每日统合自动收进清单{config?.consolidate.enabled ? "" : "（统合当前关闭）"}。
      </p>
      <button
        onClick={onCreate}
        className="mt-3 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
      >
        新建第一条待办
      </button>
    </div>
  );
}
