import { useState } from "react";
import { ArrowUp, CalendarClock, Check, Copy, PencilLine, X } from "lucide-react";
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

export function UserMessageBubble({
  text,
  attachments,
  messageId,
  sessionId,
  origin,
  isLatestUserTurn,
  busy,
}: {
  text: string;
  attachments?: readonly ChatAttachment[];
  /** daemon 侧真实 messageId（echo 回填后的 user-N；本地假 id 时编辑入口禁用） */
  messageId: string;
  /** 这条消息所属的段 —— revision 的 ofSessionId */
  sessionId: string;
  /** 消息来源（docs/23）："automation" = 定时任务到点代发 —— 气泡上方亮「定时」徽标 */
  origin?: string;
  /** 时间线最后一条用户消息：编辑重发只对它开放（latestQueryEditOnly） */
  isLatestUserTurn: boolean;
  busy: boolean;
}) {
  const parsed = parseSlashCommand(text);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(text);
  const editAndResend = useWorkbench((s) => s.editAndResend);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);

  const blocked =
    busy ||
    sourceStatus === "running" ||
    sourceStatus === "awaiting_permission" ||
    sourceStatus === "awaiting_input";
  // 本地合成气泡的假 messageId（u${seq}，echo 尚未回填）不能做账本锚点
  const anchorReady = /^user-\d+$/.test(messageId);
  const canEdit = isLatestUserTurn && !blocked && anchorReady;
  const disabledTitle = blocked ? "先让这一轮落定" : "锚点还没落进账本，稍等一下再试";

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

  // ---- 编辑态：气泡原位替换为编辑器 ----
  if (editing) {
    return (
      <div data-turn-id={messageId} className="flex w-full flex-col items-end">
        <div className="w-full max-w-full rounded-[16px] rounded-tr-[4px] border border-teal/40 bg-card px-3.5 py-2.5 shadow-xs focus-within:border-teal/60">
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
            className="w-full resize-none bg-transparent text-body leading-relaxed text-ink outline-none"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-caption text-ash">
              重发将在新分支替换这一轮（原分支保留可回看，附件与文件改动不回滚）
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

  const editEntry = isLatestUserTurn ? (
    <button
      onClick={openEdit}
      disabled={!canEdit}
      aria-label="编辑重发"
      title={canEdit ? "编辑这条消息并重新发送：在新分支里替换这一轮（原位编辑，不进输入框）" : disabledTitle}
      className="flex shrink-0 cursor-pointer items-center rounded-btn p-1 text-ash opacity-60 transition hover:bg-line-soft hover:text-ink group-hover/user:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PencilLine size={12} />
    </button>
  ) : null;

  const actionEntries = (
    <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover/user:opacity-100">
      <button
        onClick={copyText}
        aria-label="复制此消息"
        title={copied ? "已复制到剪贴板" : "复制此消息"}
        className="flex cursor-pointer items-center rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink transition"
      >
        {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
      </button>
      {editEntry}
    </div>
  );

  if (parsed.isCommand) {
    return (
      <div data-turn-id={messageId} className="group/user flex items-end justify-end gap-1.5">
        {actionEntries}
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          {attachments && attachments.length > 0 && (
            <AttachmentsBar attachments={[...attachments]} readOnly />
          )}
          <div className="max-w-full rounded-[16px] rounded-tr-[4px] border border-line bg-card px-3.5 py-2.5 shadow-xs flex items-center gap-2.5">
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
    <div data-turn-id={messageId} className="group/user flex items-end justify-end gap-1.5">
      {actionEntries}
      <div className="flex min-w-0 flex-col items-end gap-1.5">
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
          <div className="max-w-full rounded-[16px] rounded-tr-[4px] border border-line bg-card px-4 py-3 shadow-xs">
            <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{text}</p>
          </div>
        )}
      </div>
    </div>
  );
}
