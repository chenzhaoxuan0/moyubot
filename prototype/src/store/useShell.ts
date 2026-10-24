import { create } from "zustand";
import type { UnitId } from "../core/units.ts";
// 类型引入（编译期擦除，无运行时环）：请求形状的定义权在弹窗组件那里，
// store 只存它 —— 放 core 会把 UI 概念（模板预填）漏进领域层
import type { AutomationDialogRequest } from "../ui/AutomationDialog.tsx";

/**
 * 外壳状态 —— 和业务状态（工作单元 / 会话 / 事件流）分离。
 *
 * 布局结构对齐 ZCode 的 WorkspaceShellLayout：
 * - 侧栏 264px 起，可拖拽，宽度持久化到 localStorage
 *   （ZCode 用的是同一个键名思路：zcode:workspace-shell:sidebar-width-px）
 * - 右栏是**标签页面板**，不是固定详情栏
 * - 底部终端面板可开关
 * - 命令中心 Cmd/Ctrl+K
 */

/**
 * 主视图 —— 对齐 ZCode 的 WorkspaceMainView（app-shell/types.ts）。
 *
 * ZCode 只有 chat / automations / plugin-store 三种主视图：
 * - 设置页**不是主视图**，是全屏覆盖层（WorkspaceSettingsLayer：absolute inset-0，
 *   shell 压暗不卸载），所以这里用 settingsOpen 布尔而不是 "settings" 视图；
 * - 搜索**也不是主视图**，是 ⌘K 命令中心浮层（CommandCenterDialog）。
 * - image（出图工作台）是本项目的扩展：与自动化同级的独立功能视图
 *   （gpt_image_playground 的移植落点）。
 * - backlog（待办/GTD）同上：目标维度的任务清单 + 心跳提议，与自动化（过程维度）相对。
 * - sourceControl（源代码管理）同上：激活单元仓库的分支 / 工作树管理，
 *   交互范式对齐 VSCode SCM（ADR 0008）。
 */
export type MainView = "chat" | "automations" | "image" | "backlog" | "sourceControl";

/**
 * 会话内视图（docs/13 统一 Web 化：决策拍板「新会话默认结构化聊天」）：
 * - chat 为结构化对话（Timeline + Composer，消费 RuntimeEvent 归一化事件流）
 * - terminal 为终端画布（TUI 原生体验，xterm 画布持久挂载）
 * trajectory 轨迹透视不随本轮恢复，需要时从 git 历史取（TrajectoryView.tsx）。
 */
export type ConversationView = "chat" | "terminal";

/**
 * 设置分区 id。
 *
 * 原先对齐 ZCode 有 11 个，其中 general / appearance / skills / hooks / trace
 * 只有「导航 + 面包屑 + 一句尚未实现」的空骨架 —— 用户能点进去、什么都改不了。
 * 已整体移除，等真要做的时候再加回来（git log 有原形）。
 */
export type SettingsSectionId =
  | "appearance"
  | "models"
  | "cli"
  | "history"
  | "archivedTasks"
  | "heartbeat"
  | "terminal"
  | "image"
  | "shortcuts"
  | "context"
  | "memory"
  | "skills"
  | "mcp"
  | "browserControl"
  | "computerControl"
  | "search"
  | "remoteControl";

export type SettingsGroupId = "basics" | "agentCapabilities";

export interface SettingsSectionDef {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly desc: string;
  readonly groupId: SettingsGroupId;
  /** 图标 key，交给渲染层映射，避免状态层依赖 react 图标 */
  readonly icon: string;
}

/** 分组定义，顺序即侧栏显示顺序 */
export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; title: string }[] = [
  { id: "basics", title: "基础" },
  { id: "agentCapabilities", title: "bot 能力" },
];

/**
 * 分区清单 —— 结构照搬 ZCode 的 BASE_SETTINGS_SECTIONS，
 * 但内容按本项目的实际资产重排：
 * 「执行器」进基础设置（六家工具是一等公民，必须显眼）
 * **「自动化」不在此列表** —— 它是独立主视图（见 MainView 注释）
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: "appearance", title: "外观", desc: "预设主题、十组配色、透明度、背景壁纸与表面排版", groupId: "basics", icon: "palette" },
  { id: "models", title: "执行器与模型", desc: "执行器实例、供应商与每个 CLI 的模型清单", groupId: "basics", icon: "brain" },
  { id: "cli", title: "命令行 (aw)", desc: "零依赖命令行客户端（node≥22，独立包 cli/）：agent 指挥工作台、脚本批量操作、无 GUI 服务器驾驶它；每个 bot 工作区播种同名技能", groupId: "basics", icon: "terminal" },
  { id: "history", title: "历史会话", desc: "会话时间轴过滤、失败记录隐藏与展示偏好", groupId: "basics", icon: "history" },
  { id: "archivedTasks", title: "归档任务", desc: "查看与恢复已归档的历史任务，放进抽屉不占侧栏空间", groupId: "basics", icon: "archive" },
  { id: "heartbeat", title: "心跳", desc: "心跳开关、周期、空闲阈值、提议超时与忽略上限 —— 待办自动提议的节拍", groupId: "basics", icon: "alarm" },
  { id: "terminal", title: "终端", desc: "对话页小终端的 Shell 类型（默认 PowerShell 7）与终端页共享的档案", groupId: "basics", icon: "terminal" },
  { id: "shortcuts", title: "快捷键", desc: "全局键位速查", groupId: "basics", icon: "keyboard" },

  { id: "context", title: "上下文清单", desc: "选一个 bot：注入矩阵与 SOUL / AGENTS / MEMORY / STANDING / USER 全部上下文文件的集中编辑", groupId: "agentCapabilities", icon: "book" },
  { id: "memory", title: "记忆", desc: "记忆就是项目文件夹里的普通 Markdown：MEMORY.md 恒注入，memory/daily/ 按天分片不注入，skills/ 是程序性记忆；跨会话检索是第四件事，单独授权、默认关", groupId: "agentCapabilities", icon: "brain" },
  { id: "skills", title: "技能", desc: "停用 = 技能文件夹移入源内 .disabled/ 目录，对读取该源的所有执行器立即生效；恢复即搬回，文件一个不丢。每组头部的执行器徽标就是影响范围——专属目录只影响一家，公共目录（.agents）影响所有家", groupId: "agentCapabilities", icon: "layers" },
  { id: "mcp", title: "MCP 服务", desc: "直接读写各执行器自己的配置文件（唯一真相源，原生 TUI 里改的这里也看得到）。停用 = 条目移出配置并存入停用库，恢复即写回；改对新会话生效，运行中的会话不受影响", groupId: "agentCapabilities", icon: "plug" },
  { id: "browserControl", title: "浏览器控制", desc: "playwright-mcp 一键扇出到全部执行器；隔离 / 接管（共享 Chrome）两模式", groupId: "agentCapabilities", icon: "globe" },
  { id: "computerControl", title: "电脑控制", desc: "执行器操作真实桌面（截图 / 键鼠 / 窗口）：总闸、急停与动作日志", groupId: "agentCapabilities", icon: "monitor" },
  { id: "search", title: "搜索", desc: "按 bot 配置联网搜索（Tavily / DeepSeek / 豆包 / 元宝）：密钥 daemon 侧分槽，workbench-search 桥按会话目录暴露 web_search；这里看各家余量与条目扇出状态", groupId: "agentCapabilities", icon: "search" },
  { id: "remoteControl", title: "移动端远控", desc: "扫码直连手机 Web 触控界面、公网穿透与 IM 渠道守护状态", groupId: "agentCapabilities", icon: "smartphone" },
  { id: "image", title: "出图", desc: "图像供应商 profile 管理（gpt_image_playground 字段全集）", groupId: "agentCapabilities", icon: "image" },
];

// ---------------------------------------------------------------------------
// 右侧标签面板：状态在独立的 store/useSidePane.ts（契约在 core/sidePaneTabs.ts）。
// 本 store 只管外壳布局（侧栏宽度 / 主视图 / 弹窗开关），不放面板内容 ——
// 面板有自己的作用域语义（切 bot 跟随），混进来会让两套生命周期互相污染。
// 历史版本：IDE 式 19-tab 右栏曾在 588d458 整体移除；本版是弹窗迁移式的
// 重做（历史会话打头），入口与渲染都是真的。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const WIDTH_KEY = "agent-workbench:sidebar-width-px";
/** 与设置页左侧导航（w-[264px]）对齐，两栏切换时视觉宽度一致 */
const SIDEBAR_DEFAULT = 264;
/**
 * 最小宽度下限 = 顶部动作行不溢出的宽度：px-2.5 内边距 + 收起钮 + 6 个
 * 导航图标钮（搜索/自动化/待办/源代码管理/出图/设置）≈ 226px 固定内容。
 * 旧下限 200px 时这行被压溢出，栏底出现横向滚动条 —— 下限必须盖住头部。
 */
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX_RATIO = 0.5;

/** 对话区过窄时自动收起（对齐 ZCode 的 360 / 480 阈值思路） */
const AUTO_COLLAPSE_SIDEBAR_PX = 360;
const AUTO_COLLAPSE_SIDE_PANE_PX = 480;

function readWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    // 若为旧版默认值 200、布局异常值 351 或无效数值，重置为当前默认 264
    if (!Number.isFinite(n) || n <= 0 || n === 200 || n === 351) {
      return SIDEBAR_DEFAULT;
    }
    return Math.max(SIDEBAR_MIN, Math.round(n));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function persistWidth(w: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 对话列宽：时间线阅读列与输入框共用的最大宽度（对齐 ZCode：composer 与消息列
// 同容器同宽）。默认 900 ≈ ZCode 有内容时的 max-w-4xl（896px），设置页可调。
// ---------------------------------------------------------------------------

const CHAT_WIDTH_KEY = "agent-workbench:chat-column-width-px";
/** 阅读舒适度的下限（再窄一行放不下几个字）与上限（跟整窗等宽就失去列的意义） */
export const CHAT_WIDTH_MIN = 640;
export const CHAT_WIDTH_MAX = 1440;
const CHAT_WIDTH_DEFAULT = 900;

function readChatColumnWidth(): number {
  if (typeof window === "undefined") return CHAT_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return CHAT_WIDTH_DEFAULT;
    return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(n)));
  } catch {
    return CHAT_WIDTH_DEFAULT;
  }
}

function persistChatColumnWidth(w: number): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 全局底栏高度（任务栏）：默认最薄一档（28px，与原状态栏同高），可拖拽调高
// 给愿意用高度换信息的用户 —— 拉高后任务 chip 展开「正在干什么」的细节行。
// ---------------------------------------------------------------------------

const STATUSBAR_HEIGHT_KEY = "agent-workbench:statusbar-height-px";
/** 原全局状态栏高度（h-7）—— 单行紧凑 chip 正好放下，也是默认档 */
export const STATUSBAR_MIN = 28;
/** 上限 = 折叠对话会用到的最高高度：双行详情 chip（32px）+ 上下留白。
 *  再高只会在 chip 之外堆空白，不给拖 */
const STATUSBAR_MAX = 44;
const STATUSBAR_DEFAULT = 28;

function readStatusBarHeight(): number {
  if (typeof window === "undefined") return STATUSBAR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STATUSBAR_HEIGHT_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n)) return STATUSBAR_DEFAULT;
    return Math.min(STATUSBAR_MAX, Math.max(STATUSBAR_MIN, Math.round(n)));
  } catch {
    return STATUSBAR_DEFAULT;
  }
}

function persistStatusBarHeight(h: number): void {
  try {
    window.localStorage.setItem(STATUSBAR_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

const STATUSBAR_LOCKED_KEY = "agent-workbench:statusbar-locked";
/** 默认锁定（任务栏锁定语义）：高度固定不可拖拽，停在最薄一档 */
function readStatusBarLocked(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STATUSBAR_LOCKED_KEY) !== "0";
  } catch {
    return true;
  }
}

interface ShellState {
  sidebarWidth: number;
  /** 对话阅读列最大宽度（时间线与输入框共用，设置页外观区可调） */
  chatColumnWidth: number;
  sidebarCollapsed: boolean;
  /** 全局底栏（任务栏）高度，px。默认 28（最薄档）；拖上缘调高，双击手柄复位 */
  statusBarHeight: number;
  /** 底栏高度锁定（默认 true）：锁定时隐藏拖拽手柄、高度固定 —— 设置页开关 */
  statusBarLocked: boolean;
  /**
   * 当前折叠是不是「窗口变窄触发的自动折叠」。窄→宽时要跟着自动展开；
   * 用户手动收起（toggleSidebar）会清掉这个标记 —— 显式选择优先于自动恢复。
   * 会话内记忆，不持久化：重启后无从谈起。
   */
  sidebarAutoCollapsed: boolean;

  commandOpen: boolean;
  mainView: MainView;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  /**
   * 自动化编辑弹窗的打开请求（docs/23）。放 store 而不是 AutomationsPage 局部
   * 状态：侧栏的待触发行、自动化页的新建/编辑按钮共用一个弹窗 —— 从侧栏点
   * 待触发任务直接弹编辑窗，不必先跳页。
   */
  automationDialog: AutomationDialogRequest | null;
  /** 新建 bot 对话框（AGENTS.md 岗位说明书）。放 store 而不是 Sidebar 局部状态：
   *  「添加 bot」的按钮收进了侧栏 ⋯ 之后，单元区的空态要能当第二个入口，
   *  两处共用一个开关。新建＝新建＋认领单轨：指向已有文件夹时原地注册，
   *  不再另设导入对话框（原 ImportBotDialog 已并入）。 */
  /** 会话内视图：默认结构化聊天（docs/13 决策），终端画布为可切换的并行形态 */
  conversationView: ConversationView;

  setSidebarWidth: (w: number) => void;
  setChatColumnWidth: (w: number) => void;
  /** 底栏高度（px）。拖拽过程传 persist:false 只改内存，落定后默认落盘 */
  setStatusBarHeight: (h: number, opts?: { persist?: boolean }) => void;
  /** 锁定底栏高度（默认 true） */
  setStatusBarLocked: (locked: boolean) => void;
  toggleSidebar: () => void;

  setConversationView: (v: ConversationView) => void;

  setMainView: (v: MainView) => void;
  /** 打开设置覆盖层（ZCode 的 WorkspaceSettingsLayer），可直落某个分区 */
  openSettings: (section?: SettingsSectionId) => void;
  /** 关闭设置覆盖层。对齐 ZCode：退出设置统一回到 chat 主视图 */
  closeSettings: () => void;
  /** 打开自动化弹窗（新建可带模板预填 / 编辑某条）。全局唯一挂载点在 WorkspaceShell */
  openAutomationDialog: (req: AutomationDialogRequest) => void;
  closeAutomationDialog: () => void;

  setCommandOpen: (open: boolean) => void;
}

export const useShell = create<ShellState>((set, get) => ({
  sidebarWidth: readWidth(),
  chatColumnWidth: readChatColumnWidth(),
  statusBarHeight: readStatusBarHeight(),
  statusBarLocked: readStatusBarLocked(),
  sidebarCollapsed: false,
  sidebarAutoCollapsed: false,

  commandOpen: false,
  mainView: "chat",
  settingsOpen: false,
  settingsSection: "models",
  automationDialog: null,
  conversationView: "chat",

  setMainView: (mainView) => set({ mainView }),

  setConversationView: (conversationView) => set({ conversationView }),

  openAutomationDialog: (req) => set({ automationDialog: req }),
  closeAutomationDialog: () => set({ automationDialog: null }),

  openSettings: (section) =>
    set((s) => ({
      settingsOpen: true,
      settingsSection: section ?? s.settingsSection,
    })),

  closeSettings: () => set({ settingsOpen: false, mainView: "chat" }),

  setSidebarWidth: (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.round(w));
    set({ sidebarWidth: clamped });
    persistWidth(clamped);
  },

  setChatColumnWidth: (w) => {
    const clamped = Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(w)));
    set({ chatColumnWidth: clamped });
    persistChatColumnWidth(clamped);
  },

  /** 底栏高度：拖拽中连续 set（不落盘，跟手），结束时调用方传 persist 落盘 */
  setStatusBarHeight: (h, opts) => {
    const clamped = Math.min(STATUSBAR_MAX, Math.max(STATUSBAR_MIN, Math.round(h)));
    set({ statusBarHeight: clamped });
    if (opts?.persist !== false) persistStatusBarHeight(clamped);
  },

  /** 锁定/解锁底栏高度（设置页开关）。锁定只固定高度，不改变当前值 */
  setStatusBarLocked: (locked) => {
    set({ statusBarLocked: locked });
    try {
      window.localStorage.setItem(STATUSBAR_LOCKED_KEY, locked ? "1" : "0");
    } catch {
      /* ignore */
    }
  },

  // 手动开合 = 用户接管：清掉自动折叠标记，宽回来时不替用户做主
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed, sidebarAutoCollapsed: false })),

  setCommandOpen: (commandOpen) => set({ commandOpen }),

}));

// ---------------------------------------------------------------------------
// 全局快捷键（对齐 ZCode 的命令中心习惯）
// ---------------------------------------------------------------------------

export function bindShellShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const shell = useShell.getState();
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      shell.setCommandOpen(!shell.commandOpen);
      return;
    }
    // 搜索也是命令中心（ZCode 没有独立搜索视图，⌘F 并入同一入口）
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      shell.setCommandOpen(true);
      return;
    }
    // ZCode：toggleSidebar 默认 Cmd/Ctrl+B。排他 Alt：Ctrl+Alt+B 是右侧面板的
    // 开合键（sidePaneShortcuts），不排的话一次按键把左栏和右面板同时翻转
    if (mod && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      shell.toggleSidebar();
      return;
    }
    // ZCode：openSettings 默认 Cmd/Ctrl+,
    if (mod && e.key === ",") {
      e.preventDefault();
      shell.openSettings();
      return;
    }
    if (e.key === "Escape") {
      const s = useShell.getState();
      if (s.commandOpen) s.setCommandOpen(false);
      else if (s.settingsOpen) s.closeSettings();
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** 供 ResizablePanel onLayout 计算：视口宽度换算最大侧栏宽 */
export function maxSidebarWidth(containerWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.round(containerWidth * SIDEBAR_MAX_RATIO));
}

export { AUTO_COLLAPSE_SIDEBAR_PX, AUTO_COLLAPSE_SIDE_PANE_PX, SIDEBAR_DEFAULT, SIDEBAR_MIN };
