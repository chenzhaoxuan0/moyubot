import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CalendarClock, Check, ChevronDown, Copy, PencilLine, Undo2, X } from "lucide-react";
import type { ChatAttachment } from "../../../core/attachments.ts";
import { AttachmentsBar } from "../../AttachmentsBar.tsx";
import { useWorkbench } from "../../../store/useWorkbench.ts";
import { cn } from "../../cn.ts";

function parseSlashCommand(text: string): { isCommand: boolean; name: string; args: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\n")) {
    return { isCommand: false, name: "", args: "" };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { isCommand: true, name: trimmed.slice(1), args: "" };
  }
  return {
    isCommand: true,
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/**
 * 账本真实用户消息 id 的形态判定。daemon 侧只有两种构造：
 * - `user-${turnCount}`（backend/src/runtime/host.ts，普通轮/首轮的用户 delta）；
 * - `msg_ext_${idx+1}`（backend/src/history/sync.ts，外部原生会话同步轮）。
 * 分叉锚点校验（resolveForkAtSeq）按账本里的这两种 id 匹配；本地合成气泡的
 * 假 id（run 内 `u${seq}`、pushUserBubble 的 `user_opt_N`，echo 回填前）不在
 * 其中 —— 不能当撤回/编辑锚点，否则 daemon 直接 unknown_anchor。
 */
const isLedgerMessageId = (id: string): boolean => /^(user-\d+|msg_ext_\d+)$/.test(id);

/**
 * 超长 prompt 气泡的折叠（钳 6 视觉行）：外部编排 prompt（子 agent 任务书、
 * 注入后的长上下文）动辄上百行，整段铺开会把对话流顶得只剩任务书——默认
 * 钳到 6 行，点「展开全文」看完整内容，展开态按消息记忆（虚拟卸载不丢）。
 */
const userBubbleOpenStates = new Map<string, boolean>();

/** 超长正文区：默认钳 6 行，溢出时显示「展开全文」；展开/收起按消息记忆 */
function ClampedPromptText({ text, stateKey }: { text: string; stateKey: string }) {
  const [open, setOpen] = useState(() => userBubbleOpenStates.get(stateKey) ?? false);
  const [overflows, setOverflows] = useState(false);
  const pRef = useRef<HTMLParagraphElement | null>(null);

  // 钳制态下的溢出检测：scrollHeight 超过 clientHeight 即超过 6 行；宽度变化
  //（对话列变宽/变窄导致换行数变化）也要重判，挂 ResizeObserver
  useLayoutEffect(() => {
    const p = pRef.current;
    if (p === null || open) return;
    const check = (): void => {
      if (p.scrollHeight - p.clientHeight > 2) setOverflows(true);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(p);
    return () => ro.disconnect();
  }, [open, text]);

  const toggle = (): void => {
    const next = !open;
    userBubbleOpenStates.set(stateKey, next);
    setOpen(next);
  };

  return (
    <>
      <p
        ref={pRef}
        className={cn(
          "whitespace-pre-wrap text-thread text-ink",
          // 字面量（Tailwind JIT 只扫源码里的完整类名）；与 USER_BUBBLE_CLAMP_LINES 同值
          !open && "line-clamp-6",
        )}
      >
        {text}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "mt-1.5 flex cursor-pointer items-center gap-1 rounded-btn px-1.5 py-0.5 text-caption text-ash transition hover:bg-line-soft hover:text-ink select-none",
          )}
        >
          <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
          {open ? "收起" : `展开全文（${text.length} 字）`}
        </button>
      )}
    </>
  );
}

export function UserMessageBubble({
  text,
  attachments,
  messageId,
  sessionId,
  origin,
  isLatestUserTurn,
  busy,
  at,
}: {
  text: string;
  attachments?: readonly ChatAttachment[];
  /** daemon 侧真实 messageId（echo 回填后的 user-N；本地假 id 时编辑入口禁用） */
  messageId: string;
  /** 这条消息所属的段 —— revision 的 ofSessionId */
  sessionId: string;
  /** 消息来源（docs/23）："automation" = 定时任务到点代发 —— 气泡上方亮「定时」徽标 */
  origin?: string;
  /** 时间线最后一条用户消息 */
  isLatestUserTurn: boolean;
  busy: boolean;
  /** 发送时间戳 */
  at?: number;
}) {
  const parsed = parseSlashCommand(text);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(text);
  const editAndResend = useWorkbench((s) => s.editAndResend);
  const recallMessage = useWorkbench((s) => s.recallMessage);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);

  const blocked =
    busy ||
    sourceStatus === "running" ||
    sourceStatus === "awaiting_permission" ||
    sourceStatus === "awaiting_input";
  // 本地合成气泡的假 messageId（u${seq} / user_opt_N，echo 尚未回填）不能做账本锚点
  const anchorReady = Boolean(messageId) && isLedgerMessageId(messageId);
  const canEdit = !blocked && anchorReady;
  const canRecall = isLatestUserTurn && anchorReady;
  const disabledTitle = blocked ? "当前正在执行中，先让这一轮落定" : "锚点还没落进账本，稍等一下再试";

  const editTitle = isLatestUserTurn
    ? "原位编辑并重发（替换本轮重新开始）"
    : "从该历史消息开启新分支会话并重发";

  const openEdit = () => {
    setEditDraft(text);
    setEditing(true);
  };

  const submitEdit = () => {
    const v = editDraft.trim();
    if (v === "") return;
    setEditing(false);
    void editAndResend({ ofSessionId: sessionId as never, anchorMessageId: messageId, text: v });
  };

  const handleRecall = () => {
    void recallMessage({
      ofSessionId: sessionId as never,
      anchorMessageId: messageId,
      text,
    });
  };

  // ---- 编辑态：气泡原位替换为编辑器 ----
  if (editing) {
    return (
      <div data-turn-id={messageId} className="flex w-full flex-col items-end pt-[22px]">
        <div className="w-full max-w-full rounded-2xl border border-teal/40 bg-card px-3.5 py-2.5 shadow-xs focus-within:border-teal/60">
          <textarea
            autoFocus
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            rows={Math.min(10, Math.max(2, editDraft.split("\n").length))}
            className="w-full resize-none bg-transparent text-thread text-ink outline-none"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-caption text-ash">
              {isLatestUserTurn
                ? "重发将替换本轮对话（原分支保留可回看，附件与文件改动不回滚）"
                : "发送将从此轮前开启新分支会话（原分支完整保留，以此修改作为新分支的首条消息）"}
            </span>
            <button
              onClick={() => setEditing(false)}
              title="取消编辑（Esc）"
              className="flex shrink-0 cursor-pointer items-center rounded-btn border border-line p-1.5 text-graphite transition hover:bg-line-soft hover:text-ink"
            >
              <X size={12} />
            </button>
            <button
              onClick={submitEdit}
              disabled={editDraft.trim() === ""}
              title="重发（Enter）"
              className="flex shrink-0 cursor-pointer items-center rounded-btn bg-teal p-1.5 text-canvas transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const [copied, setCopied] = useState(false);
  const copyText = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const timeLabel = at
    ? new Date(at).toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const recallEntry = isLatestUserTurn ? (
    <button
      onClick={handleRecall}
      disabled={!canRecall}
      aria-label="撤回消息"
      title={canRecall ? "撤回此消息：中止执行并将内容退回输入框重新编辑" : "正在发送中，稍候可撤回"}
      className="flex shrink-0 cursor-pointer items-center rounded-btn p-1 text-ash opacity-60 transition hover:bg-line-soft hover:text-ink group-hover/user:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Undo2 size={12} />
    </button>
  ) : null;

  const editEntry = (
    <button
      onClick={openEdit}
      disabled={!canEdit}
      aria-label="编辑重发"
      title={canEdit ? editTitle : disabledTitle}
      className="flex shrink-0 cursor-pointer items-center rounded-btn p-1 text-ash opacity-60 transition hover:bg-line-soft hover:text-ink group-hover/user:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PencilLine size={12} />
    </button>
  );

  const actionEntries = (
    <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover/user:opacity-100">
      {timeLabel && (
        <span className="font-mono text-[11px] text-ash select-none mr-0.5">
          {timeLabel}
        </span>
      )}
      {recallEntry}
      {editEntry}
      <button
        onClick={copyText}
        aria-label="复制此消息"
        title={copied ? "已复制到剪贴板" : "复制此消息"}
        className="flex cursor-pointer items-center rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
      >
        {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
      </button>
    </div>
  );

  if (parsed.isCommand) {
    return (
      <div data-turn-id={messageId} className="group/user flex items-end justify-end gap-1.5 pt-[22px]">
        {actionEntries}
        <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1.5">
          {attachments && attachments.length > 0 && (
            <AttachmentsBar attachments={[...attachments]} readOnly />
          )}
          <div className="max-w-full rounded-2xl border border-line bg-rail px-3.5 py-2.5 flex items-center gap-2.5">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[11px] font-bold leading-none">
              /
            </div>
            <span className="font-mono text-body font-bold text-ink">
              /{parsed.name}
            </span>
            {parsed.args ? (
              <span className="font-mono text-body-sm text-graphite rounded-md bg-line-soft/80 px-2 py-0.5 border border-line-soft max-w-[420px] truncate">
                {parsed.args}
              </span>
            ) : null}
            <span className="ml-1 font-mono text-[10px] text-graphite/70 border border-line-soft rounded px-1.5 py-px shrink-0">
              斜杠指令
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-turn-id={messageId} className="group/user flex items-end justify-end gap-1.5 pt-[22px]">
      {actionEntries}
      <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1.5">
        {/* 定时代发徽标（docs/23）：气泡上方一枚小 pill —— 这条不是用户亲手
            发的，是定时任务到点投进来的；字段随事件进账本，回放同样可见 */}
        {origin === "automation" && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-teal-tint px-1.5 py-px text-[9px] font-medium text-teal"
            title="定时任务到点代发（非用户手动发送）"
          >
            <CalendarClock size={9} />
            定时
          </span>
        )}
        {attachments && attachments.length > 0 && (
          <AttachmentsBar attachments={[...attachments]} readOnly />
        )}
        {text.trim() && (
          <div className="max-w-full rounded-2xl border border-line bg-rail px-3.5 py-2.5">
            <ClampedPromptText text={text} stateKey={messageId || `t:${text.slice(0, 60)}`} />
          </div>
        )}
      </div>
    </div>
  );
}
