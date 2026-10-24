import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";
import {
  scheduleRuleToCron,
  formatAbsoluteHuman,
  formatRelative,
  type Automation,
  type DispatchTarget,
  type ScheduleRule,
  type Weekday,
} from "../core/automation.ts";
import type { AutomationWriteInput, ResumableSession } from "../adapters/daemon/client.ts";
import { fetchResumableSessions } from "../adapters/daemon/client.ts";
import { SESSION_SOURCE_LABEL, type SessionSource } from "../core/units.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { cn } from "./cn.ts";

/**
 * 新建 / 编辑自动化 —— 自动化页此前只有卡片没有入口，这个对话框补上创建链路。
 *
 * 表单产出的不是裸 cron，而是 **ScheduleRule（权威）**：频率选择器的每个 tab
 * 直接映射成规则对象交给 daemon，daemon 用与 UI 共享的引擎（core/automation.ts）
 * 算 next_run_at 并调度。「N 分钟后」走 delayMinutes，相对时间以 daemon 时钟为锚。
 */

export type FreqTab = "delay" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

/**
 * 弹窗打开请求（docs/23）：新建（可带模板预填）或编辑。全局唯一份，存于
 * useShell.automationDialog —— 侧栏待触发行、自动化页新建/编辑共用，挂载点
 * 在 WorkspaceShell（不依赖当前 mainView）。
 */
export type AutomationDialogRequest =
  | { mode: "create"; prefill?: AutomationDialogPrefill }
  | { mode: "edit"; automation: Automation };

/** 模板预填：名称 + 描述 + 提示词 + 重复规则草稿（空态宫格点进来的半成品表单） */
export interface AutomationDialogPrefill {
  readonly name: string;
  /** 卡片上的一行说明（仅空态宫格展示用） */
  readonly desc?: string;
  readonly prompt: string;
  readonly freq: FreqTab;
  readonly time?: string;
  readonly weekdays?: readonly Weekday[];
  readonly interval?: number;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | "months";
}

const FREQ_TABS: readonly { id: FreqTab; label: string }[] = [
  { id: "delay", label: "一次性" },
  { id: "hourly", label: "每小时" },
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "monthly", label: "每月" },
  { id: "custom", label: "自定义" },
];

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;

const UNIT_OPTIONS: readonly { id: NonNullable<ScheduleRule["unit"]>; label: string }[] = [
  { id: "minutes", label: "分钟" },
  { id: "hours", label: "小时" },
  { id: "days", label: "天" },
  { id: "weeks", label: "周" },
  { id: "months", label: "个月" },
];

const MODE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: "", label: "跟随默认" },
  { id: "build", label: "build（默认权限）" },
  { id: "plan", label: "plan（只读规划）" },
  { id: "edit", label: "edit" },
  { id: "yolo", label: "yolo（免审批）" },
];

const LAUNCH_MODE_OPTIONS: readonly { id: "terminal" | "chat" | "headless"; label: string; hint: string }[] = [
  { id: "chat", label: "对话页（默认）", hint: "到点把会话开在主聊天页前台 —— 可看可插话，GUI 原生形态" },
  { id: "terminal", label: "终端 TUI", hint: "到点在前端拉起执行器终端界面，可看可插手（自动配免审批）" },
  { id: "headless", label: "纯后台", hint: "headless 会话：不弹任何界面、走会话台账，适合例行任务" },
];

/**
 * 「已有对话」的执行方式子集：终端 TUI 不是定时收件对象（终端与会话是两套
 * 体系，TUI 里跑的对话没有会话台账可续接），所以这里只剩一个决定 ——
 * 到点发消息时，要不要把那个对话顺手拉到聊天页前台。
 */
const EXISTING_LAUNCH_MODE_OPTIONS: readonly { id: "chat" | "headless"; label: string; hint: string }[] = [
  { id: "chat", label: "对话页（到点打开该对话）", hint: "到点把消息发进老对话，并把它打开到聊天页前台" },
  { id: "headless", label: "纯后台（只发不打开）", hint: "到点只发消息，不动你当前看的页面" },
];

/**
 * 「发到哪里」—— 定时发送的全部口径就这一处二选一。
 *
 * 说人话：到点了，是**新开一个对话**把这几句话当开场白，
 * 还是**往一个已经聊过的对话里再发一条**，让 agent 在原上下文里接着干。
 * 「用量恢复后续跑」用的就是后者 —— 中断前的东西还在那儿，不该从头交代一遍。
 */
const DISPATCH_TARGET_OPTIONS: readonly { id: DispatchTarget; label: string; hint: string }[] = [
  {
    id: "new_session",
    label: "新对话（默认）",
    hint: "到点新开一个对话，把下面这段提示词当第一句话发出去",
  },
  {
    id: "existing_session",
    label: "已有对话",
    hint: "到点把提示词当一条消息发进老对话。对话如果已经结束会自动接回来，上下文不断",
  },
];

/** 表单里的调度草稿（tab + 各 tab 的字段） */
interface BuilderDraft {
  readonly freq: FreqTab;
  /** "HH:MM"，daily/weekly/monthly/custom(天以上) 用 */
  readonly time: string;
  readonly weekdays: Weekday[];
  readonly dayOfMonth: number;
  readonly interval: number;
  readonly unit: NonNullable<ScheduleRule["unit"]>;
  /** 一次性：N 分钟后 */
  readonly delayMinutes: number;
  /**
   * 一次性：到底用哪种表达。
   * - relative =「N 分钟后」，相对量要人自己数
   * - absolute = 指定到某个确切时刻 —— 用量恢复续跑属于后者：
   *   恢复时刻是探针读出来的**确切时间**，逼用户反推分钟数没有意义
   */
  readonly delayMode: "relative" | "absolute";
  /** absolute 模式下的 "YYYY-MM-DDTHH:MM"（datetime-local 的原生格式） */
  readonly runAtLocal: string;
  readonly recurring: boolean;
  /** 有限次：跑满即停（recurring=false 时生效；recurring=true 时不限） */
  readonly maxRuns: number;
}

/** 两位补零 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** datetime-local 用的 "YYYY-MM-DDTHH:MM" */
function toLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 字符串 → epoch ms；解析不出来给 null（表单校验会去拦） */
function fromLocalInput(v: string): number | null {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 引擎是分钟粒度 —— 选出来的秒一律抹平，避免「15:09:30」看着能用其实会进位到 15:10 */
function floorToMinute(at: number): number {
  return Math.floor(at / 60_000) * 60_000;
}

function createDefaultDraft(): BuilderDraft {
  return {
    freq: "daily",
    time: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    interval: 30,
    unit: "minutes",
    delayMinutes: 30,
    delayMode: "relative",
    // 默认给「一小时后」，而不是今天某个可能已经过去的钟点
    runAtLocal: toLocalInput(Date.now() + 3_600_000),
    recurring: true,
    maxRuns: 1,
  };
}

const DEFAULT_DRAFT = createDefaultDraft();

/** 规则 → 表单草稿（编辑预填）。「N 分钟后」与「指定时刻」两种一次性各自还原。 */
function draftOf(a: Automation): BuilderDraft {
  const rule = a.rule;
  const time = `${pad(rule.hour)}:${pad(rule.minute)}`;
  const oneShot = a.recurring === false && (a.maxRuns ?? 1) <= 1;
  // 绝对时刻优先判定：它和相对延迟共用 custom/minutes 形态，
  // 先认 anchorAt 会把「10-20 15:09」还原成「1 分钟后」——正是要修的那个毛病
  if (oneShot && rule.runAt !== undefined) {
    return {
      ...DEFAULT_DRAFT,
      freq: "delay",
      delayMode: "absolute",
      runAtLocal: toLocalInput(rule.runAt),
      recurring: false,
      maxRuns: a.maxRuns ?? 1,
    };
  }
  if (oneShot && rule.frequency === "custom" && rule.unit === "minutes" && rule.anchorAt !== undefined) {
    return {
      ...DEFAULT_DRAFT,
      freq: "delay",
      delayMode: "relative",
      delayMinutes: Math.max(1, rule.interval ?? 1),
      recurring: false,
      maxRuns: a.maxRuns ?? 1,
    };
  }
  const freq: FreqTab = rule.frequency === "custom" ? "custom" : rule.frequency;
  return {
    ...DEFAULT_DRAFT,
    freq,
    time,
    weekdays: [...rule.weekdays],
    dayOfMonth: rule.dayOfMonth,
    interval: rule.interval ?? 30,
    unit: rule.unit ?? "minutes",
    recurring: a.recurring !== false,
    maxRuns: a.maxRuns ?? 1,
  };
}

/** 除锚点外的规则内容（保留策略已由 scheduleTouched 承担，此比较器不再需要） */

/** bot.json 里存的是裸执行器 id；主绑定的优先 */
function unitRuntimeId(u: { readonly bindings: readonly { readonly runtimeId: string; readonly primary: boolean }[] } | undefined): string {
  const primary = u?.bindings.find((b) => b.primary) ?? u?.bindings[0];
  return (primary?.runtimeId ?? "").replace(/^daemon:/, "");
}

export function AutomationDialog({
  initial,
  prefill,
  onClose,
}: {
  initial: Automation | null;
  prefill?: AutomationDialogPrefill;
  onClose: () => void;
}) {
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);
  const createAutomationAction = useWorkbench((s) => s.createAutomationAction);
  const updateAutomationAction = useWorkbench((s) => s.updateAutomationAction);

  const [name, setName] = useState(initial?.name ?? prefill?.name ?? "");
  const [unitId, setUnitId] = useState(initial?.unitId ?? (units[0]?.id ?? ""));
  const [runtimeBare, setRuntimeBare] = useState(
    initial?.runtimeId ?? unitRuntimeId(units[0]),
  );
  const [prompt, setPrompt] = useState(initial?.description ?? prefill?.prompt ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [mode, setMode] = useState(initial?.mode ?? "");
  // 新建默认「对话页」；编辑沿用定义行的值（旧行缺省按 terminal 读，映射层已归一）
  const [launchMode, setLaunchMode] = useState<"terminal" | "chat" | "headless">(initial?.launchMode ?? "chat");
  const [dispatchTarget, setDispatchTarget] = useState<DispatchTarget>(initial?.dispatchTarget === "existing_session" ? "existing_session" : "new_session");
  /** 定时发送的收件对话：空串 = 发火时自动挑最近一个能接回来的 */
  const [targetSessionId, setTargetSessionId] = useState<string>(initial?.targetSessionId ?? "");
  const [resumable, setResumable] = useState<readonly ResumableSession[]>([]);
  const [resumableLoading, setResumableLoading] = useState(false);
  const [draft, setDraft] = useState<BuilderDraft>(() =>
    initial !== null
      ? draftOf(initial)
      : prefill !== undefined
        ? {
            ...DEFAULT_DRAFT,
            freq: prefill.freq,
            ...(prefill.time !== undefined ? { time: prefill.time } : {}),
            ...(prefill.weekdays !== undefined ? { weekdays: [...prefill.weekdays] } : {}),
            ...(prefill.interval !== undefined ? { interval: prefill.interval } : {}),
            ...(prefill.unit !== undefined ? { unit: prefill.unit } : {}),
          }
        : DEFAULT_DRAFT,
  );
  /** 编辑时碰过调度控件没有。没碰过 = 提交时原样保留旧调度（见 submit），表单的还原是近似的，不能拿来改写用户的原表达式 */
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const unit = units.find((u) => u.id === unitId);
  const rootPath = unit?.rootPath ?? "";

  // 保存时真正要发的时间粒度（预览 cron 用）
  const patch = (p: Partial<BuilderDraft>): void => setDraft((d) => ({ ...d, ...p }));

  /** 调度字段专用：任何一碰就意味着「用户要改调度」，提交时不再保留旧 cron/锚点 */
  const patchSchedule = (p: Partial<BuilderDraft>): void => {
    setScheduleTouched(true);
    setDraft((d) => ({ ...d, ...p }));
  };

  const namespacedRuntime = `daemon:${runtimeBare}`;

  // 「发到已有对话」要能选**具体哪个**对话：只写「已有对话」等于让用户猜，
  // 而发火时才自动挑的那条，未必是他以为的那个。执行器变了必须重拉 ——
  // 会话是执行器私有的，跨执行器的 id 根本接不回来。
  useEffect(() => {
    if (dispatchTarget !== "existing_session") return;
    let cancelled = false;
    setResumableLoading(true);
    void fetchResumableSessions({ runtimeId: runtimeBare, limit: 20 })
      .then((list) => {
        if (!cancelled) setResumable(list);
      })
      .catch(() => {
        if (!cancelled) setResumable([]);
      })
      .finally(() => {
        if (!cancelled) setResumableLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatchTarget, runtimeBare]);

  // 由草稿构规则（不含 anchorAt —— 提交时按锚点策略补）
  const ruleFromDraft = useMemo((): ScheduleRule | null => {
    const parts = draft.time.split(":");
    const hh = Number.parseInt(parts[0] ?? "", 10);
    const mm = Number.parseInt(parts[1] ?? "", 10);
    const hour = Number.isFinite(hh) ? Math.min(23, Math.max(0, hh)) : 9;
    const minute = Number.isFinite(mm) ? Math.min(59, Math.max(0, mm)) : 0;
    switch (draft.freq) {
      case "delay":
        return null;
      case "hourly":
        return { frequency: "hourly", hour, minute, weekdays: [], dayOfMonth: 1 };
      case "daily":
        return { frequency: "daily", hour, minute, weekdays: [], dayOfMonth: 1 };
      case "weekly":
        return { frequency: "weekly", hour, minute, weekdays: [...draft.weekdays].sort((a, b) => a - b), dayOfMonth: 1 };
      case "monthly":
        return { frequency: "monthly", hour, minute, weekdays: [], dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)) };
      case "custom":
        return {
          frequency: "custom",
          interval: Math.max(1, Math.round(draft.interval)),
          unit: draft.unit,
          hour,
          minute,
          weekdays: [],
          dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)),
        };
    }
  }, [draft]);

  const previewCron = useMemo(() => {
    if (draft.freq === "delay") return `${Math.max(1, Math.round(draft.delayMinutes))} 分钟后跑一次`;
    if (ruleFromDraft === null) return "";
    return scheduleRuleToCron(ruleFromDraft);
  }, [draft, ruleFromDraft]);

  const submit = async (): Promise<void> => {
    if (submitting) return; // 防双击双发
    if (unit === undefined) {
      setErr("先选一个归属单元（bot）—— 自动化是替它跑的");
      return;
    }
    if (name.trim() === "") {
      setErr("取个名字");
      return;
    }
    if (prompt.trim() === "") {
      setErr("提示词不能为空 —— 到点后原样发给执行器");
      return;
    }
    if (draft.freq === "weekly" && draft.weekdays.length === 0) {
      setErr("每周任务至少选一个星期（不选按周一算）");
      return;
    }
    // 绝对时刻要在提交前自己拦一道：daemon 也会拒，但那时用户已经填了一堆别的，
    // 只回一句「runAt 已经是过去时间」很难对应到哪个框
    let runAt: number | null = null;
    if (draft.freq === "delay" && draft.delayMode === "absolute") {
      const parsed = fromLocalInput(draft.runAtLocal);
      if (parsed === null) {
        setErr("指定时间还没填好");
        return;
      }
      runAt = floorToMinute(parsed);
      if (runAt <= Date.now()) {
        setErr("指定的时间已经过去了 —— 挑一个将来的时刻");
        return;
      }
    }

    // 调度保留策略（编辑且没碰调度控件时，原样回传 daemon 的权威调度）：
    // - 纯 cron 行：回传 cron 原文。表单的 ruleFromCron 是近似还原（复杂表达式直接
    //   还原不出），拿它落库 = 静默把用户的调度改写成另一回事。
    // - 规则行：回传旧规则对象（含锚点）。改个名字不该重置「每 30 分钟」的相位，
    //   更不该把「N 分钟后」的触发时刻推走。
    const touched = initial === null || scheduleTouched;
    let scheduleRule: ScheduleRule | null = ruleFromDraft;
    let cronPassthrough: string | undefined;
    if (!touched) {
      if (initial.scheduleSource === "cron" && typeof initial.cron === "string" && initial.cron !== "") {
        cronPassthrough = initial.cron;
        scheduleRule = null;
      } else {
        scheduleRule = initial.rule;
      }
    }

    const input: AutomationWriteInput = {
      name: name.trim(),
      unitId: unit.id,
      unitName: unit.name,
      runtimeId: runtimeBare,
      rootPath,
      prompt: prompt.trim(),
      model: model === "" ? null : model,
      mode: mode === "" ? null : mode,
      recurring: draft.freq === "delay" ? false : draft.recurring,
      // delay 分支不发 maxRuns：delayMinutes 本身就定性一次性（跑一次收口），
      // 后端 create 明确拒绝「delayMinutes + maxRuns」组合，带上就是必报错
      maxRuns: draft.freq === "delay" ? undefined : (draft.recurring ? null : Math.max(1, Math.round(draft.maxRuns))),
      // 已有对话不认 TUI（终端不是收件对象）：terminal 兜底归一成 chat
      launchMode: dispatchTarget === "existing_session" ? (launchMode === "headless" ? "headless" : "chat") : launchMode,
      dispatchTarget,
      // 留空 = 发火时自动挑该执行器最近一个能接回来的对话（daemon 侧回退）。
      // 选了具体某个就钉死它 —— 用户能看见选了谁，才可能发现选错了。
      targetSessionId: dispatchTarget === "existing_session" && targetSessionId !== "" ? targetSessionId : null,
      // runAt / delayMinutes 只在「碰过调度」时发；没碰就靠上面的 scheduleRule
      // 原样回传（回传里带着 runAt，daemon 认得）
      ...(touched && draft.freq === "delay"
        ? draft.delayMode === "absolute"
          ? { runAt: runAt ?? undefined }
          : { delayMinutes: Math.max(1, Math.round(draft.delayMinutes)) }
        : {}),
      ...(scheduleRule !== null ? { scheduleRule } : {}),
      ...(cronPassthrough !== undefined ? { cron: cronPassthrough } : {}),
    };
    setSubmitting(true);
    setErr(null);
    const ok = initial === null ? await createAutomationAction(input) : await updateAutomationAction(initial.id, input);
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initial === null ? "新建自动化" : "编辑自动化"}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <CalendarClock size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">{initial === null ? "新建自动化" : "编辑自动化"}</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Field label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：每日依赖巡检"
              className={inputCls}
            />
          </Field>

          <Field label="归属单元" hint="到点后替它跑（用它的身份与工作目录）">
            {units.length === 0 ? (
              <p className="rounded-input bg-rail px-2.5 py-2 text-caption text-loss">
                还没有任何 bot —— 先在侧栏新建一个，再回来建自动化
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

          <Field label="执行器" hint="host 侧注册的裸 id（zcode / codex / claude …）">
            <select value={runtimeBare} onChange={(e) => setRuntimeBare(e.target.value)} className={inputCls}>
              {runtimes.map((r) => (
                <option key={r.id} value={r.id.replace(/^daemon:/, "")}>
                  {r.presentation.displayName}
                </option>
              ))}
              {runtimes.length === 0 && <option value={runtimeBare}>{runtimeBare || "（无可用执行器）"}</option>}
            </select>
          </Field>

          <Field label="发到哪里" hint={DISPATCH_TARGET_OPTIONS.find((m) => m.id === dispatchTarget)?.hint}>
            <select
              value={dispatchTarget}
              onChange={(e) => {
                const next = e.target.value === "existing_session" ? "existing_session" : "new_session";
                setDispatchTarget(next);
                // 往老对话发不认 TUI（终端不是收件对象）：切过来时把 terminal 归一成 chat，
                // 执行方式控件才不会出现「选了个发不出去的值」
                if (next === "existing_session" && launchMode === "terminal") setLaunchMode("chat");
              }}
              className={inputCls}
            >
              {DISPATCH_TARGET_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          {/* 选了「已有对话」就必须能选具体是哪个 —— 否则「已有对话」等于「猜一个」 */}
          {dispatchTarget === "existing_session" && (
            <Field
              label="发到哪个对话"
              hint={
                resumable.length === 0 && !resumableLoading
                  ? `${runtimeBare} 还没有能续接的对话（只有跑过至少一轮、执行器留了引用的才能续）`
                  : "列表均为对话页会话（终端 TUI 不是定时收件对象）；已结束的会自动接回来"
              }
            >
              {resumableLoading ? (
                <div className="rounded-input bg-rail px-2.5 py-2 text-caption text-ash">正在读取可续接的对话…</div>
              ) : resumable.length === 0 ? (
                <div className="rounded-input bg-rail px-2.5 py-2 text-caption text-loss">
                  没有可选的对话 —— 到点会退回「新开会话」
                </div>
              ) : (
                <select
                  value={targetSessionId}
                  onChange={(e) => setTargetSessionId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">自动选最近一个能续接的（推荐）</option>
                  {resumable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {/* 来源跟着条目走：自动化的、飞书的、工作台手开的对话在这里长得一样，
                          不标出来用户只能靠标题猜这条是谁家的 */}
                      [{SESSION_SOURCE_LABEL[(s.source ?? "workbench") as SessionSource] ?? s.source}]{" "}
                      {s.title !== "" ? s.title : s.id}
                      {s.endedAt === null ? " · 运行中" : ""} ·{" "}
                      {new Date(s.lastActiveAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          {/* 执行方式两个目标都要有：新对话 = 怎么起（TUI / 对话页 / 纯后台），
              已有对话 = 到点要不要把那个对话拉到前台（TUI 不是收件对象） */}
          {dispatchTarget === "new_session" ? (
            <Field label="执行方式" hint={LAUNCH_MODE_OPTIONS.find((m) => m.id === launchMode)?.hint}>
              <select
                value={launchMode}
                onChange={(e) => {
                  const v = e.target.value;
                  setLaunchMode(v === "terminal" || v === "chat" || v === "headless" ? v : "chat");
                }}
                className={inputCls}
              >
                {LAUNCH_MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label="执行方式"
              hint={EXISTING_LAUNCH_MODE_OPTIONS.find((m) => m.id === (launchMode === "headless" ? "headless" : "chat"))?.hint}
            >
              <select
                value={launchMode === "headless" ? "headless" : "chat"}
                onChange={(e) => setLaunchMode(e.target.value === "headless" ? "headless" : "chat")}
                className={inputCls}
              >
                {EXISTING_LAUNCH_MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label="提示词"
            hint={
              dispatchTarget === "existing_session"
                ? "到点后原样发进那个老对话里 —— 写清最终要做什么，运行期间无人回答问题"
                : "到点后原样发给执行器 —— 自包含、直接描述最终工作；无人值守运行，别要求它再建定时任务"
            }
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="例如：检查 pnpm 依赖有没有新版本与安全告警，写一份摘要到 docs/"
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </Field>

          <Field label="重复规则" hint={`落库口径：${previewCron}`}>
            <div className="space-y-2.5">
              <div className="flex flex-wrap gap-1">
                {FREQ_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => patchSchedule({ freq: t.id })}
                    className={cn(
                      "rounded-chip px-2.5 py-1 text-caption transition",
                      draft.freq === t.id ? "bg-teal-tint font-medium text-teal" : "text-ash hover:bg-line-soft hover:text-graphite",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {draft.freq === "delay" && (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        { id: "relative", label: "多少分钟后" },
                        { id: "absolute", label: "指定到某个时刻" },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          if (m.id !== "absolute") {
                            patchSchedule({ delayMode: m.id });
                            return;
                          }
                          // 预填值是模块加载时算的，页面开久了已是过去时 ——
                          // 切到「指定时刻」时给个一定可用的「一小时后」，别让人先撞一次校验
                          const parsed = fromLocalInput(draft.runAtLocal);
                          patchSchedule(
                            parsed === null || parsed <= Date.now()
                              ? { delayMode: m.id, runAtLocal: toLocalInput(Date.now() + 3_600_000) }
                              : { delayMode: m.id },
                          );
                        }}
                        className={cn(
                          "rounded-chip px-2.5 py-1 text-caption transition",
                          draft.delayMode === m.id ? "bg-teal-tint font-medium text-teal" : "text-ash hover:bg-line-soft hover:text-graphite",
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {draft.delayMode === "relative" ? (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>现在起</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.delayMinutes}
                        onChange={(e) => patchSchedule({ delayMinutes: Number(e.target.value) })}
                        className={cn(inputCls, "w-24")}
                      />
                      <span>分钟后跑一次（以 daemon 时钟为锚，跑完即停）</span>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-body-sm text-graphite">
                        <span>到</span>
                        <input
                          type="datetime-local"
                          value={draft.runAtLocal}
                          min={toLocalInput(Date.now())}
                          onChange={(e) => patchSchedule({ runAtLocal: e.target.value })}
                          className={cn(inputCls, "w-56")}
                        />
                        <span>跑一次（到点即发，跑完即停）</span>
                      </div>
                      {/* 绝对时刻的意义就在这行：不用反推「3 小时后」到底是几点 */}
                      <p className="text-caption text-ash">
                        {(() => {
                          const t = fromLocalInput(draft.runAtLocal);
                          if (t === null) return "时间还没填好";
                          return `将于 ${new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 发出（${formatAbsoluteHuman(t)}，${formatRelative(t)}）`;
                        })()}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {draft.freq !== "delay" && (
                <>
                  {draft.freq !== "hourly" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>触发时刻</span>
                      <input
                        type="time"
                        value={draft.time}
                        onChange={(e) => patchSchedule({ time: e.target.value })}
                        className={cn(inputCls, "w-32")}
                      />
                    </div>
                  )}
                  {draft.freq === "weekly" && (
                    <div className="flex flex-wrap items-center gap-1">
                      {WEEKDAY_ZH.map((label, d) => {
                        const on = draft.weekdays.includes(d as Weekday);
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patchSchedule({
                                weekdays: on
                                  ? draft.weekdays.filter((x) => x !== d)
                                  : [...draft.weekdays, d as Weekday].sort((a, b) => a - b),
                              })
                            }
                            className={cn(
                              "h-7 w-7 rounded-full text-caption transition",
                              on ? "bg-teal text-canvas" : "bg-line-soft text-ash hover:text-graphite",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {draft.freq === "monthly" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>每月</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={draft.dayOfMonth}
                        onChange={(e) => patchSchedule({ dayOfMonth: Number(e.target.value) })}
                        className={cn(inputCls, "w-24")}
                      />
                      <span>日（当月没有这天就跳过）</span>
                    </div>
                  )}
                  {draft.freq === "custom" && (
                    <div className="flex items-center gap-2 text-body-sm text-graphite">
                      <span>每</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.interval}
                        onChange={(e) => patchSchedule({ interval: Number(e.target.value) })}
                        className={cn(inputCls, "w-20")}
                      />
                      <select
                        value={draft.unit}
                        onChange={(e) => patchSchedule({ unit: e.target.value as BuilderDraft["unit"] })}
                        className={cn(inputCls, "w-28")}
                      >
                        {UNIT_OPTIONS.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      {draft.unit !== "minutes" && <span>的 {draft.time} 触发</span>}
                    </div>
                  )}

                  <div className="flex items-center gap-4 pt-1">
                    <label className="flex cursor-pointer items-center gap-1.5 text-body-sm text-graphite">
                      <input
                        type="checkbox"
                        checked={draft.recurring}
                        onChange={(e) => patch({ recurring: e.target.checked })}
                        className="accent-teal"
                      />
                      循环执行
                    </label>
                    {!draft.recurring && (
                      <label className="flex items-center gap-1.5 text-body-sm text-graphite">
                        跑
                        <input
                          type="number"
                          min={1}
                          value={draft.maxRuns}
                          onChange={(e) => patch({ maxRuns: Number(e.target.value) })}
                          className={cn(inputCls, "w-20")}
                        />
                        次后停
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="模型" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 里可自行切换）" : "可选，缺省跟随执行器默认"}>
              <ModelSelect
                runtimeId={namespacedRuntime}
                value={model}
                onChange={setModel}
                className={inputCls}
              />
            </Field>
            <Field label="权限模式" hint={launchMode === "terminal" ? "仅纯后台模式生效（TUI 默认免审批）" : "到点的会话以此模式起"}>
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
                {MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {err !== null && (
            <p className="rounded-btn bg-loss/5 px-2.5 py-2 text-caption text-loss">{err}</p>
          )}
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
