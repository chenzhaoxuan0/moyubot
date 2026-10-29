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
  RefreshCw,
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
import { useWorkbench, visibleModelsFor } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { asUnitId } from "../core/units.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { BacklogDialog } from "./BacklogDialog.tsx";
import { NumField } from "./NumField.tsx";
import { cn } from "./cn.ts";

/**
 * 待办清单页 —— 目标维度的任务面板（与自动化页对照：那边是"给定过程"）。
 *
 * 权威数据在 daemon；本页 30s 轮询 + 信号驱动刷新。
 * 顺序即优先级（上移/下移写回 sortPos）；验收（通过/打回带备注）是 GTD 的回顾环节。
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

export function BacklogPage(): ReactElement {
  const items = useBacklog((s) => s.items);
  const state = useBacklog((s) => s.state);
  const config = useBacklog((s) => s.config);
  const notice = useBacklog((s) => s.notice);
  const setNotice = useBacklog((s) => s.setNotice);
  const refresh = useBacklog((s) => s.refresh);
  const reorder = useBacklog((s) => s.reorder);

  const [filter, setFilter] = useState<Filter>("active");
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; item: BacklogItem } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  const visible = useMemo(
    () => items.filter((i) => (filter === "active" ? isActiveStatus(i.status) : i.status === filter)),
    [items, filter],
  );
  const activeCount = items.filter((i) => isActiveStatus(i.status)).length;

  const move = (id: number, dir: -1 | 1): void => {
    const order = items.filter((i) => isActiveStatus(i.status)).map((i) => i.id);
    const from = order.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    void reorder(order);
  };

  return (
    /* 头在滚动容器之外（固定 48px + 下方 flex-1 滚动）：滚动条不再越过 HEAD */
    <div className="flex h-full min-h-0 flex-col">
      {/* titlebar-drag 挂整宽外层条；no-drag 占位绝对锚定行右缘（落在窗口按钮带
          正下方——留在居中列里会在头右侧挖出一个拖不动的洞） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">待办</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">目标驱动 · 空闲心跳 · 确认门</span>
        </div>
        <div
          aria-hidden
          className="titlebar-no-drag absolute right-0 top-0 h-full"
          style={{ width: "var(--wco-w, 0px)" }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-5">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-body-lg font-medium text-ink">
              <span className={cn("h-2 w-2 rounded-full", PHASE_DOT[state?.phase ?? "busy"])} />
              {WORK_PHASE_LABEL[state?.phase ?? "busy"]}
              <span className="text-caption font-normal text-ash">{activeCount} 条活跃</span>
            </h1>
            <p className="mt-0.5 text-body-sm text-graphite">
              {state?.reason ?? "总状态计算中……"}
              {state?.nextBeatAt != null && state.heartbeatEnabled && ` · 下次心跳 ${formatBacklogRelative(state.nextBeatAt)}`}
              {state?.lastBeatOutcome != null && ` · 上跳：${state.lastBeatOutcome}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <HeaderBtn icon={HeartPulse} label={state?.forceBusy ? "解除强制忙碌" : "强制忙碌"} onClick={() => void useBacklog.getState().setForceBusy(!(state?.forceBusy ?? false))} active={state?.forceBusy} />
            <HeaderBtn icon={Zap} label="跳一跳" onClick={() => void useBacklog.getState().forceBeat()} />
            <HeaderBtn icon={Settings2} label="心跳设置" onClick={() => setSettingsOpen(true)} active={settingsOpen} />
            <button
              onClick={() => setDialog({ mode: "create" })}
              className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
            >
              <ListTodo size={12} />
              新建
            </button>
          </div>
        </header>

        {notice !== null && (
          <div
            role="status"
            className={cn(
              "mb-4 flex items-start gap-2 rounded-btn px-3 py-2 text-body-sm",
              notice.kind === "error" ? "bg-loss/10 text-loss" : notice.kind === "success" ? "bg-gain/10 text-gain" : "bg-teal-tint text-teal",
            )}
          >
            <CircleAlert size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{notice.text}</span>
            <button onClick={() => setNotice(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100" aria-label="关闭提示">
              ×
            </button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
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
          <div className="grid grid-cols-2 gap-3">
            {visible.map((item) => (
              <BacklogCard key={item.id} item={item} onEdit={() => setDialog({ mode: "edit", item })} confirmingDelete={confirmingDelete} setConfirmingDelete={setConfirmingDelete} onMove={move} />
            ))}
          </div>
        )}
      </div>

      {dialog !== null && (
        <BacklogDialog key={dialog.mode === "edit" ? dialog.item.id : "new"} initial={dialog.mode === "edit" ? dialog.item : null} onClose={() => setDialog(null)} />
      )}
      {settingsOpen && <BacklogSettings onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
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
}: {
  item: BacklogItem;
  onEdit: () => void;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  onMove: (id: number, dir: -1 | 1) => void;
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
    <div className={cn("relative flex flex-col gap-2.5 rounded-card border border-line bg-card px-4 py-3", item.status === "sleeping" && "opacity-60")}>
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
            title="闲时执行（打勾门）：勾上 = 工作台空闲且余量足够时自动派发，跑完自动验收；取消 = 不再自动执行，只能手动跑或重新勾选。任何编辑保存后会自动取消勾，需重新勾选才会再进闲时队列。"
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

function MenuRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }): ReactElement {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-btn px-2 py-1.5 text-left text-caption transition hover:bg-line-soft",
        danger === true ? "text-loss hover:text-loss" : "text-graphite hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyPanel({ filter, onCreate, config }: { filter: Filter; onCreate: () => void; config: BacklogConfig | null }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
      <ListTodo size={16} className="mb-2 text-ash" />
      <p className="text-body-sm font-medium text-ink">{filter === "active" ? "还没有待办" : `没有「${FILTERS.find((f) => f.id === filter)?.label}」的待办`}</p>
      <p className="mt-1 max-w-[460px] text-body-sm leading-relaxed text-graphite">
        写下目标，空闲心跳会在合适的时机提议启动 —— 也可以在每个单元的 GTD.md 里追加一行，
        每日统合自动收进清单{config?.consolidate.enabled ? "" : "（统合当前关闭）"}。
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

/* ------------------------------------------------------------------ 设置 */

function HeaderBtn({ icon: Icon, label, onClick, active }: { icon: typeof Zap; label: string; onClick: () => void; active?: boolean }): ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-btn transition",
        active ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      <Icon size={13} />
    </button>
  );
}

/** 心跳 / 余量 / 统合 / 飞书 四组配置（kv 权威，daemon 侧归一钳制） */
function BacklogSettings({ onClose }: { onClose: () => void }): ReactElement {
  const config = useBacklog((s) => s.config);
  const saveConfig = useBacklog((s) => s.saveConfig);
  const refreshQuotas = useBacklog((s) => s.refreshQuotas);
  const consolidate = useBacklog((s) => s.consolidate);
  const quotas = useBacklog((s) => s.quotas);
  const runtimes = useWorkbench((s) => s.runtimes);

  const hb = config?.heartbeat;
  // 旧 daemon / 旧前端状态里可能还没有 autopilot —— 兜一份默认值，别让设置页崩
  const ap = config?.autopilot ?? { enabled: false, maxConcurrent: 1, headroomFloorPercent: 10, autoReview: true };
  const [busy, setBusy] = useState(false);
  if (config === null || hb === undefined) {
    return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />;
  }

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    await saveConfig(patch);
    setBusy(false);
  };

  const minutesToClock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const clockToMinutes = (v: string): number => {
    const parts = v.split(":");
    const h = Number(parts[0] ?? NaN);
    const m = Number(parts[1] ?? NaN);
    return (Number.isFinite(h) ? h : 22) * 60 + (Number.isFinite(m) ? m : 0);
  };

  const hbRuntimes = ["", ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))];

  const runtimeIds = [...new Set([...Object.keys(config.runtimes), ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))])];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="心跳与余量设置"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Settings2 size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">心跳与余量设置</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-body-sm">
          {/* 心跳 */}
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <HeartPulse size={13} className="text-teal" />
              心跳
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={hb.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ heartbeat: { ...hb, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                启用
              </label>
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="心跳周期（分钟）" value={hb.intervalMinutes} min={5} max={1440} inputClassName={inputCls} onSave={(n) => void save({ heartbeat: { ...hb, intervalMinutes: n } })} />
              <NumField label="空闲阈值（分钟）" value={hb.idleMinutes} min={1} max={1440} inputClassName={inputCls} onSave={(n) => void save({ heartbeat: { ...hb, idleMinutes: n } })} />
              <NumField label="提议超时（分钟）" value={hb.proposalTimeoutMinutes} min={1} max={120} inputClassName={inputCls} onSave={(n) => void save({ heartbeat: { ...hb, proposalTimeoutMinutes: n } })} />
              <NumField label="连续忽略上限（次→休眠）" value={hb.maxIgnoreCount} min={1} max={10} inputClassName={inputCls} onSave={(n) => void save({ heartbeat: { ...hb, maxIgnoreCount: n } })} />
            </div>
            <label className="flex cursor-pointer items-start gap-1.5 text-caption text-graphite" title="默认关：取消打勾的任务不执行也不被打扰，打勾模型是主流程。打开后恢复旧的提议-确认门（空闲时心跳 agent 为未打勾任务弹提议，你确认才执行）。">
              <input
                type="checkbox"
                checked={hb.proposeNonAuto}
                disabled={busy}
                onChange={(e) => void save({ heartbeat: { ...hb, proposeNonAuto: e.target.checked } })}
                className="mt-0.5 accent-teal"
              />
              <span>
                为未打勾的任务弹提议（旧确认门流程，默认关）—— 关闭时，取消打勾的任务完全静默，只能手动执行或重新打勾
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="block text-body-sm text-ink" title="建议指到有冗余的订阅执行器。">
                  心跳会话的执行器
                </span>
                <select
                  value={hb.runtimeId}
                  disabled={busy}
                  onChange={(e) => void save({ heartbeat: { ...hb, runtimeId: e.target.value } })}
                  className={inputCls}
                >
                  {hbRuntimes.map((id) => (
                    <option key={id} value={id}>
                      {id === "" ? "（跟随心跳 bot 的主绑定）" : id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">模型（缺省跟随执行器）</span>
                <ModelSelect
                  runtimeId={`daemon:${hb.runtimeId}`}
                  value={hb.model ?? ""}
                  onChange={(v: string) => void save({ heartbeat: { ...hb, model: v === "" ? null : v } })}
                  className={inputCls}
                  disabled={busy || hb.runtimeId === ""}
                />
              </div>
            </div>
          </section>

          {/* 闲时自动执行（autopilot）—— 清单升级的引擎面 */}
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <Zap size={13} className="text-teal" />
              闲时自动执行
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={ap.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ autopilot: { ...ap, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                启用
              </label>
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <NumField
                label="同时在跑的上限"
                value={ap.maxConcurrent}
                min={1}
                max={4}
                inputClassName={inputCls}
                onSave={(n) => void save({ autopilot: { ...ap, maxConcurrent: n } })}
              />
              <NumField
                label="余量地板（%，低于不再派发）"
                value={ap.headroomFloorPercent}
                min={0}
                max={100}
                inputClassName={inputCls}
                onSave={(n) => void save({ autopilot: { ...ap, headroomFloorPercent: n } })}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
              <input
                type="checkbox"
                checked={ap.autoReview}
                disabled={busy}
                onChange={(e) => void save({ autopilot: { ...ap, autoReview: e.target.checked } })}
                className="accent-teal"
              />
              跑完自动验收（关了仍进待验收，人工过目）
            </label>
            <p className="text-[10px] leading-relaxed text-ash">
              只作用于勾了「闲时自动执行」的待办（清单分类沉淀的任务默认勾上）：工作台空闲且余量 ≥ 地板时直接派发，持续把清单做完。
              没勾的照旧走心跳提议 + 确认门。
            </p>
          </section>

          {/* 订阅执行器余量 */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <RefreshCw size={13} className="text-teal" />
              订阅执行器余量
              <button onClick={() => void refreshQuotas()} className="ml-auto rounded-btn px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink">
                刷新读数
              </button>
            </h3>
            <div className="space-y-1.5">
              {runtimeIds.map((id) => {
                const q = config.runtimes[id];
                const live = quotas.find((x) => x.runtimeId === id);
                return (
                  <div key={id} className="flex flex-wrap items-center gap-2 rounded-btn bg-rail px-2.5 py-2">
                    <label className="flex items-center gap-1.5 text-caption text-ink">
                      <input
                        type="checkbox"
                        checked={q?.subscribed ?? false}
                        disabled={busy}
                        onChange={(e) => void save({ runtimes: { [id]: { ...(q ?? { probeCmd: null, probeFormat: "raw", windowHours: 5, limit: null }), subscribed: e.target.checked } } })}
                        className="accent-teal"
                      />
                      <span className="font-mono">{id}</span>
                    </label>
                    {live !== undefined && (
                      <span className={cn("text-caption tnum", live.percent === null ? "text-ash" : live.percent > 30 ? "text-gain" : "text-loss")}>
                        {live.percent !== null ? `${live.percent}%` : "未知"}
                      </span>
                    )}
                    <input
                      defaultValue={q?.probeCmd ?? ""}
                      placeholder="配额命令（如 zcode quota）"
                      disabled={busy}
                      onBlur={(e) => void save({ runtimes: { [id]: { ...(q ?? { subscribed: true, probeFormat: "raw", windowHours: 5, limit: null }), probeCmd: e.target.value.trim() === "" ? null : e.target.value.trim() } } })}
                      className="min-w-0 flex-1 rounded-input border border-transparent bg-canvas px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
                    />
                    <select
                      defaultValue={q?.probeFormat ?? "raw"}
                      disabled={busy}
                      onChange={(e) => void save({ runtimes: { [id]: { ...(q ?? { subscribed: true, probeCmd: null, windowHours: 5, limit: null }), probeFormat: e.target.value } } })}
                      className="rounded-input border border-transparent bg-canvas px-1.5 py-1 text-caption text-ink outline-none"
                    >
                      <option value="zcode-quota">zcode 解析</option>
                      <option value="mmx-json">mmx JSON</option>
                      <option value="raw">原文</option>
                    </select>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-ash">
              有配额命令走实时探针（默认缓存 5 分钟）；没有的按本地账本 + 自配窗口上限估算，口径仅含本工作台会话。
            </p>
          </section>

          {/* 统合与飞书 */}
          <section className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <h3 className="text-body-sm font-medium text-ink">收件箱统合</h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={config.consolidate.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ consolidate: { ...config.consolidate, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                每日统合各单元 GTD.md
              </label>
              <div className="flex items-center gap-2 text-caption text-graphite">
                <input
                  type="time"
                  value={minutesToClock(config.consolidate.atMinutes)}
                  disabled={busy}
                  onChange={(e) => void save({ consolidate: { ...config.consolidate, atMinutes: clockToMinutes(e.target.value) } })}
                  className={cn(inputCls, "w-28")}
                />
                <span>触发</span>
              </div>
              <button
                onClick={() => void consolidate()}
                className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                立即统合一次
              </button>
            </div>
            <div className="space-y-2">
              <h3 className="text-body-sm font-medium text-ink">飞书通知与确认</h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={config.feishu.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ feishu: { ...config.feishu, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                提议/结果发飞书
              </label>
              <div className="space-y-1.5">
                <input
                  defaultValue={config.feishu.botId}
                  placeholder="出站 bot id（默认 steward）"
                  disabled={busy}
                  onBlur={(e) => void save({ feishu: { ...config.feishu, botId: e.target.value.trim() } })}
                  className={inputCls}
                />
                <input
                  defaultValue={config.feishu.receiveId}
                  placeholder="确认会话 chat_id（飞书里 @机器人 发「确认」也生效）"
                  disabled={busy}
                  onBlur={(e) => void save({ feishu: { ...config.feishu, receiveId: e.target.value.trim() } })}
                  className={inputCls}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";
