import { useEffect, type ReactElement } from "react";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useTaskJump } from "../store/useTaskJump.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { InboxComposer } from "./InboxComposer.tsx";
import { TimelineColumn } from "./TimelineColumn.tsx";
import { NoticeBanner } from "./WorklistBits.tsx";

/**
 * 清单页（单列时间轴，2026-10-30 重构）—— 个人 context 的唯一入口：
 * 顶部文本框写任何东西 → 状态带（机器状态总览）→ 一列事件块（捕获→沉淀
 * 空间化：条目点开展示它拆解出的任务）。原两栏（清单 | 待办）合并于此。
 *
 * HEAD 只放标题（窄窗口不与最小化/最大化/关闭钮打架）；功能控件住在状态带
 * 与各块内。跨入口跳转（通知深链等）统一走 useTaskJump 信箱，滚动与展开
 * 由 TimelineColumn 消费。
 */

/** 轮询兜底间隔（权威同步走 inbox/backlog 信号帧，这是 daemon 不在/漏帧时的兜底） */
const POLL_MS = 30_000;
/** 页面级通知的自动消失时长 */
const NOTICE_TTL_MS = 5_000;
/** 跳转高亮停留时长 */
const JUMP_HIGHLIGHT_MS = 1_600;

export function WorklistPage(): ReactElement {
  const inboxRefresh = useInbox((s) => s.refresh);
  const backlogRefresh = useBacklog((s) => s.refresh);
  const refreshAutomations = useWorkbench((s) => s.refreshAutomations);
  const inboxNotice = useInbox((s) => s.notice);
  const setInboxNotice = useInbox((s) => s.setNotice);
  const backlogNotice = useBacklog((s) => s.notice);
  const setBacklogNotice = useBacklog((s) => s.setNotice);

  // 一个轮询喂时间轴 + 状态带（automations 无信号帧，30s 轮询同口径）
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

  // 全局跳转信箱：高亮 1.6s 后清信箱（滚动与展开在 TimelineColumn 消费）
  const jumpTarget = useTaskJump((s) => s.target);
  const jumpSeq = useTaskJump((s) => s.seq);
  useEffect(() => {
    if (jumpTarget === null) return;
    const t = window.setTimeout(() => useTaskJump.getState().clear(), JUMP_HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [jumpTarget, jumpSeq]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* titlebar-drag 挂整宽外层条；no-drag 占位绝对锚定行右缘。右侧刻意不放
          任何控件：窄窗口时它们会撞上最小化/最大化/关闭钮（功能钮在状态带） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">清单</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">一个入口 · 时间轴 · 事件块里看任务</span>
        </div>
        <div aria-hidden className="titlebar-no-drag absolute right-0 top-0 h-full" style={{ width: "var(--wco-w, 0px)" }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 单列主体：适度收窄（时间沟 + 事件块的双列信息不需要 6xl 全宽） */}
        <div className="mx-auto max-w-4xl px-8 pb-12 pt-5">
          {/* 文本框 —— 唯一需要编辑的东西 */}
          <InboxComposer />

          {(inboxNotice !== null || backlogNotice !== null) && (
            <div className="mt-4 space-y-2">
              {inboxNotice !== null && <NoticeBanner kind={inboxNotice.kind} text={inboxNotice.text} onClose={() => setInboxNotice(null)} />}
              {backlogNotice !== null && <NoticeBanner kind={backlogNotice.kind} text={backlogNotice.text} onClose={() => setBacklogNotice(null)} />}
            </div>
          )}

          <div className="mt-5">
            <TimelineColumn jumpTarget={jumpTarget} />
          </div>
        </div>
      </div>
    </div>
  );
}
