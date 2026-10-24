import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  History,
  Radio,
  Trash2,
  AlarmClock,
} from "lucide-react";
import {
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  describeSchedule,
  filterByStatus,
  formatRelative,
  formatAbsolute,
  formatAbsoluteHuman,
  nextRunAt as estimateNextRunAt,
  resolveStatusKind,
  type Automation,
  type StatusFilter,
  type Weekday,
} from "../core/automation.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { asUnitId } from "../core/units.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { fetchResumableSessions, type ResumableSession } from "../adapters/daemon/client.ts";
import type { AutomationDialogPrefill } from "./AutomationDialog.tsx";
import { cn } from "./cn.ts";

/**
 * 自动化面板 —— 对齐 ZCode 的 AutomationsSection。
 *
 * 照搬的结构：
 *   状态筛选（全部/进行中/已完成/失败）
 *   卡片网格：名称 / 描述 / 频率徽章 / 下次运行 / 最近运行 / 状态徽章 / 开关 / 操作菜单
 *   空态时的模板宫格
 *
 * 两条从 ZCode 抄来的口径，都写在代码注释里，这里再强调一次因为很容易写错：
 * 1. **分组口径以卡片实际展示的状态徽章为准**，不是以内部字段为准。
 * 2. **切 tab 即回到「全部」筛选**，不恢复上次那个 tab 的旧筛选。
 *
 * 与 ZCode 的差异：ZCode 的「闲时」是低优先级的闲时任务，本项目暂未实现，
 * 所以没有该 tab。数据全部来自 daemon（SQLite 持久化 + 20s tick 调度），
 * 新建/开关/删除/立即运行都是 daemon RPC，失败会在顶部横幅说实话。
 */

/** 对话框的打开状态已上收 useShell.automationDialog（docs/23）：侧栏待触发行
 *  与本页共用一份弹窗，挂载点在 WorkspaceShell —— 这里只调 openAutomationDialog */

export function AutomationsPage() {
  const automations = useWorkbench((s) => s.automations);
  const units = useWorkbench((s) => s.units);
  const notice = useWorkbench((s) => s.automationNotice);
  const setNotice = useWorkbench((s) => s.setAutomationNotice);
  const refreshAutomations = useWorkbench((s) => s.refreshAutomations);
  const openAutomationDialog = useShell((s) => s.openAutomationDialog);
  const quotaResume = useBacklog((s) => s.quotaResume);
  const refreshBacklog = useBacklog((s) => s.refresh);
  const [resumableSessions, setResumableSessions] = useState<readonly ResumableSession[]>([]);

  const [filter, setFilter] = useState<StatusFilter>("all");

  // 挂载即拉一次 + 30s 轻轮询：daemon 是唯一权威，下一次运行的倒计时、
  // 运行记录的终态都要跟着它走 —— 不然「3 分钟后」会永远停在 3 分钟前
  useEffect(() => {
    void refreshAutomations();
    const timer = setInterval(() => void refreshAutomations(), 30_000);
    return () => clearInterval(timer);
  }, [refreshAutomations]);

  // 续跑判定态跟着同一节奏刷新：它解释「为什么现在有/没有那条续跑任务」，
  // 属于这个页面的信息，不该让用户跑到别处才知道。
  useEffect(() => {
    void refreshBacklog();
    const timer = setInterval(() => void refreshBacklog(), 30_000);
    return () => clearInterval(timer);
  }, [refreshBacklog]);

  // 卡片要显示「发到哪个对话」，得把可续接会话的标题拉下来做映射
  useEffect(() => {
    let cancelled = false;
    void fetchResumableSessions({ limit: 50 })
      .then((list) => {
        if (!cancelled) setResumableSessions(list);
      })
      .catch(() => {
        /* 拿不到就让卡片显示 id，不影响其余功能 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 通知 5 秒自动消失
  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  // 自动排的续跑用合成单元（quota:<runtimeId>），units 里查不到 ——
  // 回落到库里存的 unit_name，好过在卡片上显示一个「—」
  const unitName = (id: string, fallback?: string) => units.find((u) => u.id === id)?.name ?? fallback ?? "—";

  // 口径 1：按 resolveStatusKind 分组，它就是卡片徽章的来源
  const visible = useMemo(() => filterByStatus(automations, filter), [automations, filter]);

  // 续跑提示：只看启用中的执行器，且必须有「值得说一句」的事（排上了 / 有说明）
  const resumeStates = useMemo(() => {
    const qr = quotaResume;
    if (qr === null || !qr.enabled) return [];
    return qr.states.filter((s) => s.scheduledAutomationId !== null || s.note !== null);
  }, [quotaResume]);

  /**
   * 会话 id → 标题。卡片上的「发到已有对话」只存了 id，光有 id 用户判不出那是哪段对话。
   * 只拉**可续接**的：卡片上出现的目标对话本来就必须是能接回来的那些。
   * 拉不到就退化成显示 id（仍然诚实，只是不好看），不显示空白。
   */
  const sessionTitles = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of resumableSessions) m.set(s.id, s.title !== "" ? s.title : s.id);
    return m;
  }, [resumableSessions]);

  return (
    /* 头在滚动容器之外（固定 48px + 下方 flex-1 滚动）：sticky-in-scroller 的
       旧结构会让滚动条轨道顶到窗口最上缘，从 HEAD 上面穿出去压住窗口控制钮 */
    <div className="flex h-full min-h-0 flex-col">
      {/* 面包屑顶带 —— 统一在侧边栏返回工作台。titlebar-drag 挂整宽外层条，
          no-drag 占位绝对锚定行右缘（减法只对 drag 行的后代生效，且必须落在
          窗口按钮带正下方——留在居中列里会在头右侧挖出一个拖不动的洞） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">自动化</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">定时巡航与自动化触发</span>
        </div>
        <div
          aria-hidden
          className="titlebar-no-drag absolute right-0 top-0 h-full"
          style={{ width: "var(--wco-w, 0px)" }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
      {/* pt-5 与头部 mb-5 同值：说明行收进悬停后标题独占一行，顶部留白对齐下方间距 */}
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-5">

        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-body-lg font-medium text-ink" title="按日程自动派活给工作单元，跑完归档产出">
              自动化
            </h1>
          </div>
          <button
            onClick={() => openAutomationDialog({ mode: "create" })}
            className="flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
          >
            <Plus size={12} />
            新建
          </button>
        </header>

        {notice !== null && (
          <div
            role="status"
            className={cn(
              "mb-4 flex items-start gap-2 rounded-btn px-3 py-2 text-body-sm",
              notice.kind === "error" ? "bg-loss/10 text-loss" : "bg-teal-tint text-teal",
            )}
          >
            <CircleAlert size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{notice.text}</span>
            <button onClick={() => setNotice(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100" aria-label="关闭提示">
              ×
            </button>
          </div>
        )}

        {/* 用量续跑状态：只说「需要用户知道的事」。
            没排的时候必须说清楚为什么没排 —— 静默不响会让人以为功能坏了。
            disabled 的执行器不进这里：用户主动关掉的开关不该被反复念叨。 */}
        {resumeStates.length > 0 && (
          <div className="mb-4 space-y-1.5">
            {resumeStates.map((s) => (
              <div
                key={s.runtimeId}
                role="status"
                className="flex items-start gap-2 rounded-btn bg-amber-500/10 px-3 py-2 text-body-sm text-amber-600"
              >
                <AlarmClock size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{s.runtimeId}</span> 用量已用尽
                  {s.percent !== null && `（剩余 ${s.percent}%）`}
                  {s.fireAt !== null
                    ? ` · ${new Date(s.fireAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 自动发「继续」`
                    : ""}
                  {s.targetSessionId !== null && "到刚才中断的那个对话"}
                  {s.note !== null && ` · ${s.note}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 状态筛选 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="ml-auto flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  "rounded-chip px-2.5 py-1 text-caption",
                  filter === f
                    ? "bg-line-soft font-medium text-ink"
                    : "text-ash hover:text-graphite",
                )}
              >
                {STATUS_FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        {/* 卡片网格 */}
        {visible.length === 0 ? (
          <EmptyPanel
            icon={<CircleAlert size={16} />}
            title={filter === "all" ? "还没有定时任务" : `没有${STATUS_FILTER_LABEL[filter]}的任务`}
            desc={filter === "all" ? "从下面的模板挑一个开始" : "换个筛选看看"}
            templates={filter === "all"}
            onTemplate={(t) => openAutomationDialog({ mode: "create", prefill: t })}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((a) => (
              <AutomationCard
                key={a.id}
                a={a}
                unitName={unitName(a.unitId, a.unitName)}
                sessionTitles={sessionTitles}
                onEdit={() => openAutomationDialog({ mode: "edit", automation: a })}
              />
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 卡片 */

const STATUS_META = {
  inProgress: { icon: CircleDot, cls: "bg-line-soft text-graphite", label: "进行中" },
  completed: { icon: CircleCheck, cls: "bg-gain/10 text-gain", label: "已完成" },
  failed: { icon: CircleAlert, cls: "bg-loss/10 text-loss", label: "失败" },
} as const;

const RUN_STATUS_META = {
  running: { icon: CircleDot, cls: "text-graphite", label: "运行中" },
  completed: { icon: CircleCheck, cls: "text-gain", label: "完成" },
  failed: { icon: CircleAlert, cls: "text-loss", label: "失败" },
  skipped: { icon: CircleAlert, cls: "text-ash", label: "已跳过" },
} as const;

function AutomationCard({
  a,
  unitName,
  sessionTitles,
  onEdit,
}: {
  a: Automation;
  unitName: string;
  /** 会话 id → 标题：把 targetSessionId 翻译成人话，否则用户判不出是哪段对话 */
  sessionTitles: ReadonlyMap<string, string>;
  onEdit: () => void;
}) {
  const toggle = useWorkbench((s) => s.toggleAutomation);
  const runNow = useWorkbench((s) => s.runAutomationNowAction);
  const remove = useWorkbench((s) => s.deleteAutomationAction);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);

  const kind = resolveStatusKind(a);
  const meta = STATUS_META[kind];
  const Icon = meta.icon;
  // daemon 持久化的 next_run_at 是权威值；没有（旧数据 / 停用）再本地预估
  const next = a.enabled ? (a.nextRunAt ?? estimateNextRunAt(a)) : null;
  const last = a.runs.at(-1);

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2.5 rounded-card border border-line bg-card px-4 py-3",
        !a.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-medium text-ink">{a.name}</p>
          {a.description && (
            <p className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-graphite">
              {a.description}
            </p>
          )}
        </div>
        <div className="relative shrink-0">
          <button
            aria-label={`${a.name} 更多操作`}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v);
              setConfirmingDelete(false);
            }}
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <>
              {/* 点击外部即收起：全屏透明捕获层 */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 top-6 z-50 flex w-36 flex-col rounded-card border border-line bg-card p-1 shadow-subtle">
                <MenuItem
                  icon={<Pencil size={12} />}
                  label="编辑"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit();
                  }}
                />
                <MenuItem
                  icon={<History size={12} />}
                  label={runsOpen ? "收起运行记录" : "运行记录"}
                  onClick={() => {
                    setMenuOpen(false);
                    setRunsOpen((v) => !v);
                  }}
                />
                <MenuItem
                  icon={<Trash2 size={12} />}
                  label={confirmingDelete ? "确认删除？" : "删除"}
                  danger
                  onClick={() => {
                    if (!confirmingDelete) {
                      setConfirmingDelete(true);
                      return;
                    }
                    setMenuOpen(false);
                    void remove(a.id);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-graphite">
          {describeSchedule(a)}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip px-2 py-0.5 text-caption", meta.cls)}>
          <Icon size={12} />
          {meta.label}
        </span>
        {!a.enabled && (
          <span className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">已暂停</span>
        )}
        {/* 已跑次数（ZCode「Ran N times」口径）：与 maxRuns 分母分离，只报事实 */}
        {(a.runCount ?? 0) > 0 && (
          <span
            className="shrink-0 whitespace-nowrap rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash"
            title="累计已发火次数（含手动立即运行）"
          >
            已跑 {a.runCount} 次
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line-soft pt-2.5 text-caption">
        <div className="min-w-0">
          <dt className="text-ash">归属</dt>
          <dd className="truncate text-graphite">{unitName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">下次运行</dt>
          {/* 失败态弱化调度信息（ZCode hasAutomationFailureState 口径）：失败横幅
              已在卡片区优先展示，下次时间降为次要色，不与失败抢注意力 */}
          <dd
            className={cn("truncate", next ? (a.lastFailure ? "text-ash" : "text-graphite") : "text-ash")}
            title={next !== null ? formatAbsolute(next) : undefined}
          >
            {next === null ? (a.enabled ? "已跑完" : "—") : `${formatAbsoluteHuman(next)}（${formatRelative(next)}）`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">最近运行</dt>
          <dd className="truncate text-graphite">
            {last ? formatRelative(last.startedAt) : "从未"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ash">失败记录</dt>
          <dd className={cn("truncate", a.lastFailure ? "text-loss" : "text-graphite")}>
            {a.lastFailure ? formatRelative(a.lastFailure.at) : "无"}
          </dd>
        </div>
      </dl>

      {a.lastFailure && (
        <p className="flex items-start gap-1.5 rounded-btn bg-loss/5 px-2 py-1.5 text-caption text-loss">
          <CircleAlert size={12} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{a.lastFailure.reason}</span>
        </p>
      )}

      {runsOpen && (
        <div className="flex flex-col gap-1 rounded-btn bg-rail px-2.5 py-2">
          {a.runs.length === 0 ? (
            <p className="text-caption text-ash">还没有运行记录（daemon 保留最近若干条）</p>
          ) : (
            [...a.runs].reverse().map((r) => {
              const rm = (RUN_STATUS_META as Record<string, { icon: typeof CircleDot; cls: string; label: string }>)[r.status] ??
                RUN_STATUS_META.running;
              const RIcon = rm.icon;
              return (
                <div key={r.startedAt} className="flex items-center gap-2 text-caption">
                  <RIcon size={11} className={cn("shrink-0", rm.cls)} />
                  <span className="text-graphite">{rm.label}</span>
                  <span className="text-ash">{formatRelative(r.startedAt)}</span>
                  {r.summary !== undefined && (
                    <span className="min-w-0 truncate text-ash" title={r.summary}>
                      {r.summary}
                    </span>
                  )}
                  {/* headless run 有完整事件账本 —— 一键进右侧面板看它干了什么
                      （在跑实时看，已结束可回放）。TUI run 该列存的是 autoterm_ 前缀的
                      终端 id（后端同款判据），没有事件流；quota:<runtime> 合成单元
                      在 units 里查不到，live tab 会变成任何视角都不可见的无主 tab，
                      两类都不给入口 */}
                  {r.sessionId != null &&
                    r.sessionId !== "" &&
                    !r.sessionId.startsWith("autoterm_") &&
                    !a.unitId.startsWith("quota:") && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        // 监控 tab 按 owner 过滤可见：自动化可能属于别的 bot（本页是
                        // 全局页），不先切过去就是「点了没反应」（Sidebar/通知跳行同款守卫）
                        const w = useWorkbench.getState();
                        if (String(w.activeUnitId) !== String(a.unitId)) w.selectUnit(asUnitId(a.unitId));
                        useSidePane.getState().openLiveSession({
                          unitId: asUnitId(a.unitId),
                          sessionId: r.sessionId!,
                          runtimeId: a.runtimeId,
                          title: a.name,
                        });
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key !== "Enter" && ev.key !== " ") return;
                        const w = useWorkbench.getState();
                        if (String(w.activeUnitId) !== String(a.unitId)) w.selectUnit(asUnitId(a.unitId));
                        useSidePane.getState().openLiveSession({
                          unitId: asUnitId(a.unitId),
                          sessionId: r.sessionId!,
                          runtimeId: a.runtimeId,
                          title: a.name,
                        });
                      }}
                      title="在右侧面板跟随这次运行的事件流（在跑实时看，已结束可回放）"
                      className="ml-auto flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
                    >
                      <Radio size={9} />
                      监控
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* 底部两行：元信息带可换行（chip 一律不内折，宁可整枚换行），
          动作行独立 —— 此前七个元素挤一行，窄窗口时按钮被压成竖排文字 */}
      <div className="mt-auto space-y-2 border-t border-line-soft pt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap font-mono text-caption text-ash">{a.runtimeId}</span>
          {/* 投递目标：发给新对话 vs 往老对话里发一条。用户建任务时最容易误解的就是这个 */}
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded-chip px-1.5 py-px text-caption",
              a.dispatchTarget === "existing_session" ? "bg-teal-tint text-teal" : "bg-line-soft text-ash",
            )}
            title={a.dispatchTarget === "existing_session" ? "到点把提示词当一条消息发进已有的对话（对话已结束会自动接回来）" : "到点新开一个对话，把提示词当第一句话"}
          >
            {a.dispatchTarget === "existing_session" ? "发到已有对话" : "新对话"}
          </span>
          {/* 钉了具体对话就说清楚是哪一段 —— 「发到已有对话」本身用户无从判断 */}
          {a.dispatchTarget === "existing_session" && (
            <span
              className="min-w-0 max-w-[15rem] shrink truncate rounded-chip bg-line-soft px-1.5 py-px text-caption text-graphite"
              title={a.targetSessionId ?? undefined}
            >
              {a.targetSessionId === null || a.targetSessionId === undefined || a.targetSessionId === ""
                ? "自动选最近一个"
                : (sessionTitles.get(a.targetSessionId) ?? a.targetSessionId)}
            </span>
          )}
          {/* 自动排的续跑要标出来：否则用户看到一条自己没建过的任务会以为系统乱排 */}
          {a.origin === "quota_resume" && (
            <span
              className="shrink-0 whitespace-nowrap rounded-chip bg-amber-500/10 px-1.5 py-px text-caption text-amber-600"
              title="用量耗尽时自动排的续跑任务，到点往刚才中断的那个对话里发一句「继续」"
            >
              用量续跑
            </span>
          )}
          {/* 执行方式标记：TUI = 到点在前端拉终端；对话页 = 开在聊天页前台；后台 = headless 会话 */}
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded-chip px-1.5 py-px text-caption",
              a.launchMode === "headless" ? "bg-line-soft text-ash" : "bg-teal-tint text-teal",
            )}
            title={
              a.launchMode === "headless"
                ? "纯后台 headless 会话执行"
                : a.launchMode === "chat"
                  ? "到点把会话开在主聊天页前台（可看可插话）"
                  : "到点在前端拉起执行器 TUI（免审批）"
            }
          >
            {a.launchMode === "headless" ? "后台" : a.launchMode === "chat" ? "对话页" : "TUI"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void runNow(a.id)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-1.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
          >
            <Play size={12} />
            立即运行
          </button>
          <button
            role="switch"
            aria-checked={a.enabled}
            aria-label={`${a.name} 开关`}
            onClick={() => void toggle(a.id)}
            className={cn(
              "relative ml-auto h-5 w-9 shrink-0 rounded-chip transition",
              a.enabled ? "bg-teal" : "bg-line",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                a.enabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }): React.ReactElement {
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

/* ------------------------------------------------------------------ 空态 */

/** 模板 = 预填好的表单草稿（点开对话框，不是静默建任务 —— 用户得看到自己同意了什么） */
const TEMPLATES: readonly AutomationDialogPrefill[] = [
  { name: "每日内容产出", desc: "每天早上跑一次，产出当天草稿", prompt: "跑一遍今天的内容产出流程，把草稿写到 docs/drafts/ 下", freq: "daily", time: "08:00" },
  { name: "周报汇总", desc: "每周五下班前汇总本周进展", prompt: "汇总本周会话与产出，写一份周报到 docs/reports/", freq: "weekly", time: "18:30", weekdays: [5] },
  { name: "依赖巡检", desc: "每天检查依赖与工具版本", prompt: "检查依赖有没有新版本与安全告警，输出一份简短摘要", freq: "daily", time: "09:00" },
  { name: "剪藏入库", desc: "把新抓取内容归档进知识库", prompt: "把最近抓取的新内容归档进知识库并打标签", freq: "custom", interval: 6, unit: "hours" },
];

function EmptyPanel({
  icon,
  title,
  desc,
  templates,
  onTemplate,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  templates?: boolean;
  onTemplate: (t: AutomationDialogPrefill) => void;
}) {
  return (
    <div>
      <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
        <span className="mb-2 text-ash">{icon}</span>
        <p className="text-body-sm font-medium text-ink">{title}</p>
        <p className="mt-1 max-w-[420px] text-body-sm leading-relaxed text-graphite">{desc}</p>
      </div>

      {templates && (
        <>
          <p className="px-1 pb-2 pt-5 text-body-sm text-ash">从模板开始</p>
          <div className="grid grid-cols-2 gap-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => onTemplate(t)}
                className="flex flex-col gap-1.5 rounded-card bg-card px-4 py-3 text-left shadow-subtle hover:bg-surface-hover"
              >
                <span className="text-body-sm font-medium text-ink">{t.name}</span>
                <span className="text-caption text-graphite">{t.desc}</span>
                <span className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash w-fit">
                  {templateFreqLabel(t)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function templateFreqLabel(t: AutomationDialogPrefill): string {
  switch (t.freq) {
    case "delay":
      return "一次性";
    case "hourly":
      return "每小时";
    case "daily":
      return `每天 ${t.time ?? ""}`.trim();
    case "weekly":
      return `每周${(t.weekdays ?? []).map((d) => ["日", "一", "二", "三", "四", "五", "六"][d]).join("、")} ${t.time ?? ""}`.trim();
    case "monthly":
      return `每月 ${t.time ?? ""}`.trim();
    case "custom":
      return `每 ${t.interval ?? 1} ${{ minutes: "分钟", hours: "小时", days: "天", weeks: "周", months: "个月" }[t.unit ?? "hours"]}`;
  }
}
