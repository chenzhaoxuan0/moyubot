import { create } from "zustand";

/**
 * 画布拖拽的轻量共享态（docs/31 二期）—— 标签拖动期间，标签栏（重排指示）
 * 与各窗格（四向吸附区高亮）都要知道「正在拖哪个组」。用 zustand 而不是
 * dataTransfer 读回：dragover 里 getData() 在多数浏览器恒空（仅 drop 可读），
 * 指示层无从谈起。
 *
 * 生命周期：dragstart 置位 → drop/dragend 清零。模块级单例，不持久化。
 */
interface CanvasDndState {
  draggingGroupId: string | null;
  startDrag: (groupId: string) => void;
  endDrag: () => void;
}

export const useCanvasDnd = create<CanvasDndState>((set) => ({
  draggingGroupId: null,
  startDrag: (groupId) => set({ draggingGroupId: groupId }),
  endDrag: () => set({ draggingGroupId: null }),
}));
