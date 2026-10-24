/**
 * 自动化 / 定时任务 —— bot模式的时间维度。
 *
 * 设计对齐 ZCode 的 automation 模型：
 * **权威数据是结构化 scheduleRule，不是裸 cron 字符串。**
 * cron 只在「自定义」时作为兜底展示，因为纯解析 cron 会把
 * 「每 30 个月」误显成「每月」、把一次性的「4 分钟后」误显成「每 4 分钟」。
 */

// ---------------------------------------------------------------------------
// 频率
// ---------------------------------------------------------------------------

export type Frequency = "hourly" | "daily" | "weekly" | "monthly" | "custom";

/** 每周的星期，0=周日 … 6=周六 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ScheduleRule {
  readonly frequency: Frequency;
  /** daily / custom 时的触发时刻 */
  readonly hour: number;
  readonly minute: number;
  /** weekly 时生效的星期 */
  readonly weekdays: readonly Weekday[];
  /** monthly 时生效的日 */
  readonly dayOfMonth: number;
  /** custom 时：间隔数 + 单位 */
  readonly interval?: number;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | "months";
  /** custom 时的原始 cron 表达式 */
  readonly rawExpr?: string;
  /** 相对锚点，用于「4 分钟后」这类一次性任务 */
  readonly anchorAt?: number;
  /**
   * **绝对时刻**的一次性任务：到 `2026-10-20 15:09` 只跑这一次。
   *
   * 为什么单列而不靠 anchorAt + interval 表达：锚点步进是「anchorAt + k·间隔」，
   * 推出来的永远是一串等间隔时刻，既写不出「10-20 那天」，写出来了界面也只能
   * 显示成「N 分钟后」—— 用户判断不了那到底是几点。用量恢复续跑尤其吃亏：
   * 恢复时刻是探针读出来的**确切时间**，却被迫换算成分钟数再让人反推。
   * 有这个字段就直接对着墙钟落点，不必反推。
   */
  readonly runAt?: number;
}

export type RunStatus = "idle" | "running" | "completed" | "failed" | "paused";

/**
 * 到点之后把消息投到哪里。
 *
 * - `new_session`：新开一个会话把 prompt 当首轮发出去（历史行为，缺省）
 * - `existing_session`：往 `targetSessionId` 那个已有对话里续发一条消息 ——
 *   会话死了先 resume 再发，上下文原地接上，不重开对话。
 *
 * 这就是「定时发送」的全部口径：新对话还是老对话，二选一。
 */
export type DispatchTarget = "new_session" | "existing_session";

/**
 * 执行方式三形态（自动化与待办共用；docs/23）：
 * - `terminal`：到点在前端 PTY 里拉执行器 TUI 本尊（免审批），人可看可插手
 * - `chat`：到点走 headless 派发 + 广播 `session.foreground` 把前端拉到该会话 ——
 *   对话开在主聊天页前台，可看可插话（steer 队列天然支持），GUI 原生形态
 * - `headless`：纯后台 host 会话，不拉前台（历史/任务栏/监控里事后可看）
 */
export type LaunchMode = "terminal" | "chat" | "headless";


export interface AutomationRun {
  readonly startedAt: number;
  readonly endedAt?: number;
  /** skipped = 错过窗口被跳过（misfire 不补跑）——它没真的跑过，徽章上不能算「运行中」 */
  readonly status: "running" | "completed" | "failed" | "skipped";
  readonly summary?: string;
  /** headless run 的会话 id（事件账本可回放，一键开监控用）；TUI run 是 autoterm_ 前缀的终端 id */
  readonly sessionId?: string | null;
}

export interface Automation {
  readonly id: string;
  readonly name: string;
  /** 关联的工作单元 id —— bot模式下自动化是「谁」在干活 */
  readonly unitId: string;
  /** 单元名冗余存一份：合成单元（如用量续跑的 quota:<runtime>）在 units 里查不到，
   *  只靠 unitId 去查会在界面上显示成「—」 */
  readonly unitName?: string;
  readonly description?: string;
  /** 跑这条自动化的执行器 */
  readonly runtimeId: string;
  readonly rule: ScheduleRule;
  readonly enabled: boolean;
  /** 一次性任务跑完即停 */
  readonly recurring: boolean;
  readonly maxRuns?: number;
  /** 累计已发火次数（含手动，ZCode「Ran N times」口径；与 maxRuns 分母分离） */
  readonly runCount?: number;
  readonly runs: readonly AutomationRun[];
  /** 跑出来的产出，指向 deliverables */
  readonly deliverableIds: readonly string[];
  readonly createdAt: number;
  /** 到点会话用的模型（null/缺省 = 跟随执行器默认） */
  readonly model?: string | null;
  /** 到点会话的权限模式（缺省 = 执行器默认） */
  readonly mode?: string | null;
  /** daemon 权威行上的 cron 原文（兼容展示；scheduleSource="cron" 时编辑未动调度要原样回传） */
  readonly cron?: string;
  /** 执行方式（缺省 = terminal）：terminal / chat（对话页前台）/ headless（纯后台），见 LaunchMode */
  readonly launchMode?: LaunchMode;
  /** 到点把消息投到哪里（缺省 = new_session，与 v2 旧行一致） */
  readonly dispatchTarget?: DispatchTarget;
  /** dispatchTarget=existing_session 时的收件对话 id */
  readonly targetSessionId?: string | null;
  /**
   * 这条自动化是哪来的：manual = 用户手建；quota_resume = 用量耗尽自动排的续跑。
   * 自动排的那条要在卡片上说明白「为什么会有这条」，否则用户以为是自己建的。
   */
  readonly origin?: "manual" | "quota_resume";
  /** 调度权威来源：rule = scheduleRule；cron = 纯 cron 行（表单的规则还原能力有限，不能拿来改写它） */
  readonly scheduleSource?: "rule" | "cron";
  /**
   * daemon 持久化的下次触发时间（权威值）。有它显示就用它，
   * 没有再退回 nextRunAt() 本地预估 —— 两边共用一个引擎，通常一致。
   */
  readonly nextRunAt?: number;
  /** 最近一次失败会一直挂着徽章，不被后续成功覆盖 —— 对齐 ZCode 的 hasAutomationFailureState */
  readonly lastFailure?: { at: number; reason: string };
}

// ---------------------------------------------------------------------------
// 人类可读描述 —— 对齐 ZCode 的 describeCron / describeCronBuilder
// ---------------------------------------------------------------------------

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** 「08:30」 */
export function formatClock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * 绝对时刻 → 「10-16 15:09」。
 *
 * 一次性任务**必须**给人看这个，只给「3 小时后」等于让人反推 ——
 * 反推不出来的那半小时就会变成「它到底几点跑」的疑问。用量恢复续跑
 * 尤其如此：恢复时刻本来就是探针读出来的确切时间，没道理藏成一个分钟数。
 */
export function formatAbsolute(target: number): string {
  const d = new Date(target);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「今天 15:09」/「明天 09:00」/「10-20 15:09」—— 近的带上星期几式称呼 */
export function formatAbsoluteHuman(target: number, from = Date.now()): string {
  const d = new Date(target);
  const dayMs = 86_400_000;
  const startOfDay = (t: number): number => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const diffDays = Math.round((startOfDay(target) - startOfDay(from)) / dayMs);
  if (diffDays === 0) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diffDays === 1) return `明天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return formatAbsolute(target);
}

/** 频率描述，不含时刻 —— 对齐 ZCode 的 describeCronBuilder 输出形态 */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.frequency) {
    case "hourly":
      return "每小时";
    case "daily":
      return "每天";
    case "weekly": {
      if (rule.weekdays.length === 0) return "每周";
      if (rule.weekdays.length === 7) return "每天";
      if (isConsecutiveDays(rule.weekdays)) {
        const [a, b] = [rule.weekdays[0]!, rule.weekdays.at(-1)!];
        return `每${WEEKDAY_ZH[a]}至${WEEKDAY_ZH[b]}`;
      }
      return `每${rule.weekdays.map((d) => WEEKDAY_ZH[d]).join("、")}`;
    }
    case "monthly":
      return rule.dayOfMonth === 1 ? "每月" : `每月 ${rule.dayOfMonth} 日`;
    case "custom": {
      const n = rule.interval ?? 1;
      if (!rule.unit) return "自定义";
      const unitZh = {
        minutes: "分钟",
        hours: "小时",
        days: "天",
        weeks: "周",
        months: "个月",
      }[rule.unit];
      return n === 1 ? `每${unitZh}` : `每 ${n} ${unitZh}`;
    }
  }
}

function isConsecutiveDays(days: readonly Weekday[]): boolean {
  if (days.length < 2) return false;
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
}

/** 完整的一行描述：频率 + 时刻。对齐 ZCode 卡片上的 schedule 文案 */
export function describeSchedule(a: Pick<Automation, "rule" | "recurring" | "maxRuns">): string {
  // 一次性任务没有频率，真实时机由「下次运行」承载 —— 对齐 ZCode 的处理。
  // 但绝对时刻是用户直接给的落点，值得写进频率徽章里当标题用。
  if (a.recurring === false && (a.maxRuns ?? 1) <= 1) {
    return a.rule.runAt !== undefined ? `一次性 · ${formatAbsolute(a.rule.runAt)}` : "自定义";
  }
  const { rule } = a;
  if (rule.frequency === "hourly") return describeRule(rule);
  if (rule.frequency === "weekly" && rule.weekdays.length === 0) return describeRule(rule);
  return `${describeRule(rule)} ${formatClock(rule.hour, rule.minute)}`;
}

// ---------------------------------------------------------------------------
// 权威调度引擎 —— daemon（backend/src）与 UI 共用这一份（同 units.ts 的共享方式）
// ---------------------------------------------------------------------------

/**
 * ScheduleRule → 5 段 cron（本地时区）。
 *
 * cron 只是**兼容展示与兜底**，不是调度依据 —— 「每 30 个月」这类超出 cron
 * 字段上限的间隔在 cron 里写不出真值。custom/weeks 干脆没有 cron 语义，
 * 落一个每日占位表达式：有 scheduleRule 的地方调度永远走 rule（见
 * computeScheduleNextRunAt），这个占位只在「rule 丢失」的极端兜底里被读到。
 */
export function scheduleRuleToCron(rule: ScheduleRule): string {
  // 绝对时刻：cron 表达不了「某年某月某日」，落一个「每天 HH:MM」占位。
  // 调度永远走 rule（有 runAt 的行 computeScheduleNextRunAt 直接返回它），
  // 这个占位只喂给「rule 丢失」的极端降级与界面展示。
  if (rule.runAt !== undefined) {
    const d = new Date(rule.runAt);
    return `${d.getMinutes()} ${d.getHours()} * * *`;
  }
  const m = Math.min(59, Math.max(0, Math.round(rule.minute)));
  const h = Math.min(23, Math.max(0, Math.round(rule.hour)));
  const day = Math.min(31, Math.max(1, Math.round(rule.dayOfMonth)));
  switch (rule.frequency) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly": {
      const days = rule.weekdays.length > 0 ? [...rule.weekdays].sort((a, b) => a - b).join(",") : "*";
      return `${m} ${h} * * ${days}`;
    }
    case "monthly":
      return `${m} ${h} ${day} * *`;
    case "custom": {
      const n = Math.max(1, Math.round(rule.interval ?? 1));
      switch (rule.unit) {
        case "minutes":
          return `*/${n} * * * *`;
        case "hours":
          return `${m} */${n} * * *`;
        case "days":
          return `${m} ${h} */${n} * *`;
        case "weeks":
          return `${m} ${h} * * *`; // cron 表达不了「每 N 周」，占位；调度走 rule
        case "months":
          return `${m} ${h} ${day} */${n} *`;
        default:
          return `${m} ${h} * * *`;
      }
    }
  }
}

/**
 * 规则的下一次触发点（严格大于 from；无解返回 null）。本地时区。
 *
 * 锚点推进口径（对齐 ZCode automationCron.ts）：
 * - **分钟 / 小时间隔从 anchorAt 推导**（anchorAt + k·step），不与墙钟刻度对齐。
 *   首次触发 = anchorAt + step（「4 分钟后」就是 4 分钟后，不是立刻也不吃墙钟整分）；
 *   scheduler 晚醒一拍也不会像 cron 的星号斜杠步进那样逐轮累积漂移。
 * - 日历类（daily/weekly/monthly 与 custom 的天以上单位）从锚点日起逐格推进，
 *   weekly 空星期按周一算（历史上空数组导致 nextRunAt 恒 null 的坑），
 *   monthly 溢出月（2 月 31 日）跳过。
 */
export function computeScheduleNextRunAt(rule: ScheduleRule, from = Date.now()): number | null {
  // 绝对时刻优先于一切日历推进行为：它是用户/探针给的**确切落点**，
  // 任何推演都只会把它改掉。已经过去就返回 null（不静默顺延到下一次）。
  if (rule.runAt !== undefined) return rule.runAt > from ? rule.runAt : null;

  const anchor = rule.anchorAt ?? from;

  // 分钟 / 小时：锚点推进
  if (rule.frequency === "hourly" || (rule.frequency === "custom" && rule.unit === "hours")) {
    const n = rule.frequency === "hourly" ? 1 : Math.max(1, Math.round(rule.interval ?? 1));
    const step = n * 3_600_000;
    const k = Math.max(1, Math.floor((from - anchor) / step) + 1);
    return anchor + k * step;
  }
  if (rule.frequency === "custom" && rule.unit === "minutes") {
    const step = Math.max(1, Math.round(rule.interval ?? 1)) * 60_000;
    const k = Math.max(1, Math.floor((from - anchor) / step) + 1);
    return anchor + k * step;
  }

  const at = (y: number, mo: number, d: number): number =>
    new Date(y, mo, d, Math.min(23, Math.max(0, Math.round(rule.hour))), Math.min(59, Math.max(0, Math.round(rule.minute))), 0, 0).getTime();

  // 月推进（monthly / custom months）：跳过溢出月
  if (rule.frequency === "monthly" || (rule.frequency === "custom" && rule.unit === "months")) {
    const n = rule.frequency === "monthly" ? 1 : Math.max(1, Math.round(rule.interval ?? 1));
    const day = Math.min(31, Math.max(1, Math.round(rule.dayOfMonth)));
    const a = new Date(anchor);
    let y = a.getFullYear();
    let mo = a.getMonth();
    for (let i = 0; i < 1200; i += n) {
      const t = at(y, mo, day);
      // getMonth() 回读能查出「这个月没有这一天」（溢出会滚到下个月）
      if (new Date(y, mo, day).getMonth() === mo && t > from) return t;
      mo += n;
      y += Math.floor(mo / 12);
      mo %= 12;
    }
    return null;
  }

  // 日推进：daily / weekly / custom days|weeks
  const dayStep = (() => {
    if (rule.frequency === "daily") return 1;
    if (rule.frequency === "weekly") return 1;
    if (rule.frequency === "custom") {
      const n = Math.max(1, Math.round(rule.interval ?? 1));
      if (rule.unit === "days") return n;
      if (rule.unit === "weeks") return n * 7;
    }
    return 1; // 兜底：未知形态按每天推
  })();
  // 没选具体星期时按周一算 —— 空数组若设为 null 会误匹配所有日期（变成每天），空数组不匹配则会恒为 null
  const weeklyDays = rule.frequency === "weekly" ? (rule.weekdays.length > 0 ? rule.weekdays : [1 as Weekday]) : null;

  const a = new Date(anchor);
  let y = a.getFullYear();
  let mo = a.getMonth();
  let d = a.getDate();
  for (let i = 0; i < 800; i++) {
    const dayOk = weeklyDays === null || weeklyDays.includes(new Date(y, mo, d).getDay() as Weekday);
    if (dayOk) {
      const t = at(y, mo, d);
      if (t > from) return t;
    }
    d += dayStep;
    // 归一化溢出（Date 构造器自己会滚，但 y/mo 要跟着读回来）
    const norm = new Date(y, mo, d);
    y = norm.getFullYear();
    mo = norm.getMonth();
    d = norm.getDate();
  }
  return null;
}

/**
 * 「N 分钟后」一次性任务 —— 以服务端真实时钟为锚点的相对规则。
 *
 * 相对表达绝不让调用方自己换算绝对时间：两边时钟差一分钟就是差一次触发。
 * recurring=false + maxRuns=1 的终态由调度器在首次发火后收口。
 */
export function buildRelativeDelaySchedule(delayMinutes: number, from = Date.now()): ScheduleRule {
  const target = new Date(from + delayMinutes * 60_000);
  return {
    frequency: "custom",
    hour: target.getHours(),
    minute: target.getMinutes(),
    weekdays: [],
    dayOfMonth: 1,
    interval: Math.max(1, Math.round(delayMinutes)),
    unit: "minutes",
    anchorAt: from,
  };
}

/**
 * 「2026-10-20 15:09 只跑一次」—— 以**绝对时刻**为锚的一次性规则。
 *
 * 和 buildRelativeDelaySchedule 的分工：前者表达「从现在起 N 分钟」，
 * 那是人自己数的相对量；后者表达一个确切落点。用量恢复续跑属于后者 ——
 * 恢复时刻是探针读出来的确切值，换算成分钟再让人反推是白白增加理解成本。
 *
 * hour/minute 仍按落点填好：scheduleRuleToCron 的占位、以及任何走日历
 * 推进的降级路径都还读它们，不能留 0。
 */
export function buildAbsoluteSchedule(runAt: number): ScheduleRule {
  const target = new Date(runAt);
  return {
    frequency: "custom",
    hour: target.getHours(),
    minute: target.getMinutes(),
    weekdays: [],
    dayOfMonth: target.getDate(),
    interval: 1,
    unit: "minutes",
    runAt,
  };
}

// ---------------------------------------------------------------------------
// cron 兜底解析（仅展示与 rule 缺失时的降级，不是调度依据）
// ---------------------------------------------------------------------------

/** 把 5 段 cron 尽力还原成 ScheduleRule（认不出的形态返回 null，不瞎猜）。 */
export function ruleFromCron(expr: string): ScheduleRule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parse = (field: string, min: number, max: number): { values: number[]; star: boolean; step: number | null } | null => {
    if (field === "*") return { values: [], star: true, step: null };
    const slash = field.indexOf("/");
    const step = slash >= 0 ? Number.parseInt(field.slice(slash + 1), 10) : null;
    const base = slash >= 0 ? field.slice(0, slash) : field;
    const values: number[] = [];
    for (const piece of base.split(",")) {
      const dash = piece.indexOf("-");
      const lo = dash >= 0 ? Number.parseInt(piece.slice(0, dash), 10) : Number.parseInt(piece, 10);
      const hi = dash >= 0 ? Number.parseInt(piece.slice(dash + 1), 10) : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max) return null;
      for (let v = lo; v <= hi; v++) values.push(v);
    }
    if (values.length === 0) return null;
    if (step !== null && (!Number.isFinite(step) || step < 1)) return null;
    return { values, star: false, step };
  };
  const minute = parse(parts[0]!, 0, 59);
  const hour = parse(parts[1]!, 0, 23);
  const dom = parse(parts[2]!, 1, 31);
  const month = parse(parts[3]!, 1, 12);
  const dow = parse(parts[4]!, 0, 7);
  if (minute === null || hour === null || dom === null || month === null || dow === null) return null;
  // 步进/区间形态（*/15、1-5）交给 custom 兜底； month 受限的直接放弃还原
  if (month.star === false) return null;

  const mk = (over: Partial<ScheduleRule>): ScheduleRule => ({
    frequency: "daily",
    hour: hour.values[0] ?? 0,
    minute: minute.values[0] ?? 0,
    weekdays: [],
    dayOfMonth: dom.values[0] ?? 1,
    ...over,
  });

  // */N 分钟
  if (hour.star && dom.star && dow.star && minute.star && minute.step !== null) {
    return mk({ frequency: "custom", interval: minute.step, unit: "minutes" });
  }
  // 每小时（hour=*，分钟为具体值）
  if (hour.star && dom.star && dow.star && minute.star === false && minute.step === null) {
    return mk({ frequency: "hourly" });
  }
  // 固定时刻系列：分钟、小时都必须是具体值
  if (minute.star || hour.star || minute.step !== null || hour.step !== null || minute.values.length !== 1 || hour.values.length !== 1) {
    return mk({ frequency: "custom", interval: 1, unit: "days" });
  }
  if (dom.star && dow.star) return mk({ frequency: "daily" });
  if (dom.star && dow.star === false) {
    return mk({ frequency: "weekly", weekdays: dow.values.map((v) => (v === 7 ? 0 : v)) as Weekday[] });
  }
  if (dom.star === false && dow.star) return mk({ frequency: "monthly", dayOfMonth: dom.values[0]! });
  return mk({ frequency: "custom", interval: 1, unit: "days" });
}

// ---------------------------------------------------------------------------
// 下次运行（UI 预估；权威值由 daemon 持久化的 next_run_at 提供）
// ---------------------------------------------------------------------------

/**
 * 算下一次触发时间。一次性任务用 anchorAt + interval 表达相对时间，不走日历推进。
 * 递归部分统一委托给 computeScheduleNextRunAt —— daemon 调度与卡片预估同一口径，
 * 不会出现「卡片说 9 点、daemon 9 点半才跑」的两套算术。
 */
export function nextRunAt(a: Automation, from = Date.now()): number | null {
  if (!a.enabled) return null;
  if (a.rule.runAt !== undefined) return a.rule.runAt > from ? a.rule.runAt : null;
  if (a.recurring === false && (a.maxRuns ?? 1) <= 1) {
    if (a.runs.length >= (a.maxRuns ?? 1)) return null;
    // 「N 分钟后」形态（custom minutes + 锚点）走引擎：下次 = 锚点 + 间隔，
    // 与 daemon 的首次触发时刻一致；纯 anchorAt（旧数据）原样返回。
    if (a.rule.frequency === "custom" && a.rule.unit === "minutes" && a.rule.anchorAt !== undefined) {
      return computeScheduleNextRunAt(a.rule, from);
    }
    return a.rule.anchorAt ?? null;
  }
  return computeScheduleNextRunAt(a.rule, from);
}

/** 「3 小时后」 / 「2 天前」 —— 对齐 ZCode 的 formatAutomationCardNextRun */
export function formatRelative(target: number, from = Date.now()): string {
  const diff = target - from;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "后" : "前";

  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.round(abs / 3_600_000);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.round(abs / 86_400_000);
  if (day < 30) return `${day} 天${suffix}`;
  return new Date(target).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 卡片状态徽章。
 * 分组口径：**以卡片实际展示的徽章为准** —— 用户看到什么颜色就落在哪一组。
 * 对齐 ZCode 的 automationStatusFilter 注释。
 */
export function resolveStatusKind(a: Automation): "inProgress" | "completed" | "failed" {
  if (a.lastFailure) return "failed";
  const last = a.runs.at(-1);
  if (!last) return "inProgress";
  if (last.status === "completed") return "completed";
  if (last.status === "failed") return "failed";
  return "inProgress";
}

export const STATUS_FILTERS = ["all", "inProgress", "completed", "failed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "全部",
  inProgress: "进行中",
  completed: "已完成",
  failed: "失败",
};

export function filterByStatus(list: readonly Automation[], f: StatusFilter): readonly Automation[] {
  if (f === "all") return list;
  return list.filter((a) => resolveStatusKind(a) === f);
}
