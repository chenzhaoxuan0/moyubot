import { useEffect, useState } from "react";
import { Check, Copy, GitBranch, Timer } from "lucide-react";
import { MarkdownContent } from "../../MarkdownContent.tsx";
import { useWorkbench } from "../../../store/useWorkbench.ts";

export function AssistantMessageBlock({
  text,
  messageId,
  sessionId,
  streaming = false,
  busy,
  turnStartedAt,
  variant = "final",
}: {
  text: string;
  /** daemon 侧的助手消息 id —— 分叉锚点（resolveForkAtSeq 按它定位轮边界） */
  messageId: string;
  sessionId: string;
  streaming?: boolean;
  busy: boolean;
  turnStartedAt?: number;
  /**
   * final = 落定回复（meta 行：流式秒表 + 悬停浮现的分叉/复制；无时间戳/落定耗时/模型名）；
   * process = 工作组里的中间叙述（Codex 逻辑：过程文本就是纯文本，
   * 不带任何元信息行——时间、耗时、分叉、复制、执行器全部不出现）。
   */
  variant?: "final" | "process";
}) {
  const startFork = useWorkbench((s) => s.startFork);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);
  const [copied, setCopied] = useState(false);
  const [liveSec, setLiveSec] = useState(0);

  const isActuallyLive = streaming && sourceStatus === "running";

  // 流式中实时更新已执行秒数（对齐截图与用户诉求）
  useEffect(() => {
    if (!isActuallyLive || !turnStartedAt) return;
    const update = () => {
      setLiveSec(Math.max(1, Math.round((Date.now() - turnStartedAt) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isActuallyLive, turnStartedAt]);

  // Codex 逻辑：耗时属于思考行（"思考了 N 秒"），落定回复不挂耗时；
  // 这里只在流式期间保留实时秒表作为"仍在干活"的反馈
  const displayDuration = isActuallyLive
    ? (liveSec > 0 ? `已执行 ${liveSec}秒` : "执行中…")
    : null;

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

        {/* meta 行只属于落定回复（Codex 逻辑）：流式中 = 脉冲点 + 实时秒表；
            落定后只剩悬停浮现的分叉/复制；时间戳、落定耗时、模型名一律不显示 */}
        {variant === "final" && (
        <div className="mt-1.5 flex items-center gap-2.5 text-caption text-ash select-none">
          {streaming && (
            <>
              <span
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal"
                aria-label="生成中"
              />
              {displayDuration && (
                <span
                  className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-ash/90"
                  title="正在执行中"
                >
                  <Timer size={11} className="animate-spin text-teal" />
                  <span>{displayDuration}</span>
                </span>
              )}
            </>
          )}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100">
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
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
