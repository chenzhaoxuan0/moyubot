import { create } from "zustand";
import { terminalSessionRegistry, CHAT_DOCK_UNIT_ID } from "./TerminalSessionManager.ts";
import { useChatPanes } from "./useChatPanes.ts";

export type SplitDirection = "horizontal" | "vertical"; // horizontal = 左右 (row), vertical = 上下 (col)

/**
 * 画布布局树（docs/31 会话画布）—— leaf 泛化为双 kind：
 * - "leaf" 终端窗格（系统终端 / Agent TUI，指向 TerminalInstanceItem）
 * - "chatLeaf" 对话窗格（结构化对话，paneKey 指向 useChatPanes 注册表）
 * 同一棵树里可任意混排（对话 | TUI 并排是杀手场景）。
 */
export type LayoutNode =
  | {
      type: "leaf";
      instanceId: string;
    }
  | {
      type: "chatLeaf";
      paneKey: string;
    }
  | {
      type: "branch";
      id: string;
      direction: SplitDirection;
      first: LayoutNode;
      second: LayoutNode;
      ratio: number; // 0.1 ~ 0.9, 默认 0.5
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
  /** 来自重挂 —— 背后是活进程，不是占位标签，不许被「换 bot 专属标签」的启发式顺手关掉 */
  reattached?: boolean;
}

export interface TerminalTabGroup {
  id: string;
  title?: string;
  rootLayout: LayoutNode;
}

/** 递归获取树中所有终端窗格的 instanceId（dispose / 终端匹配专用；不含 chat 窗格） */
export function collectLeafIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.instanceId];
  if (node.type === "chatLeaf") return [];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/** 递归获取树中所有 chat 窗格的 paneKey */
export function collectChatPaneKeys(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [];
  if (node.type === "chatLeaf") return [node.paneKey];
  return [...collectChatPaneKeys(node.first), ...collectChatPaneKeys(node.second)];
}

/** 树中窗格总数（双 kind，标签徽章 / mini-bar 判定用） */
export function countLeaves(node: LayoutNode | null): number {
  return collectLeafIds(node).length + collectChatPaneKeys(node).length;
}

/** 叶子是否就是指定窗格（instanceId 与 paneKey 命名空间不重叠，按 id 通配） */
function leafMatches(node: LayoutNode, targetId: string): boolean {
  if (node.type === "leaf") return node.instanceId === targetId;
  if (node.type === "chatLeaf") return node.paneKey === targetId;
  return false;
}

/** 递归找到包含指定窗格（任意 kind）的分组 */
export function findGroupOfPane(
  groups: readonly TerminalTabGroup[],
  targetId: string,
): TerminalTabGroup | undefined {
  return groups.find((g) => paneInLayout(g.rootLayout, targetId));
}

function paneInLayout(node: LayoutNode | null, targetId: string): boolean {
  if (!node) return false;
  if (node.type === "leaf" || node.type === "chatLeaf") return leafMatches(node, targetId);
  return paneInLayout(node.first, targetId) || paneInLayout(node.second, targetId);
}

/** 递归拆分指定窗格（任意 kind），新窗格由调用方给出（终端 leaf 或 chatLeaf） */
export function splitTreeNode(
  node: LayoutNode,
  targetId: string,
  newLeaf: LayoutNode,
  direction: SplitDirection,
): LayoutNode {
  if (node.type === "leaf" || node.type === "chatLeaf") {
    if (leafMatches(node, targetId)) {
      return {
        type: "branch",
        id: `br_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`,
        direction,
        first: node,
        second: newLeaf,
        ratio: 0.5,
      };
    }
    return node;
  }
  return {
    ...node,
    first: splitTreeNode(node.first, targetId, newLeaf, direction),
    second: splitTreeNode(node.second, targetId, newLeaf, direction),
  };
}

/** 递归移除指定窗格（任意 kind），兄弟节点自动提升填补空间 */
export function removeTreeNode(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.type === "leaf" || node.type === "chatLeaf") {
    return leafMatches(node, targetId) ? null : node;
  }
  const newFirst = removeTreeNode(node.first, targetId);
  const newSecond = removeTreeNode(node.second, targetId);
  if (!newFirst && !newSecond) return null;
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;
  return {
    ...node,
    first: newFirst,
    second: newSecond,
  };
}

/** 递归更新分屏比例 */
export function updateTreeRatio(
  node: LayoutNode,
  branchId: string,
  ratio: number,
): LayoutNode {
  if (node.type === "leaf" || node.type === "chatLeaf") return node;
  if (node.id === branchId) {
    return { ...node, ratio };
  }
  return {
    ...node,
    first: updateTreeRatio(node.first, branchId, ratio),
    second: updateTreeRatio(node.second, branchId, ratio),
  };
}

interface TerminalStoreState {
  instances: TerminalInstanceItem[];
  groups: TerminalTabGroup[];
  activeGroupId: string | null;
  activeInstanceId: string | null;
  /**
   * 焦点 chat 窗格的游标（docs/31）。焦点窗格可能是终端（activeInstanceId）
   * 或对话（activeChatPaneKey），两者互斥：任一聚焦都清掉另一个。
   * useChatPanes.installChatPaneSync 订阅它的变化驱动快照/恢复。
   */
  activeChatPaneKey: string | null;
  maximizedInstanceId: string | null;
  defaultProfileId: string;
  /** 首载重挂是否已尝试过（无论找没找到）—— 空态自动建标签必须等它，否则抢占重挂 */
  reattachDone: boolean;
  /**
   * 派发在途登记（unitId → 过期时刻）。侧栏历史行 / 历史弹窗直点「TUI 恢复」后，
   * 「终端跟随 bot」effect 会因标签还没落地（created 帧在途）而再派发一个**全新的**
   * TUI —— 双进程竞态。登记 5s 内的派发意图，跟随 effect 看到即跳过。
   */
  pendingUnitDispatch: Record<string, number>;
  notePendingUnitDispatch: (unitId: string) => void;
  /** created 帧推送认领是否已装（幂等闸，防止重复订阅） */
  claimInstalled: boolean;
  /** 终端启动 Antigravity 时是否默认携带 --dangerously-skip-permissions 免审批 */
  agyDefaultYolo: boolean;
  setAgyDefaultYolo: (val: boolean) => void;

  /** 新建独立终端标签页 */
  createTab: (opts?: {
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
    unitId?: string;
  }) => string;

  /** 新建对话标签页（chatLeaf 单窗格组）；activate=false 只建标签不抢焦点（F5 种子重建用） */
  createChatTab: (paneKey: string, activate?: boolean) => string;

  /** 自由拆分（支持任意嵌套左右/上下；目标与新窗格都可为终端或对话窗格） */
  splitPane: (opts?: {
    /** 拆分目标窗格（instanceId 或 paneKey，任意 kind）；缺省 = 焦点窗格 */
    targetPaneId?: string;
    /** 拆分方向 */
    direction?: SplitDirection;
    /* —— 终端窗格的创建参数（chatPaneKey 存在时忽略） —— */
    profileId?: string;
    cwd?: string;
    executorId?: string;
    title?: string;
    unitId?: string;
    /* —— 对话窗格：给出 paneKey 则新窗格为 chatLeaf —— */
    chatPaneKey?: string;
  }) => string | null;

  /** 关闭单个终端窗格（若为标签页内最后一个窗格，则连带关闭标签页） */
  closePane: (instanceId: string) => void;

  /** 关闭对话窗格（删窗格不杀会话；组内最后一个则连带关标签） */
  closeChatPane: (paneKey: string) => void;

  /** 把焦点游标翻到某个 chat 窗格（点窗格本体 / 标签激活走这里） */
  focusChatPaneTab: (paneKey: string) => void;

  /** 关闭整个标签页组 */
  closeTab: (groupId: string) => void;

  /** 标签右键：保留该组，杀掉其余全部（含各组分屏窗格）并激活保留组 */
  closeOtherTabs: (keepGroupId: string) => void;

  /** 标签右键：杀掉全部终端、清空所有标签组 */
  closeAllTabs: () => void;

  /** 设置当前活跃标签组 */
  setActiveGroup: (groupId: string) => void;

  /** 设置当前聚焦的窗格实例 */
  setActiveInstance: (instanceId: string) => void;

  /** 调整分屏分割线比例 */
  setBranchRatio: (branchId: string, ratio: number) => void;

  /** 最大化 / 还原窗格 */
  toggleMaximize: (instanceId?: string) => void;

  /** 重命名实例 */
  renameInstance: (instanceId: string, title: string) => void;

  /** 重命名标签页 */
  renameTab: (groupId: string, title: string) => void;

  /** 全部清空销毁 */
  clearAll: () => void;

  /**
   * F5 重挂：把 daemon 里还活着的 PTY 找回来（terminal.list），逐个还原成标签。
   * 没有它，刷新一次就积累一批孤儿进程 —— 界面上再也关不掉，直到手杀 daemon。
   */
  reattachFromDaemon: () => Promise<void>;

  /**
   * created 帧推送认领：daemon 侧新建的终端（定时任务 TUI 派发）主动推帧过来，
   * 前端收到即开标签并切过去 —— 不等 F5、不轮询。装一次，全局生效。
   */
  installTerminalCreatedClaim: () => void;

  // 兼容别名
  createInstance: (opts?: { profileId?: string; cwd?: string; executorId?: string; title?: string }) => string;
  closeInstance: (id: string) => void;
  splitWithNew: (profileId?: string) => string | null;
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

/** daemon terminal.list 的行形态（重挂与推送认领共用） */
interface DaemonTermRow {
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

/** daemon 终端行 → 标签实例 + 独立标签组（重挂、created 推送认领共用一套还原逻辑） */
function adoptTermRow(
  t: DaemonTermRow,
  units: ReadonlyArray<{ id: string; name: string; rootPath?: string }>,
): { instance: TerminalInstanceItem; group: TerminalTabGroup } {
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

  const instance: TerminalInstanceItem = {
    id: t.terminalId,
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
  return { instance, group: { id: `group_${t.terminalId}`, rootLayout: { type: "leaf", instanceId: t.terminalId } } };
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  instances: [],
  groups: [],
  activeGroupId: null,
  activeInstanceId: null,
  maximizedInstanceId: null,
  activeChatPaneKey: null,
  defaultProfileId: "pwsh",
  reattachDone: false,
  claimInstalled: false,
  pendingUnitDispatch: {},
  agyDefaultYolo: initialTerminalPrefs.agyDefaultYolo,

  notePendingUnitDispatch: (unitId) => {
    set((s) => ({ pendingUnitDispatch: { ...s.pendingUnitDispatch, [unitId]: Date.now() + 5000 } }));
  },

  setAgyDefaultYolo: (val: boolean) => {
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
    if (
      (bareExec === "agy" || bareExec === "antigravity") &&
      get().agyDefaultYolo
    ) {
      finalExecutorId = "agy:yolo";
      if (!finalTitle) finalTitle = "Antigravity (YOLO)";
    }

    const id = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = get().instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      finalTitle ??
      (finalExecutorId
        ? finalExecutorId.endsWith(":yolo")
          ? `${finalExecutorId.replace(/:yolo$/, "")} (YOLO)`
          : `${finalExecutorId} (pwsh)`
        : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: finalExecutorId ? finalExecutorId : profile.icon,
      cwd: opts.cwd ?? "",
      executorId: finalExecutorId,
      unitId: opts.unitId,
      createdAt: Date.now(),
    };

    const groupId = `group_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
    const newGroup: TerminalTabGroup = {
      id: groupId,
      title,
      rootLayout: { type: "leaf", instanceId: id },
    };

    set((state) => ({
      instances: [...state.instances, newInst],
      groups: [...state.groups, newGroup],
      activeGroupId: groupId,
      activeInstanceId: id,
      activeChatPaneKey: null,
    }));

    return id;
  },

  createChatTab: (paneKey, activate = true) => {
    const groupId = `group_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
    const newGroup: TerminalTabGroup = {
      id: groupId,
      rootLayout: { type: "chatLeaf", paneKey },
    };
    set((state) => ({
      groups: [...state.groups, newGroup],
      // F5 种子重建不抢焦点：焦点由 hash 路由回放决定，抢了会跟它打架
      ...(activate
        ? { activeGroupId: groupId, activeInstanceId: null, activeChatPaneKey: paneKey }
        : {}),
      maximizedInstanceId: null,
    }));
    return groupId;
  },

  focusChatPaneTab: (paneKey) => {
    const group = findGroupOfPane(get().groups, paneKey);
    if (!group) return;
    set({
      activeGroupId: group.id,
      activeInstanceId: null,
      activeChatPaneKey: paneKey,
      maximizedInstanceId: null,
    });
  },

  splitPane: (opts = {}) => {
    const { activeInstanceId, activeChatPaneKey, groups, instances } = get();
    // 拆分目标：显式指定（任意 kind）→ 焦点窗格（chat 游标优先）→ 首个窗格
    const targetId =
      opts.targetPaneId ??
      activeChatPaneKey ??
      activeInstanceId ??
      collectLeafIds(groups[0]?.rootLayout ?? null)[0] ??
      collectChatPaneKeys(groups[0]?.rootLayout ?? null)[0];
    if (!targetId) {
      return get().createTab(opts);
    }

    // 找到包含该目标的标签组
    const group = findGroupOfPane(groups, targetId);
    if (!group) {
      return get().createTab(opts);
    }

    const direction: SplitDirection = opts.direction ?? "horizontal";

    // 对话窗格落在目标旁边（对话|对话、终端|对话 混排都是合法组合）
    if (opts.chatPaneKey !== undefined) {
      const chatLayout = splitTreeNode(group.rootLayout, targetId, { type: "chatLeaf", paneKey: opts.chatPaneKey }, direction);
      set((state) => ({
        groups: state.groups.map((g) =>
          g.id === group.id ? { ...g, rootLayout: chatLayout } : g,
        ),
        activeGroupId: group.id,
        activeInstanceId: null,
        activeChatPaneKey: opts.chatPaneKey,
        maximizedInstanceId: null,
      }));
      return opts.chatPaneKey;
    }

    const targetInst = instances.find((i) => i.id === targetId);
    const profileId = opts.profileId ?? targetInst?.profileId ?? get().defaultProfileId;
    const fallbackProfile: TerminalProfile = SUPPORTED_TERMINAL_PROFILES[0]!;
    const profile: TerminalProfile =
      SUPPORTED_TERMINAL_PROFILES.find((p) => p.id === profileId) ?? fallbackProfile;

    const newId = `term_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
    const count = instances.filter((i) => i.profileId === profile.id).length + 1;
    const title =
      opts.title ??
      (opts.executorId
        ? `${opts.executorId} (pwsh)`
        : `${profile.name} #${count}`);

    const newInst: TerminalInstanceItem = {
      id: newId,
      title,
      shell: profile.shell,
      profileId: profile.id,
      icon: opts.executorId ? opts.executorId : profile.icon,
      cwd: opts.cwd ?? targetInst?.cwd ?? "",
      executorId: opts.executorId,
      unitId: opts.unitId,
      createdAt: Date.now(),
    };

    const updatedLayout = splitTreeNode(group.rootLayout, targetId, { type: "leaf", instanceId: newId }, direction);

    set((state) => ({
      instances: [...state.instances, newInst],
      groups: state.groups.map((g) =>
        g.id === group.id ? { ...g, rootLayout: updatedLayout } : g,
      ),
      activeGroupId: group.id,
      activeInstanceId: newId,
      activeChatPaneKey: null,
      maximizedInstanceId: null, // 拆分时自动解除最大化
    }));

    return newId;
  },

  closeChatPane: (paneKey) => {
    const group = findGroupOfPane(get().groups, paneKey);
    useChatPanes.getState().handlePaneClosed(paneKey);
    if (!group) return;
    // 关窗格不杀会话（docs/31 §四）：只摘布局叶子；组内最后一个叶子连带关标签
    const updatedLayout = removeTreeNode(group.rootLayout, paneKey);
    if (!updatedLayout) {
      get().closeTab(group.id);
      return;
    }
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === group.id ? { ...g, rootLayout: updatedLayout } : g,
      ),
      ...(state.activeChatPaneKey === paneKey ? { activeChatPaneKey: null } : {}),
    }));
  },

  closePane: (instanceId: string) => {
    terminalSessionRegistry.dispose(instanceId);

    set((state) => {
      const group = state.groups.find((g) =>
        collectLeafIds(g.rootLayout).includes(instanceId),
      );
      if (!group) {
        return {
          instances: state.instances.filter((i) => i.id !== instanceId),
        };
      }

      const updatedLayout = removeTreeNode(group.rootLayout, instanceId);
      const newInstances = state.instances.filter((i) => i.id !== instanceId);

      let newGroups = state.groups;
      let newActiveGroupId = state.activeGroupId;
      let newActiveInstanceId = state.activeInstanceId;
      let newActiveChatPaneKey = state.activeChatPaneKey;

      if (!updatedLayout) {
        // 该组已无任何窗格，关闭整个组
        const gIdx = state.groups.findIndex((g) => g.id === group.id);
        newGroups = state.groups.filter((g) => g.id !== group.id);
        if (state.activeGroupId === group.id) {
          if (newGroups.length > 0) {
            const nextIdx = Math.max(0, gIdx - 1);
            newActiveGroupId = newGroups[nextIdx]?.id ?? null;
            const nextRoot = newGroups[nextIdx]?.rootLayout ?? null;
            newActiveInstanceId = collectLeafIds(nextRoot)[0] ?? null;
            newActiveChatPaneKey = collectChatPaneKeys(nextRoot)[0] ?? null;
          } else {
            newActiveGroupId = null;
            newActiveInstanceId = null;
            newActiveChatPaneKey = null;
          }
        }
      } else {
        // 更新组内布局树
        newGroups = state.groups.map((g) =>
          g.id === group.id ? { ...g, rootLayout: updatedLayout } : g,
        );
        if (state.activeInstanceId === instanceId) {
          // 混排组里终端关掉后，焦点让给剩下的 chat 窗格（若有）
          newActiveInstanceId = collectLeafIds(updatedLayout)[0] ?? null;
          if (newActiveInstanceId === null) {
            newActiveChatPaneKey = collectChatPaneKeys(updatedLayout)[0] ?? null;
          }
        }
      }

      return {
        instances: newInstances,
        groups: newGroups,
        activeGroupId: newActiveGroupId,
        activeInstanceId: newActiveInstanceId,
        ...(newActiveChatPaneKey !== state.activeChatPaneKey ? { activeChatPaneKey: newActiveChatPaneKey } : {}),
        maximizedInstanceId:
          state.maximizedInstanceId === instanceId ? null : state.maximizedInstanceId,
      };
    });
  },

  closeTab: (groupId: string) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;

    const leafIds = collectLeafIds(group.rootLayout);
    leafIds.forEach((id) => terminalSessionRegistry.dispose(id));
    // chat 窗格摘注册表记录（不杀会话）；焦点游标归位交给下面的激活逻辑
    for (const paneKey of collectChatPaneKeys(group.rootLayout)) {
      useChatPanes.getState().handlePaneClosed(paneKey);
    }

    set((state) => {
      const gIdx = state.groups.findIndex((g) => g.id === groupId);
      const newGroups = state.groups.filter((g) => g.id !== groupId);
      const newInstances = state.instances.filter((i) => !leafIds.includes(i.id));

      let newActiveGroupId = state.activeGroupId;
      let newActiveInstanceId = state.activeInstanceId;
      let newActiveChatPaneKey = state.activeChatPaneKey;

      if (state.activeGroupId === groupId) {
        if (newGroups.length > 0) {
          const nextIdx = Math.max(0, gIdx - 1);
          newActiveGroupId = newGroups[nextIdx]?.id ?? null;
          const nextRoot = newGroups[nextIdx]?.rootLayout ?? null;
          newActiveInstanceId = collectLeafIds(nextRoot)[0] ?? null;
          newActiveChatPaneKey = collectChatPaneKeys(nextRoot)[0] ?? null;
        } else {
          newActiveGroupId = null;
          newActiveInstanceId = null;
          newActiveChatPaneKey = null;
        }
      }

      return {
        instances: newInstances,
        groups: newGroups,
        activeGroupId: newActiveGroupId,
        activeInstanceId: newActiveInstanceId,
        ...(newActiveChatPaneKey !== state.activeChatPaneKey ? { activeChatPaneKey: newActiveChatPaneKey } : {}),
      };
    });
  },

  setActiveGroup: (groupId: string) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    // 组内首个窗格可能是 chat：两种游标互斥，谁在前聚焦谁
    const firstTerminal = collectLeafIds(group.rootLayout)[0] ?? null;
    const firstChat = collectChatPaneKeys(group.rootLayout)[0] ?? null;
    set({
      activeGroupId: groupId,
      activeInstanceId: firstChat !== null ? null : firstTerminal,
      activeChatPaneKey: firstChat,
      maximizedInstanceId: null,
    });
  },

  // tab 右键三件套（ZCode SidePaneTabTrigger 同款）—— 批量关闭是显式杀进程语义
  closeOtherTabs: (keepGroupId) => {
    const { groups } = get();
    const keep = groups.find((g) => g.id === keepGroupId);
    if (!keep || groups.length <= 1) return;
    for (const g of groups) {
      if (g.id === keepGroupId) continue;
      for (const id of collectLeafIds(g.rootLayout)) terminalSessionRegistry.dispose(id);
      for (const paneKey of collectChatPaneKeys(g.rootLayout)) {
        useChatPanes.getState().handlePaneClosed(paneKey);
      }
    }
    const keepLeaves = collectLeafIds(keep.rootLayout);
    const keepChats = collectChatPaneKeys(keep.rootLayout);
    set((state) => ({
      groups: state.groups.filter((g) => g.id === keepGroupId),
      instances: state.instances.filter((i) => keepLeaves.includes(i.id)),
      activeGroupId: keepGroupId,
      activeInstanceId: keepChats.length > 0 ? null : (keepLeaves[0] ?? null),
      activeChatPaneKey: keepChats[0] ?? null,
      maximizedInstanceId: null,
    }));
  },

  closeAllTabs: () => {
    const { groups } = get();
    if (groups.length === 0) return;
    for (const g of groups) {
      for (const id of collectLeafIds(g.rootLayout)) terminalSessionRegistry.dispose(id);
      for (const paneKey of collectChatPaneKeys(g.rootLayout)) {
        useChatPanes.getState().handlePaneClosed(paneKey);
      }
    }
    set({
      groups: [],
      instances: [],
      activeGroupId: null,
      activeInstanceId: null,
      activeChatPaneKey: null,
      maximizedInstanceId: null,
    });
  },

  setActiveInstance: (instanceId: string) => {
    const group = get().groups.find((g) =>
      collectLeafIds(g.rootLayout).includes(instanceId),
    );
    set({
      activeInstanceId: instanceId,
      activeChatPaneKey: null,
      activeGroupId: group ? group.id : get().activeGroupId,
    });
  },

  setBranchRatio: (branchId: string, ratio: number) => {
    const clamped = Math.max(0.1, Math.min(0.9, ratio));
    set((state) => ({
      groups: state.groups.map((g) => ({
        ...g,
        rootLayout: updateTreeRatio(g.rootLayout, branchId, clamped),
      })),
    }));
  },

  toggleMaximize: (instanceId?: string) => {
    const target = instanceId ?? get().activeInstanceId;
    set((state) => ({
      maximizedInstanceId:
        state.maximizedInstanceId === target ? null : (target ?? null),
    }));
  },

  renameInstance: (instanceId: string, title: string) => {
    set((state) => ({
      instances: state.instances.map((i) =>
        i.id === instanceId ? { ...i, title } : i,
      ),
    }));
  },

  renameTab: (groupId: string, title: string) => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, title } : g)),
    }));
  },

  clearAll: () => {
    terminalSessionRegistry.disposeAll();
    set({
      instances: [],
      groups: [],
      activeGroupId: null,
      activeInstanceId: null,
      maximizedInstanceId: null,
    });
  },

  reattachFromDaemon: async () => {
    // 用户这次会话已经建过标签（终端或对话窗格）就不动 —— 重挂只在首载跑一次
    if (get().groups.length > 0 || get().reattachDone) {
      set({ reattachDone: true });
      return;
    }
    let list: DaemonTermRow[];
    let client: { rpc: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T> } | null = null;
    try {
      const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      client = DaemonClient.get(defaultDaemonEndpoint());
      list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
    } catch {
      set({ reattachDone: true }); // daemon 没起：放行空态自动建标签
      return;
    }
    if (get().groups.length > 0 || get().reattachDone) {
      set({ reattachDone: true });
      return;
    }
    if (list.length === 0) {
      set({ reattachDone: true });
      return;
    }

    const { useWorkbench } = await import("./useWorkbench.ts");
    const units = useWorkbench.getState().units;

    // 全面放开：每个存活的 PTY 都还原成标签 —— 同一 Bot 的多终端
    // （手动一个 + 定时任务 TUI 一个）是合法并存，不在这里替用户清理。
    // 对话页小终端除外：它归 ChatTerminalDock 自己认领（unitId 标记）。
    const adopted = list
      .filter((t) => t.unitId !== CHAT_DOCK_UNIT_ID)
      .map((t) => adoptTermRow(t, units));

    const activeUnitId = useWorkbench.getState().activeUnitId;
    const initialActiveInst = activeUnitId
      ? (adopted.find((a) => a.instance.unitId === activeUnitId)?.instance ?? adopted[0]?.instance)
      : adopted[0]?.instance;
    const initialActiveGroup = initialActiveInst
      ? (adopted.find((a) => a.instance === initialActiveInst)?.group ?? adopted[0]?.group)
      : undefined;

    set({
      instances: adopted.map((a) => a.instance),
      groups: adopted.map((a) => a.group),
      activeGroupId: initialActiveGroup?.id ?? null,
      activeInstanceId: initialActiveInst?.id ?? null,
      activeChatPaneKey: null,
      reattachDone: true,
    });
  },

  installTerminalCreatedClaim: () => {
    if (get().claimInstalled) return;
    set({ claimInstalled: true });
    void (async () => {
      const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
      const client = DaemonClient.get(defaultDaemonEndpoint());
      // WS 是懒连接（首个 rpc 才拨）：不主动 ensureConnected 的话，
      // 静默的前端永远收不到 created 帧 —— 认领必须先把管道撑开
      await client.ensureConnected().catch(() => {
        // daemon 未起：订阅仍在，将来任何 rpc 触发重连后帧自然恢复
      });
      client.onTerminalFrame((f) => {
        if (f.kind !== "created") return;
        if (get().instances.some((i) => i.id === f.terminalId)) return;
        // 对话页小终端不进标签树：它有自己的挂载点（ChatTerminalDock），
        // 认领成 TUI 标签会出现两处 xterm 抢同一块 PTY 画布
        if (f.unitId === CHAT_DOCK_UNIT_ID) return;
        void (async () => {
          try {
            // created 帧只带档案字段；补拉一次 list 拿 scrollback —— 认领前的
            // 输出（TUI 启动横幅）只有它有，认领后的实时帧由订阅自然接管
            const list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
            const row = list.find((t) => t.terminalId === f.terminalId);
            if (row === undefined) return; // 创建即秒退的终端：不建占位标签
            const { useWorkbench } = await import("./useWorkbench.ts");
            const { useShell } = await import("./useShell.ts");
            const { instance, group } = adoptTermRow(row, useWorkbench.getState().units);
            if (get().instances.some((i) => i.id === f.terminalId)) return; // 双帧竞态兜底
            set((s) => ({
              instances: [...s.instances, instance],
              groups: [...s.groups, group],
              activeGroupId: group.id,
              activeInstanceId: instance.id,
              activeChatPaneKey: null,
              maximizedInstanceId: null,
            }));
            // 定时任务到点的意义就是「让我看到」：主视图不在工作区就切回来
            if (useShell.getState().mainView !== "chat") useShell.getState().setMainView("chat");
          } catch {
            // daemon 断连等瞬时失败：放弃这一次，F5 重挂是兜底
          }
        })();
      });
    })();
  },

  createInstance: (opts) => get().createTab(opts),
  closeInstance: (id) => get().closePane(id),
  splitWithNew: (profileId) => get().splitPane({ profileId, direction: "horizontal" }),
}));
