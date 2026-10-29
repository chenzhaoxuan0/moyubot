import { useEffect, useState, type ReactElement } from "react";
import { HeartPulse, ListTodo, Loader2, Settings2, Sparkles } from "lucide-react";
import type { BacklogItem } from "../core/backlog.ts";
import { useInbox } from "../store/useInbox.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { BacklogDialog } from "./BacklogDialog.tsx";
import { InboxComposer } from "./InboxComposer.tsx";
import { InboxColumn } from "./InboxColumn.tsx";
import { BacklogColumn } from "./BacklogColumn.tsx";
import { InboxSettings } from "./InboxSettings.tsx";
import { BacklogSettings } from "./BacklogSettings.tsx";
import { HeaderBtn, NoticeBanner } from "./WorklistBits.tsx";
import { Toggle } from "./Toggle.tsx";

/**
 * 清单页（单页两栏）—— 个人 context 的唯一入口，同时是任务状态机视图：
 * 顶部文本框写任何东西，左栏清单条目（routing 分类分块），右栏待办任务
 * （从左栏沉淀出来的目标在这里管）。原「清单」「待办」两页合并于此。
 *
 * 头部两个总开关（测试/不想被自动处理时一关即静）：
 * - 自动分类 = inbox.autoClassify：关了新内容停在「待分类」，不烧 routing 会话；
 * - 闲时执行 = backlog.autopilot.enabled：关了空闲时不再派发 auto 任务。
 */

/** 轮询兜底间隔（权威同步走 inbox/backlog 信号帧，这是 daemon 不在/漏帧时的兜底） */
const POLL_MS = 30_000;
/** 页面级通知的自动消失时长 */
const NOTICE_TTL_MS = 5_000;
/** 左栏跳右栏的任务卡片高亮停留时长 */
const JUMP_HIGHLIGHT_MS = 1_600;

export function WorklistPage(): ReactElement {
  const inboxRefresh = useInbox((s) => s.refresh);
  const backlogRefresh = useBacklog((s) => s.refresh);
  const inboxNotice = useInbox((s) => s.notice);
  const setInboxNotice = useInbox((s) => s.setNotice);
  const backlogNotice = useBacklog((s) => s.notice);
  const setBacklogNotice = useBacklog((s) => s.setNotice);
  const classifier = useInbox((s) => s.classifier);
  const inboxConfig = useInbox((s) => s.config);
  const backlogConfig = useBacklog((s) => s.config);

  const [settings, setSettings] = useState<null | "inbox" | "backlog">(null);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; item: BacklogItem } | null>(null);
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);

  // 一个轮询喂两栏（两 store 的信号帧在 main.tsx 全局绑定，这里只做漏帧兜底）
  useEffect(() => {
    void inboxRefresh();
    void backlogRefresh();
    const timer = setInterval(() => {
      void inboxRefresh();
      void backlogRefresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inboxRefresh, backlogRefresh]);

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

  const jumpToTask = (id: number): void => {
    setJumpTarget(id);
    window.setTimeout(() => setJumpTarget((cur) => (cur === id ? null : cur)), JUMP_HIGHLIGHT_MS);
  };

  const autoClassify = inboxConfig?.autoClassify ?? false;
  const autopilotOn = backlogConfig?.autopilot.enabled ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* titlebar-drag 挂整宽外层条（与两页旧制同款）；no-drag 占位绝对锚定行右缘 */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">清单</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">一个入口 · 左写清单 · 右管待办</span>
          <div className="ml-auto flex items-center gap-1.5">
            {classifier?.classifying === true ? (
              <span className="flex items-center gap-1.5 text-caption text-teal">
                <Loader2 size={12} className="animate-spin" />
                routing 分类中…
              </span>
            ) : (
              classifier?.lastOutcome != null && (
                <span className="max-w-72 truncate text-caption text-ash" title={classifier.lastOutcome}>
                  {classifier.lastOutcome.replace(/^(ok|failed):/, "")}
                </span>
              )
            )}
            {/* 总开关：写测试/不想被自动处理时一关即静（不杀已在跑的会话/任务） */}
            <label
              className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite"
              title="总开关：写进清单后是否自动交给 routing 分类。关闭时新内容停在「待分类」，可「立即分类」手动触发；已在跑的分类会话不受影响。"
            >
              <Toggle on={autoClassify} ariaLabel="自动分类总开关" onChange={(v) => void useInbox.getState().saveConfig({ autoClassify: v })} />
              自动分类
            </label>
            <label
              className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite"
              title="总开关：工作台空闲时是否自动执行勾了「闲时执行」的待办。关闭后不再派发新任务（20 秒内生效）；手动「立即执行」与心跳确认不受影响。"
            >
              <Toggle
                on={autopilotOn}
                ariaLabel="闲时执行总开关"
                onChange={(v) => {
                  const cfg = useBacklog.getState().config;
                  if (cfg !== null) void useBacklog.getState().saveConfig({ autopilot: { ...cfg.autopilot, enabled: v } });
                }}
              />
              闲时执行
            </label>
            <HeaderBtn icon={Sparkles} label="立即分类（手动触发一轮）" onClick={() => void useInbox.getState().classifyNow()} />
            <HeaderBtn icon={Settings2} label="清单设置" onClick={() => setSettings((s) => (s === "inbox" ? null : "inbox"))} active={settings === "inbox"} />
            <HeaderBtn icon={HeartPulse} label="待办设置（心跳与余量）" onClick={() => setSettings((s) => (s === "backlog" ? null : "backlog"))} active={settings === "backlog"} />
            <button
              onClick={() => setDialog({ mode: "create" })}
              className="flex items-center gap-1.5 rounded-btn bg-ink px-3 py-2 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition"
            >
              <ListTodo size={12} />
              新建
            </button>
          </div>
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
            <InboxColumn onJumpToTask={jumpToTask} />
            <BacklogColumn onCreate={() => setDialog({ mode: "create" })} onEdit={(item) => setDialog({ mode: "edit", item })} highlightId={jumpTarget} />
          </div>
        </div>

        {dialog !== null && (
          <BacklogDialog key={dialog.mode === "edit" ? dialog.item.id : "new"} initial={dialog.mode === "edit" ? dialog.item : null} onClose={() => setDialog(null)} />
        )}
        {settings === "inbox" && <InboxSettings onClose={() => setSettings(null)} />}
        {settings === "backlog" && <BacklogSettings onClose={() => setSettings(null)} />}
      </div>
    </div>
  );
}
