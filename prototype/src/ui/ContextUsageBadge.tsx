import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { modelSpecFor, useWorkbench } from "../store/useWorkbench.ts";
import { daemonModelId } from "../adapters/daemon/adapter.ts";
import { formatContext } from "../core/models.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { cn } from "./cn.ts";

/** 环形电量图的几何（viewBox 24）：弧长 = 占比 × 周长，-90° 起笔（12 点钟方向） */
const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 上下文容量环形徽标（Composer 底栏右侧，发送键左边 —— ZCode 同款位型）。
 *
 * - **环 = 环形电量图**：占用比例多少环就亮多少 —— 口径为最近一轮 usage 的
 *   input + 缓存读 + output ÷ 模型上下文窗口（**非**累计，每轮 input 已含全部
 *   历史；亦非服务端权威计数）。≥70% 琥珀、≥90% 红。
 * - **左键点开弹层**：口径明细 + 模型 + 订阅执行器配额余量（QuotaHeadroom）。
 *   余量只住在弹层里 —— 环保持「上下文占用」的单一语义，不再平铺 ·余N%。
 */
export function ContextUsageBadge() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const usage = useWorkbench((s) =>
    s.activeSessionId === null ? undefined : s.usageBySession[String(s.activeSessionId)],
  );
  const spec = useWorkbench((s) => {
    const session = s.activeSessionId === null ? undefined : s.sessions.find((x) => x.id === s.activeSessionId);
    const modelId = session?.modelActual ?? s.runtimeModels[s.activeRuntimeId] ?? null;
    return modelSpecFor(
      s.runtimes.find((r) => r.id === s.activeRuntimeId),
      modelId === null ? null : daemonModelId(String(modelId)),
    );
  });
  const bareRuntime = useWorkbench((s) => s.activeRuntimeId.replace(/^daemon:/, ""));
  const quota = useBacklog((s) => s.quotas.find((q) => q.runtimeId === bareRuntime) ?? null);
  const refreshQuotas = useBacklog((s) => s.refreshQuotas);

  // 挂载 / 换执行器时刷一次余量（daemon 侧探测，内部自捕获错误）
  useEffect(() => {
    void useBacklog.getState().refreshQuotas();
  }, [bareRuntime]);

  // 点外关闭走文档级 mousedown 捕获（QuickContextMenu 同款），不用 fixed 遮罩：
  // 徽标住在 Composer 的 @container 外壳里，container-type 附带 layout containment，
  // fixed 遮罩会被困在外壳范围内 —— 点时间线关不掉弹层
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const contextWindow = spec?.contextWindow;
  if (usage === undefined || contextWindow === undefined || contextWindow <= 0) return null;

  const used = usage.inputTokens + (usage.cacheReadTokens ?? 0) + usage.outputTokens;
  const pct = Math.min(100, Math.round((used / contextWindow) * 100));
  const tone =
    pct >= 90
      ? "text-red-500"
      : pct >= 70
        ? "text-amber-600"
        : "text-graphite";

  const cacheLine =
    usage.cacheReadTokens !== undefined ? `，缓存读 ${formatContext(usage.cacheReadTokens)}` : "";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          // 弹层打开时顺带刷一次余量（挂着没动过的执行器，数据可能还是上次的）
          if (!open) void refreshQuotas();
          setOpen((o) => !o);
        }}
        aria-label={`上下文占用 ${pct}%，点开查看口径明细与订阅余量`}
        title={`上下文 ≈${formatContext(used)} / ${formatContext(contextWindow)}（${pct}%）` +
          `\n点击查看口径明细与订阅余量`}
        className="hidden @min-[380px]:flex items-center justify-center rounded-btn h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8 select-none cursor-pointer transition hover:bg-line-soft"
      >
        <UsageRing pct={pct} tone={tone} className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-76 max-w-[calc(100cqw-32px)] rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed">
          <div className="flex items-center gap-2 border-b border-line-soft pb-1.5 text-body-sm font-medium text-ink">
            <UsageRing pct={pct} tone={tone} className="h-4 w-4" />
            上下文窗口 · {pct}%
          </div>
          <div className="mt-2 space-y-1 text-graphite">
            <p>
              占用 ≈ {formatContext(used)} / {formatContext(contextWindow)}
            </p>
            <p className="text-ash">口径：最近一轮输入{cacheLine} + 输出 —— 近似值，非服务端权威计数</p>
            <p className="text-ash">模型：{spec?.displayName ?? usage.model}</p>
          </div>

          <div className="mt-2.5 border-t border-line-soft pt-2">
            <div className="flex items-center justify-between text-body-sm font-medium text-ink">
              <span>订阅执行器余量</span>
              <button
                type="button"
                onClick={() => void refreshQuotas()}
                aria-label="重新探测余量"
                title="重新探测当前执行器的订阅余量"
                className="rounded p-1 text-ash transition hover:bg-line-soft hover:text-ink"
              >
                <RefreshCw size={11} />
              </button>
            </div>
            {quota !== null && quota.percent !== null ? (
              <p className="mt-1 text-graphite">
                剩余 {quota.percent}%{quota.summary !== null ? ` —— ${quota.summary}` : ""}
              </p>
            ) : (
              <p className="mt-1 text-ash">未探测到余量数据（执行器可能未订阅或不支持探测）</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 占用比例环：底环 line-soft，占用弧按比例点亮；0% 时不画弧（round 端帽的零长弧会成一个点） */
function UsageRing({ pct, tone, className }: { pct: number; tone: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r={RING_R} fill="none" strokeWidth="3" className="stroke-line-soft" />
      {pct > 0 && (
        <circle
          cx="12"
          cy="12"
          r={RING_R}
          fill="none"
          strokeWidth="3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={`${(RING_C * pct) / 100} ${RING_C}`}
          transform="rotate(-90 12 12)"
          className={tone}
        />
      )}
    </svg>
  );
}
