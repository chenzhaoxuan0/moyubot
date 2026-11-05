import { useAppearance } from "../store/useAppearance.ts";
import type { WorkUnit } from "../core/units.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { cn } from "./cn.ts";

/**
 * bot 头像（自定义图优先，缺省彩色底 + 首字）—— 新建会话页与对话窗格的
 * bot 选择器共用（review Duplicated Code 收口；侧栏 UnitRow 有自己的日程
 * 角标形态，不并入）。
 */
export function BotAvatar({ unit, size = "md" }: { unit: WorkUnit; size?: "sm" | "md" }) {
  const avatarFrame = useAppearance((s) => s.avatarFrame);
  const avatar = botAvatarStyle(unit.name, avatarFrame);
  const box = size === "md" ? "h-7 w-7" : "h-6 w-6";
  const glyph = size === "md" ? "text-body-sm" : "text-caption";
  if (unit.avatar) {
    return <img src={unit.avatar} alt="" className={cn(box, "shrink-0 object-cover", avatar?.shape)} />;
  }
  return (
    <span
      className={cn(
        box,
        glyph,
        "flex shrink-0 items-center justify-center bg-line-soft font-medium text-graphite",
        avatar?.shape,
      )}
    >
      {unit.name.slice(0, 1)}
    </span>
  );
}
