/**
 * 会话状态灯的领域契约 —— 纯函数 + 常量，不碰 React / DOM / store。
 *
 * 2026-11-06 重构（用户定稿「注意力提纯」）：灯只指示「需要你知道的事」，
 * 一个人同时只能跟进 3-5 个会话，灯的带宽必须留给真信号：
 *
 * | 态          | 表现              | 触发                                        |
 * |-------------|-------------------|---------------------------------------------|
 * | none        | 无灯              | 已读已结束的正常会话、空闲存活（idle）       |
 * | unreadDone  | 圆点（默认绿）    | 完成且有新产出、还没看过                     |
 * | attention   | 圆点（默认琥珀）  | 等你交互：问卷 / 决策卡 / 确认请求           |
 * | error       | 圆点（默认红）    | 执行出错 / 非正常退出                        |
 * | running     | 转圈 spinner      | 正在运行                                     |
 *
 * 相对旧模型（蓝呼吸=执行/待决策、浅蓝常驻=存活）的三处语义分野：
 * 1. 存活空闲不再亮灯 —— 常驻灯没有信息量，纯耗注意力；
 * 2. 「正在运行」与「等你交互」拆开 —— 前者不用管，后者必须回来看，
 *    混在一个呼吸灯里恰恰丢掉了最重要的区分；
 * 3. 运行中用 spinner 而非呼吸灯 —— 动画形态本身表达「进行中」，
 *    不再占用灯色语义；灯色因此可以全部开放给用户自定义。
 *
 * 灯色是**用户偏好数据**（有人适应蓝、有人适应橙），存 store/useSessionLights；
 * 本文件只定义色板与默认值，渲染唯一入口在 ui/SessionLightDot.tsx。
 */

/** 灯的五种形态；none = 不渲染 */
export type SessionLightKind = "running" | "attention" | "unreadDone" | "error" | "none";

/** 可配色的四种态（none 没有灯，无可配置） */
export type SessionLightColorState = Exclude<SessionLightKind, "none">;

export const SESSION_LIGHT_COLOR_STATES: readonly SessionLightColorState[] = [
  "running",
  "attention",
  "unreadDone",
  "error",
];

export interface SessionLightPaletteEntry {
  readonly id: string;
  /** 中文名（设置面板 swatch 的悬停说明） */
  readonly label: string;
  readonly hex: string;
}

/**
 * 预设色板：覆盖常用 agent / 人的日常灯色认知（绿=好、黄=注意、红=错、
 * 蓝=进行中……），不给自由取色器 —— 灯要在一排行里被一眼区分，任意邻近
 * 色会互相吞掉；预设九色已够表达，也免去校验地狱。
 */
export const SESSION_LIGHT_PALETTE: readonly SessionLightPaletteEntry[] = [
  { id: "green", label: "绿", hex: "#22c55e" },
  { id: "teal", label: "青", hex: "#14b8a6" },
  { id: "blue", label: "蓝", hex: "#3b82f6" },
  { id: "yellow", label: "黄", hex: "#eab308" },
  { id: "amber", label: "琥珀", hex: "#f59e0b" },
  { id: "orange", label: "橙", hex: "#f97316" },
  { id: "red", label: "红", hex: "#ef4444" },
  { id: "rose", label: "玫红", hex: "#f43f5e" },
  { id: "violet", label: "紫", hex: "#8b5cf6" },
];

/** 默认灯色：完成未读=绿、待交互=琥珀、异常=红、运行中=青（主题 accent） */
export const SESSION_LIGHT_DEFAULT_COLORS: Record<SessionLightColorState, string> = {
  unreadDone: "#22c55e",
  attention: "#f59e0b",
  error: "#ef4444",
  running: "#14b8a6",
};

/** 色板内 hex 判定（读档校验用，大小写不敏感） */
export function isPaletteHex(hex: string): boolean {
  const lower = hex.toLowerCase();
  return SESSION_LIGHT_PALETTE.some((c) => c.hex === lower);
}

/** 契约 SessionStatus（或台账里的原始状态串）→ 灯的事实输入。
 *  idle 落全 false（无灯）；done 同样全 false——「完成未读」由 unread
 *  输入表达，不占状态位。未知 / 缺席状态同样落无灯。 */
export function lightFlagsFromStatus(status: string | undefined): {
  failed: boolean;
  awaiting: boolean;
  running: boolean;
} {
  return {
    // failed 用前缀匹配：台账/适配器层存在 failed_executor 这类变体
    // （backend 真实产生），严格相等会漏红
    failed: status !== undefined && status.startsWith("failed"),
    awaiting: status === "awaiting_permission" || status === "awaiting_input",
    running: status === "running",
  };
}

/**
 * 灯判定（唯一口径，侧栏历史行 / 画布 chat 标签共用）。
 *
 * 优先级：手动覆盖 > 异常 > 待交互 > 运行中 > 完成未读 > 无灯。
 * 异常最高：挂了的会话不会再自己变好，最需要人来收；待交互高于运行中：
 * 「等你」比「它在干活」更需要注意力 —— 前者阻塞的是人，后者阻塞的是机器。
 */
export function deriveSessionLight(input: {
  failed: boolean;
  awaiting: boolean;
  running: boolean;
  unread: boolean;
  /** 用户右键手动覆盖（null/undefined = 跟随系统自动灯） */
  override?: SessionLightKind | null;
}): SessionLightKind {
  if (input.override !== undefined && input.override !== null) {
    return input.override;
  }
  if (input.failed) return "error";
  if (input.awaiting) return "attention";
  if (input.running) return "running";
  if (input.unread) return "unreadDone";
  return "none";
}
