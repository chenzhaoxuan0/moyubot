/**
 * 浏览器控制与电脑控制契约（docs/14）—— 设置页两个分区与 daemon
 * `browserControl.*` / `computerControl.*` RPC 的共享形态。
 *
 * 领域语言见根 CONTEXT.md §「浏览器与电脑控制」：
 * - 浏览器控制：工作台只做登记与模式管理（隔离 / 接管），不内置浏览器；
 * - 电脑控制：默认停用，总闸 + 急停 + 输入租约，动作日志集中记录。
 */

/** 浏览器通道：直接用系统已装的浏览器，零下载 */
export type BrowserChannel = "msedge" | "chrome";

/** 浏览器控制模式：isolated = 各执行器独立 profile；takeover = CDP 接管共享 Chrome */
export type BrowserControlMode = "isolated" | "takeover";

/** 浏览器控制配置（<homeDir>/browser-control.json） */
export interface BrowserControlConfig {
  /** false = 不写任何条目（默认）。启用即扇出到全部受支持执行器 */
  readonly enabled: boolean;
  readonly mode: BrowserControlMode;
  /** 隔离模式的浏览器通道 */
  readonly browser: BrowserChannel;
  /** 接管模式：共享 Chrome 的调试端口（默认基址 9333，被占时上浮；持久化让条目跨重启稳定） */
  readonly sharedPort?: number;
}

/** 共享 Chrome（接管模式）的运行状态 */
export interface SharedChromeStatus {
  readonly running: boolean;
  /** 可执行文件路径（探测结果） */
  readonly executable: string | null;
  /** 实际拉起的是 chrome 还是 edge 兜底 */
  readonly kind: "chrome" | "edge" | null;
  readonly port: number | null;
  /** 进程意外退出时的原因；null = 正常 / 未运行 */
  readonly exitReason: string | null;
  /** 最近一次启动/停止失败的说明（UI 展示用）；null = 无 */
  readonly lastError: string | null;
}

/** 单家执行器的扇出结果 */
export interface ControlFanoutOutcome {
  readonly executorId: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** 动作日志一行（工作台侧事件：配置变更 / 生命周期 / 工具调用） */
export interface ControlActionEntry {
  /** 单调递增序号（前端增量拉取的游标） */
  readonly seq: number;
  readonly at: number;
  /** search = 搜索桥（core/search.ts，同款日志复用这个形状） */
  readonly domain: "browser" | "computer" | "search";
  /** 动作名：enabled / disabled / mode / entry.write / sharedChrome.start / tool.computer_click … */
  readonly action: string;
  /** 摘要（谁 / 参数要点 / 结果），纯文本，不承载审批语义 */
  readonly detail: string;
}

/** `browserControl.get` 的返回 */
export interface BrowserControlState {
  readonly config: BrowserControlConfig;
  readonly sharedChrome: SharedChromeStatus;
  /** 最近一次扇出的逐家结果（未启用时为空） */
  readonly fanout: readonly ControlFanoutOutcome[];
  /** 不支持落盘配置的执行器（dsh 动态注入；sdk-bridge 不支持）及其说明 */
  readonly notes: readonly { readonly executorId: string; readonly note: string }[];
  readonly actions: readonly ControlActionEntry[];
}

/** 电脑控制配置（<homeDir>/computer-control.json） */
export interface ComputerControlConfig {
  /** 总闸：false = server 对一切工具调用拒绝（默认） */
  readonly enabled: boolean;
}

/** 输入租约持有方状态 */
export interface ComputerLeaseInfo {
  /** null = 空闲 */
  readonly holder: string | null;
  /** 租约获取时间（ms epoch） */
  readonly since: number | null;
  /** 最近一次活动（TTL 120s 的刷新锚点） */
  readonly lastActive: number | null;
}

/** `computerControl.get` 的返回 */
export interface ComputerControlState {
  readonly config: ComputerControlConfig;
  readonly lease: ComputerLeaseInfo;
  /** nut 运行时是否已加载成功（懒加载；失败时工具面报 runtime unavailable） */
  readonly runtimeReady: boolean;
  readonly runtimeError: string | null;
  readonly fanout: readonly ControlFanoutOutcome[];
  readonly notes: readonly { readonly executorId: string; readonly note: string }[];
  readonly actions: readonly ControlActionEntry[];
}

/** dsh（ACP session/new）动态注入用的 MCP 服务形状 —— ACP 线上格式 */
export interface AcpMcpServer {
  readonly name: string;
  /** stdio 形态 */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** http 形态 */
  readonly type?: "http";
  readonly url?: string;
}
