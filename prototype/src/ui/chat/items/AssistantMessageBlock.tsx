import { useState } from "react";
import { Check, Copy, GitBranch } from "lucide-react";
import { MarkdownContent } from "../../MarkdownContent.tsx";
import { useWorkbench } from "../../../store/useWorkbench.ts";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function AssistantMessageBlock({
  text,
  at,
  messageId,
  sessionId,
  streaming = false,
  usage,
  busy,
}: {
  text: string;
  at: number;
  /** daemon 侧的助手消息 id —— 分叉锚点（resolveForkAtSeq 按它定位轮边界） */
  messageId: string;
  sessionId: string;
  streaming?: boolean;
  /** 本轮用量（groupTimelineEvents 把 usage 事件并入这里；缺省不渲染右侧 meta） */
  usage?: { model: string; inputTokens: number; outputTokens: number };
  busy: boolean;
}) {
  const startFork = useWorkbench((s) => s.startFork);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);
  const [copied, setCopied] = useState(false);

  // idle 门禁（ADR 0013 不变量 6）：本轮流式中 / 源段 running/awaiting_* 时禁止分叉
  const blocked =
    busy ||
    sourceStatus === "running" ||
    sourceStatus === "awaiting_permission" ||
    sourceStatus === "awaiting_input";
  const canFork = !streaming && !blocked && messageId !== "";

  const copyReply = (): void => {
    const finish = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(text).then(finish, () => {});
    } else {
      // 非安全上下文（http 源）兜底：execCommand 已废弃但仍是唯一通路
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      finish();
    }
  };

  return (
    <div className="group/msg py-1">
      {/* 正文 Markdown 渲染（流式态容错未闭合围栏、跳过高亮） */}
      <div>
        <MarkdownContent content={text} streaming={streaming} />

        {/* 底部 meta 行：左 = 流式点 + 时间 + 分叉 + 复制；右 = 执行器模型名 */}
        <div className="mt-2 flex items-center gap-2.5 text-caption text-ash select-none">
          {streaming && (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal"
              aria-label="生成中"
            />
          )}
          <span className="tnum shrink-0">{clock(at)}</span>
          <button
            type="button"
            onClick={() => startFork({ ofSessionId: sessionId as never, anchorMessageId: messageId, kind: "branch" })}
            disabled={!canFork}
            aria-label="从此处分叉"
            title={
              streaming
                ? "这一轮还在生成，落定后可分叉"
                : blocked
                  ? "先让这一轮落定"
                  : messageId === ""
                    ? "这条回复没有可定位的锚点（老账本记录），无法分叉"
                    : "从此回复之后开启分叉：新段携带此前对话的只读前缀，当前分支保留可回看"
            }
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GitBranch size={12} />
          </button>
          <button
            type="button"
            onClick={copyReply}
            aria-label="复制这条回复"
            title={copied ? "已复制" : "复制这条回复全文"}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
          >
            {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
          </button>
          {usage !== undefined && (
            <span className="ml-auto flex min-w-0 shrink-0 items-center font-mono" title={`本轮由 ${usage.model} 执行`}>
              <span className="truncate">{usage.model}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
