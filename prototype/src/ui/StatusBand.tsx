import type { ReactElement } from "react";
import { BellRing, HeartPulse, ListTodo, Settings2, Zap } from "lucide-react";
import { WORK_PHASE_LABEL, type BacklogConfig, type BacklogItem, type WorkPhase } from "../core/backlog.ts";
import { formatAbsoluteHuman } from "../core/automation.ts";
import { HeaderBtn } from "./WorklistBits.tsx";
import { Toggle } from "./Toggle.tsx";
import { cn } from "./cn.ts";
import type { SortMode, StatusCounts, StatusFilter } from "./worklistMetrics.ts";

/**
 * 状态带（时间轴顶部的机器状态总览，单列布局的「扫一眼」层）——三行：
 *   行1 工作相位 + 计数 + 两侧总开关与动作钮
 *   行2 状态计数 chips（点击=状态过滤）+ 下一条 + 当前判定 + 定时带
 *   行3 排序切换（时间=日志态 / 队列=sortPos 调度态）+ 标签过滤
 * 状态不是标签（docs/30）：推送型注意力住这条带子，拉取型组织住标签行。
 */

const PHASE_DOT: Record<WorkPhase, string> = {
  busy: "bg-line-strong",
  idle: "bg-gain animate-pulse",
  beating: "bg-teal animate-pulse",
  awaiting_confirm: "bg-amber-500 animate-pulse",
  executing: "bg-blue-500 animate-pulse",
  awaiting_review: "bg-violet-500",
};

const STATUS_CHIPS: readonly { id: StatusFilter; label: string; cls: string }[] = [
  { id: "executing", label: "执行中", cls: "bg-blue-500/10 text-blue-500" },
  { id: "awaiting_review", label: "待验收", cls: "bg-violet-500/10 text-violet-500" },
  { id: "awaiting_confirm", label: "待确认", cls: "bg-amber-500/10 text-amber-600" },
  { id: "backoff", label: "退避", cls: "bg-loss/10 text-loss" },
  { id: "sleeping", label: "休眠", cls: "bg-line-soft text-ash" },
];

export interface StatusBandProps {
  readonly phase: WorkPhase;
  readonly activeCount: number;
  readonly todayDoneCount: number;
  readonly counts: StatusCounts;
  readonly queueHead: BacklogItem | null;
  readonly precondition: string | null;
  readonly nextAutomationAt: number | null;
  readonly forceBusy: boolean;
  readonly autopilotOn: boolean;
  readonly autoClassifyOn: boolean;
  readonly sortMode: SortMode;
  readonly statusFilter: StatusFilter | null;
  readonly tagFilter: string | null;
  readonly tags: readonly { id: string; label: string }[];
  readonly onAutopilot: (on: boolean) => void;
  readonly onAutoClassify: (on: boolean) => void;
  readonly onForceBusy: () => void;
  readonly onForceBeat: () => void;
  readonly onCreate: () => void;
  readonly onBacklogSettings: () => void;
  readonly onViewPatch: (patch: { sortMode?: SortMode; statusFilter?: StatusFilter | null; tagFilter?: string | null }) => void;
  readonly onJumpQueueHead: () => void;
}

export function StatusBand(p: StatusBandProps): ReactElement {
  return (
    <div className="mb-4 space-y-2 rounded-card border border-line bg-card px-4 py-3">
      {/* 行1：工作相位 + 计数 | 清单侧总开关与动作 | 待办侧总开关与动作 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-2 text-body-sm font-medium text-ink">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", PHASE_DOT[p.phase])} />
          <span className="truncate">{WORK_PHASE_LABEL[p.phase]}</span>
        </span>
        <span className="shrink-0 text-caption text-ash">
          {p.activeCount} 条活跃{p.todayDoneCount > 0 ? ` · 今日完成 ${p.todayDoneCount}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-caption text-graphite"
            title="总开关：写进清单后是否自动交给 routing 分类。关闭时新内容停在「待分类」；已在跑的分类会话不受影响。"
          >
            <Toggle on={p.autoClassifyOn} ariaLabel="自动分类总开关" onChange={p.onAutoClassify} />
            自动分类
          </label>
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-caption text-graphite"
            title="总开关：工作台空闲时是否自动执行勾了「闲时执行」的待办。关闭后不再派发新任务（20 秒内生效）；手动「立即执行」与心跳确认不受影响。"
          >
            <Toggle on={p.autopilotOn} ariaLabel="闲时执行总开关" onChange={p.onAutopilot} />
            闲时执行
          </label>
          <HeaderBtn icon={Settings2} label="待办设置（心跳与余量）" onClick={p.onBacklogSettings} />
          <HeaderBtn icon={HeartPulse} label={p.forceBusy ? "解除强制忙碌" : "强制忙碌"} onClick={p.onForceBusy} active={p.forceBusy} />
          <HeaderBtn icon={Zap} label="跳一跳" onClick={p.onForceBeat} />
          <button
            onClick={p.onCreate}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
          >
            <ListTodo size={12} />
            新建任务
          </button>
        </div>
      </div>

      {/* 行2：状态计数 chips（点击过滤）+ 下一条 + 当前判定 + 定时带 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-caption">
        {STATUS_CHIPS.map((s) => {
          const n = p.counts[s.id];
          const active = p.statusFilter === s.id;
          return (
            <button
              key={s.id}
              onClick={() => p.onViewPatch({ statusFilter: active ? null : s.id })}
              aria-pressed={active}
              title={active ? `点掉「${s.label}」过滤` : `只看${s.label}的任务`}
              className={cn(
                "shrink-0 rounded-chip px-2 py-0.5 transition",
                active ? `${s.cls} font-medium ring-1 ring-line` : n > 0 ? s.cls : "bg-line-soft text-ash",
                n === 0 && !active && "opacity-70",
              )}
            >
              {s.label} {n}
            </button>
          );
        })}
        {p.queueHead !== null && (
          <button
            onClick={p.onJumpQueueHead}
            title="空闲且余量够时下一拍派发的就是它 —— 点击定位"
            className="flex min-w-0 shrink-0 items-center gap-1 rounded-chip bg-teal-tint px-2 py-0.5 text-teal hover:bg-teal hover:text-canvas"
          >
            下一条
            <span className="max-w-40 truncate">{p.queueHead.title}</span>
          </button>
        )}
        {p.precondition !== null && (
          <span className="min-w-0 flex-1 truncate text-ash" title={`当前判定：${p.precondition}（引擎 20 秒一拍，条件变了下一拍就动）`}>
            · {p.precondition}
          </span>
        )}
        {p.nextAutomationAt !== null && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-ash" title="钟控轴（定时任务/提醒）下次发火的确切时刻 —— 硬承诺给确切时间，与余量轴的当前判定对照">
            <BellRing size={11} />
            下次定时 {formatAbsoluteHuman(p.nextAutomationAt)}
          </span>
        )}
      </div>

      {/* 行3：排序切换 + 标签过滤 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-caption">
        <span className="flex shrink-0 overflow-hidden rounded-chip bg-line-soft">
          {(["time", "queue"] as const).map((m) => (
            <button
              key={m}
              onClick={() => p.onViewPatch({ sortMode: m })}
              aria-pressed={p.sortMode === m}
              title={m === "time" ? "按捕获时间排（日志态：发生过什么）" : "按优先级排（调度态：接下来干什么，sortPos 序）"}
              className={cn("px-2.5 py-0.5 transition", p.sortMode === m ? "bg-ink text-canvas" : "text-ash hover:text-graphite")}
            >
              {m === "time" ? "时间" : "队列"}
            </button>
          ))}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => p.onViewPatch({ tagFilter: null })}
            aria-pressed={p.tagFilter === null}
            className={cn("shrink-0 rounded-chip px-2 py-0.5 transition", p.tagFilter === null ? "bg-line-soft font-medium text-ink" : "text-ash hover:text-graphite")}
          >
            全部
          </button>
          {p.tags.map((t) => (
            <button
              key={t.id}
              onClick={() => p.onViewPatch({ tagFilter: p.tagFilter === t.id ? null : t.id })}
              aria-pressed={p.tagFilter === t.id}
              className={cn("shrink-0 rounded-chip px-2 py-0.5 transition", p.tagFilter === t.id ? "bg-line-soft font-medium text-ink" : "text-ash hover:text-graphite")}
              title={`只看标签「${t.label}」的条目`}
            >
              {t.label}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
