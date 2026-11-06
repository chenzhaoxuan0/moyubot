import { create } from "zustand";
import {
  SESSION_LIGHT_COLOR_STATES,
  SESSION_LIGHT_DEFAULT_COLORS,
  isPaletteHex,
  type SessionLightColorState,
} from "../core/sessionLight.ts";

/**
 * 会话灯色的用户偏好（2026-11-06）：有人适应蓝灯、有人适应橙灯——灯色是
 * 偏好不是语义，四种可配色态（running/attention/unreadDone/error）各自
 * 独立设置。值域限定 core/sessionLight 的预设色板——拦的是任意邻近色
 * （自由取色器会选出肉眼难分的两态）；把两态选成同一个色板色是用户的
 * 自由，不强校验。
 *
 * 设置面在底栏左下角的灯说明弹层（StatusIndicators.SessionLightLegendBadge，
 * 图例与色板一体 —— 看到的就是当前生效的灯）。
 */

const STORAGE_KEY = "agent-workbench:session-light-colors.v1";

function readColors(): Record<SessionLightColorState, string> {
  if (typeof window === "undefined") return { ...SESSION_LIGHT_DEFAULT_COLORS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...SESSION_LIGHT_DEFAULT_COLORS };
    const p = JSON.parse(raw) as Partial<Record<SessionLightColorState, unknown>>;
    const out = { ...SESSION_LIGHT_DEFAULT_COLORS };
    for (const k of SESSION_LIGHT_COLOR_STATES) {
      const v = p[k];
      if (typeof v === "string" && isPaletteHex(v)) out[k] = v.toLowerCase();
    }
    return out;
  } catch {
    return { ...SESSION_LIGHT_DEFAULT_COLORS };
  }
}

function persistColors(colors: Record<SessionLightColorState, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    /* ignore */
  }
}

interface SessionLightsStore {
  colors: Record<SessionLightColorState, string>;
  /** 换色（值必须来自色板；调用方是设置面板的 swatch，天然满足） */
  setColor: (state: SessionLightColorState, hex: string) => void;
  /** 恢复全部默认灯色 */
  resetColors: () => void;
}

export const useSessionLights = create<SessionLightsStore>((set) => ({
  colors: readColors(),

  setColor: (state, hex) =>
    set((s) => {
      if (!isPaletteHex(hex)) return s;
      const colors = { ...s.colors, [state]: hex.toLowerCase() };
      persistColors(colors);
      return { colors };
    }),

  resetColors: () => {
    persistColors({ ...SESSION_LIGHT_DEFAULT_COLORS });
    set({ colors: { ...SESSION_LIGHT_DEFAULT_COLORS } });
  },
}));
