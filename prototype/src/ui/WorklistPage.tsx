import { useEffect, type ReactElement } from "react";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useTaskJump } from "../store/useTaskJump.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { InboxComposer } from "./InboxComposer.tsx";
import { InboxColumn } from "./InboxColumn.tsx";
import { BacklogColumn } from "./BacklogColumn.tsx";
import { NoticeBanner } from "./WorklistBits.tsx";

/**
 * 清单页（单页两栏）—— 个人 context 的唯一入口，同时是任务状态机视图：
 * 顶部文本框写任何东西，左栏清单条目（routing 分类分块），右栏待办任务
 * （从左栏沉淀出来的目标在这里管）。原「清单」「待办」两页合并于此。
 *
 * HEAD 只放标题（窄窗口不与最小化/最大化/关闭钮打架）；功能控件分家到两栏
 * 栏头：左栏=清单（自动分类总开关、立即分类、清单设置、分类器状态），
 * 右栏=待办（闲时执行总开关、待办设置、强制忙碌、跳一跳、新建）。
 *
 * 跨入口跳转（左栏任务链接、通知深链）统一走 useTaskJump 信箱：本页消费、
 * 滚到对应栏的锚点并短暂高亮 —— 页外入口（通知中心等）不依赖本页内部状态。
 */

/** 轮询兜底间隔（权威同步走 inbox/backlog 信号帧，这是 daemon 不在/漏帧时的兜底） */
const POLL_MS = 30_000;
/** 页面级通知的自动消失时长 */
const NOTICE_TTL_MS = 5_000;
/** 跳转高亮停留时长（任务卡 / 清单条目共用） */
const JUMP_HIGHLIGHT_MS = 1_600;

export function WorklistPage(): ReactElement {
  const inboxRefresh = useInbox((s) => s.refresh);
  const backlogRefresh = useBacklog((s) => s.refresh);
  const refreshAutomations = useWorkbench((s) => s.refreshAutomations);
  const inboxNotice = useInbox((s) => s.notice);
  const setInboxNotice = useInbox((s) => s.setNotice);
  const backlogNotice = useBacklog((s) => s.notice);
  const setBacklogNotice = useBacklog((s) => s.setNotice);

  // 一个轮询喂两栏 + 右栏「定时带」（automations 无信号帧，30s 轮询同口径）
  useEffect(() => {
    void inboxRefresh();
    void backlogRefresh();
    void refreshAutomations();
    const timer = setInterval(() => {
      void inboxRefresh();
      void backlogRefresh();
      void refreshAutomations();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inboxRefresh, backlogRefresh, refreshAutomations]);

  useEffect(() => {
    if (inboxNotice === null) return;
    const t = setTimeout(() => setInboxNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [inboxNotice, setInboxNotice]);

  useEffect(() => {
    if (backlogNotice === null) return;
    const t = setTimeout(() => setBacklogNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [backlogNotice, setBacklogNotice]);

  // 全局跳转信箱：滚到锚点（高亮 ring 由两栏按各自 highlightId 渲染），1.6s 后清信箱
  const jumpTarget = useTaskJump((s) => s.target);
  const jumpSeq = useTaskJump((s) => s.seq);
  useEffect(() => {
    if (jumpTarget === null) return;
    const anchor = jumpTarget.kind === "backlog" ? `backlog-card-${jumpTarget.id}` : `inbox-entry-${jumpTarget.id}`;
    document.getElementById(anchor)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = window.setTimeout(() => useTaskJump.getState().clear(), JUMP_HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [jumpTarget, jumpSeq]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* titlebar-drag 挂整宽外层条；no-drag 占位绝对锚定行右缘。右侧刻意不放
          任何控件：窄窗口时它们会撞上最小化/最大化/关闭钮（功能钮都在两栏栏头） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">清单</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">一个入口 · 左写清单 · 右管待办</span>
        </div>
        <div aria-hidden className="titlebar-no-drag absolute right-0 top-0 h-full" style={{ width: "var(--wco-w, 0px)" }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 pb-12 pt-5">
          {/* 文本框 —— 唯一需要编辑的东西 */}
          <InboxComposer />

          {(inboxNotice !== null || backlogNotice !== null) && (
            <div className="mt-4 space-y-2">
              {inboxNotice !== null && <NoticeBanner kind={inboxNotice.kind} text={inboxNotice.text} onClose={() => setInboxNotice(null)} />}
              {backlogNotice !== null && <NoticeBanner kind={backlogNotice.kind} text={backlogNotice.text} onClose={() => setBacklogNotice(null)} />}
            </div>
          )}

          {/* 两栏：窄屏上下堆叠，整页一起滚 */}
          <div className="mt-5 grid grid-cols-1 items-start gap-x-6 gap-y-6 xl:grid-cols-2">
            <InboxColumn onJumpToTask={(id) => useTaskJump.getState().jump({ kind: "backlog", id })} highlightId={jumpTarget?.kind === "inbox" ? jumpTarget.id : null} />
            <BacklogColumn highlightId={jumpTarget?.kind === "backlog" ? jumpTarget.id : null} />
          </div>
        </div>
      </div>
    </div>
  );
}
