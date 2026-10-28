/**
 * 单 bot 对话列强调色（2026-10-28）：active unit 带 themeAccent 时，把 accent 系
 * 变量摊成内联 style 给对话列容器——子树继承生效，<html> 上的全局主题同名变量
 * 不动；无值/非法值 = 跟随全局（undefined）。桌面 ConversationSlot 与移动端
 * MobileLayout 共用这一个 hook，护栏逻辑（明暗两套可读性）见
 * core/appearance.ts 的 deriveChatAccentVariables。
 */
import { useMemo, type CSSProperties } from "react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { deriveChatAccentVariables, isValidColor } from "../core/appearance.ts";

export function useChatAccentStyle(): CSSProperties | undefined {
  const unit = useWorkbench(selectActiveUnit);
  const resolvedTheme = useAppearance((s) => s.resolvedAppearance);
  return useMemo(() => {
    const accent = unit?.themeAccent;
    if (!accent || !isValidColor(accent)) return undefined;
    return deriveChatAccentVariables(accent, resolvedTheme === "dark") as CSSProperties;
  }, [unit?.themeAccent, resolvedTheme]);
}
