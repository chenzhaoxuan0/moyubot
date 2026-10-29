import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ChevronDown,
  CircleAlert,
  FolderOpen,
  Inbox as InboxIcon,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  BUILTIN_CATEGORY_ORDER,
  DEFAULT_INBOX_CATEGORIES,
  INBOX_STATUS_LABEL,
  inboxCategoryLabel as categoryLabel,
  type InboxCategoryDef,
  type InboxEntry,
  type InboxHints,
} from "../core/inbox.ts";
import { BACKLOG_STATUS_LABEL, formatBacklogRelative, type BacklogStatus } from "../core/backlog.ts";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useShell } from "../store/useShell.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 清单页 —— 个人 context 的唯一捕获入口（与待办页相对：那边是任务状态机视图）。
 *
 * 两个必要的东西：一个文本框（写任何东西）+ 基础分类（routing bot 自动分，
 * 也可手动改）。列表按分类分块；actionable 分类的条目沉淀成待办任务（auto
 * 直通闲时自动执行），想法/资料留在这里归档。
 */

/** 轮询兜底间隔（权威同步走 inbox 信号帧，这是 daemon 不在/漏帧时的兜底） */
const POLL_MS = 30_000;
/** 页面级通知的自动消失时长 */
const NOTICE_TTL_MS = 5_000;

export function InboxPage(): ReactElement {
  const entries = useInbox((s) => s.entries);
  const config = useInbox((s) => s.config);
  const classifier = useInbox((s) => s.classifier);
  const notice = useInbox((s) => s.notice);
  const setNotice = useInbox((s) => s.setNotice);
  const refresh = useInbox((s) => s.refresh);

  const backlogItems = useBacklog((s) => s.items);
  // O(entries) 而不是 O(entries × items)：每行找实时任务状态走一次 Map
  const taskById = useMemo(() => new Map(backlogItems.map((i) => [i.id, i])), [backlogItems]);
  const backlogConfig = useBacklog((s) => s.config);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  const customCategories = config?.categories ?? [];
  const blockOrder = useMemo(() => [...BUILTIN_CATEGORY_ORDER, ...customCategories.map((c) => c.id)], [customCategories]);

  const pending = useMemo(() => entries.filter((e) => e.status === "pending" || e.status === "failed"), [entries]);
  const blocks = useMemo(
    () =>
      blockOrder
        .map((id) => ({ id, items: entries.filter((e) => e.category === id) }))
        .filter((b) => b.items.length > 0),
    [entries, blockOrder],
  );
  // 分类结果落在已删自定义分类里的条目 —— 兜底块，别让数据凭空消失
  const knownIds = useMemo(() => new Set([...DEFAULT_INBOX_CATEGORIES.map((c) => c.id), ...customCategories.map((c) => c.id)]), [customCategories]);
  const orphan = useMemo(() => entries.filter((e) => e.category !== null && !knownIds.has(e.category)), [entries, knownIds]);

  const autopilotOn = backlogConfig?.autopilot.enabled ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* titlebar-drag 挂整宽外层条（与待办页同款） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">清单</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">一个入口 · routing 分类 · 空闲自动执行</span>
          <div className="ml-auto flex items-center gap-1.5">
            {classifier?.classifying === true ? (
              <span className="flex items-center gap-1.5 text-caption text-teal">
                <Loader2 size={12} className="animate-spin" />
                routing 分类中…
              </span>
            ) : (
              classifier?.lastOutcome != null && <span className="max-w-72 truncate text-caption text-ash" title={classifier.lastOutcome}>{classifier.lastOutcome.replace(/^(ok|failed):/, "")}</span>
            )}
            <HeaderBtn icon={Sparkles} label="立即分类" onClick={() => void useInbox.getState().classifyNow()} />
            <HeaderBtn icon={ListTodo} label="去待办页管理任务" onClick={goBacklog} />
            <HeaderBtn icon={Settings2} label="清单设置" onClick={() => setSettingsOpen(true)} active={settingsOpen} />
          </div>
        </div>
        <div aria-hidden className="titlebar-no-drag absolute right-0 top-0 h-full" style={{ width: "var(--wco-w, 0px)" }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 pb-12 pt-5">
          {/* 文本框 —— 唯一需要编辑的东西 */}
          <Composer />

          {notice !== null && (
            <div
              role="status"
              className={cn(
                "mt-4 flex items-start gap-2 rounded-btn px-3 py-2 text-body-sm",
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

          <p className="mt-4 flex items-center gap-1.5 text-caption text-ash">
            <span className={cn("h-1.5 w-1.5 rounded-full", autopilotOn ? "bg-gain" : "bg-line-strong")} />
            闲时自动执行{autopilotOn ? "已开启" : "已关闭"}
            （在
            <button className="text-teal underline-offset-2 hover:underline" onClick={goBacklog}>
              待办页
            </button>
            调整）—— 用量还有富余的时候，agent 会持续完成清单沉淀出来的任务
          </p>

          {/* 待分类块置顶 —— routing 还没分拣的 */}
          {pending.length > 0 && (
            <Block title="待分类" count={pending.length} accent>
              {pending.map((e) => (
                <EntryRow key={e.id} entry={e} confirmingDelete={confirmingDelete} setConfirmingDelete={setConfirmingDelete} taskItem={findTask(taskById, e)} />
              ))}
            </Block>
          )}

          {blocks.map((b) => (
            <Block key={b.id} title={categoryLabel(b.id, customCategories)} count={b.items.length}>
              {b.items.map((e) => (
                <EntryRow key={e.id} entry={e} confirmingDelete={confirmingDelete} setConfirmingDelete={setConfirmingDelete} taskItem={findTask(taskById, e)} />
              ))}
            </Block>
          ))}

          {orphan.length > 0 && (
            <Block title="其他" count={orphan.length}>
              {orphan.map((e) => (
                <EntryRow key={e.id} entry={e} confirmingDelete={confirmingDelete} setConfirmingDelete={setConfirmingDelete} taskItem={findTask(taskById, e)} />
              ))}
            </Block>
          )}

          {entries.length === 0 && (
            <div className="mt-4 flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
              <InboxIcon size={16} className="mb-2 text-ash" />
              <p className="text-body-sm font-medium text-ink">清单还是空的</p>
              <p className="mt-1 max-w-[460px] text-body-sm leading-relaxed text-graphite">
                像编辑你那个 Notepad++ 里的 txt 一样用这里：想法、近期目标、要做的杂事、留存的资料 ——
                全写进上面的文本框。routing bot 会分好类：目标/待办沉淀成任务，空闲用量里自动执行。
              </p>
            </div>
          )}
        </div>

        {settingsOpen && <InboxSettings onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 文本框 */

function Composer(): ReactElement {
  const add = useInbox((s) => s.add);
  const classifier = useInbox((s) => s.classifier);
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);

  const [text, setText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [hints, setHints] = useState<InboxHints>({});
  const [submitting, setSubmitting] = useState(false);

  const runtimeIds = useMemo(() => runtimes.map((r) => r.id.replace(/^daemon:/, "")), [runtimes]);
  const hintsFilled = Object.values(hints).some((v) => v !== undefined && v !== null && v !== "");

  const submit = (): void => {
    const t = text.trim();
    if (t === "" || submitting) return;
    // daemon 往返期间再按 Enter / 点按钮会重复提交同一段文字 —— 占位挡住
    setSubmitting(true);
    void add({ text: t, hints: hintsFilled ? hints : undefined })
      .then((ok) => {
        if (ok) {
          setText("");
          setHints({});
        }
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="rounded-card border border-line bg-card px-4 py-3 focus-within:border-teal">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter 直接收进清单（Shift+Enter 换行）；IME 组合中（拼音候选）不拦截
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="写下任何东西：想法、近期目标、要做的杂事、留存的资料……"
        className="w-full resize-none bg-transparent text-body-sm leading-relaxed text-ink outline-none placeholder:text-ash"
      />
      <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
        <button
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-ash hover:bg-line-soft hover:text-ink"
          aria-expanded={advanced}
        >
          可选项（指定 bot / 文件夹 / 执行器 / 模型 / 会话）
          <ChevronDown size={12} className={cn("transition-transform", advanced && "rotate-180")} />
        </button>
        {hintsFilled && <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已预置 {Object.keys(hints).length} 项</span>}
        <span className="ml-auto text-caption text-ash">Enter 收进清单 · Shift+Enter 换行</span>
        <button
          onClick={submit}
          disabled={text.trim() === "" || submitting}
          className="flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition disabled:opacity-40"
        >
          {classifier?.classifying === true ? <Loader2 size={12} className="animate-spin" /> : <InboxIcon size={12} />}
          收进清单
        </button>
      </div>
      {advanced && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-btn bg-rail px-3 py-3">
          <HintField label="指定 bot（归属工作单元）">
            <select
              value={hints.unitId ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, unitId: e.target.value === "" ? undefined : e.target.value }))}
              className={inputCls}
            >
              <option value="">（由 routing 建议）</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </HintField>
          <HintField label="指定文件夹（覆盖工作目录）">
            <input
              value={hints.rootPath ?? ""}
              placeholder="（由 routing 决定）"
              onChange={(e) => setHints((h) => ({ ...h, rootPath: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={cn(inputCls, "font-mono")}
            />
          </HintField>
          <HintField label="指定执行器">
            <select
              value={hints.runtimeId ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, runtimeId: e.target.value === "" ? undefined : e.target.value }))}
              className={inputCls}
            >
              <option value="">（由 routing 建议）</option>
              {runtimeIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </HintField>
          <HintField label="指定模型">
            <input
              value={hints.model ?? ""}
              placeholder="（缺省跟随执行器）"
              onChange={(e) => setHints((h) => ({ ...h, model: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={inputCls}
            />
          </HintField>
          <HintField label="执行方式">
            <select
              value={hints.launchMode ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, launchMode: e.target.value === "" ? undefined : (e.target.value as "terminal" | "chat" | "headless") }))}
              className={inputCls}
            >
              <option value="">headless（自动执行缺省）</option>
              <option value="chat">对话页前台</option>
              <option value="terminal">执行器 TUI</option>
              <option value="headless">纯后台</option>
            </select>
          </HintField>
          <HintField label="在某个已有会话里执行">
            <input
              value={hints.targetSessionId ?? ""}
              placeholder="（留空 = 新开会话）"
              onChange={(e) => setHints((h) => ({ ...h, targetSessionId: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={cn(inputCls, "font-mono")}
            />
          </HintField>
          <p className="col-span-2 text-[10px] leading-relaxed text-ash">
            预置了就照你的来，routing 不改写；空着的由 routing 分类时建议。这些字段沉淀成任务后都能在待办页再改。
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 分块 */

function Block({ title, count, accent, children }: { title: string; count: number; accent?: boolean; children: React.ReactNode }): ReactElement {
  return (
    <section className="mt-5">
      <h2 className="mb-2 flex items-center gap-2">
        <span className={cn("text-body-sm font-medium", accent ? "text-amber-600" : "text-ink")}>{title}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">{count}</span>
      </h2>
      <div className="overflow-hidden rounded-card border border-line bg-card">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ 行 */

const CATEGORY_CHIP: Record<string, string> = {
  goal: "bg-blue-500/10 text-blue-500",
  todo: "bg-amber-500/10 text-amber-600",
  idea: "bg-teal-tint text-teal",
  note: "bg-line-soft text-graphite",
  later: "bg-violet-500/10 text-violet-500",
};

function findTask(
  taskById: ReadonlyMap<number, { id: number; status: string; title: string }>,
  entry: InboxEntry,
): { id: number; status: string; title: string } | null {
  if (entry.task === null) return null;
  // 实时状态优先（backlog store 常驻轮询），快照兜底
  return taskById.get(entry.task.id) ?? { id: entry.task.id, status: entry.task.status, title: entry.task.title };
}

function EntryRow({
  entry,
  confirmingDelete,
  setConfirmingDelete,
  taskItem,
}: {
  entry: InboxEntry;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  taskItem: { id: number; status: string; title: string } | null;
}): ReactElement {
  const updateText = useInbox((s) => s.updateText);
  const setCategory = useInbox((s) => s.setCategory);
  const reclassify = useInbox((s) => s.reclassify);
  const remove = useInbox((s) => s.remove);
  const config = useInbox((s) => s.config);

  const [menuOpen, setMenuOpen] = useState(false);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  const allCategories = [...DEFAULT_INBOX_CATEGORIES, ...(config?.categories ?? [])];

  const saveEdit = (): void => {
    const t = draft.trim();
    setEditing(false);
    if (t !== "" && t !== entry.text) void updateText(entry.id, t);
  };

  return (
    <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-2.5 last:border-b-0">
      {/* 原话（可内联编辑） */}
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
        {/* 分类理由 / 任务链接 / 预置字段 —— 元信息一行 */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ash">
          {entry.categoryNote !== null && entry.categoryNote !== "" && <span className="max-w-md truncate" title={entry.categoryNote}>routing：{entry.categoryNote}</span>}
          {entry.status === "failed" && <span className="text-loss">分类失败 —— 可改分类或重试</span>}
          {taskItem !== null && (
            <button onClick={goBacklog} className="flex items-center gap-1 text-graphite hover:text-ink" title="去待办页查看/管理这个任务">
              <ListTodo size={11} />
              任务 #{taskItem.id} · {BACKLOG_STATUS_LABEL[taskItem.status as BacklogStatus] ?? taskItem.status}
              {taskItem.status === "executing" && <Loader2 size={10} className="animate-spin text-blue-500" />}
            </button>
          )}
          {entry.hints !== null && <span className="font-mono text-[10px]" title={JSON.stringify(entry.hints)}>预置字段</span>}
          <span>{formatBacklogRelative(entry.createdAt)}</span>
        </div>
      </div>

      {/* 分类 chip（点开可改） */}
      <div className="relative shrink-0">
        <button
          onClick={() => {
            setCatMenuOpen((v) => !v);
            setMenuOpen(false);
          }}
          className={cn(
            "whitespace-nowrap rounded-chip px-2 py-0.5 text-caption",
            entry.category === null
              ? entry.status === "failed"
                ? "bg-loss/10 text-loss"
                : "bg-amber-500/10 text-amber-600"
              : CATEGORY_CHIP[entry.category] ?? "bg-line-soft text-graphite",
          )}
          title="点击改分类"
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

      {/* 行内菜单 */}
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
              {entry.task !== null && (
                <MenuRow icon={<FolderOpen size={12} />} label="查看任务（待办页）" onClick={() => { setMenuOpen(false); goBacklog(); }} />
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

/* ------------------------------------------------------------------ 设置 */

function InboxSettings({ onClose }: { onClose: () => void }): ReactElement {
  const config = useInbox((s) => s.config);
  const saveConfig = useInbox((s) => s.saveConfig);
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);

  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newActionable, setNewActionable] = useState(false);

  if (config === null) {
    return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />;
  }

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    await saveConfig(patch);
    setBusy(false);
  };

  // Enter 与「添加」按钮共用的提交口：busy 守卫收在这里，两条路径都不会并发写
  const submitNewCategory = (): void => {
    const label = newLabel.trim();
    if (label === "" || busy) return;
    void save({ categories: [...config.categories, { id: label, label, actionable: newActionable }] });
    setNewLabel("");
  };

  const hbRuntimes = ["", ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="清单设置"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Settings2 size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">清单设置</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-body-sm">
          {/* 自动分类 */}
          <section className="space-y-2.5">
            <h3 className="text-body-sm font-medium text-ink">routing 分类</h3>
            <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
              <input
                type="checkbox"
                checked={config.autoClassify}
                disabled={busy}
                onChange={(e) => void save({ autoClassify: e.target.checked })}
                className="accent-teal"
              />
              写进清单后自动交给 routing 分类（关了就只能手动「立即分类」）
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">分类会话的执行器</span>
                <select
                  value={config.classifier.runtimeId}
                  disabled={busy}
                  onChange={(e) => void save({ classifier: { ...config.classifier, runtimeId: e.target.value } })}
                  className={inputCls}
                >
                  {hbRuntimes.map((id) => (
                    <option key={id} value={id}>
                      {id === "" ? "（跟随 routing bot 的主绑定）" : id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">模型（缺省跟随执行器）</span>
                <input
                  value={config.classifier.model ?? ""}
                  placeholder="（缺省跟随执行器）"
                  disabled={busy}
                  onChange={(e) => void save({ classifier: { ...config.classifier, model: e.target.value.trim() === "" ? null : e.target.value.trim() } })}
                  className={inputCls}
                />
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-ash">
              routing 是常驻 bot（侧栏「Routing」），它的主绑定在 bot 设置页改 —— 这里显式指定时优先。
            </p>
          </section>

          {/* 自定义分类 */}
          <section className="space-y-2">
            <h3 className="text-body-sm font-medium text-ink">自定义分类</h3>
            <p className="text-[10px] leading-relaxed text-ash">
              内置五个通用分类（目标 / 待办 / 想法 / 资料 / 以后再说）；这里追加你自己的。勾「沉淀任务」的分类会像目标/待办一样生成任务。
            </p>
            <div className="space-y-1.5">
              {config.categories.length === 0 && <p className="text-caption text-ash">还没有自定义分类</p>}
              {config.categories.map((c: InboxCategoryDef) => (
                <div key={c.id} className="flex items-center gap-2 rounded-btn bg-rail px-2.5 py-2">
                  <span className="flex-1 text-caption text-ink">{c.label}</span>
                  <label className="flex cursor-pointer items-center gap-1 text-caption text-graphite">
                    <input
                      type="checkbox"
                      checked={c.actionable}
                      disabled={busy}
                      onChange={(e) =>
                        void save({ categories: config.categories.map((x) => (x.id === c.id ? { ...x, actionable: e.target.checked } : x)) })
                      }
                      className="accent-teal"
                    />
                    沉淀任务
                  </label>
                  <button
                    onClick={() => void save({ categories: config.categories.filter((x) => x.id !== c.id) })}
                    className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-loss"
                    aria-label={`删除分类 ${c.label}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newLabel}
                placeholder="新分类名（如「读书清单」）"
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submitNewCategory();
                }}
                className={inputCls}
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-caption text-graphite">
                <input type="checkbox" checked={newActionable} onChange={(e) => setNewActionable(e.target.checked)} className="accent-teal" />
                沉淀任务
              </label>
              <button onClick={submitNewCategory} disabled={newLabel.trim() === "" || busy} className="shrink-0 rounded-btn bg-ink px-2.5 py-1.5 text-caption text-canvas hover:opacity-90 disabled:opacity-40">
                添加
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 杂项 */

function HintField({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <span className="block text-caption text-graphite">{label}</span>
      {children}
    </div>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon?: React.ReactNode; label: string; onClick: () => void; danger?: boolean }): ReactElement {
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

function HeaderBtn({ icon: Icon, label, onClick, active }: { icon: typeof Sparkles; label: string; onClick: () => void; active?: boolean }): ReactElement {
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

/** 去待办页（任务管理在那边） */
function goBacklog(): void {
  useShell.getState().setMainView("backlog");
}

const inputCls =
  "w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";
