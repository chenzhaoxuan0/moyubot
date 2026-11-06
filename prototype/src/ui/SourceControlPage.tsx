import { useEffect, useState, type ReactNode } from "react";
import { Files, FolderGit2, GitBranch, Loader2, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { GIT_ERROR_CODES, sumChanges, type GitStatus, type GitWorktree } from "../core/git.ts";
import {
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  removeGitWorktree,
  revealGitWorktree,
} from "../adapters/daemon/client.ts";
import { useGit } from "../store/useGit.ts";
import { useGitChanges } from "../store/useGitChanges.ts";
import { useShell } from "../store/useShell.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { selectActiveUnit, useWorkbench } from "../store/useWorkbench.ts";
import { BranchRow } from "./sourceControl/BranchRow.tsx";
import { ChangeFileList } from "./sourceControl/ChangeFileList.tsx";
import { WorktreeRow, worktreeTitle } from "./sourceControl/WorktreeRow.tsx";
import { CreateBranchDialog } from "./sourceControl/CreateBranchDialog.tsx";
import { CreateWorktreeDialog } from "./sourceControl/CreateWorktreeDialog.tsx";
import { ConfirmDialog } from "./sourceControl/ConfirmDialog.tsx";
import { StartSessionDialog } from "./sourceControl/StartSessionDialog.tsx";

/**
 * 源代码管理页 —— 激活单元仓库的「仓库总管」（ADR 0010）。
 *
 * 2026-11-06 起住右侧标签面板（workspace 级单例 tab，内容跟随激活单元换仓，
 * 与主视图时代同一语义）；左侧栏入口与 sourceControl 主视图已退役。
 *
 * 它不是三个入口之外的第四个入口，而是全景视图：分支 + 工作树 + 改动。
 * 三个入口回答三个各自的问题（在哪工作 / 要不要落库 / 改了什么），这里回答
 * 「坐下来管理这个仓库」。会话工作树（隔离承重墙，ADR 0008）继续只住在这里。
 *
 * 分支面对齐 ZCode 窄模型（ADR 0009）：只做「在哪个分支上工作」——
 * 列出 / 新建即切换 / 切换；合并、改名、删除留给终端。远程分支只读展示，
 * 可作为新建工作树的基点。
 *
 * 「改动」区（ADR 0010 的 ③）与提交对话框读**同一个** useGitChanges store：
 * 两边各拉一份 git.changes 就会出现「对话框说 3 个文件、面板说 4 个」。
 *
 * 工作树层（ADR 0008）完整保留：
 * - 删除有改动的工作树：remove 失败（worktree_dirty）→ 确认 → --force；
 *   有活跃会话跑在该树里时直接拒绝（Windows 强删会拔掉执行器的 cwd）
 * - 分支已被别的工作树检出（branch_checked_out_elsewhere，带 data.path）→
 *   引导「打开那个工作树」而不是让用户干瞪眼
 *
 * 行组件与对话框在 ./sourceControl/ 下按 ui/ 约定一组件一文件。
 * 仍不做：discard / 逐 hunk 暂存 / rebase / tag（ADR 0009、0010）。
 */

// ---- RPC 错误的形状（daemon GitError → wire error {code,message,data}） --------

interface RpcErrorShape {
  readonly code?: string;
  readonly message?: string;
  readonly data?: { readonly path?: string };
}

function asRpcError(err: unknown): RpcErrorShape {
  // data 必须带出来：branch_checked_out_elsewhere 的 data.path 是
  // 「打开那个工作树」出口按钮的唯一数据源，丢了它按钮永远不渲染
  if (err instanceof Error) {
    const e = err as Error & { code?: string; data?: { path?: string } };
    return { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
  }
  return { message: String(err) };
}

/** 开终端并把用户带到看得见它的地方：终端标签建在会话画布上（docs/31 后
 *  createTab 自带激活）；面板本身已在 chat 主视图，setMainView 只是防御 */
function openTerminalAt(cwd: string, title: string): void {
  useTerminalStore.getState().createTab({ cwd, title });
  useShell.getState().setMainView("chat");
}

/** 路径比对统一分隔符并大小写不敏感：git 输出正斜杠、Windows 本地字符串反斜杠，
 *  且 Windows 文件系统大小写不敏感（盘符大小写漂移 / 大小写改名后不能漏判） */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

type Dialog =
  | { kind: "createBranch"; ref?: string }
  | { kind: "createWorktree"; branch?: string; commitish?: string }
  /** root 在打开时快照：删除确认期间切了单元，也不能操作到别的仓库（评审 P1） */
  | { kind: "deleteWorktree"; root: string; wt: GitWorktree; forceReason?: string }
  | { kind: "startSession"; wt: GitWorktree }
  | null;

export function SourceControlPage({ shown = true }: { shown?: boolean }) {
  const unit = useWorkbench(selectActiveUnit);
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeRuntimeId = useWorkbench((s) => s.activeRuntimeId);
  const sessions = useWorkbench((s) => s.sessions);
  const rootPath = useGit((s) => s.rootPath);
  const status = useGit((s) => s.status);
  const branches = useGit((s) => s.branches);
  const worktrees = useGit((s) => s.worktrees);
  const loading = useGit((s) => s.loading);
  const error = useGit((s) => s.error);
  const setError = useGit((s) => s.setError);
  const refresh = useGit((s) => s.refresh);
  const openRepo = useGit((s) => s.openRepo);
  const pendingDialog = useGit((s) => s.pendingDialog);
  const setPendingDialog = useGit((s) => s.setPendingDialog);

  // 改动面（ADR 0010）：与提交对话框共用同一个 store，这里只负责绑定仓库
  const changes = useGitChanges((s) => s.changes);
  const loadingChanges = useGitChanges((s) => s.loading);
  const busyChanges = useGitChanges((s) => s.busy);
  const changesError = useGitChanges((s) => s.error);
  const openChangesRepo = useGitChanges((s) => s.openRepo);
  const reloadChanges = useGitChanges((s) => s.reload);
  const stagePaths = useGitChanges((s) => s.stage);
  const unstagePaths = useGitChanges((s) => s.unstage);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const activeRuntime = runtimes.find((r) => r.id === activeRuntimeId);
  /** 会话工作树按执行器能力门控（契约 RuntimeCapabilities.worktrees） */
  const sessionWorktreeSupported = activeRuntime?.capabilities.worktrees === true;

  // 跟随激活单元换仓库（key 用 rootPath：unit 对象身份每次 units 重建都变，
  // 拿它当依赖会让无关的列表刷新都触发一轮 4+ git 进程的 refresh）。
  // shown 门控（DiffPane 同款）：右栏保活挂载下 tab 可能只是挂着不可见 / 右栏
  // 收起 —— 此前每次切 bot 都在后台起 4+ 个 git 进程，和会话回放抢同一条 daemon
  // 连接。不可见时不绑；重新可见时 shown 翻真，按当下的仓库补绑（同仓库即一轮
  // refresh，正好「切回来看到的不是旧数据」）。提交/推送对话框与 DiffPane 各自
  // 绑定仓库，不依赖这里的跟随
  const unitRootPath = unit?.rootPath;
  useEffect(() => {
    if (shown && unitRootPath !== undefined) openRepo(unitRootPath);
  }, [shown, unitRootPath, openRepo]);
  useEffect(() => {
    if (shown && unitRootPath !== undefined) openChangesRepo(unitRootPath);
  }, [shown, unitRootPath, openChangesRepo]);

  // 没有激活单元时不消费：留着等单元就绪后面板挂载时再弹，而不是静默吞掉
  useEffect(() => {
    if (pendingDialog === null || unit === undefined) return;
    setDialog(pendingDialog === "createBranch" ? { kind: "createBranch" } : { kind: "createWorktree" });
    setPendingDialog(null);
  }, [pendingDialog, setPendingDialog, unit]);

  // 面板聚焦时刷新一次（从别处切回来看到的就不是旧数据）。右栏保活挂载下
  // tab 可能只是挂着不可见 —— 不可见不刷（一轮 refresh 是 4+ 个 git 进程）
  useEffect(() => {
    if (!shown) return;
    const onFocus = (): void => {
      void refresh();
      void reloadChanges();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, reloadChanges, shown]);

  /** 所有操作的统一外壳：busy 门闩 + 失败横幅 + 成功刷新 */
  const op = async (name: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (err: unknown) {
      const e = asRpcError(err);
      setError({ text: `${name}失败：${e.message ?? "未知错误"}`, code: e.code, data: e.data });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (unit === undefined) {
    return <EmptyState text="没有激活的工作单元 —— 先在侧栏选择一个 bot 或项目" />;
  }

  // openRepo 生效前 rootPath 可能还是 null；页面级后续统一用收窄后的 root
  const root = rootPath ?? unit.rootPath;
  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? "";

  const stagedChanges = changes?.staged ?? [];
  const unstagedChanges = changes?.unstaged ?? [];
  const untrackedChanges = changes?.untracked ?? [];
  const changesTotals = sumChanges(stagedChanges, unstagedChanges, untrackedChanges);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* 头部：仓库 + 当前分支状态。右栏宿主下窗口拖拽热区 / 窗口钮让位都在
          面板自己的 tab 条上（SidePanePanel），这里只是普通内容行 */}
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-2">
        <FolderGit2 size={15} className="shrink-0 text-teal" />
        <span className="truncate text-body font-medium text-ink" title={root}>
          {repoName}
        </span>
        {status?.isRepo && <BranchChip status={status} />}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              void refresh();
              void reloadChanges();
            }}
            disabled={loading || busy || loadingChanges}
            title="刷新"
            aria-label="刷新"
            className="rounded-btn p-1.5 text-ash hover:bg-line-soft hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading || loadingChanges ? "animate-spin" : undefined} />
          </button>
        </div>
      </header>

      {/* 错误横幅（分支被别的工作树占用时给「打开那个工作树」出口） */}
      {error !== null && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-card border border-line bg-card px-3 py-2 text-body-sm text-ink">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-loss" />
          <span className="min-w-0 flex-1 break-all">{error.text}</span>
          {error.code === GIT_ERROR_CODES.branchCheckedOutElsewhere && error.data?.path !== undefined && (
            <button
              onClick={() => void revealGitWorktree(error.data?.path ?? "")}
              className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
            >
              打开那个工作树
            </button>
          )}
          <button
            onClick={() => setError(null)}
            aria-label="关闭"
            className="shrink-0 rounded-btn p-0.5 text-ash hover:text-ink"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {status !== null && !status.isRepo ? (
        <EmptyState text="该目录不是 git 仓库（没有 .git）" />
      ) : (
        /* 整页滚动语义：链路上不压 min-h-0 —— 那会解除 flex 子项「不压缩到
            内容高度以下」的默认下限，矮窗口时三个 section 被按比例压扁，
            内容溢出盖到下一个 section 上（改动列表叠上分支/工作树） */
        <div className="flex flex-col gap-4 p-4">
          {/* ---- 改动（ADR 0010 的 ③：改了什么）—— 在分支区之上 ---- */}
          <section>
            <SectionHeader
              icon={<Files size={13} className="text-teal" />}
              title="改动"
              count={changesTotals.files}
              action={
                <span className="tnum font-mono text-[11px] text-ash">
                  {changesTotals.added > 0 && <span className="text-gain">+{changesTotals.added} </span>}
                  {changesTotals.removed > 0 && <span className="text-loss">-{changesTotals.removed}</span>}
                </span>
              }
            />
            {changes === null ? (
              loadingChanges ? (
                <LoadingRow />
              ) : (
                <div className="rounded-card border border-line px-3 py-2 text-caption text-ash">还没有改动数据</div>
              )
            ) : changesError !== null ? (
              // **绝不把读取失败显示成「工作树干净」** —— 那是撒谎，用户会以为
              // 改动不存在而直接提交（或者更糟：以为安全而丢弃工作）
              <div className="flex items-start gap-2 rounded-card border border-line bg-card px-3 py-2 text-caption text-loss">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">读取改动失败：{changesError.text}</span>
                <button
                  onClick={() => void reloadChanges()}
                  className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  重试
                </button>
              </div>
            ) : changesTotals.files === 0 ? (
              <div className="rounded-card border border-line bg-card py-6 text-center text-caption text-ash">
                工作树干净，没有未提交的改动
              </div>
            ) : (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-card border border-line bg-card">
                  <header className="flex h-7 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2.5">
                    <span className="text-caption font-medium text-ink">已暂存</span>
                    <span className="tnum text-[11px] text-ash">({stagedChanges.length})</span>
                  </header>
                  <ChangeFileList
                    rootPath={root}
                    entries={stagedChanges}
                    sourceId="staged"
                    disabled={busy}
                    busy={busyChanges}
                    onUnstage={(paths) => void unstagePaths(paths)}
                    emptyText="暂存区是空的"
                  />
                </div>
                <div className="overflow-hidden rounded-card border border-line bg-card">
                  <header className="flex h-7 items-center gap-1.5 border-b border-line-soft bg-line-soft/40 px-2.5">
                    <span className="text-caption font-medium text-ink">未暂存</span>
                    <span className="tnum text-[11px] text-ash">
                      ({unstagedChanges.length + untrackedChanges.length})
                    </span>
                  </header>
                  <ChangeFileList
                    rootPath={root}
                    entries={[...unstagedChanges, ...untrackedChanges]}
                    sourceId="unstaged"
                    disabled={busy}
                    busy={busyChanges}
                    onStage={(paths) => void stagePaths(paths)}
                    emptyText="没有未暂存的改动"
                  />
                </div>
              </div>
            )}
          </section>

          {/* ---- 分支 ---- */}
          <section>
            <SectionHeader
              icon={<GitBranch size={13} className="text-teal" />}
              title="分支"
              count={branches?.branches.length}
              action={
                <button
                  onClick={() => setDialog({ kind: "createBranch" })}
                  className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  <Plus size={11} />
                  <span>新建分支</span>
                </button>
              }
            />
            {branches === null ? (
              <LoadingRow />
            ) : (
              <div className="overflow-hidden rounded-card border border-line bg-card">
                {branches.branches.length === 0 && <EmptyState text="没有任何分支" inset />}
                {branches.branches.map((b) => (
                  <BranchRow
                    key={b.kind === "local" ? `l/${b.name}` : `r/${b.name}`}
                    branch={b}
                    current={branches.current}
                    disabled={busy}
                    onCheckout={() => void op(`切换到 ${b.name}`, () => checkoutGitBranch({ rootPath: root, name: b.name }))}
                    onCreateWorktreeFrom={() =>
                      // 远程分支不是本地分支，不能走「检出已有分支」模式：
                      // 作为新分支的 commitish 基点传下去，否则会静默从当前 HEAD 建树
                      setDialog(
                        b.kind === "local"
                          ? { kind: "createWorktree", branch: b.name }
                          : { kind: "createWorktree", commitish: b.name },
                      )
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* ---- 工作树 ---- */}
          <section>
            <SectionHeader
              icon={<FolderGit2 size={13} className="text-teal" />}
              title="工作树"
              count={worktrees?.length}
              action={
                <button
                  onClick={() => setDialog({ kind: "createWorktree" })}
                  className="flex items-center gap-0.5 rounded-btn px-1.5 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
                >
                  <Plus size={11} />
                  <span>新建工作树</span>
                </button>
              }
            />
            {worktrees === null ? (
              <LoadingRow />
            ) : (
              <div className="overflow-hidden rounded-card border border-line bg-card">
                {worktrees.length === 0 && <EmptyState text="没有工作树" inset />}
                {worktrees.map((w) => (
                  <WorktreeRow
                    key={w.path}
                    wt={w}
                    rootPath={root}
                    disabled={busy}
                    sessionWorktreeSupported={sessionWorktreeSupported}
                    onStartSession={() => setDialog({ kind: "startSession", wt: w })}
                    onTerminal={() => openTerminalAt(w.path, worktreeTitle(w))}
                    onReveal={() =>
                      void revealGitWorktree(w.path).catch((err: unknown) => {
                        const e = asRpcError(err);
                        setError({ text: `在文件管理器中显示失败：${e.message ?? "未知错误"}`, code: e.code });
                      })
                    }
                    onDelete={() => setDialog({ kind: "deleteWorktree", root, wt: w })}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---- 对话框 ---- */}
      {dialog?.kind === "createBranch" && (
        <CreateBranchDialog
          existing={branches?.branches.filter((b) => b.kind === "local").map((b) => b.name) ?? []}
          refs={branches?.branches ?? []}
          defaultRef={dialog.ref}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(name, ref) =>
            op("新建分支", () => createGitBranch({ rootPath: root, name, ...(ref ? { ref } : {}) }))
          }
        />
      )}
      {dialog?.kind === "createWorktree" && (
        <CreateWorktreeDialog
          branches={branches?.branches.filter((b) => b.kind === "local") ?? []}
          defaultBranch={dialog.branch}
          defaultCommitish={dialog.commitish}
          rootPath={root}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(payload) => op("新建工作树", () => createGitWorktree({ rootPath: root, ...payload }))}
        />
      )}
      {dialog?.kind === "deleteWorktree" && (() => {
        // 活跃会话防拆：有会话的 cwd 指向这棵树时拒绝删除（rootPath 是会话的
        // 实际工作目录，会话工作树场景下就是树路径；契约字段，老 daemon 缺省）
        const live = sessions.filter(
          (s) => s.rootPath !== undefined && samePath(s.rootPath, dialog.wt.path) && s.status !== "done" && s.status !== "failed",
        );
        return (
          <ConfirmDialog
            title={`删除工作树 ${worktreeTitle(dialog.wt)}`}
            body={
              dialog.forceReason !== undefined
                ? `${dialog.forceReason}。强制删除（--force）会丢掉这些改动，确定？`
                : `删除工作树目录 ${dialog.wt.path}？（目录里有未提交改动时会再向你确认一次）`
            }
            confirmLabel={dialog.forceReason !== undefined ? "强制删除" : "删除"}
            danger
            busy={busy}
            confirmDisabled={live.length > 0}
            note={
              live.length > 0
                ? `有 ${live.length} 个会话正在此工作树中运行，先停止或等它结束再删除（强删会直接拔掉执行器的工作目录）`
                : undefined
            }
            onClose={() => setDialog(null)}
            onConfirm={async () => {
              const ok = await op(
                "删除工作树",
                () =>
                  removeGitWorktree({
                    rootPath: dialog.root,
                    path: dialog.wt.path,
                    force: dialog.forceReason !== undefined,
                  }),
              );
              if (ok) {
                setDialog(null);
                return;
              }
              if (useGit.getState().error?.code === GIT_ERROR_CODES.worktreeDirty) {
                useGit.getState().setError(null);
                setDialog({ ...dialog, forceReason: "该工作树里有未提交改动" });
              }
            }}
          />
        );
      })()}
      {dialog?.kind === "startSession" && (
        <StartSessionDialog
          wt={dialog.wt}
          runtimeName={activeRuntime?.presentation.displayName ?? "当前执行器"}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(prompt) => {
            const wt = dialog.wt;
            setDialog(null);
            useShell.getState().setMainView("chat");
            void useWorkbench
              .getState()
              .run(prompt.trim().length > 0 ? prompt : "在这个工作树中工作", {
                worktree: { path: wt.path, branch: wt.branch ?? "" },
              });
          }}
        />
      )}
    </div>
  );
}

// ---- 页面级小组件 -----------------------------------------------------------

function BranchChip({ status }: { status: GitStatus }) {
  if (status.detached) {
    return (
      <span className="flex items-center gap-1 rounded-chip border border-line bg-rail px-2 py-0.5 text-caption text-graphite">
        分离头指针 @{status.headShort}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-chip border border-teal-edge bg-teal-tint px-2 py-0.5 text-caption text-ink">
      <GitBranch size={11} className="shrink-0 text-teal" />
      <span className="truncate">{status.branch}</span>
      {status.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="有未提交改动" />}
      {(status.ahead > 0 || status.behind > 0) && (
        <span className="tnum shrink-0 text-ash">
          {status.behind > 0 && <span>↓{status.behind} </span>}
          {status.ahead > 0 && <span>↑{status.ahead}</span>}
        </span>
      )}
    </span>
  );
}

function SectionHeader(props: { icon: ReactNode; title: string; count?: number; action: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between">
      <div className="flex items-center gap-1.5">
        {props.icon}
        <span className="text-caption font-medium text-ink">{props.title}</span>
        {props.count !== undefined && <span className="tnum text-[11px] text-ash">({props.count})</span>}
      </div>
      {props.action}
    </div>
  );
}

function EmptyState({ text, inset }: { text: string; inset?: boolean }) {
  const body = (
    <>
      <FolderGit2 size={18} className="mx-auto mb-2 text-graphite" />
      <p className="text-body-sm text-ash">{text}</p>
    </>
  );
  // 列表内嵌空态（inset）保持轻量单行；页面级空态包卡片，与 Backlog/Automations 同构
  if (inset) return <div className="py-8 text-center">{body}</div>;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="rounded-card border border-line bg-card px-6 py-10 text-center">{body}</div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 rounded-card border border-line px-3 py-3 text-caption text-ash">
      <Loader2 size={13} className="animate-spin" />
      读取中…
    </div>
  );
}
