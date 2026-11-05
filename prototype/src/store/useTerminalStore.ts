import { create } from "zustand";
import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from "./TerminalSessionManager.ts";
import { useChatPanes } from "./useChatPanes.ts";

/**
 * 会话画布 store（docs/32 组栈模型）—— **叶子=标签组（栈）**，窗格（终端/
 * 对话）是组栈里的标签；每个分屏格子自带标签条，空组自动塌缩。对齐 orca
 * `tab-types.ts` 的两层正交模型（分屏树只组合组，标签增删永远不碰树）。
 *
 * 焦点单轨：activePaneId 是唯一焦点游标（旧双轨 activeInstanceId↔
 * activeChatPaneKey 收敛）——kind 查 panes[id].kind；useChatPanes 的焦点同步
 * 器订阅它驱动「单活+快照注册表」的恢复链（chat 聚焦/失焦）。
 *
 * 持久化（canvasLayout v2）：panes/groups/layout/activeGroupId 一并落盘；
 * 对话标签的身份在序列化层映射为稳定 id（运行时 paneKey 仍是会话内瞬态）。
 */

export type SplitDirection = "horizontal" | "vertical"; // horizontal = 左右 (row), vertical = 上下 (col)

/** 窗格种类：终端（daemon PTY 视图）或对话（会话线视图） */
export type PaneKind = "terminal" | "chat";

/** 终端窗格的创建/挂载数据（沿用旧 TerminalInstanceItem 字段面） */
export interface TerminalInstanceItem {
  id: string;
  title: string;
  shell: string;
  profileId: string;
  icon: string;
  cwd: string;
  executorId?: string;
  /** 所属 bot（终端跟随 bot：切换 bot 时激活它的专属标签页） */
  unitId?: string;
  createdAt: number;
  /** 重挂（F5 找回 daemon 存活 PTY）时的一次性回放快照；新建标签没有它 */
  attachScrollback?: string;
  /** 来自重挂 —— 背后是活进程，不是占位标签，不许被启发式顺手关掉 */
  reattached?: boolean;
}

/** 窗格 = 标签（docs/32：组栈里的一项） */
export interface CanvasPane {
  readonly id: string;
  readonly kind: PaneKind;
  title: string;
  /* 终端专属字段（kind === "terminal"） */
  shell?: string;
  profileId?: string;
  icon?: string;
  cwd?: string;
  executorId?: string;
  unitId?: string;
  createdAt?: number;
  attachScrollback?: string;
  reattached?: boolean;
}

/** 组 = 分屏格子 = 标签栈 */
export interface PaneGroup {
  readonly id: string;
  /** 组内标签序（显示顺序） */
  tabOrder: readonly string[];
  /** 组内激活标签；null = 空组（normalize 会塌缩掉） */
  activePaneId: string | null;
  /** 组内 MRU（升序，尾 = 最近使用）——关标签按此恢复，不是视觉邻居 */
  recentPaneIds: readonly string[];
}

/** 分屏树：叶子=组（组栈模型核心）；单组全幅时 layout 为 null */
export type GroupLayoutNode =
  | { type: "group"; groupId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      first: GroupLayoutNode;
      second: GroupLayoutNode;
      /** first 子树占比 0-1；|r-0.5|≤容差 时序列化省略（对齐 orca 口径） */
      ratio?: number;
    };

export interface TerminalProfile {
  id: string;
  name: string;
  shell: string;
  icon: "pwsh" | "powershell" | "cmd" | "wsl" | "bash";
  args?: string[];
}

export const SUPPORTED_TERMINAL_PROFILES: TerminalProfile[] = [
  { id: "pwsh", name: "PowerShell 7", shell: "pwsh.exe", icon: "pwsh" },
  { id: "powershell", name: "Windows PowerShell", shell: "powershell.exe", icon: "powershell" },
  { id: "cmd", name: "Command Prompt", shell: "cmd.exe", icon: "cmd" },
  { id: "wsl", name: "WSL (Linux)", shell: "wsl.exe", icon: "wsl" },
  { id: "bash", name: "Git Bash", shell: "bash.exe", icon: "bash" },
];

/** 拖拽落点（docs/32 §四）：中央=入栈；四边=分出新组 */
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

/* --------------------------------------------------------------- 树纯函数 */

function newBranchId(): string {
  return `br_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

/** 树中全部 groupId（顺序 = 布局序） */
export function collectGroupIds(node: GroupLayoutNode | null): string[] {
  if (node === null) return [];
  if (node.type === "group") return [node.groupId];
  return [...collectGroupIds(node.first), ...collectGroupIds(node.second)];
}

/** 把指定叶子组替换为任意子树（拖拽分屏嫁接） */
export function replaceGroupLeaf(
  node: GroupLayoutNode,
  groupId: string,
  replacement: GroupLayoutNode,
): GroupLayoutNode {
  if (node.type === "group") return node.groupId === groupId ? replacement : node;
  return { ...node, first: replaceGroupLeaf(node.first, groupId, replacement), second: replaceGroupLeaf(node.second, groupId, replacement) };
}

/** 摘掉指定组叶，兄弟提升（塌缩） */
export function removeGroupLeaf(node: GroupLayoutNode, groupId: string): GroupLayoutNode | null {
  if (node.type === "group") return node.groupId === groupId ? null : node;
  const first = removeGroupLeaf(node.first, groupId);
  const second = removeGroupLeaf(node.second, groupId);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

/** 指定组旁放新组（direction + 先后） */
export function splitGroupNode(
  node: GroupLayoutNode,
  groupId: string,
  newGroupId: string,
  direction: SplitDirection,
  newFirst: boolean,
): GroupLayoutNode {
  return replaceGroupLeaf(node, groupId, {
    type: "split",
    id: newBranchId(),
    direction,
    first: newFirst ? { type: "group", groupId: newGroupId } : { type: "group", groupId },
    second: newFirst ? { type: "group", groupId } : { type: "group", groupId: newGroupId },
    ratio: 0.5,
  });
}

/** 树按 split.id 更新比例 */
export function updateSplitRatio(node: GroupLayoutNode, splitId: string, ratio: number): GroupLayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, first: updateSplitRatio(node.first, splitId, ratio), second: updateSplitRatio(node.second, splitId, ratio) };
}

/** 树里所有 split 节点（Splitter 渲染面） */
export function collectSplits(node: GroupLayoutNode | null): Array<{ id: string; direction: SplitDirection }> {
  if (node === null || node.type === "group") return [];
  return [
    { id: node.id, direction: node.direction },
    ...collectSplits(node.first),
    ...collectSplits(node.second),
  ];
}

/* --------------------------------------------------------------- state 接口 */

interface TerminalStoreState {
  panes: Readonly<Record<string, CanvasPane>>;
  groups: Readonly<Record<string, PaneGroup>>;
  layout: GroupLayoutNode | null;
  activeGroupId: string | null;
  /** 唯一焦点游标（docs/32 单轨）：kind 查 panes[id].kind */
  activePaneId: string | null;
  maximizedPaneId: string | null;
  defaultProfileId: string;
  /** 首载重挂是否已尝试过（无论找没找到）—— 空态自动建标签必须等它，否则抢占重挂 */
  reattachDone: boolean;
  /** 派发在途登记（unitId → 过期时刻）：防「标签还没落地又派发一个全新的」双进程竞态 */
  pendingUnitDispatch: Record<string, number>;
  notePendingUnitDispatch: (unitId: string) => void;
  /** created 帧推送认领是否已装（幂等闸） */
  claimInstalled: boolean;
  /** 终端启动 Antigravity 时是否默认携带 --dangerously-skip-permissions 免审批 */
  agyDefaultYolo: boolean;
  setAgyDefaultYolo: (val: boolean) => void;

  /** 新建终端标签（加进激活组；没有组就开新组） */
  createTab: (opts?: {
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
    unitId?: string;
  }) => string;
  /** 新建对话标签（paneKey 来自 useChatPanes 注册表），同样落进激活组 */
  createChatTab: (paneKey: string) => string;

  /** 焦点主入口：激活某标签（置组内 activePaneId + activeGroupId） */
  activatePane: (paneId: string) => void;
  /** 旧名兼容（docs/31 遗留调用面）：chat 窗格激活 */
  focusChatPaneTab: (paneKey: string) => void;
  /** 激活某个分组格（焦点 = 组内激活标签） */
  setActiveGroup: (groupId: string) => void;

  /** 拆分当前组：新组承载新标签（终端或对话），返回新组 id */
  splitPane: (opts?: {
    direction?: SplitDirection;
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
    unitId?: string;
    chatPaneKey?: string;
  }) => string | null;

  /** 关标签（终端杀 PTY / 对话摘注册表不杀会话）；组空塌缩 */
  closePane: (paneId: string) => void;
  /** 标签右键：保留该标签，关掉同组其余 */
  closeOtherPanes: (keepPaneId: string) => void;
  /** 关整个分组格（组内全部标签；组从树摘除） */
  closeGroup: (groupId: string) => void;
  /** 跨组移动/组内重排（拖拽提交） */
  movePaneToGroup: (paneId: string, toGroupId: string, index?: number) => void;
  /** 拖标签五向落点（center=入栈并激活；四边=分出新组） */
  dropPaneOnGroup: (paneId: string, targetGroupId: string, zone: DropZone) => void;
  /** 拖自身组内最后一个标签到自身四边 = no-op 判定 */
  isSplitDropNoOp: (paneId: string, targetGroupId: string) => boolean;

  /** 最大化 / 还原窗格（双 kind 通用 id） */
  toggleMaximize: (paneId?: string) => void;
  /** 调整分屏分割线比例（提交式：拖动结束才调用） */
  setSplitRatio: (splitId: string, ratio: number) => void;

  /** 重命名标签 */
  renamePane: (paneId: string, title: string) => void;

  /** 全部清空销毁 */
  clearAll: () => void;

  /**
   * F5 重挂：把 daemon 里还活着的 PTY 找回来（terminal.list），逐个还原成
   * 标签（进默认组）。没有它，刷新一次就积累一批界面再也关不掉的孤儿进程。
   */
  reattachFromDaemon: () => Promise<void>;

  /**
   * created 帧推送认领：daemon 侧新建的终端（定时任务 TUI 派发）主动推帧过来，
   * 前端收到即开标签并切过去 —— 不等 F5、不轮询。装一次，全局生效。
   */
  installTerminalCreatedClaim: () => void;

  /**
   * 弹出独立窗口的交接（docs/31 三期）：把终端标签从组里摘除，本地会话
   * **释放不杀**（registry.release）——PTY 留在 daemon 给 popout 重认领。
   */
  releaseTerminalToPopout: (terminalId: string) => boolean;

  /** 重认领（归拢 / popout 关闭 / F5）：按台账行找回终端建标签并激活 */
  readoptTerminal: (terminalId: string) => Promise<void>;
}

const TERMINAL_PREFS_KEY = "agent-workbench:terminal-prefs";

function readTerminalPrefs(): { agyDefaultYolo: boolean } {
  if (typeof window === "undefined") return { agyDefaultYolo: false };
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFS_KEY);
    if (!raw) return { agyDefaultYolo: false };
    const parsed = JSON.parse(raw);
    return { agyDefaultYolo: Boolean(parsed.agyDefaultYolo) };
  } catch {
    return { agyDefaultYolo: false };
  }
}

function persistTerminalPrefs(prefs: { agyDefaultYolo: boolean }): void {
  try {
    window.localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

const initialTerminalPrefs = readTerminalPrefs();

/** daemon terminal.list 的行形态（重挂、推送认领、popout 重认领共用） */
export interface DaemonTermRow {
  terminalId: string;
  shell: string;
  cwd: string;
  executor: string;
  unitId?: string;
  scrollback?: string;
}

function shellToProfileId(shell: string): string {
  const s = shell.toLowerCase();
  if (s.includes("pwsh")) return "pwsh";
  if (s.includes("powershell")) return "powershell";
  if (s.includes("cmd")) return "cmd";
  if (s.includes("wsl")) return "wsl";
  if (s.includes("bash")) return "bash";
  return "pwsh";
}

/** daemon 终端行 → 窗格（重挂、created 推送认领、popout 共用一套还原逻辑） */
export function adoptTermRow(
  t: DaemonTermRow,
  units: ReadonlyArray<{ id: string; name: string; rootPath?: string }>,
): CanvasPane {
  // 匹配 Bot：优先用终端记录的 unitId，兜底用工作目录匹配
  let targetUnitId = t.unitId;
  if (!targetUnitId && t.cwd) {
    const matched = units.find((u) => u.rootPath && u.rootPath === t.cwd);
    if (matched) targetUnitId = matched.id;
  }

  const isShell = t.executor === "shell" || t.executor === undefined || t.executor === "";
  const profileId = shellToProfileId(t.shell);
  const profile = SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId);

  const bot = targetUnitId ? units.find((u) => u.id === targetUnitId) : undefined;
  let title: string;
  if (bot) {
    const execName = t.executor && t.executor !== "shell" ? t.executor : "终端";
    title = `${bot.name} · ${execName} (TUI)`;
  } else if (isShell) {
    title = profile?.name ?? "终端";
  } else {
    title = t.executor ?? "终端";
  }

  return {
    id: t.terminalId,
    kind: "terminal",
    title,
    shell: t.shell,
    profileId,
    icon: isShell ? (profile?.icon ?? "pwsh") : t.executor,
    cwd: t.cwd,
    executorId: isShell ? undefined : t.executor,
    unitId: targetUnitId,
    createdAt: Date.now(),
    attachScrollback: t.scrollback,
    reattached: true,
  };
}

function newGroupId(): string {
  return `grp_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

/** 焦点跟随用的辅助：组内下一个激活标签（关标签后按 MRU 恢复） */
function nextActiveAfterClose(group: PaneGroup, closingPaneId: string): string | null {
  const remaining = group.tabOrder.filter((id) => id !== closingPaneId);
  if (remaining.length === 0) return null;
  for (let i = group.recentPaneIds.length - 1; i >= 0; i--) {
    const candidate = group.recentPaneIds[i]!;
    if (remaining.includes(candidate)) return candidate;
  }
  return remaining[remaining.length - 1] ?? null;
}

function touchRecent(group: PaneGroup, paneId: string): readonly string[] {
  return [...group.recentPaneIds.filter((id) => id !== paneId), paneId];
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => {
  /* ---- 内部：把窗格放进组（建组可选）；返回 [groupId, paneId] 焦点对 ---- */
  const addPaneToGroup = (
    pane: CanvasPane,
    opts: { groupId?: string; activate?: boolean; title?: string } = {},
  ): string => {
    const state = get();
    const groups = { ...state.groups };
    let targetGroupId = opts.groupId ?? state.activeGroupId;
    if (targetGroupId === null || groups[targetGroupId] === undefined) {
      // 没有可落点的组：开新组（树没有就单组全幅）
      targetGroupId = newGroupId();
      groups[targetGroupId] = { id: targetGroupId, tabOrder: [], activePaneId: null, recentPaneIds: [] };
    }
    const group = groups[targetGroupId]!;
    groups[targetGroupId] = {
      ...group,
      tabOrder: [...group.tabOrder, pane.id],
      activePaneId: opts.activate === false ? group.activePaneId : pane.id,
      recentPaneIds: opts.activate === false ? group.recentPaneIds : touchRecent(group, pane.id),
    };
    set({
      panes: { ...state.panes, [pane.id]: pane },
      groups,
      // 单组全幅约定（docs/32）：layout 只在组数 >1 时存在
      layout:
        Object.keys(groups).length > 1
          ? (state.layout ?? { type: "group", groupId: targetGroupId })
          : null,
      ...(opts.activate === false
        ? {}
        : { activeGroupId: targetGroupId, activePaneId: pane.id }),
    });
    return targetGroupId;
  };

  /* ---- 内部：规范化——空组塌缩、单组收平、焦点自愈 ---- */
  const normalize = (s: {
    panes: Readonly<Record<string, CanvasPane>>;
    groups: Readonly<Record<string, PaneGroup>>;
    layout: GroupLayoutNode | null;
    activeGroupId: string | null;
    activePaneId: string | null;
    maximizedPaneId: string | null;
  }): Partial<TerminalStoreState> => {
    const groups = { ...s.groups };
    let layout = s.layout;
    // 空组摘叶
    for (const g of Object.values(groups)) {
      if (g.tabOrder.length === 0 && (layout === null || collectGroupIds(layout).includes(g.id))) {
        if (layout !== null) {
          const next = removeGroupLeaf(layout, g.id);
          layout = next !== null && next.type === "group" ? null : next;
        }
        delete groups[g.id];
      }
    }
    // 单组收平
    if (layout !== null && layout.type === "group") layout = null;
    // 焦点自愈：组没了/标签没了 → 落到仍在的最后一个激活标签
    let { activeGroupId, activePaneId } = s;
    if (activeGroupId !== null && groups[activeGroupId] === undefined) activeGroupId = null;
    if (activePaneId !== null && s.panes[activePaneId] === undefined) activePaneId = null;
    if (activeGroupId === null || groups[activeGroupId] === undefined) {
      const firstGroup = Object.values(groups)[0];
      if (firstGroup !== undefined) {
        activeGroupId = firstGroup.id;
        if (activePaneId === null || !firstGroup.tabOrder.includes(activePaneId)) {
          activePaneId = firstGroup.activePaneId ?? firstGroup.tabOrder[firstGroup.tabOrder.length - 1] ?? null;
        }
      } else {
        activeGroupId = null;
        activePaneId = null;
      }
    }
    const maximizedPaneId = s.maximizedPaneId !== null && s.panes[s.maximizedPaneId] === undefined ? null : s.maximizedPaneId;
    return { groups, layout, activeGroupId, activePaneId, ...(maximizedPaneId !== s.maximizedPaneId ? { maximizedPaneId } : {}) };
  };

  /* ---- 内部：从组里摘标签（不删 pane 记录；返回受影响的组快照） ---- */
  const detachPaneFromGroup = (paneId: string): void => {
    const state = get();
    for (const g of Object.values(state.groups)) {
      if (!g.tabOrder.includes(paneId)) continue;
      const tabOrder = g.tabOrder.filter((id) => id !== paneId);
      const activePaneId = g.activePaneId === paneId ? nextActiveAfterClose(g, paneId) : g.activePaneId;
      set((s) => ({
        groups: {
          ...s.groups,
          [g.id]: { ...g, tabOrder, activePaneId, recentPaneIds: g.recentPaneIds.filter((id) => id !== paneId) },
        },
      }));
      return;
    }
  };

  return {
    panes: {},
    groups: {},
    layout: null,
    activeGroupId: null,
    activePaneId: null,
    maximizedPaneId: null,
    defaultProfileId: "pwsh",
    reattachDone: false,
    claimInstalled: false,
    pendingUnitDispatch: {},
    agyDefaultYolo: initialTerminalPrefs.agyDefaultYolo,

    notePendingUnitDispatch: (unitId) => {
      set((s) => ({ pendingUnitDispatch: { ...s.pendingUnitDispatch, [unitId]: Date.now() + 5000 } }));
    },

    setAgyDefaultYolo: (val) => {
      set({ agyDefaultYolo: val });
      persistTerminalPrefs({ agyDefaultYolo: val });
    },

    createTab: (opts = {}) => {
      const profileId = opts.profileId ?? get().defaultProfileId;
      const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
      const profile: TerminalProfile =
        SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;

      let finalExecutorId = opts.executorId;
      let finalTitle = opts.title;

      // 当用户未显式指定 yolo 且全局偏好配置了 agy 默认走 yolo 时，直启 agy:yolo
      const bareExec = finalExecutorId ? finalExecutorId.replace(/^daemon:/, "").toLowerCase() : "";
      if ((bareExec === "agy" || bareExec === "antigravity") && get().agyDefaultYolo) {
        finalExecutorId = "agy:yolo";
        if (!finalTitle) finalTitle = "Antigravity (YOLO)";
      }

      const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
      const count = Object.values(get().panes).filter((p) => p.kind === "terminal" && p.profileId === profile.id).length + 1;
      const title =
        finalTitle ??
        (finalExecutorId
          ? finalExecutorId.endsWith(":yolo")
            ? `${finalExecutorId.replace(/:yolo$/, "")} (YOLO)`
            : `${finalExecutorId} (pwsh)`
          : `${profile.name} #${count}`);

      const pane: CanvasPane = {
        id,
        kind: "terminal",
        title,
        shell: profile.shell,
        profileId: profile.id,
        icon: finalExecutorId ? finalExecutorId : profile.icon,
        cwd: opts.cwd ?? "",
        executorId: finalExecutorId,
        unitId: opts.unitId,
        createdAt: Date.now(),
      };
      addPaneToGroup(pane);
      return id;
    },

    createChatTab: (paneKey) => {
      addPaneToGroup({ id: paneKey, kind: "chat", title: "对话" });
      return paneKey;
    },

    activatePane: (paneId) => {
      const state = get();
      if (state.panes[paneId] === undefined) return;
      for (const g of Object.values(state.groups)) {
        if (!g.tabOrder.includes(paneId)) continue;
        set((s) => ({
          activeGroupId: g.id,
          activePaneId: paneId,
          groups: { ...s.groups, [g.id]: { ...g, activePaneId: paneId, recentPaneIds: touchRecent(g, paneId) } },
        }));
        return;
      }
    },

    focusChatPaneTab: (paneKey) => get().activatePane(paneKey),

    setActiveGroup: (groupId) => {
      const group = get().groups[groupId];
      if (group === undefined) return;
      const paneId = group.activePaneId ?? group.tabOrder[group.tabOrder.length - 1] ?? null;
      set((s) => ({
        activeGroupId: groupId,
        activePaneId: paneId,
        ...(paneId !== null
          ? { groups: { ...s.groups, [groupId]: { ...group, activePaneId: paneId, recentPaneIds: touchRecent(group, paneId) } } }
          : {}),
        maximizedPaneId: null,
      }));
    },

    splitPane: (opts = {}) => {
      const state = get();
      // 拆分对象 = 激活组（docs/32：分屏的原子是组）
      const sourceGroupId = state.activeGroupId ?? Object.keys(state.groups)[0] ?? null;
      const direction: SplitDirection = opts.direction ?? "horizontal";
      const gid = newGroupId();
      const groups: Record<string, PaneGroup> = {
        ...state.groups,
        [gid]: { id: gid, tabOrder: [], activePaneId: null, recentPaneIds: [] },
      };
      if (opts.chatPaneKey !== undefined) {
        set((s) => ({
          groups,
          layout:
            sourceGroupId === null
              ? null
              : splitGroupNode(s.layout ?? { type: "group", groupId: sourceGroupId }, sourceGroupId, gid, direction, false),
        }));
        addPaneToGroup(
          { id: opts.chatPaneKey, kind: "chat", title: "对话" },
          { groupId: gid },
        );
        return gid;
      }
      // 终端新标签直接构造后入组（createTab 的字段逻辑内联，避免二次 set 抖动）
      const profileId = opts.profileId ?? state.defaultProfileId;
      const profile = SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? SUPPORTED_TERMINAL_PROFILES[0]!;
      const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
      const count = Object.values(state.panes).filter((p) => p.kind === "terminal" && p.profileId === profileId).length + 1;
      const pane: CanvasPane = {
        id,
        kind: "terminal",
        title: opts.title ?? (opts.executorId ? `${opts.executorId} (pwsh)` : `${profile.name} #${count}`),
        shell: profile.shell,
        profileId: profile.id,
        icon: opts.executorId ? opts.executorId : profile.icon,
        cwd: opts.cwd ?? "",
        executorId: opts.executorId,
        unitId: opts.unitId,
        createdAt: Date.now(),
      };
      set((s) => ({
        groups,
        layout:
          sourceGroupId === null
            ? null
            : splitGroupNode(s.layout ?? { type: "group", groupId: sourceGroupId }, sourceGroupId, gid, direction, false),
      }));
      addPaneToGroup(pane, { groupId: gid });
      return gid;
    },

    closePane: (paneId) => {
      const pane = get().panes[paneId];
      if (pane === undefined) return;
      if (pane.kind === "terminal") terminalSessionRegistry.dispose(paneId);
      else useChatPanes.getState().handlePaneClosed(paneId);
      detachPaneFromGroup(paneId);
      set((s) => {
        const panes = { ...s.panes };
        delete panes[paneId];
        return normalize({ ...s, panes });
      });
    },

    closeOtherPanes: (keepPaneId) => {
      const state = get();
      const pane = state.panes[keepPaneId];
      if (pane === undefined) return;
      for (const g of Object.values(state.groups)) {
        if (!g.tabOrder.includes(keepPaneId)) continue;
        for (const id of g.tabOrder) {
          if (id === keepPaneId) continue;
          const p = state.panes[id];
          if (p === undefined) continue;
          if (p.kind === "terminal") terminalSessionRegistry.dispose(id);
          else useChatPanes.getState().handlePaneClosed(id);
        }
        set((s) => {
          const panes = { ...s.panes };
          for (const id of g.tabOrder) if (id !== keepPaneId) delete panes[id];
          const groups = {
            ...s.groups,
            [g.id]: { ...g, tabOrder: [keepPaneId], activePaneId: keepPaneId, recentPaneIds: [keepPaneId] },
          };
          return normalize({ ...s, panes, groups, activeGroupId: g.id, activePaneId: keepPaneId });
        });
        return;
      }
    },

    closeGroup: (groupId) => {
      const group = get().groups[groupId];
      if (group === undefined) return;
      for (const id of group.tabOrder) {
        const p = get().panes[id];
        if (p === undefined) continue;
        if (p.kind === "terminal") terminalSessionRegistry.dispose(id);
        else useChatPanes.getState().handlePaneClosed(id);
      }
      set((s) => {
        const panes = { ...s.panes };
        for (const id of group.tabOrder) delete panes[id];
        const groups = { ...s.groups };
        delete groups[groupId];
        let layout = s.layout;
        if (layout !== null) {
          const next = removeGroupLeaf(layout, groupId);
          layout = next !== null && next.type === "group" ? null : next;
        }
        return normalize({ ...s, panes, groups, layout });
      });
    },

    movePaneToGroup: (paneId, toGroupId, index) => {
      const state = get();
      if (state.panes[paneId] === undefined || state.groups[toGroupId] === undefined) return;
      const fromGroup = Object.values(state.groups).find((g) => g.tabOrder.includes(paneId));
      if (fromGroup === undefined) return;
      if (fromGroup.id === toGroupId) {
        // 组内重排
        set((s) => {
          const g = s.groups[toGroupId]!;
          const order = g.tabOrder.filter((id) => id !== paneId);
          const at = index === undefined ? order.length : Math.max(0, Math.min(order.length, index));
          order.splice(at, 0, paneId);
          return { groups: { ...s.groups, [toGroupId]: { ...g, tabOrder: order } } };
        });
        return;
      }
      detachPaneFromGroup(paneId);
      set((s) => {
        const target = s.groups[toGroupId]!;
        const order = [...target.tabOrder];
        const at = index === undefined ? order.length : Math.max(0, Math.min(order.length, index));
        order.splice(at, 0, paneId);
        const groups = {
          ...s.groups,
          [toGroupId]: { ...target, tabOrder: order, activePaneId: paneId, recentPaneIds: touchRecent(target, paneId) },
        };
        return normalize({ ...s, groups, activeGroupId: toGroupId, activePaneId: paneId });
      });
    },

    dropPaneOnGroup: (paneId, targetGroupId, zone) => {
      const state = get();
      if (state.panes[paneId] === undefined || state.groups[targetGroupId] === undefined) return;
      if (zone === "center") {
        get().movePaneToGroup(paneId, targetGroupId);
        return;
      }
      if (get().isSplitDropNoOp(paneId, targetGroupId)) return;
      const direction: SplitDirection = zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const newFirst = zone === "left" || zone === "top";
      // 先摘出拖动标签（原组可能塌缩），再把目标组一分为二、新组承载该标签
      detachPaneFromGroup(paneId);
      set((s) => {
        if (s.groups[targetGroupId] === undefined) return {};
        const gid = newGroupId();
        const groups: Record<string, PaneGroup> = {
          ...s.groups,
          [gid]: { id: gid, tabOrder: [], activePaneId: null, recentPaneIds: [] },
        };
        const layout = splitGroupNode(s.layout ?? { type: "group", groupId: targetGroupId }, targetGroupId, gid, direction, newFirst);
        const target = { ...groups[targetGroupId]! };
        const order = [...target.tabOrder, paneId];
        groups[gid] = { ...groups[gid]!, tabOrder: order, activePaneId: paneId, recentPaneIds: [paneId] };
        return normalize({ ...s, groups, layout, activeGroupId: gid, activePaneId: paneId, maximizedPaneId: null });
      });
    },

    isSplitDropNoOp: (paneId, targetGroupId) => {
      const state = get();
      const fromGroup = Object.values(state.groups).find((g) => g.tabOrder.includes(paneId));
      if (fromGroup === undefined) return false;
      // 拖自己组里最后一个标签到自身四边：分出来的新组还是它，等于没动
      return fromGroup.id === targetGroupId && fromGroup.tabOrder.length === 1;
    },

    toggleMaximize: (paneId) => {
      const target = paneId ?? get().activePaneId;
      set((s) => ({ maximizedPaneId: s.maximizedPaneId === target ? null : (target ?? null) }));
    },

    setSplitRatio: (splitId, ratio) => {
      const clamped = Math.max(0.08, Math.min(0.92, ratio));
      set((s) => (s.layout === null ? {} : { layout: updateSplitRatio(s.layout, splitId, clamped) }));
    },

    renamePane: (paneId, title) => {
      set((s) => {
        const pane = s.panes[paneId];
        if (pane === undefined) return {};
        return { panes: { ...s.panes, [paneId]: { ...pane, title } } };
      });
    },

    clearAll: () => {
      terminalSessionRegistry.disposeAll();
      set({ panes: {}, groups: {}, layout: null, activeGroupId: null, activePaneId: null, maximizedPaneId: null });
    },

    reattachFromDaemon: async () => {
      // 用户这次会话已经建过标签就不动 —— 重挂只在首载跑一次
      if (get().activeGroupId !== null || get().reattachDone) {
        set({ reattachDone: true });
        return;
      }
      let list: DaemonTermRow[];
      try {
        const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
        const client = DaemonClient.get(defaultDaemonEndpoint());
        list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
      } catch {
        set({ reattachDone: true }); // daemon 没起：放行空态
        return;
      }
      if (get().activeGroupId !== null || get().reattachDone) {
        set({ reattachDone: true });
        return;
      }
      // 对话页小终端除外：它归 ChatTerminalDock 自己认领（unitId 标记）
      const adopted = list.filter((t) => t.unitId !== CHAT_DOCK_UNIT_ID).map((t) => t);
      if (adopted.length === 0) {
        set({ reattachDone: true });
        return;
      }

      const { useWorkbench } = await import("./useWorkbench.ts");
      const units = useWorkbench.getState().units;
      const panes: Record<string, CanvasPane> = {};
      const groupId = newGroupId();
      const tabOrder: string[] = [];
      for (const row of adopted) {
        const pane = adoptTermRow(row, units);
        panes[pane.id] = pane;
        tabOrder.push(pane.id);
      }
      const activeUnitId = useWorkbench.getState().activeUnitId;
      const initialPane = activeUnitId
        ? (tabOrder.find((id) => panes[id]!.unitId === activeUnitId) ?? tabOrder[0])
        : tabOrder[0];
      set({
        panes,
        groups: { [groupId]: { id: groupId, tabOrder, activePaneId: initialPane ?? null, recentPaneIds: initialPane !== undefined ? [initialPane!] : [] } },
        layout: null,
        activeGroupId: groupId,
        activePaneId: initialPane ?? null,
        reattachDone: true,
      });
    },

    installTerminalCreatedClaim: () => {
      if (get().claimInstalled) return;
      set({ claimInstalled: true });
      void (async () => {
        const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
        const client = DaemonClient.get(defaultDaemonEndpoint());
        // WS 是懒连接（首个 rpc 才拨）：认领必须先把管道撑开
        await client.ensureConnected().catch(() => {});
        client.onTerminalFrame((f) => {
          if (f.kind !== "created") return;
          if (get().panes[f.terminalId] !== undefined) return;
          // 对话页小终端不进标签树：它有自己的挂载点（ChatTerminalDock）
          if (f.unitId === CHAT_DOCK_UNIT_ID) return;
          void (async () => {
            try {
              // created 帧只带档案字段；补拉一次 list 拿 scrollback（启动横幅只有它有）
              const list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
              const row = list.find((t) => t.terminalId === f.terminalId);
              if (row === undefined) return; // 创建即秒退的终端：不建占位标签
              const { useWorkbench } = await import("./useWorkbench.ts");
              const { useShell } = await import("./useShell.ts");
              const pane = adoptTermRow(row, useWorkbench.getState().units);
              if (get().panes[f.terminalId] !== undefined) return; // 双帧竞态兜底
              addPaneToGroup(pane);
              // 定时任务到点的意义就是「让我看到」：主视图不在工作区就切回来
              if (useShell.getState().mainView !== "chat") useShell.getState().setMainView("chat");
            } catch {
              // daemon 断连等瞬时失败：放弃这一次，F5 重挂是兜底
            }
          })();
        });
      })();
    },

    releaseTerminalToPopout: (terminalId) => {
      const pane = get().panes[terminalId];
      if (pane === undefined || pane.kind !== "terminal") return false;
      // 释放本地会话（不杀 PTY）——popout 窗口重新 subscribe 接管
      terminalSessionRegistry.release(terminalId);
      detachPaneFromGroup(terminalId);
      set((s) => {
        const panes = { ...s.panes };
        delete panes[terminalId];
        return normalize({ ...s, panes });
      });
      return true;
    },

    readoptTerminal: async (terminalId) => {
      // 已在标签里：只激活（双开同一 PTY 会两处 xterm 抢同一画布）
      if (get().panes[terminalId] !== undefined) {
        get().activatePane(terminalId);
        return;
      }
      let row: DaemonTermRow | undefined;
      try {
        const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
        const client = DaemonClient.get(defaultDaemonEndpoint());
        const list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
        row = list.find((t) => t.terminalId === terminalId);
      } catch {
        return; // daemon 抖动：静默放弃，F5 重挂是兜底
      }
      if (row === undefined) return; // PTY 已死：没有可认领的东西
      const { useWorkbench } = await import("./useWorkbench.ts");
      addPaneToGroup(adoptTermRow(row, useWorkbench.getState().units));
    },
  };
});

/* ------------------------------------------------------- 兼容别名（docs/31 遗留面） */

/** 按窗格 id 找所属组（消费方：TUI 活标签激活 / popout / 布局恢复） */
export function findGroupOfPane(
  groups: Readonly<Record<string, PaneGroup>>,
  paneId: string,
): PaneGroup | undefined {
  return Object.values(groups).find((g) => g.tabOrder.includes(paneId));
}

/** 树/组状态里的全部窗格 id（持久化与清理用） */
export function allPaneIds(groups: Readonly<Record<string, PaneGroup>>): string[] {
  return Object.values(groups).flatMap((g) => [...g.tabOrder]);
}
