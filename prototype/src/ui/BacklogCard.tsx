import { useEffect, useState, type ReactElement } from "react";
import {
  AlarmClockCheck,
  ArrowDown,
  ArrowUp,
  BellOff,
  CircleAlert,
  CircleCheck,
  CircleDot,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { BACKLOG_STATUS_LABEL, formatBacklogRelative, type BacklogItem, type BacklogStatus } from "../core/backlog.ts";
import { fetchBacklogRuns, defaultDaemonEndpoint, type BacklogRunRow } from "../adapters/daemon/client.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { asUnitId } from "../core/units.ts";
import { MenuRow } from "./WorklistBits.tsx";
import { cn } from "./cn.ts";

/**
 * 待办任务卡（时间轴嵌在事件块内 / 孤儿行直接渲染 / 队列态整行）。全交互保留：
 * 勾门、上下移（改 sortPos）、立即执行、验收带、运行历史、监控入口。
 */

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

export function BacklogCard({
  item,
  onEdit,
  confirmingDelete,
  setConfirmingDelete,
  onMove,
  highlighted,
  isQueueHead = false,
}: {
  item: BacklogItem;
  onEdit: () => void;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  onMove: (id: number, dir: -1 | 1) => void;
  highlighted: boolean;
  isQueueHead?: boolean;
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
            title="闲时执行（打勾门）：勾上 = 工作台空闲且余量足够时自动派发，跑完自动验收；取消 = 不再自动执行，只能手动跑或重新勾选。任何编辑保存后会自动取消勾，需重新勾选才会再进闲时队列。总开关在状态带「闲时执行」。"
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
