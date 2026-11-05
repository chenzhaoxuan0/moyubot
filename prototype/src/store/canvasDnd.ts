import { create } from "zustand";

/**
 * 画布拖拽的轻量共享态（docs/32 组栈模型）—— 标签拖动期间，各组的标签条
 * （插入指示）与组 body（五向吸附区）都要知道「正在拖哪个标签」。用 zustand
 * 而不是 dataTransfer 读回：dragover 里 getData() 在多数浏览器恒空（仅 drop
 * 可读），指示层无从谈起。
 *
 * 生命周期：dragstart 置位 → drop/dragend 清零。模块级单例，不持久化。
 */
interface CanvasDndState {
  draggingPaneId: string | null;
  startDrag: (paneId: string) => void;
  endDrag: () => void;
}

export const useCanvasDnd = create<CanvasDndState>((set) => ({
  draggingPaneId: null,
  startDrag: (paneId) => set({ draggingPaneId: paneId }),
  endDrag: () => set({ draggingPaneId: null }),
}));
