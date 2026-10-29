import { useMemo, useState, type ReactElement } from "react";
import { FolderOpen, Inbox as InboxIcon, ListTodo, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  BUILTIN_CATEGORY_ORDER,
  DEFAULT_INBOX_CATEGORIES,
  INBOX_STATUS_LABEL,
  inboxCategoryLabel as categoryLabel,
  type InboxEntry,
} from "../core/inbox.ts";
import { BACKLOG_STATUS_LABEL, formatBacklogRelative, type BacklogStatus } from "../core/backlog.ts";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { MenuRow } from "./WorklistBits.tsx";
import { cn } from "./cn.ts";

/**
 * 清单页左栏 —— 注入的 context 块。待分类置顶，其余按分类分块；
 * actionable 分类的条目由 routing 沉淀成右栏的待办任务（任务链接不再跳页，
 * 点击即滚到右栏对应卡片）。
 */

export function InboxColumn({ onJumpToTask }: { onJumpToTask: (taskId: number) => void }): ReactElement {
  const entries = useInbox((s) => s.entries);
  const config = useInbox((s) => s.config);
  const backlogItems = useBacklog((s) => s.items);
  // O(entries) 而不是 O(entries × items)：每行找实时任务状态走一次 Map
  const taskById = useMemo(() => new Map(backlogItems.map((i) => [i.id, i])), [backlogItems]);

  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

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

  const row = (entry: InboxEntry): ReactElement => (
    <EntryRow
      key={entry.id}
      entry={entry}
      confirmingDelete={confirmingDelete}
      setConfirmingDelete={setConfirmingDelete}
      taskItem={findTask(taskById, entry)}
      onJumpToTask={onJumpToTask}
    />
  );

  return (
    <section className="min-w-0" aria-label="清单条目">
      <h2 className="mb-3 flex items-center gap-2">
        <span className="text-body-sm font-medium text-ink">清单</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">{entries.length} 条</span>
      </h2>

      <div className="space-y-5">
        {/* 待分类块置顶 —— routing 还没分拣的 */}
        {pending.length > 0 && (
          <Block title="待分类" count={pending.length} accent>
            {pending.map(row)}
          </Block>
        )}

        {blocks.map((b) => (
          <Block key={b.id} title={categoryLabel(b.id, customCategories)} count={b.items.length}>
            {b.items.map(row)}
          </Block>
        ))}

        {orphan.length > 0 && (
          <Block title="其他" count={orphan.length}>
            {orphan.map(row)}
          </Block>
        )}
      </div>

      {entries.length === 0 && (
        <div className="flex flex-col items-center rounded-card border border-line bg-card px-6 py-10 text-center">
          <InboxIcon size={16} className="mb-2 text-ash" />
          <p className="text-body-sm font-medium text-ink">清单还是空的</p>
          <p className="mt-1 max-w-[460px] text-body-sm leading-relaxed text-graphite">
            像编辑你那个 Notepad++ 里的 txt 一样用这里：想法、近期目标、要做的杂事、留存的资料 ——
            全写进上面的文本框。routing bot 会分好类：目标/待办沉淀成任务，空闲用量里自动执行。
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ 分块 */

function Block({ title, count, accent, children }: { title: string; count: number; accent?: boolean; children: React.ReactNode }): ReactElement {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2">
        <span className={cn("text-body-sm font-medium", accent ? "text-amber-600" : "text-ink")}>{title}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-ash">{count}</span>
      </h3>
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
  onJumpToTask,
}: {
  entry: InboxEntry;
  confirmingDelete: number | null;
  setConfirmingDelete: (id: number | null) => void;
  taskItem: { id: number; status: string; title: string } | null;
  onJumpToTask: (taskId: number) => void;
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
            <button onClick={() => onJumpToTask(taskItem.id)} className="flex items-center gap-1 text-graphite hover:text-ink" title="定位右栏的对应任务">
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
                <MenuRow icon={<FolderOpen size={12} />} label="定位任务（右栏）" onClick={() => { setMenuOpen(false); onJumpToTask(entry.task!.id); }} />
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
