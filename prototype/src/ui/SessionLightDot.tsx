import { useSessionLights } from "../store/useSessionLights.ts";
import type { SessionLightKind } from "../core/sessionLight.ts";

/**
 * 会话状态灯的唯一渲染入口 —— 侧栏历史行 / bot 行 / 画布 chat 标签 /
 * 底栏说明面板四处共用，保证改一处灯色全局同步（灯色来自 useSessionLights
 * 的用户偏好，内联 style 承载任意色板色，不走 tailwind 类名映射）。
 *
 * running 用 CSS border 环 spinner：动画只有 transform 旋转（合成层），
 * 没有 JS 帧循环、不触发布局——几十个灯同时转也不心疼（旧模型用 opacity
 * 呼吸灯，指示度弱且与「进行中」的直觉不符，已退役）。
 *
 * 纯装饰组件（aria-hidden）：行的可达名与 tooltip 由各自的宿主行承载。
 */

/** 两档尺寸：sm = 侧栏历史行（灯槽 10px 内）；md = 画布 chat 标签（略大求醒目） */
const SIZES = {
  sm: { dot: 6, ring: 9 },
  md: { dot: 7, ring: 11 },
} as const;

export function SessionLightDot({
  kind,
  size = "sm",
}: {
  kind: SessionLightKind;
  size?: "sm" | "md";
}): React.ReactNode {
  const hex = useSessionLights((s) => s.colors[kind === "none" ? "running" : kind]);
  if (kind === "none") return null;
  const px = SIZES[size];
  if (kind === "running") {
    return (
      <span
        aria-hidden
        className="block shrink-0 animate-spin rounded-full"
        style={{
          width: px.ring,
          height: px.ring,
          borderWidth: 1.5,
          borderStyle: "solid",
          // 环体淡色 + 右上半弧全色（top+right 两边）：小尺寸下仍能读出
          // 「转圈」而不是实心色块
          borderColor: `${hex}38`,
          borderTopColor: hex,
          borderRightColor: hex,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-full"
      style={{ width: px.dot, height: px.dot, backgroundColor: hex }}
    />
  );
}
