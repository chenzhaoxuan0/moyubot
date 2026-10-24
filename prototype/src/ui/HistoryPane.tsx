import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Copy,
  GitBranch,
  ListTodo,
  MessageSquare,
  Radio,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  dispatchTerminal,
  fetchNativeSessionDetail,
  fetchNativeSessions,
  fetchSessionMessages,
  fetchTerminalTranscript,
  fetchUnitHistory,
  forgetSession,
  type NativeSessionDetail,
  type NativeSessionSummary,
  type UnitHistoryEntry,
} from "../adapters/daemon/client.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { asSessionId, asUnitId, SESSION_SOURCE_LABEL, type SessionSource } from "../core/units.ts";
import { useShell } from "../store/useShell.ts";
import { collapseForkVersions } from "./forkHistory.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { cn } from "./cn.ts";

/**
 * 单元历史会话 —— 每个 bot 一条统一时间轴：自动化任务、待办任务、心跳会话、
 * 手动/IM 会话。核心目的是「打开就能看到这个 bot 历史执行过什么」，不用再去
 * 各执行器的 TUI 会话列表里翻。
 *
 * 迁移自 HistoryDialog 弹窗（ZCode 右侧栏模式）：内容主体原样平移，只换壳 ——
 * - 不再有 fixed overlay / Esc / 点遮罩关闭；关闭即关 tab（面板条上的 ×）
 * - 跨 bot 保活：面板隐藏（切走 bot / 收起）时**不轮询不重置**，列表缓存与
 *   展开态保留，切回即达；重新可见时立刻刷一次并恢复轮询
 * - 「TUI 恢复 / 在聊天页继续」成功后调 onFinished 关掉这个 tab（弹窗时代
 *   是 onClose 关弹窗 —— 动作完成，这个视图的使命就结束了）
 *
 * - headless 条目带 sessionId，可展开内联看对话（session.messages，daemon 对
 *   历史会话有 store 兜底）
 * - TUI 条目没有消息流，只有运行状态与结果摘要（terminal exit / ended: …）
 */

const KIND_META: Record<UnitHistoryEntry["kind"], { icon: typeof ListTodo; label: string; cls: string }> = {
  automation: { icon: AlarmClock, label: "定时", cls: "bg-teal-tint text-teal" },
  backlog: { icon: ListTodo, label: "待办", cls: "bg-amber-500/10 text-amber-600" },
  manual: { icon: Terminal, label: "手动", cls: "bg-violet-500/10 text-violet-500" },
  session: { icon: MessageSquare, label: "会话", cls: "bg-line-soft text-graphite" },
};

function statusMeta(status: string): { icon: typeof CircleCheck; cls: string; label: string } {
  if (status === "done" || status === "completed" || status === "idle") {
    return { icon: CircleCheck, cls: "text-gain", label: "完成" };
  }
  if (status === "failed") return { icon: CircleAlert, cls: "text-loss", label: "失败" };
  if (status === "skipped") return { icon: CircleAlert, cls: "text-ash", label: "跳过" };
  if (status === "running") return { icon: CircleDot, cls: "text-blue-500 animate-pulse", label: "运行中" };
  return { icon: CircleDot, cls: "text-graphite", label: status };
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return hm;
  return `${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${hm}`;
}

function formatDuration(entry: UnitHistoryEntry): string | null {
  if (entry.endedAt === null) return null;
  const s = Math.round((entry.endedAt - entry.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * 每执行器的 TUI 恢复口径（各家 --help 实测）：
 *   zcode    --resume <sessionId>（我们的 id 即原生 sess_ id）
 *   claude   --resume <session-id>（cli_ref = CLI 原生 session id）
 *   codex    resume <SESSION_ID>（子命令，cli_ref = thread id）
 *   mcode    --session <id>（ACP sessionId 与 TUI 会话同库）
 *   kimi     --session <id>（-S，带 id 直接恢复）
 *   opencode --session <id>（-s，session id to continue）
 *   hermes   --resume <SESSION>
 *   dsh      --resume <id>（TUI 走 dst shim，--resume [id]）
 * ACP 系的 id 与 TUI 会话库同源（同一 CLI 的会话存储），若个别家实测对不上，
 * 从表里删一行即可，记录侧不受影响。
 */
const RESUME_ARGS: Record<string, (ref: string) => string[]> = {
  zcode: (ref) => ["--resume", ref],
  claude: (ref) => ["--resume", ref],
  codex: (ref) => ["resume", ref],
  mcode: (ref) => ["--session", ref],
  kimi: (ref) => ["--session", ref],
  opencode: (ref) => ["--session", ref],
  hermes: (ref) => ["--resume", ref],
  dsh: (ref) => ["--resume", ref],
  agy: (ref) => ["--conversation", ref],
  antigravity: (ref) => ["--conversation", ref],
  pi: (ref) => ["--session-id", ref],
  grok: (ref) => ["--resume", ref],
  cursor: (ref) => ["--resume", ref],
  "cursor-agent": (ref) => ["--resume", ref],
  openclaw: (ref) => ["agent", "--session-id", ref],
};

/** 可恢复判定（侧栏子列表与历史面板共用） */
export function resumeArgsFor(runtimeId: string, resumeRef: string | null): string[] | null {
  if (resumeRef === null) return null;
  const bare = runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "").toLowerCase();
  const build = RESUME_ARGS[bare] ?? RESUME_ARGS[runtimeId];
  return build === undefined ? null : build(resumeRef);
}

export function HistoryPane({
  unitId,
  unitName,
  focusKey,
  isActive,
  onFinished,
}: {
  unitId: string;
  unitName: string;
  /** 侧栏子列表点进来时预展开的条目（对话直接可见，不用再点一次） */
  focusKey?: string;
  /** 面板当前可见且为本 tab（保活协议：false 时停轮询、保留缓存） */
  isActive: boolean;
  /** 「TUI 恢复 / 在聊天页继续」成功后关掉本 tab */
  onFinished: () => void;
}): ReactElement {
  const units = useWorkbench((s) => s.units);
  const [entries, setEntries] = useState<readonly UnitHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(focusKey ?? null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);

  /** 页签：运行记录（daemon 台账）| 原生会话（各 CLI 自己的存储，docs/13 Phase 1） */
  const [tab, setTab] = useState<"runs" | "native">("runs");
  const [nativeList, setNativeList] = useState<readonly NativeSessionSummary[] | null>(null);
  const [nativeErr, setNativeErr] = useState<string | null>(null);
  const [nativeExpanded, setNativeExpanded] = useState<string | null>(null);

  /** 整理模式：勾选删除会话行（测试会话堆积的清理面）。删除走 session.forget，
   *  只对 session 类行开放（含导入行）—— 自动化/待办/TUI 运行记录没有删除 RPC */
  const [organizing, setOrganizing] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reloadNonce, setReloadNonce] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  /** 两步确认：第一下亮红「确认删除」，第二下才动手（不弹模态） */
  const [armed, setArmed] = useState(false);

  /**
   * 在 TUI 中恢复：按条目执行器派发终端，带各家 resume 口径的参数（见 RESUME_ARGS）。
   * 依据是 cli_ref（执行器原生会话 id），不是我们的内部 id —— 记录侧只存 id，
   * 适配全部收敛在这张映射表里。
   */
  const resumable = (e: UnitHistoryEntry): boolean =>
    resumeArgsFor(e.runtimeId, e.resumeRef) !== null && units.some((u) => u.id === unitId);

  const handleResume = (e: UnitHistoryEntry): void => {
    const u = units.find((x) => x.id === unitId);
    const args = resumeArgsFor(e.runtimeId, e.resumeRef);
    if (u === undefined || args === null) return;
    setResumeBusy(e.key);
    // 派发意图先登记：紧跟的「终端跟随 bot」effect 看到在途就不再发一个全新 TUI
    useTerminalStore.getState().notePendingUnitDispatch(unitId);
    void dispatchTerminal({
      unitId,
      unitName: u.name,
      rootPath: u.rootPath,
      runtimeId: e.runtimeId,
      args,
      // 带着原生引用派发 —— daemon 落库后这条新运行重启也能继续「回到它」
      resumeRef: e.resumeRef,
    })
      .then(() => {
        const wb = useWorkbench.getState();
        // 当前 bot 不重复 selectUnit —— 那会清掉正在看的聊天时间线
        if (String(wb.activeUnitId) !== String(unitId)) wb.selectUnit(asUnitId(unitId));
        // TUI 恢复的落点就是终端画布：切过去，别让用户对着聊天页猜终端在哪
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        // 打开即已读：熄掉侧栏的「完成未读」绿灯
        useHistoryPrefs
          .getState()
          .markViewed([e.key, ...(e.sessionId !== null ? [`session-${e.sessionId}`] : [])]);
        onFinished();
      })
      .catch((err2: unknown) => console.error("[HistoryPane] TUI 恢复失败:", err2))
      .finally(() => setResumeBusy(null));
  };

  /**
   * 在聊天页继续（ADR 0012 resume-in-chat）：headless 会话从 daemon 账本重建
   * 时间线；可恢复（live / cli_ref）时接回执行器，否则打开只读段。
   * 与 TUI 恢复互补：TUI 走执行器自己的存储（原生原味），这里走 host 账本投影。
   */
  const handleOpenInChat = (e: UnitHistoryEntry): void => {
    // unitId 用面板自身的所属 bot：entry.unitId 是 daemon 的可选字段，且面板
    // 固定属于一个 bot（见 Sidebar.openEntryInChat 同注）
    if (e.sessionId === null) return;
    void useWorkbench
      .getState()
      .openSession({ sessionId: asSessionId(e.sessionId), unitId: asUnitId(unitId), runtimeId: e.runtimeId });
    const sh = useShell.getState();
    sh.setMainView("chat");
    sh.setConversationView("chat");
    // 打开即已读：熄掉侧栏的「完成未读」绿灯
    useHistoryPrefs.getState().markViewed([e.key, `session-${e.sessionId}`]);
    onFinished();
  };

  useEffect(() => {
    let alive = true;
    // 保活协议：隐藏（切走 bot / 切到别的 tab / 收起面板）时不轮询不重置 ——
    // 列表缓存留着，切回即达；重新可见时立刻刷一次再恢复 20s 轮询
    //（运行中的条目状态会推进）
    if (!isActive) return;
    setErr(null);
    const load = (): void => {
      if (!alive) return;
      void fetchUnitHistory(unitId, 200)
        .then((list) => {
          if (alive) setEntries(list);
        })
        .catch((e: unknown) => {
          if (alive) setErr(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const poll = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
    // focusKey 不进依赖：面板开着换展开目标时只动 expanded，列表不重载不闪；
    // reloadNonce 是整理模式删除后的手动重拉通道
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, isActive, reloadNonce]);

  useEffect(() => {
    setExpanded(focusKey ?? null);
  }, [focusKey]);

  // 原生会话列表：切到该页签且面板可见时拉一次（不轮询——磁盘事实源，基本不变；
  // 拉过的结果在保活期间复用，切回不重拉）
  useEffect(() => {
    if (tab !== "native" || !isActive || nativeList !== null) return;
    let alive = true;
    setNativeErr(null);
    void fetchNativeSessions(unitId, 60)
      .then((rows) => {
        if (alive) setNativeList(rows);
      })
      .catch((e: unknown) => {
        if (alive) setNativeErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [tab, unitId, nativeList, isActive]);

  /** 原生会话的 TUI 恢复：sessionId 即各家原生 id（与 RESUME_ARGS 口径一致） */
  const handleNativeResume = (s: NativeSessionSummary): void => {
    const u = units.find((x) => x.id === unitId);
    const args = resumeArgsFor(s.executorId, s.sessionId);
    if (u === undefined || args === null) return;
    setResumeBusy(`native-${s.executorId}-${s.sessionId}`);
    useTerminalStore.getState().notePendingUnitDispatch(unitId);
    void dispatchTerminal({
      unitId,
      unitName: u.name,
      rootPath: u.rootPath,
      runtimeId: s.executorId,
      args,
      // 带原生引用落库：同会话再开走「重挂」不增行（见 terminal.dispatch）
      resumeRef: s.sessionId,
    })
      .then(() => {
        const wb = useWorkbench.getState();
        if (String(wb.activeUnitId) !== String(unitId)) wb.selectUnit(asUnitId(unitId));
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        onFinished();
      })
      .catch((err2: unknown) => console.error("[HistoryPane] 原生会话 TUI 恢复失败:", err2))
      .finally(() => setResumeBusy(null));
  };

  const hideFailedInDialog = useHistoryPrefs((s) => s.prefs.hideFailedInDialog);
  const setPrefs = useHistoryPrefs((s) => s.setPrefs);

  const failedCount = useMemo(() => {
    if (!entries) return 0;
    return entries.filter((e) => e.status === "failed").length;
  }, [entries]);

  const displayedEntries = useMemo(() => {
    if (!entries) return null;
    if (!hideFailedInDialog) return entries;
    return entries.filter(
      (e) =>
        e.status !== "failed" ||
        e.key === focusKey ||
        (e.sessionId !== null && `session-${e.sessionId}` === focusKey),
    );
  }, [entries, hideFailedInDialog, focusKey]);

  /** 可删行：session 类（含导入）且非活会话 —— 运行中的 daemon 会拒绝 forget */
  const pickableOf = (e: UnitHistoryEntry): boolean =>
    e.kind === "session" &&
    e.key.startsWith("session-") &&
    e.status !== "running" &&
    e.status !== "awaiting_permission" &&
    e.status !== "awaiting_input";

  const togglePick = (key: string): void => {
    setArmed(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runDelete = (): void => {
    if (deleting || picked.size === 0) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setDeleting(true);
    setDeleteErr(null);
    const ids = [...picked].filter((k) => k.startsWith("session-")).map((k) => k.slice("session-".length));
    void Promise.allSettled(ids.map((id) => forgetSession(id)))
      .then((results) => {
        const failedCount = results.filter((r) => r.status === "rejected").length;
        if (failedCount > 0) setDeleteErr(`${failedCount} 条删除失败（运行中的会话不能删），其余已完成`);
        else setDeleteErr(null);
        setPicked(new Set());
        setArmed(false);
        setReloadNonce((n) => n + 1);
        // 侧栏子列表同步刷新（它不知道这里删了东西）
        window.dispatchEvent(new CustomEvent("awb:history-refresh", { detail: { unitId } }));
      })
      .finally(() => setDeleting(false));
  };

  return (
    <section aria-label={`${unitName} 历史会话`} className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        {/* 页签切换：daemon 运行台账 | 各 CLI 原生存储 */}
        <div className="flex items-center rounded-btn bg-line-soft/80 p-0.5">
          <button
            type="button"
            onClick={() => setTab("runs")}
            className={cn(
              "rounded-btn px-2 py-0.5 text-caption font-medium transition",
              tab === "runs" ? "bg-card text-teal font-semibold shadow-xs" : "text-graphite hover:text-ink",
            )}
          >
            运行记录
          </button>
          <button
            type="button"
            onClick={() => setTab("native")}
            title="各 CLI 自己的会话存储（TUI 里聊的、任何入口产生的都来自磁盘事实源）"
            className={cn(
              "rounded-btn px-2 py-0.5 text-caption font-medium transition",
              tab === "native" ? "bg-card text-teal font-semibold shadow-xs" : "text-graphite hover:text-ink",
            )}
          >
            原生会话
          </button>
        </div>

        {tab === "runs" && failedCount > 0 && (
          <button
            type="button"
            onClick={() => setPrefs({ hideFailedInDialog: !hideFailedInDialog })}
            title={hideFailedInDialog ? "点击显示包含失败在内的全部会话" : "点击隐藏失败会话"}
            className={cn(
              "flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-caption font-medium transition cursor-pointer",
              hideFailedInDialog
                ? "bg-loss/10 text-loss hover:bg-loss/15"
                : "bg-line-soft text-graphite hover:bg-line",
            )}
          >
            <CircleAlert size={11} className={hideFailedInDialog ? "text-loss" : "text-ash"} />
            <span>{hideFailedInDialog ? `已隐藏 ${failedCount} 条失败（点击查看）` : `已显示失败（点击隐藏）`}</span>
          </button>
        )}
        {tab === "runs" && (
          <button
            type="button"
            onClick={() => {
              setOrganizing(!organizing);
              setPicked(new Set());
              setArmed(false);
              setDeleteErr(null);
            }}
            aria-pressed={organizing}
            title={organizing ? "退出整理模式" : "整理：勾选删除不再需要的会话（测试会话堆积的清理面）"}
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1 rounded-chip px-2 py-0.5 text-caption font-medium transition cursor-pointer",
              organizing ? "bg-loss/10 text-loss" : "bg-line-soft text-graphite hover:bg-line hover:text-ink",
            )}
          >
            <Trash2 size={11} />
            <span>{organizing ? "退出整理" : "整理"}</span>
          </button>
        )}
        <span className={cn("shrink-0 text-caption text-ash", tab === "runs" && organizing && "hidden")}>
          {tab === "native"
            ? nativeList === null
              ? "加载中…"
              : `${nativeList.length} 条`
            : entries === null
              ? "加载中…"
              : hideFailedInDialog && failedCount > 0
                ? `${displayedEntries?.length ?? 0} / ${entries.length} 条`
                : `${entries.length} 条`}
        </span>
      </div>

      {tab === "native" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {nativeErr !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{nativeErr}</p>}
          {nativeList !== null && nativeList.length === 0 && (
            <p className="px-1 py-6 text-center text-caption text-ash">
              这个工作目录下还没找到各 CLI 的原生会话 —— 在 TUI 里跑过之后会出现在这里
            </p>
          )}
          {nativeList?.map((s) => (
            <NativeRow
              key={`${s.executorId}-${s.sessionId}`}
              summary={s}
              expanded={nativeExpanded === `${s.executorId}-${s.sessionId}`}
              resumeBusy={resumeBusy === `native-${s.executorId}-${s.sessionId}`}
              onToggle={() =>
                setNativeExpanded(nativeExpanded === `${s.executorId}-${s.sessionId}` ? null : `${s.executorId}-${s.sessionId}`)
              }
              onResume={() => handleNativeResume(s)}
            />
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {err !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>}
          {entries !== null && entries.length === 0 && (
            <p className="px-1 py-6 text-center text-caption text-ash">还没有执行记录 —— 自动化、待办或手动会话跑过之后会出现在这里</p>
          )}
          {entries !== null && entries.length > 0 && displayedEntries !== null && displayedEntries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-caption text-ash">
                此 Bot 当前共有 {failedCount} 条记录，全部为失败会话，已根据设置隐藏。
              </p>
              <button
                type="button"
                onClick={() => setPrefs({ hideFailedInDialog: false })}
                className="mt-2.5 rounded-btn bg-line-soft px-3 py-1 text-caption font-medium text-graphite transition hover:bg-line hover:text-ink cursor-pointer"
              >
                显示全部 {failedCount} 条失败记录
              </button>
            </div>
          )}
          {displayedEntries !== null &&
            collapseForkVersions(displayedEntries).map((slot) => {
              const isFocused = Boolean(
                focusKey &&
                  (slot.entry.key === focusKey ||
                    (slot.entry.sessionId !== null && `session-${slot.entry.sessionId}` === focusKey) ||
                    (slot.family && slot.family.some((f) => f.key === focusKey))),
              );
              return (
                <HistoryRow
                  key={slot.entry.key}
                  unitId={unitId}
                  entry={slot.entry}
                  family={slot.family}
                  isFocused={isFocused}
                  expanded={expanded === slot.entry.key || isFocused}
                  onToggle={() => setExpanded(expanded === slot.entry.key ? null : slot.entry.key)}
                  resumable={resumable(slot.entry)}
                  resumeBusy={resumeBusy === slot.entry.key}
                  onResume={() => handleResume(slot.entry)}
                  onOpenInChat={slot.entry.sessionId !== null ? () => handleOpenInChat(slot.entry) : undefined}
                  onOpenFamilyMember={(m) => handleOpenInChat(m)}
                  organizing={organizing}
                  pickable={pickableOf(slot.entry)}
                  picked={picked.has(slot.entry.key)}
                  onTogglePick={() => togglePick(slot.entry.key)}
                />
              );
            })}
        </div>
      )}

      {/* 整理模式底栏：全选可删行 + 两步确认删除 */}
      {tab === "runs" && organizing && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line bg-rail px-3">
          <button
            type="button"
            onClick={() => {
              setArmed(false);
              const pickableKeys = new Set((entries ?? []).filter(pickableOf).map((e) => e.key));
              setPicked((prev) => (prev.size >= pickableKeys.size ? new Set() : pickableKeys));
            }}
            className="rounded-btn px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink cursor-pointer"
          >
            {picked.size > 0 && picked.size >= (entries ?? []).filter(pickableOf).length ? "取消全选" : "全选可删行"}
          </button>
          <span className="text-caption text-ash">
            已选 {picked.size} 条{deleteErr !== null && <span className="ml-2 text-loss">{deleteErr}</span>}
          </span>
          <button
            type="button"
            disabled={picked.size === 0 || deleting}
            onClick={runDelete}
            className={cn(
              "ml-auto flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-caption font-medium transition cursor-pointer disabled:opacity-40",
              armed ? "bg-loss text-canvas hover:opacity-90" : "bg-line-soft text-loss hover:bg-loss/10",
            )}
            title="删除所选会话行及其消息（不可恢复）；自动化/待办/TUI 运行记录不参与删除"
          >
            <Trash2 size={12} />
            {deleting ? "删除中…" : armed ? `确认删除 ${picked.size} 条` : `删除所选 ${picked.size} 条`}
          </button>
        </div>
      )}
    </section>
  );
}

/** 原生会话行：执行器徽标 + 标题 + 时间，展开富转录，可 TUI 恢复 */
function NativeRow({
  summary,
  expanded,
  resumeBusy,
  onToggle,
  onResume,
}: {
  summary: NativeSessionSummary;
  expanded: boolean;
  resumeBusy: boolean;
  onToggle: () => void;
  onResume: () => void;
}): ReactElement {
  const resumable = resumeArgsFor(summary.executorId, summary.sessionId) !== null;
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button onClick={onToggle} className="flex w-full items-start gap-2 rounded-btn px-2 py-2 text-left transition hover:bg-line-soft">
        <span className="mt-0.5 shrink-0 rounded-chip bg-teal-tint px-1.5 py-0.5 font-mono text-[10px] text-teal">
          {summary.executorId}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{summary.title}</span>
            <span className="shrink-0 text-caption text-ash">{summary.messageCount} 条</span>
            <span className="shrink-0 text-caption text-ash">{formatWhen(summary.updatedAt)}</span>
            {resumable && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onResume();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onResume();
                  }
                }}
                title={`在终端以 TUI 重开这段原生会话（${summary.executorId} resume）`}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas",
                  resumeBusy && "opacity-50",
                )}
              >
                <RotateCcw size={9} />
                {resumeBusy ? "恢复中" : "TUI 恢复"}
              </span>
            )}
            {expanded ? <ChevronDown size={13} className="shrink-0 text-ash" /> : <ChevronRight size={13} className="shrink-0 text-ash" />}
          </span>
          {summary.rootPath !== null && (
            <span className="mt-0.5 block truncate font-mono text-caption text-ash/70">{summary.rootPath}</span>
          )}
        </span>
      </button>
      {expanded && <NativeTranscript executorId={summary.executorId} sessionId={summary.sessionId} />}
    </div>
  );
}

/** 原生会话富转录：user/assistant 对话 + 工具行 + 思考折叠 */
function NativeTranscript({ executorId, sessionId }: { executorId: string; sessionId: string }): ReactElement {
  const [detail, setDetail] = useState<NativeSessionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    void fetchNativeSessionDetail(executorId, sessionId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [executorId, sessionId]);

  if (err !== null) return <p className="px-4 pb-2 text-caption text-loss">转录读取失败：{err}</p>;
  if (detail === null) return <p className="px-4 pb-2 text-caption text-ash">读取转录…</p>;
  if (detail.transcript.length === 0) return <p className="px-4 pb-2 text-caption text-ash">这条会话没有可展示的对话内容</p>;

  return (
    <div className="mx-2 mb-2 max-h-80 space-y-1.5 overflow-y-auto rounded-btn bg-rail p-2.5">
      {detail.transcript.map((e, i) => {
        if (e.kind === "tool") {
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="flex w-14 shrink-0 items-center justify-end gap-0.5 text-right text-caption text-ash/70">
                <Wrench size={9} />
                工具
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-graphite/80">
                {e.toolName !== undefined ? `[${e.toolName}] ` : ""}
                {e.text === "" ? "（无参数/输出）" : e.text}
              </p>
            </div>
          );
        }
        if (e.kind === "thinking") {
          return (
            <details key={i} className="flex items-start gap-2 group">
              <summary className="flex w-14 shrink-0 cursor-pointer items-center justify-end gap-0.5 text-right text-caption text-ash/70 list-none">
                <Sparkles size={9} />
                思考
              </summary>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed text-ash group-open:text-graphite/80">
                {e.text}
              </p>
            </details>
          );
        }
        const label = e.kind === "user" ? "用户" : e.kind === "assistant" ? "助手" : e.kind === "compaction" ? "压缩" : "系统";
        return (
          <div key={i} className="flex items-start gap-2">
            <span
              className={cn(
                "w-14 shrink-0 text-right text-caption",
                e.kind === "user" ? "text-teal" : e.kind === "assistant" ? "text-graphite" : "text-ash/60",
              )}
            >
              {label}
            </span>
            {/* 助手行走 markdown 富渲染（docs/17）；用户/系统行保持纯文本 */}
            {e.kind === "assistant" && e.text !== "" ? (
              <div className="min-w-0 flex-1 text-graphite">
                <MarkdownContent content={e.text} className="text-caption leading-relaxed" />
              </div>
            ) : (
              <p
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed",
                  e.kind === "user" ? "text-ink" : e.kind === "assistant" ? "text-graphite" : "text-ash/70",
                )}
              >
                {e.text === "" ? "（空）" : e.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryRow({
  unitId,
  entry,
  family,
  isFocused = false,
  expanded,
  onToggle,
  resumable,
  resumeBusy,
  onResume,
  onOpenInChat,
  onOpenFamilyMember,
  organizing,
  pickable,
  picked,
  onTogglePick,
}: {
  /** 面板所属 bot —— 打开/监控跳转的 unitId 用它（entry.unitId 是可选字段，见 Sidebar 同注） */
  unitId: string;
  entry: UnitHistoryEntry;
  /** 同锚点的 revision 家族（旧 → 新，含 entry；ADR 0013 P2 版本折叠） */
  family?: readonly UnitHistoryEntry[];
  /** 是否为刚刚在侧边栏点击选中的条目（高亮并滚动定位） */
  isFocused?: boolean;
  expanded: boolean;
  onToggle: () => void;
  resumable: boolean;
  resumeBusy: boolean;
  onResume: () => void;
  /** ADR 0012 resume-in-chat：headless 会话才有（TUI 条目没有我们的账本） */
  onOpenInChat?: () => void;
  /** 家族成员「在聊天页继续」（版本导航的落点） */
  onOpenFamilyMember?: (m: UnitHistoryEntry) => void;
  /** 整理模式：行点击从「展开」切换为「勾选」 */
  organizing: boolean;
  /** 整理模式下可勾选（session 类且非活会话；运行记录无删除 RPC 不可选） */
  pickable: boolean;
  picked: boolean;
  onTogglePick: () => void;
}): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFocused && rowRef.current) {
      const timer = setTimeout(() => {
        rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isFocused]);

  const kind = KIND_META[entry.kind];
  const st = useMemo(() => statusMeta(entry.status), [entry.status]);
  const dur = formatDuration(entry);
  const KIcon = kind.icon;
  const SIcon = st.icon;
  const expandable = entry.sessionId !== null || Boolean(entry.terminalId) || entry.launchMode === "terminal";
  const [familyOpen, setFamilyOpen] = useState(false);
  const badge =
    family !== undefined && family.length > 1
      ? `${family.length} 个版本`
      : entry.forkKind === "branch"
        ? "分叉"
        : entry.forkKind === "revision"
          ? "重发"
          : null;

  const isArchived = useHistoryPrefs((s) => s.isArchived(entry.key, entry.sessionId));

  return (
    <div
      ref={rowRef}
      className={cn(
        "border-b border-line-soft last:border-b-0 transition-all duration-300",
        picked && "bg-loss/5",
        isFocused && "bg-teal-tint/50 border-l-4 border-l-teal pl-1.5 ring-1 ring-teal/30 shadow-xs",
      )}
    >
      <button
        onClick={organizing ? (pickable ? onTogglePick : undefined) : expandable ? onToggle : undefined}
        className={cn(
          "flex w-full items-start gap-2 rounded-btn px-2 py-2 text-left transition",
          organizing ? (pickable ? "cursor-pointer hover:bg-line-soft" : "cursor-default opacity-60") : expandable ? "hover:bg-line-soft" : "cursor-default",
        )}
        title={
          organizing
            ? pickable
              ? picked ? "点击取消勾选" : "勾选后可在底栏批量删除（不可恢复）"
              : "运行记录（自动化 / 待办 / TUI 派发）暂不支持删除"
            : expandable
              ? "点击查看对话内容或终端输出快照"
              : undefined
        }
      >
        {organizing && (
          <span
            className={cn(
              "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
              picked ? "border-loss bg-loss text-canvas" : "border-line-strong",
              !pickable && "border-line opacity-50",
            )}
          >
            {picked && <Check size={10} strokeWidth={3} />}
          </span>
        )}
        <span className={cn("mt-0.5 shrink-0 rounded-chip px-1.5 py-0.5 text-[10px]", kind.cls)}>
          <KIcon size={10} className="mr-0.5 inline-block align-[-1px]" />
          {kind.label}
        </span>
        {entry.kind === "session" && entry.source != null && entry.source !== "" && entry.source !== "workbench" && (
          <span
            className="mt-0.5 shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite"
            title={`这条会话从${SESSION_SOURCE_LABEL[entry.source as SessionSource] ?? entry.source}发起`}
          >
            {SESSION_SOURCE_LABEL[entry.source as SessionSource] ?? entry.source}
          </span>
        )}
        {entry.trigger === "manual" && (entry.kind === "automation" || entry.kind === "backlog") && (
          <span
            className="mt-0.5 shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite"
            title="手动点的一次执行（非到点自动触发）"
          >
            手动触发
          </span>
        )}
        {badge !== null && (
          <span
            role={family !== undefined && family.length > 1 ? "button" : undefined}
            tabIndex={family !== undefined && family.length > 1 ? 0 : undefined}
            onClick={() => {
              if (family !== undefined && family.length > 1) setFamilyOpen(!familyOpen);
            }}
            onKeyDown={(ev) => {
              if ((ev.key === "Enter" || ev.key === " ") && family !== undefined && family.length > 1) {
                ev.stopPropagation();
                setFamilyOpen(!familyOpen);
              }
            }}
            className={cn(
              "mt-0.5 flex shrink-0 items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal",
              family !== undefined && family.length > 1 && "cursor-pointer transition hover:bg-teal hover:text-canvas",
            )}
            title={
              family !== undefined && family.length > 1
                ? "同一轮的多个重发版本：展开回看旧版本（旧分支永不删）"
                : "这段是从更早的对话分叉出来的"
            }
          >
            <GitBranch size={9} />
            {badge}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{entry.title}</span>
            {isFocused && (
              <span className="shrink-0 rounded bg-teal px-1.5 py-0.5 text-[10px] font-medium text-canvas shadow-xs">
                当前定位
              </span>
            )}
            <SIcon size={12} className={cn("shrink-0", st.cls)} />
            <span className={cn("shrink-0 text-caption", st.cls)}>{st.label}</span>
            {dur !== null && <span className="shrink-0 text-caption text-ash">{dur}</span>}
            <span className="shrink-0 text-caption text-ash">{formatWhen(entry.startedAt)}</span>
            {/* 在聊天页继续 / 在 TUI 中恢复：行根是 button，内嵌动作用 span 实现（button 套 button 非法） */}
            {onOpenInChat !== undefined && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenInChat();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onOpenInChat();
                  }
                }}
                title="把这段对话接回聊天页：可恢复时续聊原会话，否则打开只读历史（发消息将开新段）"
                className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
              >
                <MessageSquare size={9} />
                在聊天页继续
              </span>
            )}
            {entry.sessionId !== null && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  useSidePane.getState().openLiveSession({
                    unitId: asUnitId(unitId),
                    sessionId: entry.sessionId!,
                    runtimeId: entry.runtimeId,
                    title: entry.title,
                  });
                }}
                onKeyDown={(ev) => {
                  if (ev.key !== "Enter" && ev.key !== " ") return;
                  // Space 不拦默认行为会先滚动列表再触发，按钮语义应吃掉它
                  ev.preventDefault();
                  ev.stopPropagation();
                  useSidePane.getState().openLiveSession({
                    unitId: asUnitId(unitId),
                    sessionId: entry.sessionId!,
                    runtimeId: entry.runtimeId,
                    title: entry.title,
                  });
                }}
                title="在右侧面板跟随这条会话的事件流：在跑的实时看，已结束的可回放"
                className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas"
              >
                <Radio size={9} />
                监控
              </span>
            )}
            {resumable && (
              <span
                role="button"
                tabIndex={0}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onResume();
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.stopPropagation();
                    onResume();
                  }
                }}
                title={`在新终端以 TUI 重现这段会话（${entry.runtimeId} --resume）—— 对话原文在执行器自己的存储里，不依赖本表`}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-teal-tint px-1.5 py-px text-[10px] text-teal transition hover:bg-teal hover:text-canvas",
                  resumeBusy && "opacity-50",
                )}
              >
                <RotateCcw size={9} />
                {resumeBusy ? "恢复中" : "TUI 恢复"}
              </span>
            )}
            {/* 归档 / 取消归档按钮 */}
            <span
              role="button"
              tabIndex={0}
              onClick={(ev) => {
                ev.stopPropagation();
                useHistoryPrefs.getState().toggleArchived(entry);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.stopPropagation();
                  useHistoryPrefs.getState().toggleArchived(entry);
                }
              }}
              title={isArchived ? "取消归档：恢复至左侧栏显示" : "归档任务：移入已完成抽屉，不在左侧栏占用空间"}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip px-1.5 py-px text-[10px] transition",
                isArchived
                  ? "bg-teal-tint text-teal font-medium hover:bg-teal hover:text-canvas"
                  : "bg-line-soft text-ash hover:bg-teal-tint hover:text-teal",
              )}
            >
              {isArchived ? <ArchiveRestore size={9} /> : <Archive size={9} />}
              {isArchived ? "已归档" : "归档"}
            </span>
            {expandable && (expanded ? <ChevronDown size={13} className="shrink-0 text-ash" /> : <ChevronRight size={13} className="shrink-0 text-ash" />)}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-caption">
            <span className="font-mono text-ash">{entry.runtimeId}</span>
            <span
              className={cn(
                "rounded-chip px-1 py-px",
                entry.launchMode === "headless" ? "bg-line-soft text-ash" : "bg-teal-tint text-teal",
              )}
              title={
                entry.launchMode === "headless"
                  ? "纯后台 headless 会话"
                  : entry.launchMode === "chat"
                    ? "开在主聊天页前台的会话"
                    : "终端 TUI 运行"
              }
            >
              {entry.launchMode === "terminal" ? (
                <>
                  <Terminal size={9} className="mr-0.5 inline-block align-[-1px]" />
                  TUI
                </>
              ) : entry.launchMode === "chat" ? (
                "对话页"
              ) : (
                "后台"
              )}
            </span>
            {entry.subtitle !== null && <span className="min-w-0 flex-1 truncate text-ash">{entry.subtitle}</span>}
          </span>
          {entry.detail !== null && entry.detail !== "" && (
            <span className="mt-0.5 block truncate text-caption text-ash" title={entry.detail}>
              {entry.detail}
            </span>
          )}
        </span>
      </button>
      {familyOpen && family !== undefined && (
        <div className="mx-2 mb-2 rounded-btn border border-line-soft bg-rail/60 p-1.5">
          {family.map((m, i) => (
            <div
              key={m.key}
              className={cn(
                "flex items-center gap-2 rounded-btn px-2 py-1 text-caption",
                m.key === entry.key && "bg-teal-tint/60",
              )}
            >
              <span className="shrink-0 rounded-chip bg-line-soft px-1.5 py-px text-[10px] font-mono text-graphite">
                v{i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-graphite">{m.title}</span>
              <span className="shrink-0 text-ash/70">{formatWhen(m.startedAt)}</span>
              {m.key === entry.key ? (
                <span className="shrink-0 text-[10px] text-teal">当前</span>
              ) : (
                onOpenFamilyMember !== undefined &&
                m.sessionId !== null && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenFamilyMember(m)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") onOpenFamilyMember(m);
                    }}
                    title="把这个旧版本接回聊天页（旧分支只读可回看，不会丢）"
                    className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-chip bg-line-soft px-1.5 py-px text-[10px] text-graphite transition hover:bg-teal hover:text-canvas"
                  >
                    <MessageSquare size={9} />
                    在聊天页查看
                  </span>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {expanded && (
        <>
          {entry.sessionId !== null && <SessionMessages sessionId={entry.sessionId} />}
          {entry.launchMode === "terminal" && (
            <TerminalTranscript
              terminalId={entry.terminalId ?? null}
              runtimeId={entry.runtimeId}
              detail={entry.detail}
              resumeRef={entry.resumeRef}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 展开的对话内容：user/assistant 两栏流（工具消息等次要角色灰显） */
function SessionMessages({ sessionId }: { sessionId: string }): ReactElement {
  const [msgs, setMsgs] = useState<Array<{ at: number; role: string; text: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchSessionMessages(sessionId)
      .then((rows) => {
        if (alive) setMsgs(rows);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (err !== null) return <p className="px-4 pb-2 text-caption text-loss">消息读取失败：{err}</p>;
  if (msgs === null) return <p className="px-4 pb-2 text-caption text-ash">读取对话…</p>;
  if (msgs.length === 0) return <p className="px-4 pb-2 text-caption text-ash">这条会话没有留下消息记录</p>;

  return (
    <div className="mx-2 mb-2 max-h-72 space-y-1.5 overflow-y-auto rounded-btn bg-rail p-2.5">
      {msgs.map((m, i) => (
        <div key={i} className="flex items-start gap-2">
          <span
            className={cn(
              "w-14 shrink-0 text-right text-caption",
              m.role === "user" ? "text-teal" : m.role === "assistant" ? "text-graphite" : "text-ash/60",
            )}
          >
            {m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role}
          </span>
          <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed", m.role === "user" ? "text-ink" : "text-graphite")}>
            {m.text === "" ? "（空）" : m.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * 展开的终端会话回看，双源：
 * 1. **原生对话转录**（resumeRef 可解析时，经 history reader 读 CLI 自己的会话库）：
 *    user/assistant 结构化两栏流 —— 「回看执行时聊了什么」的正主；
 * 2. **终端输出快照**（ANSI 过滤后的纯文本日志）：原生转录拿不到或为空时的兜底，
 *    以及想看 TUI 界面原始输出的场合（复制/滚动）。
 * 两源都空（早期历史 / 会话无输出即退出 / daemon 换代丢了快照）时给出说明。
 */
function TerminalTranscript({
  terminalId,
  runtimeId,
  detail,
  resumeRef,
}: {
  terminalId: string | null;
  runtimeId: string;
  detail: string | null;
  resumeRef: string | null;
}): ReactElement {
  const bareExec = runtimeId.replace(/^daemon:/, "").replace(/:yolo$/, "");
  const [native, setNative] = useState<NativeSessionDetail | null | "failed">(resumeRef !== null ? null : "failed");
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(terminalId !== null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 原生转录：resumeRef 在（回溯/实时捕获链路补齐后覆盖 14 家执行器）
  useEffect(() => {
    if (resumeRef === null) {
      setNative("failed");
      return;
    }
    let alive = true;
    setNative(null);
    void fetchNativeSessionDetail(bareExec, resumeRef)
      .then((d) => {
        if (alive) setNative(d !== null && d.transcript.length > 0 ? d : "failed");
      })
      .catch(() => {
        if (alive) setNative("failed");
      });
    return () => {
      alive = false;
    };
  }, [bareExec, resumeRef]);

  useEffect(() => {
    if (!terminalId) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    void fetchTerminalTranscript(terminalId)
      .then((res) => {
        if (alive) {
          setText(res);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [terminalId]);

  const handleCopy = () => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const lineCount = text ? text.split("\n").length : 0;
  const nativeReady = native !== null && native !== "failed";

  return (
    <div className="mx-2 mb-2 space-y-2">
      {/* 源一：原生对话转录（结构化 user/assistant 流，执行器自己的会话记录） */}
      {native === null && <p className="text-caption text-ash">正在读取原生对话记录…</p>}
      {nativeReady && (
        <div className="overflow-hidden rounded-btn border border-line bg-rail/80">
          <div className="flex h-7 items-center border-b border-line/60 bg-rail px-2.5 text-[10px] text-ash">
            <div className="flex items-center gap-1.5 font-mono">
              <MessageSquare size={11} className="text-teal" />
              <span>
                原生对话记录 · {runtimeId}
                {native.title !== "" && <span className="text-ash/60">（{native.title.slice(0, 30)}）</span>}
              </span>
            </div>
          </div>
          <div className="max-h-72 space-y-1.5 overflow-y-auto p-2.5">
            {native.transcript.map((t, i) => (
              <div key={i} className="flex items-start gap-2">
                <span
                  className={cn(
                    "w-14 shrink-0 text-right text-caption",
                    t.kind === "user" ? "text-teal" : t.kind === "assistant" ? "text-graphite" : "text-ash/60",
                  )}
                >
                  {t.kind === "user" ? "用户" : t.kind === "assistant" ? "助手" : t.kind === "thinking" ? "思考" : "工具"}
                </span>
                <p
                  className={cn(
                    "min-w-0 flex-1 whitespace-pre-wrap break-words text-caption leading-relaxed",
                    t.kind === "user" ? "text-ink" : t.kind === "assistant" ? "text-graphite" : "text-ash",
                  )}
                >
                  {t.toolName !== undefined && <span className="mr-1 font-mono text-[10px] text-teal">[{t.toolName}]</span>}
                  {t.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 源二：终端输出快照（原始 TUI 文本；原生转录缺席时是唯一回看面） */}
      <div className="overflow-hidden rounded-btn border border-line bg-rail/80">
        <div className="flex h-7 items-center justify-between border-b border-line/60 bg-rail px-2.5 text-[10px] text-ash">
          <div className="flex items-center gap-1.5 font-mono">
            <Terminal size={11} className="text-teal" />
            <span>终端输出记录 · {runtimeId}</span>
            {lineCount > 0 && <span className="text-ash/60">({lineCount} 行)</span>}
          </div>
          {text && text.trim() !== "" && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ash transition hover:bg-line-soft hover:text-ink cursor-pointer"
            >
              <Copy size={10} />
              <span>{copied ? "已复制" : "复制输出"}</span>
            </button>
          )}
        </div>

        <div className="p-2.5">
          {loading && <p className="text-caption text-ash">正在读取终端输出…</p>}
          {err !== null && <p className="text-caption text-loss">输出读取失败：{err}</p>}
          {!loading && err === null && text && text.trim() !== "" && (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink select-text">
              {text}
            </pre>
          )}
          {!loading && err === null && (!text || text.trim() === "") && !nativeReady && (
            <div className="space-y-1 text-caption text-ash">
              <p>未截获到终端文本输出（会话在产生输出前已退出，或属于早期历史会话）。</p>
              {detail && <p className="font-mono text-[11px] text-graphite">结果摘要：{detail}</p>}
            </div>
          )}
          {!loading && err === null && (!text || text.trim() === "") && nativeReady && (
            <p className="text-caption text-ash">没有终端输出快照（上方为该会话的原生对话记录）。</p>
          )}
        </div>
      </div>
    </div>
  );
}
