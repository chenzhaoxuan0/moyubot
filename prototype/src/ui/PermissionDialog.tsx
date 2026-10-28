import { useEffect, useMemo, useRef, useState } from "react";
import { Info, ShieldAlert, X } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { getMode, needsDialog } from "../core/permission.ts";
import type { PermissionDecision } from "../core/adapter.ts";
import { cn } from "./cn.ts";

interface PendingPermission {
  readonly requestId: string;
  readonly detail: string;
  readonly kind: string;
  readonly risk: "low" | "medium" | "high";
}

const RISK_LABEL: Record<PendingPermission["risk"], string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

const KIND_LABEL: Record<string, string> = {
  file_write: "写入文件",
  shell: "执行命令",
  network: "访问网络",
  tool: "调用工具",
};

interface Option {
  readonly key: string;
  readonly decision: PermissionDecision;
  readonly label: string;
  readonly desc: string;
}

/**
 * 权限卡片 —— 对齐 ZCode 的 PermissionDialog + V4InteractionDialogs。
 *
 * 照搬的三点，每一条都有理由：
 *
 * 1. **bottom dock 卡片而非居中模态。** ZCode 把待裁决请求作为
 *    composer 正上方的 dock 卡片渲染（V4InteractionDialogs）——
 *    它必须被打断，但不遮住时间线上下文。挂载点在会话列
 *    Timeline 与 Composer 之间，与 ZCode 同位。
 *
 * 2. **先选中、再统一确认。** 不是每个选项一个按钮 —— 底部只有一个
 *    「确定」。这让「点错了」和「确认授权」成为两个不同的动作。
 *
 * 3. **点已选中的选项 = 直接确认。** 配合默认选中第一项，
 *    熟练用户可以「点两下」或「按数字键 + Enter」完成。
 *    误触一次不会造成授权泄漏，这是权限 UI 的安全底线。
 *
 * 4. **「始终允许」必须说清楚作用域。** ZCode 的 allowAlways 有
 *    global / project / session 三档，这里映射为
 *    全局 / 本工作单元 / 本次会话。混淆这三者是权限失控的主因。
 *
 * 待裁决队列从时间线事件派生，不需要额外状态。
 */
export function PermissionDialog() {
  const timeline = useWorkbench((s) => s.timeline);
  const decisions = useWorkbench((s) => s.permissionDecisions);
  const resolve = useWorkbench((s) => s.resolvePermission);
  const mode = useWorkbench((s) => s.permissionMode);
  const unit = useWorkbench((s) => s.units.find((u) => u.id === s.activeUnitId));

  // 权限模式决定「哪些请求还会弹框」：
  // bypass 全自动；plan 全部拦下；acceptEdits 只对文件写入放行。
  // 模式变了，队列里已经产生的待裁决项也要按新模式重算。
  const pending = useMemo<readonly PendingPermission[]>(
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
  const options = useOptions(unit?.name);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 队列前进时重置选中项到第一项（对齐 ZCode：默认选中 allowOnce）
  useEffect(() => {
    setSelected(0);
  }, [active?.requestId]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // ⚠ 这张卡**不抢焦点**（挂在 composer 上方，人还在输入框里打字）。
      // 所以 document 级快捷键必须先确认「这一下按键不是在输入」——
      // 否则用户打「修复 2 个问题」里的那个 2，就等于点了
      // 「本工作单元始终允许」，而字符被 preventDefault 吃掉、输入框里什么都没有。
      // 输入法组字中的 Enter 同理：那是在选词，不是在确认授权。
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target !== null &&
        (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? selected + 1 : selected - 1;
        setSelected(Math.max(0, Math.min(options.length - 1, next)));
        return;
      }
      // 数字键：直接选中并确认（快捷路径）
      const n = Number.parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault();
        const opt = options[n - 1]!;
        resolve(active.requestId, opt.decision);
        return;
      }
      if (e.key === "Enter") {
        // 焦点在按钮上时让原生 click 走 —— 否则会和 click 一起裁决两次
        if (target !== null && target.tagName === "BUTTON") return;
        e.preventDefault();
        const opt = options[selected];
        if (opt) resolve(active.requestId, opt.decision);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, options, selected, resolve]);

  // 保持选中项在可视区内
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!active) return null;

  // 只读规划模式下的措辞要变：不是"授权"，是"被拦下了"
  const planMode = mode === "plan";
  const title = planMode ? "只读模式已拦下" : "需要授权";
  const confirmLabel = planMode ? "知道了" : "确定";

  const confirm = () => {
    const opt = options[selected];
    if (opt) resolve(active.requestId, opt.decision);
  };

  return (
    // bottom dock 卡片 —— 挂在 composer 正上方（ZCode 的 V4InteractionDialogs 同位），
    // 不遮时间线、不打断输入焦点
    <div className="shrink-0">
      <div className="mx-auto w-full max-w-[900px] px-8 pb-1">
        <div
          role="dialog"
          aria-label={title}
          className="overflow-hidden rounded-card border border-line bg-canvas shadow-subtle"
        >
          <div className="flex flex-col gap-3 p-3">
          {/* 头部：工具类型 + 风险 + 原因 */}
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert size={14} className="shrink-0 text-teal" />
            <span className="text-body-sm font-medium text-graphite">
              {KIND_LABEL[active.kind] ?? active.kind}
            </span>
            <span
              className={cn(
                "rounded-chip px-2 py-0.5 text-caption",
                active.risk === "high" ? "bg-loss/10 text-loss" : "bg-line-soft text-graphite",
              )}
            >
              {RISK_LABEL[active.risk]}
            </span>
            <span className="rounded-chip bg-line-soft px-2 py-0.5 text-caption text-ash">
              {getMode(mode).label}
            </span>
            {pending.length > 1 && (
              <span className="tnum ml-auto text-caption text-ash">还有 {pending.length - 1} 条</span>
            )}
            <button
              onClick={() => resolve(active.requestId, planMode ? "deny" : "deny")}
              aria-label="关闭"
              className="ml-auto shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink"
            >
              <X size={12} />
            </button>
          </div>

          <p className="text-body-sm leading-relaxed text-ink">
            <span className="font-medium">{title}</span>
            <span className="text-graphite"> · {active.detail}</span>
          </p>

          {planMode ? (
            /* 只读规划模式：没有可授权的动作，只能看到"被拦下了什么" */
            <div className="rounded-input bg-line-soft px-3 py-2.5 text-caption leading-relaxed text-graphite">
              当前处于「只读规划」模式，写入与命令执行一律不执行。
              切到「默认询问」或「自动接受编辑」后，这里会变成可选的授权项。
            </div>
          ) : (
            /* 编号选项列表：先选中，再统一确认 */
            <div ref={listRef} role="listbox" className="space-y-1">
              {options.map((o, i) => {
                const isSelected = i === selected;
                return (
                  <button
                    key={o.key}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    onClick={() => {
                      // 已选中再点一次 = 确认；首次点击只是选中
                      if (isSelected) resolve(active.requestId, o.decision);
                      else setSelected(i);
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-input px-3 py-2 text-left transition-colors",
                      isSelected ? "bg-teal-tint" : "hover:bg-line-soft",
                    )}
                  >
                    <span
                      className={cn(
                        "w-4 shrink-0 pt-px text-body-sm font-medium tabular-nums",
                        isSelected ? "text-ink" : "text-ash",
                      )}
                    >
                      {i + 1}.
                    </span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span
                        className={cn("text-body-sm", isSelected ? "font-medium text-ink" : "text-graphite")}
                      >
                        {o.label}
                      </span>
                      <span className="min-w-0 text-caption text-ash">{o.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 底部：键盘提示 + 唯一确认按钮 */}
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="flex items-center gap-2 text-caption text-ash">
              <Info size={12} className="shrink-0" />
              {planMode ? "Esc 关闭" : "↑↓ 选择 · 1–4 快捷确认"}
            </p>
            <button
              onClick={confirm}
              className="rounded-input bg-teal px-4 py-2 text-body-sm font-medium text-on-accent hover:bg-teal-hover"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

function useOptions(unitName: string | undefined): readonly Option[] {
  const name = unitName ?? "当前工作单元";
  return useMemo(
    () => [
      { key: "allow", decision: "allow" as const, label: "允许一次", desc: "之后同类请求仍会再问" },
      {
        key: "always-unit",
        decision: "always" as const,
        label: "本工作单元始终允许",
        desc: `记住到「${name}」`,
      },
      { key: "always-global", decision: "always" as const, label: "全局始终允许", desc: "整个应用不再询问" },
      { key: "deny", decision: "deny" as const, label: "拒绝", desc: "这一次不允许" },
    ],
    [name],
  );
}
