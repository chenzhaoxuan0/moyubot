import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlarmClockCheck,
  ArrowDown,
  ArrowUp,
  BellOff,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  HeartPulse,
  History,
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
  WORK_PHASE_LABEL,
  type BacklogConfig,
  type BacklogItem,
  type BacklogStatus,
  type QuotaHeadroom,
  type WorkPhase,
} from "../core/backlog.ts";
import { formatAbsoluteHuman } from "../core/automation.ts";
import { fetchBacklogRuns, type BacklogRunRow } from "../adapters/daemon/client.ts";
import { defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
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
 * 清单页右栏 —— 推进面板：按状态机分组的任务总览（执行中 → 待验收 → 待确认
 * → 排队 → 休眠 → 完成），排队组亮「下一条」与前置条件（当前判定，不承诺
 * ETA），卡片带运行历史（trigger 来源）。左栏点任务链接 / 通知深链时
 * highlightId 命中的卡片滚动进入视野并短暂高亮。
 *
 * 栏头是待办这一侧的功能钮：「闲时执行」总开关（关 = 空闲不再派发 auto 任务，
 * 手动「立即执行」不受影响）、待办设置、强制忙碌、跳一跳、新建。行1 顺带
 * 今日完成计数，行2 状态行顺带定时带（钟控轴下次发火时刻）—— 栏头严格
 * 两行与左栏等高，不加第三行。
 */

const PHASE_DOT: Record<WorkPhase, string> = {
  busy: "bg-line-strong",
  idle: "bg-gain animate-pulse",
  beating: "bg-teal animate-pulse",
  awaiting_confirm: "bg-amber-500 animate-pulse",
  executing: "bg-blue-500 animate-pulse",
  awaiting_review: "bg-violet-500",
};

/** 与引擎 AUTOPILOT_FAILURE_BACKOFF_MS 同口径：最近一次失败 10 分钟内退避 */
const FAILURE_BACKOFF_MS = 10 * 60_000;

type GroupId = "executing" | "awaiting_review" | "awaiting_confirm" | "ready" | "sleeping" | "draft" | "today_done" | "older_done";

/**
 * 状态分组全量常驻（用户拍板：全部分组都要可见）—— 布局是看板式的固定骨架，
 * 位置可学习：扫一眼就知道哪里有东西、哪里空着。空组不隐藏，显示占位提示；
 * 默认全展开（折叠只是临时收纳动作，不作为初始态）。
 */
const GROUPS: readonly { id: GroupId; label: string; emptyHint: string }[] = [
  { id: "executing", label: "执行中", emptyHint: "没有正在执行的任务" },
  { id: "awaiting_review", label: "待验收", emptyHint: "没有待验收的任务" },
  { id: "awaiting_confirm", label: "待确认", emptyHint: "没有待确认的提议" },
  { id: "ready", label: "排队", emptyHint: "队列为空" },
  { id: "sleeping", label: "休眠", emptyHint: "没有休眠的任务" },
  { id: "draft", label: "草稿", emptyHint: "没有草稿" },
  { id: "today_done", label: "今日完成", emptyHint: "今天还没有完成的任务" },
  { id: "older_done", label: "更早完成", emptyHint: "没有更早的完成记录" },
];

function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function BacklogColumn({ highlightId }: { highlightId: number | null }): ReactElement {
  const items = useBacklog((s) => s.items);
  const state = useBacklog((s) => s.state);
  const config = useBacklog((s) => s.config);
  const quotas = useBacklog((s) => s.quotas);
  const automations = useWorkbench((s) => s.automations);
  const reorder = useBacklog((s) => s.reorder);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; item: BacklogItem } | null>(null);

  // 左栏「定位任务」/ 通知深链：滚到命中卡片（高亮 ring 由 highlightId 传进卡片渲染）
  useEffect(() => {
    if (highlightId === null) return;
    document.getElementById(`backlog-card-${highlightId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightId]);

  const activeCount = items.filter((i) => i.status !== "done").length;
  const autopilotOn = config?.autopilot.enabled ?? false;

  // 今日完成：done 且最近一次运行在今天收口（比 updatedAt 准 —— 编辑也会动它）
  const today0 = startOfToday();
  const isTodayDone = (i: BacklogItem): boolean => i.status === "done" && (i.lastRun?.finishedAt ?? 0) >= today0;

  const groups = useMemo(() => {
    const byGroup = new Map<GroupId, BacklogItem[]>();
    for (const g of GROUPS) byGroup.set(g.id, []);
    for (const i of items) {
      if (i.status === "done") byGroup.get(isTodayDone(i) ? "today_done" : "older_done")!.push(i);
      else if (i.status === "draft") byGroup.get("draft")!.push(i);
      else byGroup.get(i.status as Exclude<BacklogStatus, "done" | "draft">)!.push(i);
    }
    return byGroup;
    // isTodayDone 依赖 today0（挂载日的零点）——跨天停留页面时显式刷新分组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, today0]);

  const todayDoneCount = groups.get("today_done")!.length;

  // 定时带：钟控轴（automations）下次发火时刻 —— 钟控是真承诺，给确切时间；
  // 与余量轴（autopilot）形成双轴对照：那边只给前置条件，不给假 ETA
  const nextAutomationAt = useMemo(() => {
    const nexts = automations.filter((a) => a.enabled && typeof a.nextRunAt === "number").map((a) => a.nextRunAt as number);
    return nexts.length > 0 ? Math.min(...nexts) : null;
  }, [automations]);

  // 队列头：autopilot 的挑法（sortPos 序第一条 ready+auto，失败退避跳过）——
  // 这里只做展示对齐，真正的挑单在引擎
  const readyAuto = groups.get("ready")!.filter(
    (i) => i.auto && !(i.lastRun?.status === "failed" && Date.now() - i.lastRun.startedAt < FAILURE_BACKOFF_MS),
  );
  const queueHead = readyAuto[0] ?? null;
  const allReadyAutoBackoff = groups.get("ready")!.some((i) => i.auto) && readyAuto.length === 0;

  const precondition = queuePrecondition(state, config, quotas, autopilotOn, allReadyAutoBackoff);

  const move = (id: number, dir: -1 | 1): void => {
    const order = items.filter((i) => i.status !== "done").map((i) => i.id);
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
            <span className="shrink-0 text-caption font-normal text-ash">
              待办 · {activeCount} 条活跃{todayDoneCount > 0 ? ` · 今日完成 ${todayDoneCount}` : ""}
            </span>
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
              (state?.lastBeatOutcome != null ? ` · 上跳：${state.lastBeatOutcome}` : "") +
              (nextAutomationAt !== null ? ` · 下次定时 ${formatAbsoluteHuman(nextAutomationAt)}` : "")
            }
          >
            {state?.reason ?? "总状态计算中……"}
            {state?.nextBeatAt != null && state.heartbeatEnabled && ` · 下次心跳 ${formatBacklogRelative(state.nextBeatAt)}`}
            {state?.lastBeatOutcome != null && ` · 上跳：${state.lastBeatOutcome}`}
            {nextAutomationAt !== null && ` · 下次定时 ${formatAbsoluteHuman(nextAutomationAt)}`}
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

      {items.length === 0 && <EmptyPanel onCreate={() => setDialog({ mode: "create" })} config={config} />}

      {/* 全量常驻：空组也渲染（占位提示），组位置固定可学习 */}
      <div className="space-y-5">
        {GROUPS.map((g) => {
          const list = groups.get(g.id)!;
          const isCollapsed = collapsed[g.id] ?? false;
          return (
            <section key={g.id}>
              <h3 className="mb-2 flex items-center gap-2">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                  className="flex items-center gap-1 text-ash hover:text-graphite"
                  aria-label={`${g.label}分组${isCollapsed ? "展开" : "折叠"}`}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <span className={cn("text-body-sm font-medium", g.id === "today_done" || g.id === "older_done" ? "text-ash" : "text-ink")}>{g.label}</span>
                <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">{list.length}</span>
                {g.id === "ready" && queueHead !== null && (
                  <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal" title="空闲且余量够时，下一拍派发的就是它">
                    下一条
                  </span>
                )}
              </h3>

              {/* 排队组的前置条件行：当前判定（余量轴不承诺 ETA —— 条件可验证，预测是撒谎） */}
              {g.id === "ready" && (queueHead !== null || allReadyAutoBackoff) && precondition !== null && (
                <p className="mb-2 rounded-btn bg-rail px-2.5 py-1.5 text-caption text-graphite" title="autopilot 此刻为什么没派发 —— 引擎 20 秒一拍，条件变了下一拍就动">
                  当前判定：{precondition}
                </p>
              )}

              {!isCollapsed &&
                (list.length === 0 ? (
                  <p className="rounded-btn border border-dashed border-line px-2.5 py-2 text-caption text-ash">{g.emptyHint}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {list.map((item) => (
                      <BacklogCard
                        key={item.id}
                        item={item}
                        onEdit={() => setDialog({ mode: "edit", item })}
                        confirmingDelete={confirmingDelete}
                        setConfirmingDelete={setConfirmingDelete}
                        onMove={move}
                        highlighted={highlightId === item.id}
                        isQueueHead={g.id === "ready" && queueHead !== null && queueHead.id === item.id}
                      />
                    ))}
                  </div>
                ))}
            </section>
          );
        })}
      </div>

      {dialog !== null && (
        <BacklogDialog key={dialog.mode === "edit" ? dialog.item.id : "new"} initial={dialog.mode === "edit" ? dialog.item : null} onClose={() => setDialog(null)} />
      )}
      {settingsOpen && <BacklogSettings onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}

/**
 * 队列头为什么还没跑 —— 全部从快照现有字段推导（引擎的判定口径），零新增后端。
 * 返回 null = 说不出话（快照还没到），宁可不说也不编。
 */
function queuePrecondition(
  state: import("../core/backlog.ts").BacklogStateSnapshot | null,
  config: BacklogConfig | null,
  quotas: readonly QuotaHeadroom[],
  autopilotOn: boolean,
  allBackoff: boolean,
): string | null {
  if (!autopilotOn) return "闲时执行总开关已关 —— 队列静默（手动执行不受影响）";
  if (allBackoff) return "排队任务全部在失败退避中（10 分钟窗口）";
  if (state === null) return null;
  if (state.forceBusy) return "强制忙碌中 —— 不派发";
  if (state.phase === "beating") return "心跳评估中 —— autopilot 让路";
  if (state.phase === "awaiting_confirm") return "有提议挂起等确认";
  if (state.phase === "executing" || state.phase === "awaiting_review") return state.reason;
  if (state.phase === "busy") return state.reason;
  // idle：引擎没派只可能是余量门（或刚好在两拍之间）
  if (state.lastBeatOutcome === "autopilot:no-headroom") {
    const floor = config?.autopilot.headroomFloorPercent ?? 10;
    const resets = quotas.filter((q) => q.resetsAt !== null).map((q) => q.resetsAt as number);
    const nextReset = resets.length > 0 ? Math.min(...resets) : null;
    return `余量低于地板（${floor}%）${nextReset !== null ? ` · 最近重置 ${formatAbsoluteHuman(nextReset)}` : ""}`;
  }
  return "空闲 —— 等下一拍（20 秒内）";
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

const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  autopilot: "闲时",
  manual: "手动",
  gtd: "心跳",
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function BacklogCard({
  item,
  onEdit,
  confirmingDelete,
  setConfirmingDelete,
  onMove,
  highlighted,
  isQueueHead,
}: {
  item: BacklogItem;
  onEdit: () => void;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  onMove: (id: number, dir: -1 | 1) => void;
  highlighted: boolean;
  isQueueHead: boolean;
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
  const [runsOpen, setRunsOpen] = useState(false);
  const [runs, setRuns] = useState<readonly BacklogRunRow[] | null>(null);

  // 展开时拉一次；重开时清缓存重拉（展开看的是当下最新的历史，不是首开快照）
  useEffect(() => {
    if (!runsOpen || runs !== null) return;
    void fetchBacklogRuns(item.id, 10, defaultDaemonEndpoint())
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [runsOpen, runs, item.id]);

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
                {item.status !== "done" && item.status !== "executing" && item.status !== "awaiting_confirm" && (
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
        {isQueueHead && (
          <span className="shrink-0 whitespace-nowrap rounded-chip bg-teal-tint px-2 py-0.5 text-caption text-teal" title="空闲且余量够时，autopilot 下一拍派发的就是它">
            下一条
          </span>
        )}
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
          <dt className="text-ash">跑过次数</dt>
          <dd className="truncate text-graphite">
            {item.runCount} 次{item.lastProposedAt !== null ? ` · 上次提议 ${formatBacklogRelative(item.lastProposedAt)}` : ""}
          </dd>
        </div>
      </dl>

      {/* 运行历史：懒加载，trigger 标来源（闲时托管 / 手动 / 心跳确认后） */}
      {runsOpen && (
        <div className="flex flex-col gap-1 rounded-btn bg-rail px-2.5 py-2">
          {runs === null ? (
            <p className="text-caption text-ash">加载运行记录…</p>
          ) : runs.length === 0 ? (
            <p className="text-caption text-ash">还没有运行记录</p>
          ) : (
            runs.map((r) => (
              <div key={r.runId} className="flex items-center gap-2 text-caption">
                {r.status === "done" ? (
                  <CircleCheck size={11} className="shrink-0 text-gain" />
                ) : r.status === "failed" ? (
                  <CircleAlert size={11} className="shrink-0 text-loss" />
                ) : (
                  <CircleDot size={11} className="shrink-0 animate-pulse text-blue-500" />
                )}
                <span className="shrink-0 text-graphite">{r.status === "done" ? "完成" : r.status === "failed" ? "失败" : "运行中"}</span>
                <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-ash">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                <span className="shrink-0 text-ash">{formatBacklogRelative(r.startedAt)}</span>
                {r.finishedAt !== null && <span className="shrink-0 text-ash">· {fmtDuration(r.finishedAt - r.startedAt)}</span>}
                {r.detail !== null && (
                  <span className="min-w-0 truncate text-ash" title={r.detail}>
                    {r.detail}
                  </span>
                )}
                {/* headless/chat run 有事件账本可回放；autoterm_ 前缀是终端 id 没有事件流 */}
                {r.sessionId != null && r.sessionId !== "" && !r.sessionId.startsWith("autoterm_") && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      const w = useWorkbench.getState();
                      if (String(w.activeUnitId) !== String(item.unitId)) w.selectUnit(asUnitId(item.unitId));
                      useSidePane.getState().openLiveSession({
                        unitId: asUnitId(item.unitId),
                        sessionId: r.sessionId!,
                        runtimeId: r.runtimeId === "" ? item.runtimeId : r.runtimeId,
                        title: item.title,
                      });
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter" && ev.key !== " ") return;
                      const w = useWorkbench.getState();
                      if (String(w.activeUnitId) !== String(item.unitId)) w.selectUnit(asUnitId(item.unitId));
                      useSidePane.getState().openLiveSession({
                        unitId: asUnitId(item.unitId),
                        sessionId: r.sessionId!,
                        runtimeId: r.runtimeId === "" ? item.runtimeId : r.runtimeId,
                        title: item.title,
                      });
                    }}
                    title="在右侧面板跟随这次运行的事件流（在跑实时看，已结束可回放）"
                    className="ml-auto flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
                  >
                    监控
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* 状态化动作带：可换行，按钮/状态一律不内折（窄窗口宁可整枚换行） */}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line-soft pt-2.5">
        <button
          onClick={() => {
            const next = !runsOpen;
            setRunsOpen(next);
            if (next) setRuns(null);
          }}
          aria-expanded={runsOpen}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-1.5 py-1 text-caption transition",
            runsOpen ? "bg-line-soft text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
          )}
          title="这条任务每次运行的记录：来源（闲时/手动/心跳）、时间、时长与结果"
        >
          <History size={12} />
          运行历史（{item.runCount}）
        </button>
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

function EmptyPanel({ onCreate, config }: { onCreate: () => void; config: BacklogConfig | null }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
      <ListTodo size={16} className="mb-2 text-ash" />
      <p className="text-body-sm font-medium text-ink">还没有待办</p>
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
