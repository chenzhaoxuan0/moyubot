/**
 * 归一化运行时事件。
 *
 * 这是"多家工具平等切换"的技术前提：六家 agent 的原生事件格式完全不同
 * （ACP / JSON-RPC / CBOR 二进制 / 自定义流），如果 UI 直接消费原生事件，
 * 每加一个工具就要改一遍渲染层。
 *
 * 适配器的职责就是把原生事件收敛到这里；UI 只认这一套 union。
 * 新增事件类型 = 改 union + 各适配器补一个 mapper，渲染层不动。
 */

import type { SessionId, SessionSource, UnitId } from "./units.ts";
import type { ChatAttachment } from "./attachments.ts";

/**
 * 计划步骤的状态机。
 *
 * 刻意不做「完成度百分比」—— 步骤的权重不等，
 * 用 done/total 算出来的百分比会骗人。ZCode 的 plan-detail 也是逐条列。
 */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: PlanStepStatus;
}

/**
 * steer 待发送队列的条目形态（快照与 Session 行共用）：
 * id 是 daemon 侧寻址键（删除 / 立刻发送用）。
 */
export interface SteerQueueItem {
  readonly id: string;
  readonly text: string;
}

export type RuntimeEvent =
  // ---- 会话生命周期 ----
  /**
   * 会话开始。带来源与实际生效模型，是为了让时间轴第一行就说清两件事
   * （docs/09 §六.1 / §六.2）：
   * - 这个会话从哪来（工作台 / 飞书 / Telegram / webhook / MCP / 自动化）
   * - 你配的 modelHint 是不是被丢掉了，丢给了哪个
   *
   * 这两个字段缺了，用户就只能靠猜：以为在用便宜模型、以为在飞书里的对话
   * 和桌面是两回事。
   */
  | {
      readonly type: "session.started";
      readonly sessionId: SessionId;
      readonly unitId: UnitId;
      readonly source?: SessionSource;
      readonly modelActual?: string;
      readonly modelHintDropped?: string;
    }
  | { readonly type: "session.status"; readonly sessionId: SessionId; readonly status: string }
  /**
   * 执行器原生会话引用（WP-10：cherry 的 resume-token 事件化）。
   * 变化即推（首轮 init 后、resume 后），前端免轮询 externalRef；
   * 客户端凭它可以在 daemon 重启后跨进程续命（配合 session.resume）。
   */
  | { readonly type: "session.ref"; readonly sessionId: SessionId; readonly ref: string }
  | { readonly type: "session.ended"; readonly sessionId: SessionId; readonly reason: string }

  // ---- 轮边界（host 自产；ADR 0012：turn 是账本一等事实，不再借用 session.status 表达）----
  /**
   * 一轮开始：host 派发用户消息的时刻（含新会话首轮）。
   * `turn` 是会话内单调轮号，started/completed 凭它配对。
   */
  | { readonly type: "turn.started"; readonly sessionId: SessionId; readonly turn: number }
  /**
   * 一轮落定：idle（正常）/ failed（执行器报失败）/ cancelled（用户取消）/ error（派发失败收口）。
   * 只在确有一轮开着时发出 —— 空闲会话的杂散 status 不产生幽灵轮。
   */
  | {
      readonly type: "turn.completed";
      readonly sessionId: SessionId;
      readonly turn: number;
      readonly reason: "idle" | "failed" | "cancelled" | "error";
    }

  // ---- 消息 ----
  | {
      readonly type: "message.delta";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly attachments?: readonly ChatAttachment[];
      /**
       * 这条消息是谁投进来的（缺省 = 用户亲手在输入框发的）：
       * "automation" = 定时任务到点代发（existing_session 续跑 / 定时发送）——
       * 气泡上的「定时」徽标据此点亮，回放同样生效（字段随事件进账本）。
       */
      readonly origin?: string;
    }
  | {
      readonly type: "message.completed";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: "reasoning.delta";
      readonly sessionId: SessionId;
      readonly messageId: string;
      readonly text: string;
    }

  // ---- 工具调用 ----
  | {
      readonly type: "tool.started";
      readonly sessionId: SessionId;
      readonly callId: string;
      readonly toolName: string;
      readonly title: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool.completed";
      readonly sessionId: SessionId;
      readonly callId: string;
      readonly ok: boolean;
      readonly output?: string;
    }

  // ---- 文件与 diff（项目视图的核心）----
  | {
      readonly type: "file.diff";
      readonly sessionId: SessionId;
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
      readonly patch?: string;
    }
  | {
      readonly type: "file.changed";
      readonly sessionId: SessionId;
      readonly path: string;
      readonly change: "created" | "modified" | "deleted";
    }

  // ---- 权限（沙箱/审批的统一抽象）----
  | {
      readonly type: "permission.requested";
      readonly sessionId: SessionId;
      readonly requestId: string;
      readonly kind: "file_write" | "shell" | "network" | "tool";
      readonly detail: string;
      readonly risk: "low" | "medium" | "high";
    }
  | {
      readonly type: "permission.resolved";
      readonly sessionId: SessionId;
      readonly requestId: string;
      readonly decision: "allow" | "deny" | "always";
    }

  // ---- 子代理 / 编排（任务内组合多 agent）----
  | {
      readonly type: "subagent.spawned";
      readonly sessionId: SessionId;
      readonly childId: string;
      readonly role: string;
      readonly runtimeId: string;
    }
  | {
      readonly type: "subagent.finished";
      readonly sessionId: SessionId;
      readonly childId: string;
      readonly ok: boolean;
      readonly summary?: string;
    }

  // ---- steering（T3 语义：turn 进行中的插话排队与落点，WP-10 事件化）----
  /** 插话进入排队（turn 进行中到达，等本轮落定后发出）。id = 新条目的寻址 id */
  | { readonly type: "steer.queued"; readonly sessionId: SessionId; readonly id: string; readonly queueDepth: number }
  /** 排队插话在轮边界被注入——前端据此把 A1（pre-steer）/A2（post-steer）分行 */
  | { readonly type: "steer.boundary"; readonly sessionId: SessionId; readonly id: string; readonly text: string }
  /** 会话终结时仍在排队的插话（没有下一轮可附着）——上游渠道应知晓这些消息未被投递 */
  | { readonly type: "steer.undelivered"; readonly sessionId: SessionId; readonly inputs: readonly string[] }
  /**
   * steer 队列权威快照：入队/移除/立刻发送（提队首）/暂停/恢复/派发后各发一份。
   * 队列 UI 只认这个事件（快照免增量对账，断线重连后下一条即自愈）；
   * steer.queued / steer.boundary 保留给 IM 渠道做「已排队 / 已注入」的通知语义。
   */
  | {
      readonly type: "steer.queue";
      readonly sessionId: SessionId;
      readonly items: readonly SteerQueueItem[];
      readonly paused: boolean;
    }
  // ---- 计划（ZCode 的 plan-detail：agent 提计划 → 用户批 / 改 / 否）----
  | {
      readonly type: "plan.proposed";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly title: string;
      readonly steps: readonly PlanStep[];
      readonly rationale?: string;
    }
  | {
      readonly type: "plan.step.updated";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly stepId: string;
      readonly status: PlanStepStatus;
    }
  | {
      readonly type: "plan.resolved";
      readonly sessionId: SessionId;
      readonly planId: string;
      readonly decision: "approved" | "rejected" | "edited";
    }

  // ---- 用量（成本策略可视化）----
  | {
      readonly type: "usage";
      readonly sessionId: SessionId;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
      readonly model: string;
      /**
       * 缓存读 / 缓存写（可缺省 = 该执行器没报缓存）。
       * 计费口径对齐 dsh 的 TokenUsageProjection：
       * billedInput = uncachedInput + cacheRead + cacheWrite。
       */
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      /** 本轮解码耗时（ms），速度 = outputTokens / (decodeMs / 1000)。缺省表示没报 */
      readonly decodeMs?: number;
      /**
       * 幂等键（WP-10：cherry 语义）——driver 命名的一次 provider 调用 id
       * （如 `codex:<threadId>:<n>`）。重放/补拉场景凭它去重，落库不重复计费。
       */
      readonly requestId?: string;
    }

  // ---- 产出 ----
  | {
      readonly type: "deliverable";
      readonly sessionId: SessionId;
      readonly unitId: UnitId;
      readonly title: string;
      readonly kind: "file" | "diff" | "pr" | "report" | "image";
      readonly path?: string;
      readonly url?: string;
    }

  // ---- 错误 ----
  | {
      readonly type: "error";
      readonly sessionId: SessionId;
      readonly message: string;
      readonly recoverable: boolean;
    }

  // ---- 系统与指令通知 ----
  | {
      readonly type: "system.notice";
      readonly sessionId: SessionId;
      readonly title: string;
      readonly text: string;
      readonly level?: "info" | "success" | "warn";
      readonly meta?: Readonly<Record<string, string>>;
    }

  // ---- git 状态通知（无 sessionId：仓库级，不属任何会话） ----
  /**
   * daemon 侧文件监听发现某仓库的工作树 / .git 有变化（docs/16）。
   * 这是「该刷新了」的信号而不是数据本身 —— 前端收到后自行拉 git.status /
   * git.changes，daemon 不在事件里带货（拉取已有 TTL/代际守卫，带货反而两套口径）。
   * 不落盘、不参与 seq 判重补拉（订阅者直接消费；漏一条的代价只是晚一轮刷新）。
   */
  | {
      readonly type: "git.changed";
      readonly rootPath: string;
    }

  // ---- 前台拉起（broadcast-only：拉前端视图，不落会话账本） ----
  /**
   * 「对话页」形态的自动化/待办到点：会话已由 daemon 开好（或接回），请前端
   * 把它打开到聊天时间线前台（openSession 自带跨 bot 切换）。与 git.changed
   * 同款口径 —— 不落盘、不参与 seq 判重补拉；漏一条的代价只是不自动跳前台，
   * 会话本身仍在历史列表/底栏任务条里可点开，功能不因漏发而缺失。
   */
  | {
      readonly type: "session.foreground";
      readonly sessionId: SessionId;
      readonly unitId: UnitId;
      readonly runtimeId: string;
      readonly cause: "automation" | "backlog";
      readonly title?: string;
    };

export type RuntimeEventType = RuntimeEvent["type"];

/**
 * 这个工具调用是不是「跑了一条 shell 命令」。
 *
 * 右栏的 bash-output（后台命令）页签只认这类调用。判定放在 core 而不是 UI 里
 * `toolName.includes("bash")`：六家执行器的工具命名各不相同
 * （Bash / run_shell / LocalShell / execute_command / terminal.exec），
 * 口径散到渲染层就必然各家不一。
 *
 * 比较前先去掉分隔符再小写 —— 否则 LocalShell 和 local_shell 得维护两份。
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "bashoutput",
  "runshell",
  "shell",
  "executecommand",
  "runcommand",
  "localshell",
  "powershell",
  "terminal",
  "terminalexec",
]);

export function isShellTool(toolName: string): boolean {
  const n = toolName.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  if (SHELL_TOOL_NAMES.has(n)) return true;
  return n.startsWith("shell") || n.startsWith("bash") || n.startsWith("terminal");
}

// ---------------------------------------------------------------------------
// 轨迹记录 —— eval 闭环的原料
// ---------------------------------------------------------------------------

/**
 * 每条事件打时间戳后落盘，就是"运行时完整过程"的数据源。
 * LLM judge 消费它做回归对比。这一层与 UI 解耦：
 * 即使前端换掉，轨迹格式不变，历史数据继续可用。
 */
export interface TraceRecord {
  readonly seq: number;
  readonly at: number;
  readonly sessionId: SessionId;
  readonly unitId: UnitId;
  readonly runtimeId: string;
  readonly event: RuntimeEvent;
  /** 归一化耗时，用于找性能回归 */
  readonly durationMs?: number;
}
