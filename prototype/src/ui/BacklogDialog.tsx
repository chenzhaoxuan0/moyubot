import { useState, type ReactElement, type ReactNode } from "react";
import { ListTodo, X } from "lucide-react";
import type { BacklogItem } from "../core/backlog.ts";
import { draftPromptOf } from "../core/backlog.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { cn } from "./cn.ts";

/**
 * 新建 / 编辑待办。录入时只写目标 —— prompt 草稿由模板生成、可手改（共识 Q1c）。
 * 大小只是展示标签；排序（优先级）在清单页拖拽，不在表单里。
 */

const MODE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: "", label: "跟随默认" },
  { id: "build", label: "build（默认权限）" },
  { id: "plan", label: "plan（只读规划）" },
  { id: "edit", label: "edit" },
  { id: "yolo", label: "yolo（免审批）" },
];

/** bot.json 的主绑定执行器（裸 id） */
function unitRuntimeId(u: { readonly bindings: readonly { readonly runtimeId: string; readonly primary: boolean }[] } | undefined): string {
  const primary = u?.bindings.find((b) => b.primary) ?? u?.bindings[0];
  return (primary?.runtimeId ?? "").replace(/^daemon:/, "");
}

export function BacklogDialog({ initial, onClose }: { initial: BacklogItem | null; onClose: () => void }): ReactElement {
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);
  const createItem = useBacklog((s) => s.createItem);
  const updateItem = useBacklog((s) => s.updateItem);

  const [title, setTitle] = useState(initial?.title ?? "");
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [promptTouched, setPromptTouched] = useState(initial !== null);
  const [unitId, setUnitId] = useState(initial?.unitId ?? (units[0]?.id ?? ""));
  const [runtimeBare, setRuntimeBare] = useState(initial?.runtimeId ?? unitRuntimeId(units[0]));
  const [model, setModel] = useState(initial?.model ?? "");
  const [mode, setMode] = useState(initial?.mode ?? "");
  const [size, setSize] = useState<string>(initial?.size ?? "");
  // 新建默认「对话页」（与自动化口径一致）；编辑沿用定义行的值
  const [launchMode, setLaunchMode] = useState<"terminal" | "chat" | "headless">(initial?.launchMode ?? "chat");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const unit = units.find((u) => u.id === unitId);
  const namespaced = runtimeBare === "" ? "" : `daemon:${runtimeBare}`;

  // 目标变了且 prompt 没被手动碰过 → 跟着重新生成草稿
  const onGoalChange = (v: string): void => {
    setGoal(v);
    if (!promptTouched) setPrompt(draftPromptOf(v.trim() === "" ? "…" : v.trim()));
    if (title === "" || title === initial?.title) setTitle(v.split(/\r?\n/)[0]?.slice(0, 40) ?? "");
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    if (goal.trim() === "") {
      setErr("目标不能为空 —— 一句话说清要达成什么");
      return;
    }
    if (unit === undefined) {
      setErr("先选一个归属单元 —— 待办在它的工作目录里执行");
      return;
    }
    setSubmitting(true);
    setErr(null);
    const ok =
      initial === null
        ? await createItem({
            title: title.trim() === "" ? goal.trim().split(/\r?\n/)[0]!.slice(0, 40) : title.trim(),
            goal: goal.trim(),
            prompt: prompt.trim() === "" ? draftPromptOf(goal.trim()) : prompt.trim(),
            unitId: unit.id,
            unitName: unit.name,
            rootPath: unit.rootPath,
            runtimeId: runtimeBare,
            model: model === "" ? null : model,
            mode: mode === "" ? null : mode,
            size: size === "" ? null : size,
            launchMode,
          })
        : await updateItem(initial.id, {
            title: title.trim(),
            goal: goal.trim(),
            prompt: prompt.trim(),
            unitId: unit.id,
            unitName: unit.name,
            rootPath: unit.rootPath,
            runtimeId: runtimeBare,
            model: model === "" ? null : model,
            mode: mode === "" ? null : mode,
            size: size === "" ? null : size,
            launchMode,
          });
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initial === null ? "新建待办" : "编辑待办"}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <ListTodo size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">{initial === null ? "新建待办" : "编辑待办"}</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Field label="目标" hint="要达成的结果，一句话即可 —— 空闲心跳会挑合适的时机提议启动">
            <textarea
              value={goal}
              onChange={(e) => onGoalChange(e.target.value)}
              rows={2}
              placeholder="例如：把 agent-workbench 的 README 翻新一遍，只留当下事实"
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </Field>

          <Field label="名称" hint="缺省取目标第一行">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="清单上显示的标题" className={inputCls} />
          </Field>

          <Field label="归属单元" hint="确认后在它的工作目录执行（继承身份与配置）">
            {units.length === 0 ? (
              <p className="rounded-input bg-rail px-2.5 py-2 text-caption text-loss">
                还没有任何 bot —— 先在侧栏新建一个，再回来建待办
              </p>
            ) : (
              <select
                value={unitId}
                onChange={(e) => {
                  setUnitId(e.target.value);
                  const u = units.find((x) => x.id === e.target.value);
                  if (u !== undefined) setRuntimeBare(unitRuntimeId(u));
                }}
                className={inputCls}
              >
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}（{u.kind}）
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="默认执行器" hint="确认弹窗里可临时改选，选择会记忆回来">
              <select value={runtimeBare} onChange={(e) => { setRuntimeBare(e.target.value); setModel(""); }} className={inputCls}>
                <option value="">（必选）</option>
                {runtimes.map((r) => (
                  <option key={r.id} value={r.id.replace(/^daemon:/, "")}>
                    {r.presentation.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="大小" hint="只是展示标签，不影响调度">
              <select value={size} onChange={(e) => setSize(e.target.value)} className={inputCls}>
                <option value="">未标</option>
                <option value="big">大（长任务）</option>
                <option value="small">小</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="模型" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 里可自行切换）" : "可选，缺省跟随执行器默认"}>
              <ModelSelect
                runtimeId={namespaced}
                value={model}
                onChange={setModel}
                className={inputCls}
              />
            </Field>
            <Field label="权限模式" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 默认免审批）" : "执行时自动放行（deny 规则仍生效）"}>
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
                {MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="执行方式"
            hint={
              launchMode === "terminal"
                ? "确认后在前端拉执行器 TUI（免审批，可看可插手）"
                : launchMode === "chat"
                  ? "确认后把会话开在主聊天页前台 —— 可看可插话"
                  : "纯后台执行：不弹终端，走会话台账"
            }
          >
            <select
              value={launchMode}
              onChange={(e) => {
                const v = e.target.value;
                setLaunchMode(v === "terminal" || v === "chat" || v === "headless" ? v : "chat");
              }}
              className={inputCls}
            >
              <option value="chat">对话页（默认）</option>
              <option value="terminal">终端 TUI</option>
              <option value="headless">纯后台</option>
            </select>
          </Field>

          <Field label="启动 prompt" hint="确认后原样发给执行器（由目标模板生成，可手改）—— 无人值守执行，写清预期产出，运行期间无人回答问题">
            <textarea
              value={prompt}
              onChange={(e) => {
                setPromptTouched(true);
                setPrompt(e.target.value);
              }}
              rows={4}
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </Field>

          {err !== null && <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>}
        </div>

        <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-line px-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-line bg-canvas px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || unit === undefined}
            className="rounded-btn bg-ink px-3.5 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition disabled:opacity-40"
          >
            {submitting ? "保存中…" : initial === null ? "创建" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactElement {
  // 标签与提示分行：此前同一行 baseline 排布，提示长一点就在双列格子里换行挤压，
  // 与下方控件糊在一起 —— 宁可多占两行也要每行只装一件事。
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-body-sm font-medium text-ink">{label}</span>
        {hint !== undefined && <span className="text-caption leading-snug text-ash">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
