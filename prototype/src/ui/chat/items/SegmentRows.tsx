import { Check, GitBranch, Package, ShieldCheck, Wallet, X } from "lucide-react";
import type { RuntimeEvent } from "../../../core/events.ts";
import { SESSION_SOURCE_LABEL } from "../../../core/units.ts";
import { useWorkbench } from "../../../store/useWorkbench.ts";
import { SessionReadinessBadge } from "../../SessionReadinessBadge.tsx";
import { cn } from "../../cn.ts";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** 段边界 divider 行：执行器切换点 + 上一段 readiness（从 sessions 台账读） */
export function SegmentDividerRow({
  data,
}: {
  data: { from: string; to: string; fromId: string; toId: string };
}) {
  const fromSession = useWorkbench((s) => s.sessions.find((x) => String(x.id) === data.fromId));
  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label={`已切换执行器：${data.from} → ${data.to}`}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-caption text-graphite shadow-xs">
        已切换执行器 · {data.from} → <span className="font-medium text-ink">{data.to}</span>
        <span className="text-ash">· 上一段保留在上方</span>
        <SessionReadinessBadge live={fromSession?.live} resumable={fromSession?.resumable} />
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * 分叉拼接点行（ADR 0013）：父段只读前缀 → fork 出的新段，与执行器切换 divider 区分。
 * 带「回看原分支」入口（ZCode forkNotice 的 onNavigate 模式）
 */
export function ForkPointRow({
  data,
}: {
  data: { from: string; to: string; forkKind: "branch" | "revision"; fromId?: string };
}) {
  const isRevision = data.forkKind === "revision";
  const openSession = useWorkbench((s) => s.openSession);
  const parent = useWorkbench((s) =>
    data.fromId !== undefined ? s.sessions.find((x) => String(x.id) === data.fromId) : undefined,
  );

  const openParent = () => {
    if (parent === undefined || data.fromId === undefined) return;
    void openSession({
      sessionId: parent.id,
      unitId: parent.unitId,
      runtimeId: String(parent.runtimeId).replace(/^daemon:/, ""),
    });
  };
  const canOpenParent = parent !== undefined;

  return (
    <div
      className="my-6 flex items-center gap-3"
      role="separator"
      aria-label={isRevision ? "已编辑重发" : "已从此处分叉"}
    >
      <span className="h-px flex-1 bg-line" />
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-caption text-graphite shadow-xs">
        <GitBranch size={11} className="text-teal" />
        {isRevision ? (
          <>
            已编辑重发 ·
            <span className="font-medium text-ink">{data.from}</span>
            <span className="text-ash">· 之前对话以只读前缀带入</span>
          </>
        ) : (
          <>
            已从此处分叉 ·
            <span className="font-medium text-ink">
              {data.from === data.to ? data.from : `${data.from} → ${data.to}`}
            </span>
            <span className="text-ash">· 上文以只读前缀带入</span>
          </>
        )}
        {canOpenParent && (
          <button
            type="button"
            onClick={openParent}
            title={`回看原分支（${data.from} 的完整对话；本轮进行中需先落定）`}
            className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            回看原分支
          </button>
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function SessionStartRow({
  event,
  at,
}: {
  event: Extract<RuntimeEvent, { type: "session.started" }>;
  at: number;
}) {
  const source = event.source ?? "workbench";
  const fromWorkbench = source === "workbench";
  return (
    <div className="my-6 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="h-px flex-1 bg-line" />
      <span className="tnum shrink-0 text-caption text-ash">会话开始 · {clock(at)}</span>
      {!fromWorkbench && (
        <span
          className="shrink-0 rounded-btn bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal"
          title="这个会话是从这个渠道发起的，和工作台里的是同一段对话"
        >
          来自{SESSION_SOURCE_LABEL[source]}
        </span>
      )}
      {event.modelActual !== undefined && (
        <span
          className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite"
          title="实际生效的模型"
        >
          {event.modelActual}
        </span>
      )}
      {event.modelHintDropped !== undefined && (
        <span
          className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite"
          title={`你配的默认模型 ${event.modelHintDropped} 这家执行器不接，已回落到执行器默认`}
        >
          配的 {event.modelHintDropped} 不可用，已回落
        </span>
      )}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function SessionEndRow({ reason }: { reason: string }) {
  return (
    <div className="my-6 flex items-center gap-4">
      <span className="h-px flex-1 bg-line" />
      <span className="tnum shrink-0 text-caption text-ash">会话结束 · {reason}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

const DECISION_LABEL: Record<string, string> = {
  allow: "已允许一次",
  always: "已始终允许",
  deny: "已拒绝",
};

export function PermissionRow({
  requestId,
  detail,
  risk,
}: {
  requestId: string;
  detail: string;
  risk: "low" | "medium" | "high";
}) {
  const decision = useWorkbench((s) => s.permissionDecisions[requestId]);

  return (
    <div className="mb-2 flex items-center gap-2 rounded-btn bg-line-soft px-3 py-2 text-body-sm">
      {decision ? (
        decision === "deny" ? (
          <X size={12} className="shrink-0 text-loss" />
        ) : (
          <Check size={12} className="shrink-0 text-gain" />
        )
      ) : (
        <ShieldCheck size={12} className="shrink-0 animate-pulse text-teal" />
      )}
      <span className="min-w-0 flex-1 truncate text-graphite">{detail}</span>
      {risk === "high" && <span className="shrink-0 text-caption text-loss">高风险</span>}
      <span className={cn("shrink-0 text-caption", decision ? "text-ash" : "text-teal")}>
        {decision ? (DECISION_LABEL[decision] ?? decision) : "待裁决"}
      </span>
    </div>
  );
}

export function SystemNoticeRow({
  event,
  at,
}: {
  event: {
    title: string;
    text: string;
    level?: "info" | "success" | "warn";
    meta?: Readonly<Record<string, string>>;
  };
  at: number;
}) {
  const isSuccess = event.level === "success";
  const isWarn = event.level === "warn";

  return (
    <div
      className={cn(
        "rounded-card border p-3.5 shadow-xs transition animate-in fade-in slide-in-from-bottom-1 duration-150",
        isSuccess
          ? "border-teal/30 bg-teal-tint/20 text-ink"
          : isWarn
            ? "border-amber-500/30 bg-amber-500/10 text-ink"
            : "border-line bg-line-soft/80 text-ink",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold",
            isSuccess ? "bg-teal text-canvas" : isWarn ? "bg-amber-600 text-white" : "bg-ink text-canvas",
          )}
        >
          ⚡
        </div>
        <span className="font-semibold text-body-sm text-ink">{event.title}</span>
        <span className="ml-auto font-mono text-[10px] text-ash">{clock(at)}</span>
      </div>

      <div className="mt-2 text-body-sm text-graphite whitespace-pre-wrap leading-relaxed font-normal">
        {event.text}
      </div>

      {event.meta && Object.keys(event.meta).length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-2 border-t border-line-soft">
          {Object.entries(event.meta).map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-0.5 text-[11px] font-mono text-graphite border border-line-soft"
            >
              <span className="text-ash">{k}:</span>
              <span className="font-medium text-ink">{v}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SubagentSpawnedRow({
  role,
  runtimeId,
}: {
  role: string;
  runtimeId: string;
}) {
  return (
    <div className="rounded-card border-l-2 border-l-teal bg-card px-4 py-3 shadow-subtle flex items-center gap-2">
      <Package size={14} className="shrink-0 text-teal" />
      <p className="text-body-sm text-graphite">
        派生子代理 · 角色 <span className="font-medium text-ink">{role}</span> · 经由 {runtimeId}
      </p>
    </div>
  );
}

export function SubagentFinishedRow({ summary }: { summary?: string }) {
  return (
    <div className="flex items-center gap-2 pl-1 text-body-sm text-graphite">
      <Check size={14} className="shrink-0 text-gain" />
      <span>子代理完成{summary ? ` · ${summary}` : ""}</span>
    </div>
  );
}

export function UsageFallbackRow({ model }: { model: string }) {
  return (
    <div className="flex items-center gap-2 pl-1 text-caption text-ash">
      <Wallet size={12} />
      <span className="font-mono">{model}</span>
    </div>
  );
}

export function ErrorRow({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-loss/30 bg-loss/5 px-4 py-3 text-body-sm text-loss">
      {message}
    </div>
  );
}
