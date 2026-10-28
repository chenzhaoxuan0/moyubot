/**
 * 外观模型 —— 对齐 Codex-Dream-Skin 的 theme.json + safe-css 契约
 *
 * 取值域、默认值、枚举全部照抄 DS，理由是两边要能互换主题：
 *   - colors 十组：DS `theme.json.colors`，键名一字不改
 *   - appearance：DS `auto | light | dark`，DS 的 auto 即本项目的「跟随系统」
 *   - art 四项：DS `theme.json.art`，focusX/focusY 为 0..1 或 null（null=自动推断）
 *   - transparency：DS `theme-preferences.json` 的每主题透明度，0..100，100=全透
 *   - surface 九项：DS `safe-css-policy.json` 允许的 --ds-theme-* 变量
 *
 * ⚠ 与 DS 的两处刻意差异，README 里有完整交代：
 *   1. DS 的 safe-css 校验器只允许 safeArea ∈ {left,right,none}、taskMode ∈ {ambient,full,off}，
 *      但它自己的本机注入器还额外接受 auto/center/banner。本项目是单机应用、没有第三方主题包
 *      的兼容包袱，所以直接取两边的并集：safeArea 多 center+auto，taskMode 多 banner+auto。
 *   2. DS 的透明度是「壁纸有多透」，本项目没有强制壁纸，透明度作用在面板/画布底色上，
 *      语义仍是「底色多透」，只改背景不改文字 —— 这条 DS 用测试钉死
 *      （tools/renderer-runtime.test.mjs:1123「Background alpha must not change public element opacity」）。
 */

/* --------------------------------------------------------------------------- 颜色工具 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * 解析 DS 允许的颜色写法：#RGB(A) / #RRGGBB(AA) / rgb() / rgba()。
 * 与 DS 的 COLOR_PATTERN 同口径；解析不出来返回 null，调用方负责回退。
 */
export function parseColor(input: string | undefined | null): Rgba | null {
  if (typeof input !== "string") return null;
  const source = input.trim();
  if (!source) return null;

  const short = HEX3.exec(source);
  if (short) {
    const [, r, g, b, a] = short;
    return {
      r: parseInt((r ?? "") + (r ?? ""), 16),
      g: parseInt((g ?? "") + (g ?? ""), 16),
      b: parseInt((b ?? "") + (b ?? ""), 16),
      a: a === undefined ? 1 : parseInt(a + a, 16) / 255,
    };
  }

  const long = HEX6.exec(source);
  if (long) {
    const [, r, g, b, a] = long;
    return {
      r: parseInt(r ?? "0", 16),
      g: parseInt(g ?? "0", 16),
      b: parseInt(b ?? "0", 16),
      a: a === undefined ? 1 : parseInt(a, 16) / 255,
    };
  }

  const fn = RGB_FN.exec(source);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : Number(fn[4]);
    if (!Number.isFinite(alpha)) return null;
    return {
      r: clamp(Number(fn[1]), 0, 255),
      g: clamp(Number(fn[2]), 0, 255),
      b: clamp(Number(fn[3]), 0, 255),
      a: clamp(alpha, 0, 1),
    };
  }

  return null;
}

/** 统一输出 #rrggbb（丢弃 alpha）。解析失败回退到 fallback。 */
export function toHex(input: string, fallback = "#000000"): string {
  const parsed = parseColor(input);
  if (!parsed) return fallback;
  const hex = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}

/** 输出 rgb(...)/rgba(...)，alpha 由外部给定。 */
export function withAlpha(input: string, alpha: number): string {
  const parsed = parseColor(input) ?? { r: 0, g: 0, b: 0, a: 1 };
  const a = clamp(alpha, 0, 1);
  if (a >= 1) return toHex(input);
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${Number(a.toFixed(3))})`;
}

/** 两色线性插值，t 取 0..1。t=0 全部来自 a，t=1 全部来自 b。 */
export function mixColor(a: string, b: string, t: number): string {
  const left = parseColor(a) ?? { r: 0, g: 0, b: 0, a: 1 };
  const right = parseColor(b) ?? { r: 255, g: 255, b: 255, a: 1 };
  const ratio = clamp(t, 0, 1);
  return toHex(
    `#${[
      Math.round(left.r + (right.r - left.r) * ratio),
      Math.round(left.g + (right.g - left.g) * ratio),
      Math.round(left.b + (right.b - left.b) * ratio),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")}`,
  );
}

/** WCAG 相对亮度，用于决定强调色上的文字该用黑还是白（DS readableAccentInk 的简化版）。 */
export function relativeLuminance(color: string): number {
  const parsed = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const channel = (raw: number) => {
    const c = clamp(raw, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
}

/** 给定强调色，返回其上可读的前景色（黑或白）。 */
export function readableInk(accent: string): "#000000" | "#ffffff" {
  return relativeLuminance(accent) > 0.45 ? "#000000" : "#ffffff";
}

/** 两个颜色的 WCAG 对比度，1..21。用于 UI 里的「对比度不足」提示。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/* --------------------------------------------------------------------------- 模型 */

export const PALETTE_KEYS = [
  "background",
  "panel",
  "panelAlt",
  "accent",
  "accentAlt",
  "secondary",
  "highlight",
  "text",
  "muted",
  "line",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type ThemePalette = Record<PaletteKey, string>;

/** DS `theme.json.appearance`：auto 即跟随系统 */
export type AppearanceMode = "auto" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

/** safeArea 的并集：DS 主题包只认 left/right/none，本机注入器另接受 auto/center */
export type SafeArea = "auto" | "left" | "right" | "center" | "none";
/** taskMode 的并集，理由见文件头 */
export type TaskMode = "auto" | "ambient" | "banner" | "full" | "off";

export interface ArtSettings {
  /** 0..1，null = 按安全区自动推断（DS 同款：left→0.72 right→0.28 其余→0.5） */
  focusX: number | null;
  focusY: number | null;
  safeArea: SafeArea;
  taskMode: TaskMode;
}

/** 对话视图形态：classic=经典无气泡平铺，glass=液态毛玻璃卡片（特别适合带壁纸） */
export type ChatStyle = "classic" | "glass";

export type ShadowLevel = "none" | "soft" | "strong";
export type DensityScale = "compact" | "standard" | "comfortable";
export type MotionLevel = "off" | "reduced" | "standard";
export type FontChoice = "system" | "grotesk" | "serif" | "mono";

/** DS safe-css-policy.json 里 12 个 --ds-theme-* 变量中可被用户编辑的那一组 */
export interface SurfaceSettings {
  /** 0..28px，对应 DS safe-css 校验器 border-radius 的取值域 */
  radius: number;
  /** 0.65..1，DS safe-css 校验器 opacity 的取值域 */
  opacity: number;
  /** 0..30px，DS safe-css 校验器 backdrop-filter blur 的取值域 */
  blur: number;
  /** 0..1，DS --ds-theme-surface-border-alpha 默认 0.14 */
  borderAlpha: number;
  shadow: ShadowLevel;
  fontFamily: FontChoice;
  fontScale: number;
  density: DensityScale;
  motion: MotionLevel;
}

export interface WallpaperSettings {
  enabled: boolean;
  /**
   * **持久化值**：壁纸文件路径，相对 daemon 家（~/.agent-workbench）或写绝对路径。
   * 这是写进 appearance.json 的字段，也是 agent 要改的那个 —— 图本身不进 JSON。
   */
  path: string | null;
  /**
   * **运行时值**：daemon 把图读成的 data URL，只活在内存里，不落盘。
   * 渲染靠它，导出 JSON 时会被剥掉。
   */
  source: string | null;
  /** 1..2，等价 DS --ds-theme-image-zoom */
  zoom: number;
  /** 0..0.8，等价 DS --ds-theme-image-dim */
  dim: number;
  /** 0..1，等价 DS --ds-theme-image-task-intensity */
  taskIntensity: number;
}

export interface AppearanceProfile {
  palette: ThemePalette;
  surface: SurfaceSettings;
  /** 0..100，null = 跟随主题默认（无壁纸 0%，有壁纸 30%）。100 = 全透 */
  transparency: number | null;
  /**
   * 设置页整页底色的透明度，0..100，默认 0（完全不透明）。
   * 设置页叠在主界面上，不透明才不会透出下层文字；想要壁纸透进来自己调高。
   */
  overlayTransparency: number;
  /**
   * 终端画布底色的透明度，0..100，默认 0（完全不透明）。
   * 只透底色，文字永远不透明；开着壁纸时 20~40% 左右观感与可读性平衡最好。
   */
  terminalTransparency: number;
}

/** bot 头像框形态：圆角（按名字哈希的 blob 形状）或无圆角方形 */
export type AvatarFrame = "rounded" | "square";

/**
 * 应用 Logo。品牌标是内置的双版 SVG（亮主题白底 / 暗主题黑底）；
 * 自定义模式换成用户自己的图（单图全局，不分亮暗），落盘只存路径。
 */
export interface LogoSettings {
  /** "brand" = 内置 MoyuBot 双版标；"custom" = 用户自选图 */
  mode: "brand" | "custom";
  /** **持久化值**：logo 文件路径（相对 daemon 家），写进 appearance.json，图不进 JSON */
  path: string | null;
  /** **运行时值**：daemon 把图读成的 data URL，只活在内存里，导出时剥掉 */
  source: string | null;
}

export const DEFAULT_LOGO: LogoSettings = {
  mode: "brand",
  path: null,
  source: null,
};

export interface AppearanceState {
  schemaVersion: 1;
  /** 外壳外观：auto=跟随系统，等价 DS 的 appearance */
  mode: AppearanceMode;
  /** 亮/暗两套外观各自的完整档案，切换 mode 即切档案 */
  profiles: Record<ResolvedAppearance, AppearanceProfile>;
  art: ArtSettings;
  wallpaper: WallpaperSettings;
  /** 自定义 Logo（全局，不分亮暗档案） */
  logo: LogoSettings;
  /** bot 头像框形态（全局，不分亮暗档案） */
  avatarFrame: AvatarFrame;
  /** 当前选中的预设 id，null = 用户已手工改过 */
  presetId: string | null;
  /** 对话视图形态：classic=经典无气泡平铺，glass=液态毛玻璃卡片（特别适合带壁纸） */
  chatStyle: ChatStyle;
  /** 液态玻璃模糊度 2..32px，默认 8px（对齐 Apple Liquid 晶润水感标准） */
  glassBlur: number;
}

/* --------------------------------------------------------------------------- 默认值 */

export const DEFAULT_SURFACE: SurfaceSettings = {
  radius: 12,
  opacity: 1,
  blur: 0,
  borderAlpha: 0.14,
  shadow: "soft",
  fontFamily: "system",
  fontScale: 1,
  density: "standard",
  motion: "standard",
};

export const DEFAULT_ART: ArtSettings = {
  focusX: null,
  focusY: null,
  safeArea: "auto",
  taskMode: "auto",
};

export const DEFAULT_WALLPAPER: WallpaperSettings = {
  enabled: false,
  path: null,
  source: null,
  zoom: 1,
  dim: 0,
  taskIntensity: 0.35,
};

/**
 * 「跟随主题」的默认透明度，**按有无壁纸分两档**：
 * - 无壁纸：0%（完全不透明）。没开壁纸时半透明面板等于能看见应用背后的东西，用户明确不要；
 * - 有壁纸：30%（DS 原值，renderer-inject.js:365 的 0.70 就是 100-30）。壁纸垫在 z-index:-2，
 *   底色不透它就永远不可见 —— 开壁纸却看不到壁纸是 bug，不是偏好。
 */
export const DEFAULT_TRANSPARENCY = 0;
export const WALLPAPER_DEFAULT_TRANSPARENCY = 30;
/** 设置页整页底色的默认透明度：0% = 不透明，叠在主界面上不透字 */
export const DEFAULT_OVERLAY_TRANSPARENCY = 0;
/** 终端画布底色的默认透明度：0% = 不透明，文字可读性优先 */
export const DEFAULT_TERMINAL_TRANSPARENCY = 0;

/* --------------------------------------------------------------------------- 预设 */

export interface AppearancePreset {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly mode: AppearanceMode;
  readonly light: AppearanceProfile;
  readonly dark: AppearanceProfile;
  /** 预设推荐对话风格（如有，切换预设时自动启用） */
  readonly defaultChatStyle?: ChatStyle;
}

/** 本项目现有的两套配色，原样搬过来，保证升级后视觉零变化 */
export const PRESET_PARCHMENT: AppearancePreset = {
  id: "parchment",
  name: "温润羊皮纸",
  desc: "Cursor 暖白奶油画布、纸阶平坦分层与 Ember 炽橙高亮",
  mode: "light",
  light: {
    palette: {
      background: "#f7f7f4",
      panel: "#f2f1ed",
      panelAlt: "#e6e5e0",
      accent: "#f54e00",
      accentAlt: "#e04500",
      secondary: "#0d9488",
      highlight: "#a855f7",
      text: "#26251e",
      muted: "#84847e",
      line: "#cdcdc9",
    },
    surface: DEFAULT_SURFACE,
    transparency: null,
    overlayTransparency: DEFAULT_OVERLAY_TRANSPARENCY,
    terminalTransparency: DEFAULT_TERMINAL_TRANSPARENCY,
  },
  dark: {
    palette: {
      background: "#000000",
      panel: "#181817",
      panelAlt: "#121212",
      accent: "#cbb0f7",
      accentAlt: "#b898ec",
      secondary: "#2dd4bf",
      highlight: "#f0abfc",
      text: "#faf9f6",
      muted: "#b4b4b2",
      line: "#222221",
    },
    surface: DEFAULT_SURFACE,
    transparency: null,
    overlayTransparency: DEFAULT_OVERLAY_TRANSPARENCY,
    terminalTransparency: DEFAULT_TERMINAL_TRANSPARENCY,
  },
};

export const PRESET_OBSIDIAN: AppearancePreset = {
  id: "obsidian",
  name: "深邃黑曜石",
  desc: "纯黑终端虚空底色、平坦炭黑面板与荧光紫光标强调",
  mode: "dark",
  light: PRESET_PARCHMENT.light,
  dark: PRESET_PARCHMENT.dark,
};

export const PRESET_TWILIGHT: AppearancePreset = {
  id: "twilight-mirror",
  name: "暮色镜湖",
  desc: "DS 内置预设 · 蓝紫暮光与静水倒影",
  mode: "dark",
  light: PRESET_PARCHMENT.light,
  dark: {
    palette: {
      background: "#101b55",
      panel: "#17245e",
      panelAlt: "#253078",
      accent: "#d89be8",
      accentAlt: "#f0b9ee",
      secondary: "#79b9f4",
      highlight: "#b58be7",
      text: "#f5efff",
      muted: "#b7c5ea",
      line: "#d89be8",
    },
    surface: DEFAULT_SURFACE,
    transparency: null,
    overlayTransparency: DEFAULT_OVERLAY_TRANSPARENCY,
    terminalTransparency: DEFAULT_TERMINAL_TRANSPARENCY,
  },
};

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  PRESET_PARCHMENT,
  PRESET_OBSIDIAN,
  PRESET_TWILIGHT,
];

/* --------------------------------------------------------------------------- 默认状态 */

export function defaultAppearanceState(): AppearanceState {
  return {
    schemaVersion: 1,
    // 跟随系统明暗；预设的 mode 只在你主动选预设时生效
    mode: "auto",
    profiles: {
      light: cloneProfile(PRESET_PARCHMENT.light),
      dark: cloneProfile(PRESET_OBSIDIAN.dark),
    },
    art: { ...DEFAULT_ART },
    wallpaper: { ...DEFAULT_WALLPAPER },
    logo: { ...DEFAULT_LOGO },
    avatarFrame: "rounded",
    presetId: PRESET_PARCHMENT.id,
    chatStyle: "classic",
    glassBlur: 8,
  };
}

function cloneProfile(profile: AppearanceProfile): AppearanceProfile {
  return {
    palette: { ...profile.palette },
    surface: { ...profile.surface },
    transparency: profile.transparency,
    overlayTransparency: profile.overlayTransparency,
    terminalTransparency: profile.terminalTransparency,
  };
}

/* --------------------------------------------------------------------------- 推导 */

/**
 * 透明度 0..100 → alpha。DS 用 (100 - value)/100，方向与 CSS 直觉相反：
 * 0 是不透明，100 是全透。抄这个公式，别自己写 value/100。
 */
export function transparencyToAlpha(transparency: number | null, hasWallpaper = false): number {
  if (transparency === null || !Number.isFinite(transparency)) {
    const fallback = hasWallpaper ? WALLPAPER_DEFAULT_TRANSPARENCY : DEFAULT_TRANSPARENCY;
    return (100 - fallback) / 100;
  }
  return clamp((100 - transparency) / 100, 0, 1);
}

/** 安全区推出的默认焦点，与 DS renderer-inject.js:477-478 一致 */
export function defaultFocusX(safeArea: SafeArea): number {
  if (safeArea === "left") return 0.72;
  if (safeArea === "right") return 0.28;
  return 0.5;
}

export function resolveFocusX(art: ArtSettings): number {
  if (typeof art.focusX === "number" && Number.isFinite(art.focusX)) {
    return clamp(art.focusX, 0, 1);
  }
  const safe = art.safeArea === "auto" ? "center" : art.safeArea;
  return defaultFocusX(safe);
}

export function resolveFocusY(art: ArtSettings): number {
  if (typeof art.focusY === "number" && Number.isFinite(art.focusY)) {
    return clamp(art.focusY, 0, 1);
  }
  return 0.5;
}

const DENSITY_SCALE: Record<DensityScale, number> = {
  compact: 0.88,
  standard: 1,
  comfortable: 1.12,
};

const MOTION_DURATION: Record<MotionLevel, number> = {
  off: 0,
  reduced: 60,
  standard: 120,
};

export function densityMultiplier(density: DensityScale): number {
  return DENSITY_SCALE[density] ?? 1;
}

export function motionDurationMs(motion: MotionLevel): number {
  return MOTION_DURATION[motion] ?? 120;
}

const FONT_STACK: Record<FontChoice, string> = {
  system:
    'Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  grotesk:
    '"Helvetica Neue", Inter, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", "Noto Serif SC", Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace',
};

export function fontStack(family: FontChoice): string {
  return FONT_STACK[family] ?? FONT_STACK.system;
}

export const RADIUS_TOKENS: Record<"btn" | "input" | "card" | "chip", number> = {
  btn: 6,
  input: 12,
  card: 16,
  chip: 9999,
};

/**
 * 由「surface.radius」推出四档圆角，保持设计系统原有的比例关系
 * （默认 12 时正好还原 btn6 / input12 / card16 / chip9999）。
 */
export function radiusScale(radius: number): Record<"btn" | "input" | "card" | "chip", number> {
  const base = clamp(radius, 0, 28);
  const ratio = base / RADIUS_TOKENS.input;
  return {
    btn: Math.round(base * (RADIUS_TOKENS.btn / RADIUS_TOKENS.input)),
    input: base,
    card: Math.round(base * (RADIUS_TOKENS.card / RADIUS_TOKENS.input)),
    chip: RADIUS_TOKENS.chip,
  };
}

function shadowValue(level: ShadowLevel, ink: string): string {
  const rgb = toHex(ink);
  if (level === "none") return "none";
  if (level === "strong") {
    return `0 2px 12px 0 color-mix(in srgb, ${rgb} 22%, transparent), 0 1px 3px 0 color-mix(in srgb, ${rgb} 14%, transparent)`;
  }
  return `0 1px 3px 0 color-mix(in srgb, ${rgb} 9%, transparent), 0 1px 2px -1px color-mix(in srgb, ${rgb} 6%, transparent)`;
}

/**
 * 把一份档案推成实际的 CSS 自定义属性。
 *
 * 覆盖两类变量：
 *  1. 项目自己的 --color-* 令牌（Tailwind @theme 里已经映射好，改这里即可全站生效）
 *  2. DS 同名的 --ds-theme-* 变量（保留契约，未来导主题包时能直接对上）
 *
 * ⚠ 透明度只作用在背景类令牌（canvas/rail/card），绝不碰文字与图标 ——
 *   这条 DS 有测试钉死，本项目照抄。
 */
export function deriveCssVariables(
  profile: AppearanceProfile,
  art: ArtSettings,
  wallpaper: WallpaperSettings,
): Record<string, string> {
  const p = profile.palette;
  const surface = profile.surface;
  const hasWallpaper = wallpaper.enabled && Boolean(wallpaper.source);
  /**
   * ⚠ 透明度只在「真的有壁纸」时才生效。
   * DS 的背景永远是一张图，滑块调的是图有多透，所以面板半透明是合理的。
   * 本项目没有壁纸时，半透明面板会让整块 UI 变成能看见背后的半透明层 ——
   * 那是 bug 不是特性。所以这里按 hasWallpaper 短路。
   */
  const alpha = hasWallpaper ? transparencyToAlpha(profile.transparency, true) : 1;
  const vars: Record<string, string> = {};

  /* ---- 背景层：受透明度影响 ---- */
  vars["--color-canvas"] = withAlpha(p.background, alpha);
  vars["--color-card"] = withAlpha(p.panel, alpha);
  vars["--color-rail"] = withAlpha(p.panelAlt, alpha);
  /** 设置页整页底色 —— 默认不透明；透明度由 profile.overlayTransparency 单独控制 */
  const overlayAlpha = clamp((100 - profile.overlayTransparency) / 100, 0, 1);
  vars["--color-canvas-solid"] = withAlpha(p.background, overlayAlpha);
  /** 终端画布底色 alpha —— xterm 主题运行时读它合成 rgba 背景（文字永不受影响） */
  vars["--aw-terminal-bg-alpha"] = String(clamp(1 - profile.terminalTransparency / 100, 0, 1));

  /* ---- 文字层：永不受透明度影响 ---- */
  vars["--color-ink"] = p.text;
  vars["--color-graphite"] = p.muted;
  vars["--color-ash"] = withAlpha(p.muted, 0.85);

  /* ---- 强调色层 ---- */
  vars["--color-teal"] = p.accent;
  vars["--color-teal-hover"] = p.accentAlt;
  vars["--color-teal-tint"] = withAlpha(p.accent, 0.1);
  vars["--color-teal-edge"] = withAlpha(p.accent, 0.32);
  vars["--color-secondary"] = p.secondary;
  vars["--color-highlight"] = p.highlight;
  vars["--color-on-accent"] = readableInk(p.accent);

  /* ---- 线条与悬停 ---- */
  vars["--color-line"] = withAlpha(p.line, surface.borderAlpha * 4);
  vars["--color-line-soft"] = withAlpha(p.line, surface.borderAlpha * 2);
  vars["--color-surface-hover"] = withAlpha(p.panelAlt, alpha);

  /* ---- 状态色跟随明暗，保证 diff / 错误在两套主题下都可读 ---- */
  const isLight = relativeLuminance(p.background) > 0.5;
  vars["--color-gain"] = isLight ? "#1f8a65" : "#4ade80";
  vars["--color-loss"] = isLight ? "#cf2d56" : "#f87171";

  /* ---- 排版 ---- */
  vars["--font-sans"] = fontStack(surface.fontFamily);
  vars["--aw-font-scale"] = String(surface.fontScale);

  /* ---- 表面 ---- */
  const radius = radiusScale(surface.radius);
  vars["--radius-btn"] = `${radius.btn}px`;
  vars["--radius-input"] = `${radius.input}px`;
  vars["--radius-card"] = `${radius.card}px`;
  vars["--radius-chip"] = `${radius.chip}px`;
  vars["--aw-surface-opacity"] = String(surface.opacity);
  vars["--aw-surface-blur"] = `${surface.blur}px`;
  vars["--aw-motion-duration"] = `${motionDurationMs(surface.motion)}ms`;
  vars["--aw-density-scale"] = String(densityMultiplier(surface.density));
  vars["--shadow-subtle"] = shadowValue(surface.shadow, p.text);
  vars["--shadow-xs"] =
    surface.shadow === "none"
      ? "none"
      : `0 1px 2px 0 color-mix(in srgb, ${toHex(p.text)} 6%, transparent)`;

  /* ---- 浏览器 chrome ---- */
  vars["--color-selection"] = withAlpha(p.accent, 0.28);
  vars["--color-scrollbar"] = withAlpha(p.line, 0.5);
  vars["--color-scrollbar-hover"] = withAlpha(p.line, 0.8);

  /* ---- 壁纸 ---- */
  const focusX = resolveFocusX(art);
  const focusY = resolveFocusY(art);
  vars["--aw-wallpaper-image"] =
    wallpaper.enabled && wallpaper.source ? `url("${cssUrlEscape(wallpaper.source)}")` : "none";
  vars["--aw-wallpaper-position"] = `${(focusX * 100).toFixed(2)}% ${(focusY * 100).toFixed(2)}%`;
  vars["--aw-wallpaper-zoom"] = String(wallpaper.zoom);
  vars["--aw-wallpaper-dim"] = String(wallpaper.dim);

  /* ---- DS 同名变量：保留契约，导出主题包时能原样对上 ---- */
  vars["--ds-theme-color-background"] = `rgb(${rgbTriple(p.background)} / ${alpha})`;
  vars["--ds-theme-color-panel"] = `rgb(${rgbTriple(p.panel)} / ${alpha})`;
  vars["--ds-theme-color-panel-alt"] = `rgb(${rgbTriple(p.panelAlt)} / ${alpha})`;
  vars["--ds-theme-color-accent"] = p.accent;
  vars["--ds-theme-color-accent-alt"] = p.accentAlt;
  vars["--ds-theme-color-secondary"] = p.secondary;
  vars["--ds-theme-color-highlight"] = p.highlight;
  vars["--ds-theme-color-text"] = p.text;
  vars["--ds-theme-color-muted"] = p.muted;
  vars["--ds-theme-color-line"] = p.line;
  vars["--ds-theme-surface-radius"] = `${surface.radius}px`;
  vars["--ds-theme-surface-opacity"] = String(surface.opacity);
  vars["--ds-theme-surface-blur"] = `${surface.blur}px`;
  vars["--ds-theme-surface-border-alpha"] = String(surface.borderAlpha);
  vars["--ds-theme-surface-shadow"] = surface.shadow;
  vars["--ds-theme-font-family"] = surface.fontFamily;
  vars["--ds-theme-font-scale"] = String(surface.fontScale);
  vars["--ds-theme-density-scale"] = surface.density;
  vars["--ds-theme-motion-level"] = surface.motion;
  vars["--ds-theme-image-focus-x"] = String(Number(focusX.toFixed(4)));
  vars["--ds-theme-image-focus-y"] = String(Number(focusY.toFixed(4)));
  vars["--ds-theme-image-zoom"] = String(wallpaper.zoom);
  vars["--ds-theme-image-dim"] = String(wallpaper.dim);
  vars["--ds-theme-image-task-intensity"] = String(wallpaper.taskIntensity);
  vars["--ds-user-surface-alpha"] = String(alpha);

  return vars;
}

function rgbTriple(color: string): string {
  const parsed = parseColor(color) ?? { r: 0, g: 0, b: 0 };
  return `${Math.round(parsed.r)} ${Math.round(parsed.g)} ${Math.round(parsed.b)}`;
}

/** data URL 里可能带引号与反斜杠，进 CSS url() 前必须转义 */
function cssUrlEscape(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* --------------------------------------------------------------------------- 校验 */

/** 与 DS COLOR_PATTERN 同口径：十六进制或 rgb()/rgba()，长度上限 64 */
export function isValidColor(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 64 && parseColor(value) !== null;
}

/**
 * 读取 localStorage 时做一次校验。任何非法字段退回默认值，
 * 绝不因为一格坏数据就让整个应用白屏 —— 与 DS readThemePreferences 的容错口径一致。
 */
export function sanitizeAppearanceState(raw: unknown): AppearanceState {
  const fallback = defaultAppearanceState();
  if (!raw || typeof raw !== "object") return fallback;
  const input = raw as Partial<AppearanceState> & {
    /** 落盘形态把 schemaVersion 收在 $meta 里（对齐 bot.json 的 $meta 约定） */
    $meta?: { schemaVersion?: unknown };
  };

  /**
   * schemaVersion 接受两个位置：顶层，或 $meta 里。
   * 这不是"宽容"，是必需的 —— 落盘形态写在 $meta 下（那是给人/agent 看的元信息区），
   * 而内存里的 AppearanceState 把它放在顶层。只认顶层的话，从文件读回来的每一份
   * 都会被判成"版本不对"而整个退回默认，症状是"文件改了但界面纹丝不动"。
   * 手写文件时两种放法都有人用，所以两种都认。
   */
  const declared = input.schemaVersion ?? input.$meta?.schemaVersion;
  if (declared !== 1) return fallback;

  const mode: AppearanceMode =
    input.mode === "auto" || input.mode === "light" || input.mode === "dark" ? input.mode : fallback.mode;

  const art: Partial<ArtSettings> =
    input.art && typeof input.art === "object" ? input.art : {};
  const wallpaper: Partial<WallpaperSettings> =
    input.wallpaper && typeof input.wallpaper === "object" ? input.wallpaper : {};
  const logo: Partial<LogoSettings> =
    input.logo && typeof input.logo === "object" ? input.logo : {};
  const light = sanitizeProfile(input.profiles?.light, fallback.profiles.light);
  const dark = sanitizeProfile(input.profiles?.dark, fallback.profiles.dark);

  return {
    schemaVersion: 1,
    mode,
    profiles: { light, dark },
    art: {
      focusX: typeof art.focusX === "number" && Number.isFinite(art.focusX) ? clamp(art.focusX, 0, 1) : null,
      focusY: typeof art.focusY === "number" && Number.isFinite(art.focusY) ? clamp(art.focusY, 0, 1) : null,
      safeArea: isSafeArea(art.safeArea) ? art.safeArea : "auto",
      taskMode: isTaskMode(art.taskMode) ? art.taskMode : "auto",
    },
    wallpaper: {
      enabled: wallpaper.enabled === true,
      // path 才是持久化字段；source 是 daemon 回的运行时 data URL，读文件时一律清空，
      // 免得把一张几百 KB 的图又写回 JSON
      path: typeof wallpaper.path === "string" && wallpaper.path ? wallpaper.path : null,
      source: null,
      zoom: clampNumber(wallpaper.zoom, 1, 2, 1),
      dim: clampNumber(wallpaper.dim, 0, 0.8, 0),
      taskIntensity: clampNumber(wallpaper.taskIntensity, 0, 1, 0.35),
    },
    // logo 同口径：只留 mode/path，source 由 daemon 回填
    logo: {
      mode: logo.mode === "custom" ? "custom" : "brand",
      path: typeof logo.path === "string" && logo.path ? logo.path : null,
      source: null,
    },
    avatarFrame: input.avatarFrame === "square" ? "square" : "rounded",
    presetId: typeof input.presetId === "string" ? input.presetId : null,
    chatStyle: input.chatStyle === "glass" ? "glass" : "classic",
    glassBlur: typeof input.glassBlur === "number" && Number.isFinite(input.glassBlur) ? clamp(Math.round(input.glassBlur), 2, 40) : 8,
  };
}

function sanitizeProfile(raw: unknown, fallback: AppearanceProfile): AppearanceProfile {
  if (!raw || typeof raw !== "object") return cloneProfile(fallback);
  const input = raw as Partial<AppearanceProfile>;
  const palette = { ...fallback.palette };
  const source: Partial<ThemePalette> =
    input.palette && typeof input.palette === "object" ? input.palette : {};
  for (const key of PALETTE_KEYS) {
    const value = source[key];
    if (typeof value === "string" && isValidColor(value)) palette[key] = value;
  }

  const surfaceInput: Partial<SurfaceSettings> =
    input.surface && typeof input.surface === "object" ? input.surface : {};
  const surface: SurfaceSettings = {
    radius: clampNumber(surfaceInput.radius, 0, 28, fallback.surface.radius),
    opacity: clampNumber(surfaceInput.opacity, 0.65, 1, fallback.surface.opacity),
    blur: clampNumber(surfaceInput.blur, 0, 30, fallback.surface.blur),
    borderAlpha: clampNumber(surfaceInput.borderAlpha, 0, 1, fallback.surface.borderAlpha),
    shadow: isShadowLevel(surfaceInput.shadow) ? surfaceInput.shadow : fallback.surface.shadow,
    fontFamily: isFontChoice(surfaceInput.fontFamily)
      ? surfaceInput.fontFamily
      : fallback.surface.fontFamily,
    fontScale: clampNumber(surfaceInput.fontScale, 0.85, 1.3, fallback.surface.fontScale),
    density: isDensity(surfaceInput.density) ? surfaceInput.density : fallback.surface.density,
    motion: isMotionLevel(surfaceInput.motion) ? surfaceInput.motion : fallback.surface.motion,
  };

  const transparency =
    typeof input.transparency === "number" && Number.isFinite(input.transparency)
      ? clamp(input.transparency, 0, 100)
      : input.transparency === null
        ? null
        : fallback.transparency;

  // 缺省当 0（不透明）：旧文件没有这个字段时，设置页必须保持可读
  const overlayTransparency = clampNumber(
    input.overlayTransparency,
    0,
    100,
    fallback.overlayTransparency ?? 0,
  );
  const terminalTransparency = clampNumber(
    input.terminalTransparency,
    0,
    100,
    fallback.terminalTransparency ?? 0,
  );

  return { palette, surface, transparency, overlayTransparency, terminalTransparency };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function isSafeArea(value: unknown): value is SafeArea {
  return value === "auto" || value === "left" || value === "right" || value === "center" || value === "none";
}
function isTaskMode(value: unknown): value is TaskMode {
  return value === "auto" || value === "ambient" || value === "banner" || value === "full" || value === "off";
}
function isShadowLevel(value: unknown): value is ShadowLevel {
  return value === "none" || value === "soft" || value === "strong";
}
function isFontChoice(value: unknown): value is FontChoice {
  return value === "system" || value === "grotesk" || value === "serif" || value === "mono";
}
function isDensity(value: unknown): value is DensityScale {
  return value === "compact" || value === "standard" || value === "comfortable";
}
function isMotionLevel(value: unknown): value is MotionLevel {
  return value === "off" || value === "reduced" || value === "standard";
}

/* --------------------------------------------------------------------------- 导出 */

/** 把当前外观导成 DS theme.json 的形状，方便日后与 DS 主题包互通 */
export function toDreamSkinTheme(
  state: AppearanceState,
  resolved: ResolvedAppearance,
): Record<string, unknown> {
  const profile = state.profiles[resolved];
  const focusX = resolveFocusX(state.art);
  const focusY = resolveFocusY(state.art);
  return {
    schemaVersion: 1,
    id: state.presetId ?? "custom",
    name: state.presetId ?? "自定义",
    appearance: state.mode,
    image: state.wallpaper.source ? "background.png" : undefined,
    art: {
      focusX: Number(focusX.toFixed(4)),
      focusY: Number(focusY.toFixed(4)),
      safeArea: state.art.safeArea === "auto" ? "none" : state.art.safeArea,
      taskMode: state.art.taskMode === "auto" ? "ambient" : state.art.taskMode,
    },
    colors: { ...profile.palette },
    chatStyle: state.chatStyle ?? "classic",
    glassBlur: state.glassBlur ?? 8,
  };
}