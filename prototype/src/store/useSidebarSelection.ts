import { create } from "zustand";
import type { UnitHistoryEntry } from "../adapters/daemon/client.ts";

/**
 * 左栏会话多选（T3code 式管理选择，2026-10-27）：选择 ≠ 打开。
 * Ctrl/Cmd 点击 = 加入/移出选择集（不切换视图）；Shift 点击 = 从锚点到该行
 * 范围全选；批量操作（归档/置顶/消灯）作用在整个选择集上。
 *
 * entry 快照在选择那一刻捕获进 Map —— 左栏的行可能跨单元折叠展示，批量菜单
 * 出现在哪个单元的分节里就该能解析所有被选行，不能只依赖当前分节的列表。
 * 选择是纯内存瞬态（切走/刷新即散），不持久化。
 */
interface SidebarSelectionState {
  /** entry key → 选择时捕获的 entry 快照 */
  selected: ReadonlyMap<string, UnitHistoryEntry>;
  /** Shift 范围选的锚点（上次单选的 entry key） */
  anchor: string | null;
  /** Ctrl/Cmd 点击：单条加入/移出 */
  toggle: (entry: UnitHistoryEntry) => void;
  /** Shift 点击：anchor → key 在可见有序列表内的连续范围（anchor 缺失时退化为单选） */
  selectRange: (ordered: readonly UnitHistoryEntry[], key: string) => void;
  /** 清空选择（Esc / 普通点击未选中行 / 批量操作执行完） */
  clear: () => void;
}

export const useSidebarSelection = create<SidebarSelectionState>((set, get) => ({
  selected: new Map(),
  anchor: null,
  toggle: (entry) =>
    set((s) => {
      const next = new Map(s.selected);
      if (next.has(entry.key)) next.delete(entry.key);
      else next.set(entry.key, entry);
      return { selected: next, anchor: entry.key };
    }),
  selectRange: (ordered, key) => {
    const anchor = get().anchor;
    if (anchor === null) {
      const entry = ordered.find((e) => e.key === key);
      if (entry !== undefined) set({ selected: new Map([[key, entry]]), anchor: key });
      return;
    }
    const a = ordered.findIndex((e) => e.key === anchor);
    const b = ordered.findIndex((e) => e.key === key);
    if (a < 0 || b < 0) {
      // 锚点不在当前列表（跨单元/被过滤）：退化为单选并重置锚点
      const entry = ordered.find((e) => e.key === key);
      if (entry !== undefined) set({ selected: new Map([[key, entry]]), anchor: key });
      return;
    }
    const [from, to] = a <= b ? [a, b] : [b, a];
    const next = new Map<string, UnitHistoryEntry>();
    for (let i = from; i <= to; i++) next.set(ordered[i]!.key, ordered[i]!);
    set({ selected: next });
  },
  clear: () => set({ selected: new Map(), anchor: null }),
}));
