import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  BellRing,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  BACKLOG_STATUS_LABEL,
  formatBacklogRelative,
  type BacklogItem,
  type BacklogStatus,
} from "../core/backlog.ts";
import {
  DEFAULT_INBOX_CATEGORIES,
  INBOX_STATUS_LABEL,
  inboxCategoryLabel as categoryLabel,
  type InboxEntry,
} from "../core/inbox.ts";
import { formatAbsoluteHuman } from "../core/automation.ts";
import { createReminder, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useTaskJump, type TaskJumpTarget } from "../store/useTaskJump.ts";
import { BacklogCard } from "./BacklogCard.tsx";
import { BacklogDialog } from "./BacklogDialog.tsx";
import { BacklogSettings } from "./BacklogSettings.tsx";
import { InboxSettings } from "./InboxSettings.tsx";
import { StatusBand } from "./StatusBand.tsx";
import { MenuRow } from "./WorklistBits.tsx";
import { cn } from "./cn.ts";
import {
  inBackoff,
  nextAutomationAtOf,
  queueHeadOf,
  queuePrecondition,
  startOfToday,
  statusCounts,
  todayDoneCountOf,
  type SortMode,
  type StatusFilter,
} from "./worklistMetrics.ts";

/**
 * 时间轴工作区（单列，取代原两栏）—— 状态带 + 一列事件块：
 *
 * - 行 = 清单条目（事件块，点开展示它拆解出的任务）∪ 孤儿任务行（无源存量），
 *   按捕获时间倒序，sticky 日期刻度分段（今天/昨天/本周/更早），左侧时间沟
 * - **已读展开**：classifiedAt 晚于 seenAt 的块默认展开（转化完成看得见
 *   routing 的理解），seenAt 每 5 分钟 / 离开页面时滚动前推
 * - 待分类钉顶（routing 队列第一屏可见，分类器状态与「立即分类」就在块头）
 * - 双排序（时间=日志态 / 队列=sortPos 调度态）+ 标签/状态过滤（docs/30）
 */

const VIEW_KEY = "agent-workbench:worklist-view-v1";
const SEEN_KEY = "agent-workbench:worklist-seen-at";

interface ViewPrefs {
  readonly sortMode: SortMode;
  readonly statusFilter: StatusFilter | null;
  readonly tagFilter: string | null;
}

function loadViewPrefs(): ViewPrefs {
  const fallback: ViewPrefs = { sortMode: "time", statusFilter: null, tagFilter: null };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    if (raw === null) return fallback;
    const p = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      sortMode: p.sortMode === "queue" ? "queue" : "time",
      statusFilter:
        p.statusFilter === "executing" || p.statusFilter === "awaiting_review" || p.statusFilter === "awaiting_confirm" || p.statusFilter === "blocked" || p.statusFilter === "backoff" || p.statusFilter === "sleeping"
          ? p.statusFilter
          : null,
      tagFilter: typeof p.tagFilter === "string" && p.tagFilter !== "" ? p.tagFilter : null,
    };
  } catch {
    return fallback;
  }
}

function loadSeenAt(): number {
  if (typeof window === "undefined") return Date.now();
  try {
    const n = Number(window.localStorage.getItem(SEEN_KEY));
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  } catch {
    return Date.now();
  }
}

function persistSeenAt(n: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, String(n));
  } catch {
    /* 隐私模式：已读语义退化为本次会话 */
  }
}

/** 条目匹配状态过滤：块的去留看它有没有命中状态的卡 */
function taskMatchesStatus(t: BacklogItem, f: StatusFilter): boolean {
  if (f === "backoff") return inBackoff(t);
  return t.status === f;
}

/** 日期段标签（行序倒序，标签随时间单调变旧，分段天然连续） */
function sectionLabel(at: number): string {
  const today0 = startOfToday();
  if (at >= today0) return "今天";
  if (at >= today0 - 86_400_000) return "昨天";
  if (at >= today0 - 6 * 86_400_000) return "本周";
  return "更早";
}

function fmtHM(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type TimeRow =
  | { readonly key: string; readonly kind: "entry"; readonly at: number; readonly entry: InboxEntry }
  | { readonly key: string; readonly kind: "orphan"; readonly at: number; readonly task: BacklogItem };

export function TimelineColumn({ jumpTarget }: { jumpTarget: TaskJumpTarget | null }): ReactElement {
  const entries = useInbox((s) => s.entries);
  const inboxConfig = useInbox((s) => s.config);
  const classifier = useInbox((s) => s.classifier);
  const items = useBacklog((s) => s.items);
  const state = useBacklog((s) => s.state);
  const backlogConfig = useBacklog((s) => s.config);
  const quotas = useBacklog((s) => s.quotas);
  const automations = useWorkbench((s) => s.automations);
  const reorder = useBacklog((s) => s.reorder);

  const [view, setView] = useState<ViewPrefs>(loadViewPrefs);
  const [seenAt, setSeenAt] = useState<number>(loadSeenAt);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [backlogSettingsOpen, setBacklogSettingsOpen] = useState(false);
  const [inboxSettingsOpen, setInboxSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; item: BacklogItem } | null>(null);

  const patchView = (patch: Partial<ViewPrefs>): void => {
    setView((v) => {
      const next = { ...v, ...patch };
      try {
        window.localStorage.setItem(VIEW_KEY, JSON.stringify(next));
      } catch {
        /* 会话态退化 */
      }
      return next;
    });
  };

  // 已读线：每 5 分钟 / 离开页面时前推（挂载日的旧块全折叠）。
  // 顺手清掉两栏时代的分组偏好键（分组已随重构退役，别留脏数据吓未来的调试）
  useEffect(() => {
    try {
      window.localStorage.removeItem("agent-workbench:worklist-groups-v1");
    } catch {
      /* 清不掉无妨 */
    }
    const advance = (): void => {
      const n = Date.now();
      setSeenAt(n);
      persistSeenAt(n);
    };
    const timer = setInterval(advance, 300_000);
    window.addEventListener("beforeunload", advance);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", advance);
    };
  }, []);

  // 深链：跳到条目/任务卡 —— 先展开父块（导航动作，不写偏好），展开/切序重渲后再滚一拍。
  // inbox 锚点只在时间态存在：队列态收到 inbox 跳转先切回时间态（同样不写偏好）
  useEffect(() => {
    if (jumpTarget === null) return;
    if (jumpTarget.kind === "inbox" && view.sortMode === "queue") {
      setView((v) => (v.sortMode === "time" ? v : { ...v, sortMode: "time" }));
      return; // 等切序重渲后本效果再跑一拍，那时锚点才在 DOM 里
    }
    if (jumpTarget.kind === "inbox") {
      setExpanded((x) => (x[jumpTarget.id] === true ? x : { ...x, [jumpTarget.id]: true }));
      document.getElementById(`inbox-entry-${jumpTarget.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      const parent = entries.find((e) => e.task?.id === jumpTarget.id);
      if (parent !== undefined) setExpanded((x) => (x[parent.id] === true ? x : { ...x, [parent.id]: true }));
      document.getElementById(`backlog-card-${jumpTarget.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [jumpTarget, expanded, entries, view.sortMode]);

  // ---- 数据组装 ---------------------------------------------------------------

  const taskById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const entryByTaskId = useMemo(() => new Map(entries.filter((e) => e.task !== null).map((e) => [e.task!.id, e])), [entries]);
  const nestedOf = (e: InboxEntry): BacklogItem | null => (e.task === null ? null : taskById.get(e.task.id) ?? null);
  const linkedTaskIds = useMemo(() => new Set(entryByTaskId.keys()), [entryByTaskId]);

  // 挂在条目上的提醒（origin=reminder 且还有未来触发点）
  const reminderByEntry = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of automations) {
      if (a.origin !== "reminder" || !a.enabled || a.link?.kind !== "inbox-entry" || typeof a.nextRunAt !== "number") continue;
      const cur = m.get(a.link.id);
      if (cur === undefined || a.nextRunAt < cur) m.set(a.link.id, a.nextRunAt);
    }
    return m;
  }, [automations]);

  const isExpanded = (e: InboxEntry): boolean =>
    expanded[e.id] === true || (expanded[e.id] === undefined && (e.classifiedAt ?? e.createdAt) > seenAt);

  const pending = useMemo(() => entries.filter((e) => e.status === "pending" || e.status === "failed"), [entries]);

  // 时间态行：条目 ∪ 孤儿任务，createdAt 倒序；tag 过滤定块去留、状态过滤看块内卡
  const timeRows = useMemo(() => {
    const rows: TimeRow[] = [];
    for (const e of entries) {
      if (e.status === "pending" || e.status === "failed") continue;
      if (view.tagFilter !== null && e.category !== view.tagFilter) continue;
      const nested = nestedOf(e);
      if (view.statusFilter !== null && (nested === null || !taskMatchesStatus(nested, view.statusFilter))) continue;
      rows.push({ key: `e${e.id}`, kind: "entry", at: e.createdAt, entry: e });
    }
    for (const t of items) {
      if (linkedTaskIds.has(t.id)) continue;
      if (view.tagFilter !== null) continue; // 孤儿无标签，标签过滤激活时不可见
      if (view.statusFilter !== null && !taskMatchesStatus(t, view.statusFilter)) continue;
      rows.push({ key: `o${t.id}`, kind: "orphan", at: t.createdAt, task: t });
    }
    rows.sort((a, b) => b.at - a.at);
    return rows;
    // nestedOf/taskMatchesStatus 是纯读闭包，依赖由 entries/items/view 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, items, view.tagFilter, view.statusFilter, linkedTaskIds]);

  // 时间行分段（倒序下标签单调变旧，顺序切分即得分段）
  const sections = useMemo(() => {
    const out: Array<{ label: string; rows: TimeRow[] }> = [];
    for (const r of timeRows) {
      const label = sectionLabel(r.at);
      const last = out[out.length - 1];
      if (last !== undefined && last.label === label) last.rows.push(r);
      else out.push({ label, rows: [r] });
    }
    return out;
  }, [timeRows]);

  // 队列态行：活跃任务按 sortPos 序（items 本身有序，done 沉底），done 不进
  const queueRows = useMemo(() => {
    return items.filter((t) => {
      if (t.status === "done") return false;
      if (view.statusFilter !== null && !taskMatchesStatus(t, view.statusFilter)) return false;
      if (view.tagFilter !== null) {
        const src = entryByTaskId.get(t.id);
        if (src === undefined || src.category !== view.tagFilter) return false;
      }
      return true;
    });
  }, [items, view.statusFilter, view.tagFilter, entryByTaskId]);

  // ---- 度量（状态带与队列共用） --------------------------------------------------

  const counts = useMemo(() => statusCounts(items), [items]);
  const queueHead = useMemo(() => queueHeadOf(items), [items]);
  const todayDone = useMemo(() => todayDoneCountOf(items), [items]);
  const nextAutomationAt = useMemo(() => nextAutomationAtOf(automations), [automations]);
  const autopilotOn = backlogConfig?.autopilot.enabled ?? false;
  const allBackoff = items.some((i) => i.status === "ready" && i.auto) && !items.some((i) => i.status === "ready" && i.auto && !inBackoff(i));
  const precondition = queuePrecondition(state, backlogConfig, quotas, autopilotOn, allBackoff);

  const tags = useMemo(() => {
    const custom = inboxConfig?.categories ?? [];
    return [...DEFAULT_INBOX_CATEGORIES, ...custom].map((c) => ({ id: c.id, label: categoryLabel(c.id, custom) }));
  }, [inboxConfig]);

  const move = (id: number, dir: -1 | 1): void => {
    const order = items.filter((i) => i.status !== "done").map((i) => i.id);
    const from = order.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    void reorder(order);
  };

  return (
    <section className="min-w-0" aria-label="清单时间轴">
      <StatusBand
        phase={state?.phase ?? "busy"}
        activeCount={items.filter((i) => i.status !== "done").length}
        todayDoneCount={todayDone}
        counts={counts}
        queueHead={queueHead}
        precondition={precondition}
        nextAutomationAt={nextAutomationAt}
        forceBusy={state?.forceBusy ?? false}
        autopilotOn={autopilotOn}
        autoClassifyOn={inboxConfig?.autoClassify ?? false}
        sortMode={view.sortMode}
        statusFilter={view.statusFilter}
        tagFilter={view.tagFilter}
        tags={tags}
        onAutopilot={(on) => {
          const cfg = useBacklog.getState().config;
          if (cfg !== null) void useBacklog.getState().saveConfig({ autopilot: { ...cfg.autopilot, enabled: on } });
        }}
        onAutoClassify={(on) => void useInbox.getState().saveConfig({ autoClassify: on })}
        onForceBusy={() => void useBacklog.getState().setForceBusy(!(state?.forceBusy ?? false))}
        onForceBeat={() => void useBacklog.getState().forceBeat()}
        onCreate={() => setDialog({ mode: "create" })}
        onBacklogSettings={() => setBacklogSettingsOpen(true)}
        onViewPatch={patchView}
        onJumpQueueHead={() => {
          if (queueHead === null) return;
          // 导航不写偏好（时间态下不强行把用户切到队列态存进 localStorage）：
          // 队列态直接滚到卡；时间态跳队列头任务的父条目（展开+滚动），孤儿则滚卡
          if (view.sortMode === "queue") {
            useTaskJump.getState().jump({ kind: "backlog", id: queueHead.id });
            return;
          }
          const src = entryByTaskId.get(queueHead.id);
          useTaskJump.getState().jump(src !== undefined ? { kind: "inbox", id: src.id } : { kind: "backlog", id: queueHead.id });
        }}
      />

      {/* 待分类钉顶：routing 队列第一屏可见，分类器状态与「立即分类」就在块头 */}
      {pending.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 flex items-center gap-2">
            <span className="text-body-sm font-medium text-amber-600">待分类</span>
            <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">{pending.length}</span>
            <span className="min-w-0 flex-1 truncate text-caption text-ash">
              {classifier?.classifying === true ? (
                <span className="flex items-center gap-1.5 text-teal">
                  <Loader2 size={12} className="animate-spin" />
                  routing 分类中…
                </span>
              ) : (
                (classifier?.lastOutcome ?? "").replace(/^(ok|failed):/, "")
              )}
            </span>
            <button
              onClick={() => void useInbox.getState().classifyNow()}
              title="手动触发一轮 routing 分类（不受「自动分类」开关限制）"
              className="flex h-7 shrink-0 items-center rounded-btn px-2.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
            >
              立即分类
            </button>
            <button
              onClick={() => setInboxSettingsOpen(true)}
              aria-label="清单设置"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-ash hover:bg-line-soft hover:text-ink"
            >
              <Settings2 size={13} />
            </button>
          </h3>
          <div className="space-y-2">
            {pending.map((e) => (
              <PendingBlock key={e.id} entry={e} confirmingDelete={confirmingDelete} setConfirmingDelete={setConfirmingDelete} />
            ))}
          </div>
        </section>
      )}

      {view.sortMode === "queue" ? (
        /* 队列态：sortPos 序的任务队列（调度态）——行=来源摘要+任务卡 */
        <div className="space-y-3">
          {queueHead !== null && precondition !== null && (
            <p className="rounded-btn bg-rail px-2.5 py-1.5 text-caption text-graphite" title="autopilot 此刻为什么没派发 —— 引擎 20 秒一拍，条件变了下一拍就动">
              当前判定：{precondition}
            </p>
          )}
          {queueRows.map((t, qi) => {
            const src = entryByTaskId.get(t.id);
            return (
              <div key={`q${t.id}`} className="flex items-start gap-2">
                <div className="hidden w-16 shrink-0 flex-col items-end gap-0.5 pr-3 pt-3.5 md:flex">
                  <span className="font-mono text-caption tnum text-ash" title="优先级位次（sortPos 序，上移/下移在任务卡菜单里）">
                    #{qi + 1}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  {src !== undefined ? (
                    <button
                      onClick={() => {
                        patchView({ sortMode: "time" });
                        useTaskJump.getState().jump({ kind: "inbox", id: src.id });
                      }}
                      title="回到时间态并定位来源条目"
                      className="mb-1 flex w-full items-center gap-1 truncate rounded-btn px-1 py-0.5 text-left text-caption text-ash hover:bg-line-soft hover:text-graphite"
                    >
                      <span className="shrink-0">↳</span>
                      <span className="min-w-0 truncate">{src.text.replaceAll(/\s+/g, " ").slice(0, 60)}</span>
                    </button>
                  ) : (
                    <p className="mb-1 truncate px-1 py-0.5 text-caption text-ash">{t.source === "manual" ? "无源任务 · 手建" : "无源任务 · 收录"}</p>
                  )}
                  <BacklogCard
                    item={t}
                    onEdit={() => setDialog({ mode: "edit", item: t })}
                    confirmingDelete={confirmingDelete}
                    setConfirmingDelete={setConfirmingDelete}
                    onMove={move}
                    highlighted={jumpTarget?.kind === "backlog" && jumpTarget.id === t.id}
                    isQueueHead={queueHead !== null && queueHead.id === t.id}
                  />
                </div>
              </div>
            );
          })}
          {queueRows.length === 0 && (
            <p className="rounded-card border border-dashed border-line px-3 py-6 text-center text-caption text-ash">队列里没有任务 —— 左上写下的目标会被 routing 沉淀进来</p>
          )}
        </div>
      ) : (
        /* 时间态：日期分段的事件块流 */
        <div className="space-y-4">
          {sections.map((sec) => (
            <section key={sec.label}>
              <h3 className="sticky top-0 z-20 -mx-1 mb-2 bg-canvas/95 px-1 py-1 text-body-sm font-medium text-ink backdrop-blur-xs">{sec.label}</h3>
              <div className="space-y-3">
                {sec.rows.map((r) =>
                  r.kind === "entry" ? (
                    <div key={r.key} className="flex items-start gap-2">
                      <div className="hidden w-16 shrink-0 flex-col items-end gap-0.5 pt-3 pr-3 md:flex">
                        <span className="font-mono text-caption tnum text-ash">{fmtHM(r.at)}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <EntryBlock
                          entry={r.entry}
                          nested={nestedOf(r.entry)}
                          expanded={isExpanded(r.entry)}
                          onToggle={() => {
                            // 默认展开态（已读语义）在拍子里可能刚变：从 updater 的
                            // 当前 state 算，不读 render 快照（连点两下不吃陈旧值）
                            const fallback = (r.entry.classifiedAt ?? r.entry.createdAt) > seenAt;
                            setExpanded((x) => {
                              const cur = x[r.entry.id] !== undefined ? x[r.entry.id] : fallback;
                              return { ...x, [r.entry.id]: !cur };
                            });
                          }}
                          highlighted={jumpTarget?.kind === "inbox" && jumpTarget.id === r.entry.id}
                          taskHighlightId={jumpTarget?.kind === "backlog" && r.entry.task !== null && r.entry.task.id === jumpTarget.id ? jumpTarget.id : null}
                          confirmingDelete={confirmingDelete}
                          setConfirmingDelete={setConfirmingDelete}
                          onEditTask={(t) => setDialog({ mode: "edit", item: t })}
                          onMoveTask={move}
                          reminderAt={reminderByEntry.get(r.entry.id) ?? null}
                          onTagClick={(tag) => patchView({ tagFilter: view.tagFilter === tag ? null : tag })}
                        />
                      </div>
                    </div>
                  ) : (
                    <div key={r.key} className="flex items-start gap-2">
                      <div className="hidden w-16 shrink-0 flex-col items-end gap-0.5 pt-3 pr-3 md:flex">
                        <span className="font-mono text-caption tnum text-ash">{fmtHM(r.at)}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="mb-1 px-1 text-caption text-ash">{r.task.source === "manual" ? "无源任务 · 手建（存量）" : "无源任务 · 收录（存量）"}</p>
                        <BacklogCard
                          item={r.task}
                          onEdit={() => setDialog({ mode: "edit", item: r.task })}
                          confirmingDelete={confirmingDelete}
                          setConfirmingDelete={setConfirmingDelete}
                          onMove={move}
                          highlighted={jumpTarget?.kind === "backlog" && jumpTarget.id === r.task.id}
                        />
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>
          ))}
          {sections.length === 0 && (
            <p className="rounded-card border border-dashed border-line px-3 py-6 text-center text-caption text-ash">
              没有匹配的条目{view.tagFilter !== null || view.statusFilter !== null ? " —— 试试清掉过滤" : " —— 像编辑你那个 txt 一样，往上面的框里写下任何东西"}
            </p>
          )}
        </div>
      )}

      {dialog !== null && (
        <BacklogDialog key={dialog.mode === "edit" ? dialog.item.id : "new"} initial={dialog.mode === "edit" ? dialog.item : null} onClose={() => setDialog(null)} />
      )}
      {backlogSettingsOpen && <BacklogSettings onClose={() => setBacklogSettingsOpen(false)} />}
      {inboxSettingsOpen && <InboxSettings onClose={() => setInboxSettingsOpen(false)} />}
    </section>
  );
}

/* ------------------------------------------------------------------ 待分类块 */

function PendingBlock({
  entry,
  confirmingDelete,
  setConfirmingDelete,
}: {
  entry: InboxEntry;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
}): ReactElement {
  const updateText = useInbox((s) => s.updateText);
  const remove = useInbox((s) => s.remove);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderInput, setReminderInput] = useState("");
  const [reminderBusy, setReminderBusy] = useState(false);

  const saveEdit = (): void => {
    const t = draft.trim();
    setEditing(false);
    if (t !== "" && t !== entry.text) void updateText(entry.id, t);
  };

  // 与 EntryBlock 同款挂提醒（待分类也能挂：提醒不依赖分类完成，docs/30）
  const scheduleReminder = (runAt: number): void => {
    if (reminderBusy) return;
    setReminderBusy(true);
    void createReminder({ text: entry.text.slice(0, 200), runAt, link: { kind: "inbox-entry", id: entry.id } }, defaultDaemonEndpoint())
      .then(() => {
        useInbox.getState().setNotice({ kind: "success", text: `已挂提醒 · ${new Date(runAt).toLocaleString("zh-CN")}` });
        setMenuOpen(false);
        setReminderOpen(false);
        setReminderInput("");
      })
      .catch((err: unknown) => {
        useInbox.getState().setNotice({ kind: "error", text: `提醒没挂上：${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => setReminderBusy(false));
  };

  const tomorrowAt = (hour: number, minute = 0): number => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };

  return (
    <div
      id={`inbox-entry-${entry.id}`}
      className={cn(
        "flex items-start gap-2.5 rounded-card border border-amber-500/30 bg-amber-500/5 px-4 py-2.5",
        entry.status === "failed" && "border-loss/30 bg-loss/5",
      )}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                saveEdit();
              } else if (e.key === "Escape") {
                setEditing(false);
                setDraft(entry.text);
              }
            }}
            onBlur={saveEdit}
            rows={Math.min(6, draft.split(/\r?\n/).length + 1)}
            className="w-full resize-none rounded-input border border-transparent bg-rail px-2 py-1 text-body-sm leading-relaxed text-ink outline-none focus:border-teal"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(entry.text);
              setEditing(true);
            }}
            className="block w-full whitespace-pre-wrap break-words text-left text-body-sm leading-relaxed text-ink hover:text-graphite"
            title="点击编辑原话"
          >
            {entry.text}
          </button>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ash">
          <span className={entry.status === "failed" ? "text-loss" : "text-amber-600"}>
            {entry.status === "failed" ? "分类失败 —— 可改分类或重试" : "等 routing 分拣"}
          </span>
          {entry.hints !== null && <span className="font-mono text-[10px]" title={JSON.stringify(entry.hints)}>预置字段</span>}
          <span className="md:hidden">{formatBacklogRelative(entry.createdAt)}</span>
        </p>
      </div>
      <div className="relative shrink-0">
        <button
          aria-label={`${entry.text.slice(0, 12)} 更多操作`}
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
            <div className="absolute right-0 top-6 z-50 flex w-44 flex-col rounded-card border border-line bg-card p-1 shadow-subtle">
              <MenuRow icon={<Pencil size={12} />} label="编辑" onClick={() => { setMenuOpen(false); setDraft(entry.text); setEditing(true); }} />
              <MenuRow icon={<BellRing size={12} />} label="挂提醒" onClick={() => setReminderOpen((v) => !v)} />
              {reminderOpen && (
                <div className="mx-1 my-1 flex flex-col gap-1 rounded-btn bg-rail px-2 py-2">
                  <button onClick={() => scheduleReminder(Date.now() + 15 * 60_000)} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                    15 分钟后
                  </button>
                  <button onClick={() => scheduleReminder(Date.now() + 60 * 60_000)} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                    1 小时后
                  </button>
                  <button onClick={() => scheduleReminder(tomorrowAt(9))} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                    明天 09:00
                  </button>
                  <div className="flex items-center gap-1">
                    <input
                      type="datetime-local"
                      value={reminderInput}
                      onChange={(e) => setReminderInput(e.target.value)}
                      className="min-w-0 flex-1 rounded-input border border-transparent bg-card px-1.5 py-1 text-[11px] text-ink outline-none focus:border-teal"
                    />
                    <button
                      onClick={() => {
                        const t = new Date(reminderInput).getTime();
                        if (Number.isFinite(t) && t > Date.now()) scheduleReminder(t);
                      }}
                      disabled={reminderBusy || reminderInput.trim() === ""}
                      className="shrink-0 rounded-btn bg-ink px-2 py-1 text-[11px] text-canvas disabled:opacity-40"
                    >
                      {reminderBusy ? <Loader2 size={10} className="animate-spin" /> : "挂"}
                    </button>
                  </div>
                </div>
              )}
              <MenuRow
                icon={<Trash2 size={12} />}
                label={confirmingDelete === entry.id ? "确认删除？" : "删除"}
                danger
                onClick={() => {
                  if (confirmingDelete !== entry.id) {
                    setConfirmingDelete(entry.id);
                    return;
                  }
                  setMenuOpen(false);
                  void remove(entry.id);
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 事件块 */

const CATEGORY_CHIP: Record<string, string> = {
  goal: "bg-blue-500/10 text-blue-500",
  todo: "bg-amber-500/10 text-amber-600",
  idea: "bg-teal-tint text-teal",
  note: "bg-line-soft text-graphite",
  later: "bg-violet-500/10 text-violet-500",
  // 追加（docs/33 §1 订阅直通回执）：不是分类产物，是投递凭据 —— teal 系与直通语义同色
  followup: "bg-teal-tint text-teal",
};

function EntryBlock({
  entry,
  nested,
  expanded,
  onToggle,
  highlighted,
  taskHighlightId,
  confirmingDelete,
  setConfirmingDelete,
  onEditTask,
  onMoveTask,
  reminderAt,
  onTagClick,
}: {
  entry: InboxEntry;
  nested: BacklogItem | null;
  expanded: boolean;
  onToggle: () => void;
  highlighted: boolean;
  taskHighlightId: number | null;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  onEditTask: (t: BacklogItem) => void;
  onMoveTask: (id: number, dir: -1 | 1) => void;
  reminderAt: number | null;
  onTagClick: (tag: string) => void;
}): ReactElement {
  const updateText = useInbox((s) => s.updateText);
  const setCategory = useInbox((s) => s.setCategory);
  const dismissUrgent = useInbox((s) => s.dismissUrgent);
  const reclassify = useInbox((s) => s.reclassify);
  const remove = useInbox((s) => s.remove);
  const config = useInbox((s) => s.config);

  const [menuOpen, setMenuOpen] = useState(false);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderInput, setReminderInput] = useState("");
  const [reminderBusy, setReminderBusy] = useState(false);

  const allCategories = [...DEFAULT_INBOX_CATEGORIES, ...(config?.categories ?? [])];

  const saveEdit = (): void => {
    const t = draft.trim();
    setEditing(false);
    if (t !== "" && t !== entry.text) void updateText(entry.id, t);
  };

  const scheduleReminder = (runAt: number): void => {
    if (reminderBusy) return;
    setReminderBusy(true);
    void createReminder({ text: entry.text.slice(0, 200), runAt, link: { kind: "inbox-entry", id: entry.id } }, defaultDaemonEndpoint())
      .then(() => {
        useInbox.getState().setNotice({ kind: "success", text: `已挂提醒 · ${new Date(runAt).toLocaleString("zh-CN")}` });
        setMenuOpen(false);
        setReminderOpen(false);
        setReminderInput("");
      })
      .catch((err: unknown) => {
        useInbox.getState().setNotice({ kind: "error", text: `提醒没挂上：${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => setReminderBusy(false));
  };

  const tomorrowAt = (hour: number, minute = 0): number => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };

  const taskStatusChip = nested !== null ? BACKLOG_STATUS_LABEL[nested.status as BacklogStatus] : null;

  return (
    <div
      id={`inbox-entry-${entry.id}`}
      className={cn("rounded-card border border-line bg-card", highlighted && "ring-2 ring-teal")}
    >
      {/* 块头：原话（折叠两行摘要 / 展开全文或编辑）+ 标签 + 汇总 chips + 菜单 */}
      <div className="flex items-start gap-2 px-4 pb-2 pt-3">
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "收起事件块" : "展开事件块"}
          className="mt-0.5 shrink-0 rounded-btn p-0.5 text-ash hover:bg-line-soft hover:text-ink"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(entry.text);
                }
              }}
              onBlur={saveEdit}
              rows={Math.min(6, draft.split(/\r?\n/).length + 1)}
              className="w-full resize-none rounded-input border border-transparent bg-rail px-2 py-1 text-body-sm leading-relaxed text-ink outline-none focus:border-teal"
            />
          ) : expanded ? (
            <button
              onClick={() => {
                setDraft(entry.text);
                setEditing(true);
              }}
              className="block w-full whitespace-pre-wrap break-words text-left text-body-sm leading-relaxed text-ink hover:text-graphite"
              title="点击编辑原话"
            >
              {entry.text}
            </button>
          ) : (
            <button onClick={onToggle} className="block w-full text-left" title="点开展开">
              <span className="line-clamp-2 whitespace-pre-wrap break-words text-body-sm leading-relaxed text-ink">{entry.text}</span>
            </button>
          )}

          {/* 元信息行：标签 chip（点击过滤）/ 任务状态 / 时间线索 / 徽章 / 时刻 */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-ash">
            {entry.category !== null && (
              <button
                onClick={() => onTagClick(entry.category!)}
                title={`按标签「${categoryLabel(entry.category, config?.categories ?? [])}」过滤`}
                className={cn("shrink-0 rounded-chip px-2 py-0.5", CATEGORY_CHIP[entry.category] ?? "bg-line-soft text-graphite")}
              >
                {categoryLabel(entry.category, config?.categories ?? [])}
              </button>
            )}
            {taskStatusChip !== null && <span className="shrink-0 text-graphite">任务 · {taskStatusChip}</span>}
            {/* 订阅直通回执（docs/33 §1）：这条没走分类器，直接挂到了任务上 */}
            {entry.category === "followup" && entry.task !== null && (
              <span className="shrink-0 text-teal" title="同话题的后续输入 —— 未经分类，直接投递给已订阅的任务，下次执行自动拼入">
                ⇢ 已直通任务 #{entry.task.id}
              </span>
            )}
            {entry.categoryNote !== null && entry.categoryNote !== "" && <span className="max-w-md truncate" title={entry.categoryNote}>routing：{entry.categoryNote}</span>}
            {entry.provenance === "pasted" && (
              <span className="shrink-0 rounded-chip bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-600" title="粘贴的外部文本 —— 沉淀任务不默认进闲时执行，需人工打勾">
                粘贴 · 需打勾
              </span>
            )}
            {reminderAt !== null && (
              <span className="flex shrink-0 items-center gap-1 text-teal" title="这条条目上挂着的提醒（到点通知，链接回来）">
                <BellRing size={10} />
                提醒 {formatAbsoluteHuman(reminderAt)}
              </span>
            )}
            <span className="ml-auto shrink-0 md:ml-0">{formatBacklogRelative(entry.createdAt)}</span>
          </div>
        </div>

        {/* 分类 chip（点开可改）+ 行内菜单 */}
        <div className="relative shrink-0">
          <button
            onClick={() => {
              setCatMenuOpen((v) => !v);
              setMenuOpen(false);
            }}
            className={cn(
              "whitespace-nowrap rounded-chip px-2 py-0.5 text-caption",
              entry.category === null ? "bg-amber-500/10 text-amber-600" : CATEGORY_CHIP[entry.category] ?? "bg-line-soft text-graphite",
            )}
            title="点击改标签"
          >
            {entry.category === null ? INBOX_STATUS_LABEL[entry.status] : categoryLabel(entry.category, config?.categories ?? [])}
          </button>
          {catMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCatMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 top-6 z-50 flex max-h-72 w-36 flex-col overflow-y-auto rounded-card border border-line bg-card p-1 shadow-subtle">
                <MenuRow label="待分类" onClick={() => { setCatMenuOpen(false); void setCategory(entry.id, null); }} />
                {allCategories.map((c) => (
                  <MenuRow
                    key={c.id}
                    label={`${c.label}${c.actionable ? "（沉淀任务）" : ""}`}
                    onClick={() => {
                      setCatMenuOpen(false);
                      void setCategory(entry.id, c.id);
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        <div className="relative shrink-0">
          <button
            aria-label={`${entry.text.slice(0, 12)} 更多操作`}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v);
              setCatMenuOpen(false);
              setConfirmingDelete(null);
            }}
            className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 top-6 z-50 flex w-44 flex-col rounded-card border border-line bg-card p-1 shadow-subtle">
                <MenuRow icon={<Pencil size={12} />} label="编辑" onClick={() => { setMenuOpen(false); setDraft(entry.text); setEditing(true); }} />
                <MenuRow icon={<RefreshCw size={12} />} label="让 routing 重新分类" onClick={() => { setMenuOpen(false); void reclassify(entry.id); }} />
                <MenuRow icon={<BellRing size={12} />} label="挂提醒" onClick={() => setReminderOpen((v) => !v)} />
                {reminderOpen && (
                  <div className="mx-1 my-1 flex flex-col gap-1 rounded-btn bg-rail px-2 py-2">
                    <button onClick={() => scheduleReminder(Date.now() + 15 * 60_000)} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                      15 分钟后
                    </button>
                    <button onClick={() => scheduleReminder(Date.now() + 60 * 60_000)} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                      1 小时后
                    </button>
                    <button onClick={() => scheduleReminder(tomorrowAt(9))} className="rounded-btn px-1.5 py-1 text-left text-caption text-graphite hover:bg-line-soft hover:text-ink">
                      明天 09:00
                    </button>
                    <div className="flex items-center gap-1">
                      <input
                        type="datetime-local"
                        value={reminderInput}
                        onChange={(e) => setReminderInput(e.target.value)}
                        className="min-w-0 flex-1 rounded-input border border-transparent bg-card px-1.5 py-1 text-[11px] text-ink outline-none focus:border-teal"
                      />
                      <button
                        onClick={() => {
                          const t = new Date(reminderInput).getTime();
                          if (Number.isFinite(t) && t > Date.now()) scheduleReminder(t);
                        }}
                        disabled={reminderBusy || reminderInput.trim() === ""}
                        className="shrink-0 rounded-btn bg-ink px-2 py-1 text-[11px] text-canvas disabled:opacity-40"
                      >
                        {reminderBusy ? <Loader2 size={10} className="animate-spin" /> : "挂"}
                      </button>
                    </div>
                  </div>
                )}
                <MenuRow
                  icon={<Trash2 size={12} />}
                  label={confirmingDelete === entry.id ? "确认删除？" : "删除"}
                  danger
                  onClick={() => {
                    if (confirmingDelete !== entry.id) {
                      setConfirmingDelete(entry.id);
                      return;
                    }
                    setMenuOpen(false);
                    void remove(entry.id);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* 紧急检测（docs/30）：三出口（现在就跑 / 挂提醒 / 忽略） */}
      {entry.urgent && (
        <div className="mx-4 mb-2 flex flex-wrap items-center gap-1.5 rounded-btn bg-amber-500/10 px-2 py-1.5 text-caption">
          <span className="flex shrink-0 items-center gap-1 font-medium text-amber-600">
            <BellRing size={11} />
            紧急{entry.urgencyHint !== null && entry.urgencyHint !== "" ? ` · ${entry.urgencyHint}` : ""}
          </span>
          <span className="min-w-0 flex-1 truncate text-amber-600/80" title="闲时执行构造性来不及——三选一：现在就跑、挂提醒、或忽略这条警告">
            闲时执行来不及
          </span>
          {nested !== null && nested.status === "ready" && (
            <button
              onClick={() => void useBacklog.getState().runNow(nested.id)}
              className="shrink-0 rounded-btn bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/30"
            >
              现在就跑
            </button>
          )}
          <button
            onClick={() => {
              setMenuOpen(true);
              setReminderOpen(true);
            }}
            className="shrink-0 rounded-btn bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/30"
          >
            挂提醒
          </button>
          <button onClick={() => void dismissUrgent(entry.id)} title="我比 routing 懂轻重 —— 只灭警告，任务与分类不动" className="shrink-0 rounded-btn px-1.5 py-0.5 text-amber-700/80 hover:bg-amber-500/20">
            忽略
          </button>
        </div>
      )}

      {/* 展开区：拆解出的任务卡（嵌套 —— 捕获→沉淀的空间化，docs/30） */}
      {expanded && (
        <div className="border-t border-line-soft px-4 pb-3 pt-2.5">
          {nested !== null ? (
            <BacklogCard
              item={nested}
              onEdit={() => onEditTask(nested)}
              confirmingDelete={confirmingDelete}
              setConfirmingDelete={setConfirmingDelete}
              onMove={onMoveTask}
              highlighted={taskHighlightId === nested.id}
            />
          ) : (
            <p className="text-caption text-ash">
              {entry.task !== null ? "链接的任务已不在（可能已删）" : "没有拆解出任务 —— 这条是留存，不是待办"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
