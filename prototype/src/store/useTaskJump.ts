import { create } from "zustand";

/**
 * 全局「跳到某条任务/清单条目」的信箱 —— 任何入口（左栏任务链接、通知深链、
 * 主管报告跳转）都往这里投递目标，WorklistPage 统一消费：滚到对应锚点并短暂
 * 高亮。seq 保证同一目标重复投递也能触发 effect（zustand set 同值不重渲）。
 */

export interface TaskJumpTarget {
  /** backlog = 右栏任务卡片锚点；inbox = 左栏清单条目锚点 */
  readonly kind: "backlog" | "inbox";
  readonly id: number;
}

interface TaskJumpState {
  readonly target: TaskJumpTarget | null;
  readonly seq: number;
  jump: (t: TaskJumpTarget) => void;
  clear: () => void;
}

export const useTaskJump = create<TaskJumpState>((set) => ({
  target: null,
  seq: 0,
  jump: (t) => set((s) => ({ target: t, seq: s.seq + 1 })),
  clear: () => set({ target: null }),
}));
