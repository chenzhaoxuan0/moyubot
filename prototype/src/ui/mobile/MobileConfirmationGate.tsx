import { useMemo, useRef, useState } from "react";
import { Check, ShieldAlert, X, ChevronRight, HelpCircle, ChevronDown } from "lucide-react";
import { useWorkbench } from "../../store/useWorkbench.ts";
import { needsDialog } from "../../core/permission.ts";
import { cn } from "../cn.ts";

export function MobileConfirmationGate() {
  const timeline = useWorkbench((s) => s.timeline);
  const decisions = useWorkbench((s) => s.permissionDecisions);
  const resolve = useWorkbench((s) => s.resolvePermission);
  const mode = useWorkbench((s) => s.permissionMode);

  // 原生手势下拉关闭 / 拒绝状态
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number | null>(null);

  // 待裁决队列过滤（若任何端已经首响仲裁，decisions[reqId] 成立，会自动移出）
  const pending = useMemo(
    () =>
      timeline
        .filter((t) => t.event.type === "permission.requested" && !decisions[t.event.requestId])
        .map((t) => {
          const e = t.event as Extract<typeof t.event, { type: "permission.requested" }>;
          return { requestId: e.requestId, detail: e.detail, kind: e.kind, risk: e.risk };
        })
        .filter((p) => needsDialog(mode, p.kind as "file_write" | "shell" | "network" | "tool")),
    [timeline, decisions, mode],
  );

  const active = pending[0];
  if (!active) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startYRef.current = touch.clientY;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current === null) return;
    const touch = e.touches[0];
    if (!touch) return;
    const delta = touch.clientY - startYRef.current;
    if (delta > 0) {
      // 触控阻尼跟随
      setDragY(delta * 0.75);
    }
  };

  const handleTouchEnd = () => {
    if (dragY > 90) {
      // 超过阈值：触发拒绝操作并关闭
      resolve(active.requestId, "deny");
    }
    setDragY(0);
    setIsDragging(false);
    startYRef.current = null;
  };

  const riskMeta = {
    high: { label: "高风险操作", cls: "bg-loss-tint text-loss border-loss/20" },
    medium: { label: "中风险", cls: "bg-amber-500/15 text-amber-600 border-amber-500/20" },
    low: { label: "低风险", cls: "bg-gain-tint text-gain border-gain/20" },
  }[active.risk] ?? { label: "操作拦截", cls: "bg-line-soft text-graphite" };

  const kindLabel = {
    file_write: "写入修改文件",
    shell: "运行终端命令",
    network: "网络请求访问",
    tool: "调用外部工具",
  }[active.kind] ?? "执行敏感操作";

  return (
    <>
      {/* 半透明遮罩（透明度随手势下拉动态衰减） */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs animate-in fade-in duration-200"
        style={{ opacity: Math.max(0.1, 1 - dragY / 250) }}
        onClick={() => resolve(active.requestId, "deny")}
      />

      {/* 底部上滑卡片 Bottom Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl border-t border-line/80 bg-canvas px-5 pb-6 pt-3 shadow-2xl animate-in slide-in-from-bottom duration-300"
        style={{
          transform: `translateY(${dragY}px)`,
          transition: isDragging ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* 顶部手势把手与下拉提示区 */}
        <div
          className="flex cursor-grab flex-col items-center pb-2 pt-1 active:cursor-grabbing touch-none"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div
            className={cn(
              "h-1.5 w-12 rounded-full transition-colors",
              dragY > 50 ? "bg-loss animate-pulse" : "bg-line-strong/60",
            )}
          />
          {dragY > 30 && (
            <span className="mt-1 flex items-center gap-1 text-[10px] font-medium text-loss animate-in fade-in">
              <ChevronDown size={12} />
              <span>释放直接拒绝本次执行</span>
            </span>
          )}
        </div>

        {/* 头部标题与风险徽标 */}
        <div className="flex items-center justify-between pb-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
              <ShieldAlert size={18} className="animate-pulse" />
            </div>
            <div>
              <h3 className="text-body-sm font-bold text-ink">确认门拦截 · 需要授权</h3>
              <p className="text-[11px] text-graphite">{kindLabel}</p>
            </div>
          </div>
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
              riskMeta.cls,
            )}
          >
            {riskMeta.label}
          </span>
        </div>

        {/* 详细命令 / 路径展示框 */}
        <div className="my-3 max-h-36 overflow-y-auto rounded-xl border border-line bg-rail/60 p-3 font-mono text-[12px] leading-relaxed text-ink select-text">
          <div className="break-all whitespace-pre-wrap">{active.detail}</div>
        </div>

        {/* 底部触控大按钮组 */}
        <div className="space-y-2 pt-1">
          {/* 批准一次（主要触控点） */}
          <button
            onClick={() => resolve(active.requestId, "allow")}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal font-semibold text-on-accent shadow-md transition active:scale-[0.98] hover:bg-teal-hover"
          >
            <Check size={18} />
            <span>批准本次执行 (Allow Once)</span>
          </button>

          <div className="grid grid-cols-2 gap-2">
            {/* 总是放行 */}
            <button
              onClick={() => resolve(active.requestId, "always")}
              className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-line bg-card font-medium text-ink transition active:scale-[0.98] hover:bg-line-soft"
            >
              <span>始终允许</span>
              <ChevronRight size={14} className="text-ash" />
            </button>

            {/* 拒绝 */}
            <button
              onClick={() => resolve(active.requestId, "deny")}
              className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-loss/30 bg-loss/10 font-medium text-loss transition active:scale-[0.98] hover:bg-loss/20"
            >
              <X size={16} />
              <span>拒绝 (Reject)</span>
            </button>
          </div>
        </div>

        {/* 多端首响仲裁说明 */}
        <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-ash">
          <HelpCircle size={11} />
          <span>多端首响仲裁已激活：电脑端或微信/TG/Discord 处理后将自动关闭。</span>
        </p>
      </div>
    </>
  );
}
