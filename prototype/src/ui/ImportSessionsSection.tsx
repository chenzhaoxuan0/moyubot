import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Check, Download, FolderOpen, RefreshCw } from "lucide-react";
import {
  fetchImportableSessions,
  importNativeSessions,
  type ImportableNativeSession,
} from "../adapters/daemon/client.ts";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 「导入外部会话」—— 查询在**工作台外**、直接在外部终端里跑的 CLI 会话，
 * 勾选导入到本 bot 的历史列表（查询面参照 cc-switch 的会话管理页：按 bot
 * 工作区 + 执行器过滤，daemon 走 14 家原生 reader）。
 *
 * 数据流：history.import.list（带 known 标记 = 已在工作台历史中的行，不可重复
 * 导）→ 勾选 → history.import.apply 落 sessions 表（source = "imported"），
 * 落库即开始实时同步外部续写。导入后的行在侧栏带「导入」标签，点击进聊天页
 * （原生转录投影）、右键可从 TUI 继续。
 *
 * 自动收录（autocollect，bot 设置「导入会话」分区的开关，默认开）会周期把
 * 该目录新出现的外部会话自动收进来——本组件是它关闭或漏收时的手动兜底。
 *
 * 两个消费方共用一份：bot 设置（AddBotDialog 编辑态，unit 固定）与软件设置
 * （SettingsPage，外层带单元选择器）。
 */

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${hm}`;
}

export function ImportSessionsSection({ unitId }: { unitId: string }): ReactElement {
  const runtimes = useWorkbench((s) => s.runtimes);
  const bareIds = useMemo(() => runtimes.map((r) => r.id.replace(/^daemon:/, "")), [runtimes]);

  const [executor, setExecutor] = useState<string>(bareIds[0] ?? "");
  useEffect(() => {
    // 执行器清单异步到位后校正选中项
    if (bareIds.length > 0 && !bareIds.includes(executor)) setExecutor(bareIds[0]!);
  }, [bareIds, executor]);

  const [rows, setRows] = useState<readonly ImportableNativeSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    if (executor === "") return;
    setRows(null);
    setErr(null);
    setSelected(new Set());
    setDone(null);
    void fetchImportableSessions(unitId, executor, 80)
      .then((r) => setRows(r.sessions))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [unitId, executor]);

  useEffect(() => {
    load();
  }, [load]);

  const importable = rows?.filter((r) => !r.known) ?? [];
  const toggle = (sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const runImport = (): void => {
    const picked = importable.filter((r) => selected.has(r.sessionId));
    if (picked.length === 0 || busy) return;
    setBusy(true);
    void importNativeSessions(
      unitId,
      executor,
      picked.map((r) => ({ sessionId: r.sessionId, title: r.title, startedAt: r.startedAt, updatedAt: r.updatedAt })),
    )
      .then((r) => {
        // 导入即关注：自动置顶（久远会话按时间排百名开外，「导入成功」却在
        // 列表里找不到，等于失败）+ 广播让已展开的侧栏子列表立刻重拉
        if (r.keys.length > 0) useHistoryPrefs.getState().pinKeys(r.keys);
        window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId } }));
        setDone(
          `已导入 ${r.imported} 条${r.skipped > 0 ? `（跳过已在历史中的 ${r.skipped} 条）` : ""} —— 已置顶到侧栏该 bot 的历史列表（带「导入」标签）`,
        );
        load();
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3 text-body-sm">
      {/* 执行器分段（cc-switch 式：按执行器切换查询面）。整段说明收进悬停 */}
      <div
        className="flex flex-wrap items-center gap-1"
        title="列出在工作台外、直接用 CLI 在这个 bot 的工作目录里跑过的会话（各执行器自己的会话存储），勾选后收进本 bot 的历史列表——带「导入」标签，可回看原生转录、可从 TUI 继续。"
      >
        {bareIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setExecutor(id)}
            className={cn(
              "rounded-btn px-2 py-1 text-caption transition",
              id === executor ? "bg-teal-tint font-medium text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
            )}
          >
            {id}
          </button>
        ))}
        <button
          type="button"
          onClick={load}
          aria-label="重新查询"
          title="重新查询外部会话"
          className="ml-auto flex items-center gap-1 rounded-btn px-2 py-1 text-caption text-ash transition hover:bg-line-soft hover:text-ink"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : undefined} />
          刷新
        </button>
      </div>

      <p className="text-caption text-ash">
        自动收录开启时，这个目录的新外部会话会自动进侧栏；这里用于补收关闭自动收录或漏收的会话。
      </p>

      {err !== null && <p className="text-caption text-loss">查询失败：{err}</p>}
      {rows === null && err === null && <p className="text-caption text-ash">正在查询外部会话…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-caption text-ash">
          这个执行器在该 bot 工作目录下没有找到原生会话（CLI 在别的目录跑的不算）。
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="max-h-64 space-y-px overflow-y-auto rounded-btn border border-line">
          {rows.map((r) => {
            const checked = selected.has(r.sessionId);
            return (
              <button
                key={`${r.executorId}-${r.sessionId}`}
                type="button"
                disabled={r.known}
                onClick={() => toggle(r.sessionId)}
                title={r.known ? "已在工作台历史中" : r.source}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left text-caption transition",
                  r.known ? "cursor-default opacity-50" : "cursor-pointer hover:bg-line-soft",
                )}
              >
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                    checked ? "border-teal bg-teal text-canvas" : "border-line-strong",
                    r.known && "border-line",
                  )}
                >
                  {checked && <Check size={10} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-graphite">{r.title !== "" ? r.title : "（无标题会话）"}</span>
                {r.messageCount > 0 && <span className="shrink-0 text-ash/70">{r.messageCount} 条</span>}
                {r.known && (
                  <span className="shrink-0 rounded-full bg-line-soft px-1.5 py-px text-[9px] text-graphite">已在历史</span>
                )}
                <span className="shrink-0 text-ash/70">{fmtWhen(r.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={selected.size === 0 || busy}
          onClick={runImport}
          className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-caption font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
        >
          <Download size={12} />
          {busy ? "导入中…" : `导入所选 ${selected.size} 条`}
        </button>
        {done !== null && <p className="text-caption text-gain">{done}</p>}
        {done === null && rows !== null && rows.length > 0 && (
          <p className="flex items-center gap-1 text-[10px] text-ash">
            <FolderOpen size={10} />
            按工作目录匹配；只显示属于这个 bot 目录的会话
          </p>
        )}
      </div>
    </div>
  );
}
