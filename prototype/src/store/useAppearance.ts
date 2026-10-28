import { create } from "zustand";
import {
  APPEARANCE_PRESETS,
  createPresetFromState,
  clamp,
  defaultAppearanceState,
  deriveCssVariables,
  profileEquals,
  resolveFocusX,
  resolveFocusY,
  toDreamSkinTheme,
  type AppearanceMode,
  type AppearancePreset,
  type AppearanceProfile,
  type AppearanceState,
  type ArtSettings,
  type LogoSettings,
  type PaletteKey,
  type ResolvedAppearance,
  type WallpaperSettings,
  type AvatarFrame,
  type ChatStyle,
} from "../core/appearance.ts";

import {
  loadAppearance,
  writeAppearance,
  saveWallpaperFile,
  saveLogoFile,
  saveThemeRpc,
  deleteThemeRpc,
  listThemesRpc,
  sanitizePresetProfile,
  readCachedAppearance,
  cacheAppearanceState,
  type AppearanceLoadSource,
} from "../core/appearanceStore.ts";

function getSystemAppearance(): ResolvedAppearance {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/**
 * 把推导出的变量写到 <html> 的内联 style 上。
 *
 * 用内联而不是改 styles.css，是因为 @theme / :root 那两层的优先级都低于内联，
 * 天然覆盖掉硬编码的两套配色，且不需要重编译 CSS。
 */
let lastTerminalSync: ((appearance: ResolvedAppearance) => void) | null = null;

/** 由 main.tsx 注入，避免 core 与 store 互相 import 终端管理器 */
export function setTerminalAppearanceSync(fn: (appearance: ResolvedAppearance) => void): void {
  lastTerminalSync = fn;
}


/* --------------------------------------------------------------------------- 壁纸 URL */

/**
 * 壁纸 data URL 不能直接塞 CSS 自定义属性：两 MB 的 base64 会被 Chrome
 * 静默丢成 none（inline style 读回来就是 none，属性还在、图永远不渲染）。
 * 这里把它转成 blob URL（几十个字符）再进 CSS，state 里仍保留完整 data URL。
 * 同一张图复用同一个 blob；换图或关壁纸时 revoke 旧的。
 */
let lastWallpaperSource: string | null = null;
let wallpaperBlobUrl: string | null = null;

function wallpaperCssUrl(source: string | null): string | null {
  if (source === lastWallpaperSource) return wallpaperBlobUrl;
  if (wallpaperBlobUrl !== null) {
    URL.revokeObjectURL(wallpaperBlobUrl);
    wallpaperBlobUrl = null;
  }
  lastWallpaperSource = source;
  if (source === null) return null;

  const comma = source.indexOf(",");
  const head = source.slice(0, comma);
  const body = source.slice(comma + 1);
  const mime = /^data:([^;]+)/.exec(head)?.[1] ?? "image/png";
  try {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    wallpaperBlobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    wallpaperBlobUrl = null;
  }
  return wallpaperBlobUrl;
}

/* --------------------------------------------------------------------------- 自定义 logo */

/** 上次写进 favicon 的来源键（brand:light/dark 或 custom:<path>），变化才重算 —— applyToDom 高频触发 */
let lastFaviconKey = "";
/** 上次写进 theme-color 的底色，变化才重写 —— 同上 */
let lastThemeColor = "";
/** 当前桌面端（Electron）是否已处于「自定义 logo」覆盖态，变化才重发图标 */
let brandIconIsCustom = false;

function loadImageElement(source: string): Promise<HTMLImageElement> {
  return new Promise((resolveImage, reject) => {
    const img = new Image();
    img.onload = () => resolveImage(img);
    img.onerror = () => reject(new Error("logo decode failed"));
    img.src = source;
  });
}

/** 本地 File → data URL（导入自定义 logo 时即时拿图，不等 daemon 回读）。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("logo read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * 把任意图 cover-crop 成正方形 PNG data URL。
 * favicon / Electron 窗口 / 托盘三个消费位都要小方图（位图），用户的图什么比例都有 ——
 * 居中裁方统一在这里做。SVG 无内在尺寸时按 1024 用户坐标系处理（与品牌标同规格）。
 */
async function squarePngDataUrl(source: string, size: number): Promise<string> {
  const img = await loadImageElement(source);
  const w = img.naturalWidth || 1024;
  const h = img.naturalHeight || 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  const edge = Math.min(w, h);
  ctx.drawImage(img, (w - edge) / 2, (h - edge) / 2, edge, edge, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

function applyToDom(state: AppearanceState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveAppearance(state);
  const vars = deriveCssVariables(state.profiles[resolved], state.art, state.wallpaper, state.ink?.[resolved]);

  // 壁纸图走 blob URL：deriveCssVariables 给出的是完整 data URL，超长会被 Chrome 丢掉
  const wallpaperUrl =
    state.wallpaper.enabled && state.wallpaper.source
      ? wallpaperCssUrl(state.wallpaper.source)
      : wallpaperCssUrl(null);
  vars["--aw-wallpaper-image"] = wallpaperUrl ? `url("${wallpaperUrl}")` : "none";

  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }

  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-chat-style", state.chatStyle ?? "classic");
  // blur 归零必须输出 none 而不是 blur(0px)：后者仍会为每个玻璃区块建合成层、
  // 采样背后内容，长会话上百个 backdrop 区域白付性能。styles.css 里消费模糊的
  // glass 规则统一读 --aw-glass-blur-filter（none 或 blur(Npx)）
  const glassBlur = clamp(Math.round(state.glassBlur ?? 0), 0, 32);
  root.style.setProperty("--aw-glass-blur", `${glassBlur}px`);
  root.style.setProperty("--aw-glass-blur-filter", glassBlur > 0 ? `blur(${glassBlur}px)` : "none");
  root.style.setProperty("--aw-chat-bg-opacity", `${state.chatBgOpacity ?? 35}%`);

  const electronBridge = (
    window as unknown as {
      electronAPI?: {
        notifyTheme?: (resolved: ResolvedAppearance) => void;
        setBrandIcon?: (payload: { window: string; tray: string } | null) => void;
      };
    }
  ).electronAPI;

  /*
   * 品牌图标（favicon / Electron 窗口 / 托盘）跟随同一真相源：
   * 自定义 logo 优先，其次亮白底 / 暗黑底双版品牌标。
   * 首屏 index.html 的脚本只是近似，这里才是权威修正。
   * favicon 与桌面图标都只在「来源变化」时重算 —— applyToDom 在拖滑杆时高频触发，
   * 每次都重画 canvas / 重发 IPC 就太浪费了。
   */
  const logoActive = state.logo.mode === "custom" && Boolean(state.logo.source);
  const faviconKey = logoActive ? `custom:${state.logo.path}` : `brand:${resolved}`;
  if (faviconKey !== lastFaviconKey) {
    lastFaviconKey = faviconKey;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) {
      if (logoActive && state.logo.source) {
        // 异步裁图回来时来源可能又变了（比如立刻切回品牌标）——过期结果直接丢弃
        void squarePngDataUrl(state.logo.source, 64)
          .then((href) => {
            if (lastFaviconKey === faviconKey) favicon.href = href;
          })
          .catch(() => {});
      } else {
        favicon.href = resolved === "dark" ? "/moyu-logo-dark-64.png" : "/moyu-logo-light-64.png";
      }
    }
  }
  if (logoActive !== brandIconIsCustom) {
    const wantCustom = logoActive;
    brandIconIsCustom = wantCustom;
    if (wantCustom && state.logo.source) {
      const source = state.logo.source;
      // 同上：生成期间用户可能已切回品牌标，过期的一组图标不许再推给主进程
      void Promise.all([squarePngDataUrl(source, 256), squarePngDataUrl(source, 32)])
        .then(([windowIcon, trayIcon]) => {
          if (brandIconIsCustom === wantCustom) {
            electronBridge?.setBrandIcon?.({ window: windowIcon, tray: trayIcon });
          }
        })
        .catch(() => {
          if (brandIconIsCustom === wantCustom) electronBridge?.setBrandIcon?.(null);
        });
    } else {
      electronBridge?.setBrandIcon?.(null);
    }
  }
  // theme-color（浏览器 / PWA 环境的窗口着色）跟真实画布底色走：
  // index.html 首屏设的只是按明暗档的近似值，自定义底色（如暮色镜湖 #101b55）不能一直错着
  const themeColor = state.profiles[resolved].palette.background;
  if (themeColor !== lastThemeColor) {
    lastThemeColor = themeColor;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeColor);
  }

  electronBridge?.notifyTheme?.(resolved);

  // 壁纸：没有图或未启用时移除 data 属性，让 CSS 的默认分支接管
  const hasWallpaper = state.wallpaper.enabled && Boolean(state.wallpaper.source);
  root.toggleAttribute("data-aw-wallpaper", hasWallpaper);

  // art 三项对齐 DS 的 data-* 命名，便于日后对照排查
  const safeArea = state.art.safeArea === "auto" ? "center" : state.art.safeArea;
  root.setAttribute("data-aw-art-safe", safeArea);
  root.setAttribute("data-aw-task-mode", state.art.taskMode === "auto" ? "ambient" : state.art.taskMode);
  root.setAttribute("data-aw-art-focus", `${resolveFocusX(state.art).toFixed(4)} ${resolveFocusY(state.art).toFixed(4)}`);

  lastTerminalSync?.(resolved);
}

export function resolveAppearance(state: AppearanceState): ResolvedAppearance {
  return state.mode === "auto" ? getSystemAppearance() : state.mode;
}

/**
 * 首屏先用「上次记住的外观」（localStorage 快路径，Electron 下 preload 已把
 * appearance.json 的 mode 合并进去）立即上色。之前这里盲用默认态（mode=auto
 * 跟随系统）：系统深色 + 应用钉浅色的用户每次启动都要先黑几秒，等 hydrate
 * 读回文件才被纠正。真正的外观随后仍由 hydrateFromFile() 换上。
 */
const initialState: AppearanceState = readCachedAppearance() ?? defaultAppearanceState();
applyToDom(initialState);

/**
 * 落盘用的乐观锁基准：我方最后一次见到的 appearance.json 内容哈希。
 * 自己写完会更新它；poll 读到不同 hash 就判定「被 agent 改了」。
 */
let lastKnownHash = "";
let lastPath: string | null = null;
let lastSource: AppearanceLoadSource = "defaults";

/** 写盘是异步的，但 UI 立刻要变。串成一条链，保证顺序、避免乱序回写互相覆盖 */
let writeChain: Promise<unknown> = Promise.resolve();

function persist(next: AppearanceState): void {
  // 乐观锁在文件不可用（hash 为空）时传 null，表示无条件覆盖 —— 首启落盘就得这么写
  const expected = lastKnownHash || null;
  writeChain = writeChain
    .then(() => writeAppearance(next, expected))
    .then((result) => {
      lastKnownHash = result.hash;
      lastPath = result.path;
      lastSource = "file";
      // 写成功即文件已接管：立刻翻掉可能挂着的「daemon 没连上」警告，不等下一轮轮询
      useAppearance.setState({ source: "file", filePath: result.path } as Partial<AppearanceStore>);
      // 选中即编辑：appearance.json 落盘成功后，把改动防抖回写到当前主题文件
      scheduleThemeAutosave();
    })
    .catch(() => {
      // 写失败（daemon 没起 / hash 冲突 / 磁盘满）：界面已经变了，不回滚，
      // 但也不能让这条链卡死 —— catch 吞掉，后面的写继续排队
    });
}

/* --------------------------------------------------------------------------- 主题自动保存 */

/** 防抖窗口：表面/透明度滑杆拖动会高频触发 publish，合并成一次主题文件写 */
const THEME_AUTOSAVE_DEBOUNCE_MS = 500;
let themeAutosaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleThemeAutosave(): void {
  if (typeof window === "undefined") return;
  if (themeAutosaveTimer !== null) clearTimeout(themeAutosaveTimer);
  themeAutosaveTimer = setTimeout(() => {
    themeAutosaveTimer = null;
    void flushThemeAutosave();
  }, THEME_AUTOSAVE_DEBOUNCE_MS);
}

/**
 * 把当前完整档案写回所选主题（内置主题以 themes/<id>.json override 形式落盘）。
 * 与该主题的当前定义完全一致时跳过 —— 否则只是「选中」这个动作就会凭空造出
 * override 文件、把内置卡片假标成「已修改」。
 */
async function flushThemeAutosave(): Promise<void> {
  const state = useAppearance.getState();
  const id = state.presetId;
  if (!id) return;
  const theme = state.allPresets().find((p) => p.id === id);
  if (!theme) return; // id 指向的主题不存在（文件被外部删掉等）：不瞎写
  const draft = createPresetFromState(state, theme.name, theme.desc, id);
  if (
    draft.mode === theme.mode &&
    draft.defaultChatStyle === (theme.defaultChatStyle ?? "classic") &&
    profileEquals(draft.light, theme.light) &&
    profileEquals(draft.dark, theme.dark)
  ) {
    return;
  }
  try {
    const res = await saveThemeRpc(draft);
    const saved = res.preset ?? draft;
    const nextCustom = [...useAppearance.getState().customPresets.filter((p) => p.id !== saved.id), saved];
    useAppearance.setState({ customPresets: nextCustom } as Partial<AppearanceStore>);
  } catch {
    // daemon 没起 / RPC 断了：口径同删除失败——提示但不打断，下一次改动会重试
    useAppearance.setState({
      lastError: `主题「${theme.name}」自动保存失败：后台 daemon 未写入主题文件`,
    } as Partial<AppearanceStore>);
  }
}

export interface AppearanceStore extends AppearanceState {
  resolvedAppearance: ResolvedAppearance;
  activeProfile: AppearanceProfile;
  /** 外观文件的绝对路径，设置页显示它，用户才知道该让 agent 改哪个文件 */
  filePath: string | null;
  /** 当前外观来自哪一层：文件 / 兜底 / 默认 */
  source: AppearanceLoadSource;
  /** 写盘失败时的最后一次错误，给设置页一条提示用 */
  lastError: string | null;
  /** 从 appearance.json 重新读一次（设置页的「重新读取文件」按钮 / 外部改动后） */
  reload: () => Promise<void>;
  /** 导入壁纸：落盘到 wallpapers/ 并把路径写回状态 */
  importWallpaper: (file: File) => Promise<void>;
  /** 导入自定义 logo：落盘到 logos/ 并立即启用 */
  importLogo: (file: File) => Promise<void>;
  setLogo: <K extends keyof LogoSettings>(key: K, value: LogoSettings[K]) => void;
  resetLogo: () => void;

  setMode: (mode: AppearanceMode) => void;
  /** 对话视图形态：classic=经典无气泡平铺，glass=液态毛玻璃卡片（特别适合带壁纸） */
  setChatStyle: (style: ChatStyle) => void;
  /** 薄玻璃模糊度 0..32px */
  setGlassBlur: (blur: number) => void;
  /** 对话区画布遮罩不透明度 0..100% */
  setChatBgOpacity: (opacity: number) => void;
  /** bot 头像框形态（全局设置，不分亮暗档案） */
  setAvatarFrame: (frame: AvatarFrame) => void;
  /** 磁盘上的主题文件（themes/*.json）：自定义主题 + 内置主题的 override（编辑过即存在） */
  customPresets: AppearancePreset[];
  /** 合并视图：3 张内置卡（被 override 过的吸收文件定义并标 modified）+ 纯自定义主题 */
  allPresets: () => AppearancePreset[];
  applyPreset: (preset: AppearancePreset) => void;
  /** 新建主题：从出厂默认定义起步，创建即选中；之后的编辑由自动保存落盘 */
  createTheme: (name: string, desc?: string) => Promise<AppearancePreset>;
  /** 重命名主题（同 id 覆盖写盘，不动定义内容） */
  renameTheme: (id: string, name: string) => Promise<void>;
  /** 删除主题（自定义主题或内置主题的 override）；删的是当前选中时切回默认主题 */
  deleteTheme: (id: string) => Promise<void>;
  /** 内置主题恢复出厂：删除 override 文件并应用出厂定义 */
  resetThemeToFactory: (id: string) => Promise<void>;
  /** 全局文字色（亮/暗各一，独立于主题调色板，切主题不变） */
  setInk: (side: ResolvedAppearance, value: string) => void;
  /** 文字色恢复出厂（亮近黑 / 暗近白） */
  resetInk: () => void;
  setPaletteColor: (key: PaletteKey, value: string) => void;
  resetPaletteColor: (key: PaletteKey) => void;
  resetPalette: () => void;
  setTransparency: (value: number | null) => void;
  /** 设置页整页底色的透明度（默认 0% 不透明） */
  setOverlayTransparency: (value: number) => void;
  /** 终端画布底色的透明度（默认 0% 不透明） */
  setTerminalTransparency: (value: number) => void;
  setSurface: <K extends keyof AppearanceProfile["surface"]>(
    key: K,
    value: AppearanceProfile["surface"][K],
  ) => void;
  resetSurface: () => void;
  setArt: <K extends keyof ArtSettings>(key: K, value: ArtSettings[K]) => void;
  setWallpaper: <K extends keyof WallpaperSettings>(key: K, value: WallpaperSettings[K]) => void;
  resetArt: () => void;
  resetWallpaper: () => void;
  resetAll: () => void;
  /** 把当前外观导出成 DS theme.json 形状 */
  exportDreamSkinTheme: () => Record<string, unknown>;
}

function activeProfileOf(state: AppearanceState): AppearanceProfile {
  return state.profiles[resolveAppearance(state)];
}

/**
 * 统一出口：落盘 → 刷 DOM → 回填派生字段，返回可直接喂给 zustand set 的补丁。
 * 任何 setter 都不该绕过它，否则会出现「界面变了但没落盘」这种幽灵状态。
 */
function publish(next: AppearanceState): Partial<AppearanceStore> {
  persist(next);
  applyToDom(next);
  return {
    ...next,
    resolvedAppearance: resolveAppearance(next),
    activeProfile: activeProfileOf(next),
    lastError: null,
  } as Partial<AppearanceStore>;
}

function withProfile(
  state: AppearanceState,
  resolved: ResolvedAppearance,
  patch: (profile: AppearanceProfile) => AppearanceProfile,
): AppearanceState {
  // 选中即编辑模型：presetId 始终指向当前主题，档案改动由主题自动保存落盘
  // （见 scheduleThemeAutosave），不再有「改成自定义态」的哨兵翻转
  return {
    ...state,
    profiles: { ...state.profiles, [resolved]: patch(state.profiles[resolved]) },
  };
}

export const useAppearance = create<AppearanceStore>((set, get) => ({
  ...initialState,
  resolvedAppearance: resolveAppearance(initialState),
  activeProfile: activeProfileOf(initialState),
  filePath: null,
  source: "defaults",
  lastError: null,
  customPresets: [],

  allPresets: () => {
    const builtinIds = new Set(APPEARANCE_PRESETS.map((p) => p.id));
    const overrides = new Map(get().customPresets.filter((p) => builtinIds.has(p.id)).map((p) => [p.id, p]));
    const builtins = APPEARANCE_PRESETS.map((p) => {
      const ov = overrides.get(p.id);
      // 内置主题被编辑过：override 文件的定义吸收进卡片（仍是内置卡，额外标 modified）
      if (ov === undefined) return { ...p, builtin: true as const };
      return {
        ...p,
        mode: ov.mode,
        light: ov.light,
        dark: ov.dark,
        defaultChatStyle: ov.defaultChatStyle ?? p.defaultChatStyle,
        builtin: true as const,
        modified: true as const,
        filePath: ov.filePath,
      };
    });
    const customs = get().customPresets.filter((p) => !builtinIds.has(p.id));
    return [...builtins, ...customs];
  },

  createTheme: async (name, desc = "") => {
    // 新主题一律从出厂默认定义起步（不继承当前正在用的自定义主题）
    const preset = createPresetFromState(defaultAppearanceState(), name, desc);
    const res = await saveThemeRpc(preset);
    const saved = res.preset ?? preset;
    set({ customPresets: [...get().customPresets.filter((p) => p.id !== saved.id), saved] });
    get().applyPreset(saved);
    return saved;
  },

  renameTheme: async (id, name) => {
    const theme = get().allPresets().find((p) => p.id === id);
    if (!theme) return;
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === theme.name) return;
    const renamed = { ...theme, name: trimmed };
    const res = await saveThemeRpc(renamed);
    const saved = res.preset ?? renamed;
    set({ customPresets: [...get().customPresets.filter((p) => p.id !== saved.id), saved] });
  },

  deleteTheme: async (id) => {
    const deleted = await deleteThemeRpc(id);
    if (!deleted) {
      // daemon 删盘失败（文件不在位 / daemon 没起 / RPC 断了）：本地列表不动，
      // 否则 4 秒后 poll 会把磁盘上的主题又读回来，界面与盘上打架
      set({ lastError: `主题「${id}」删除失败：后台 daemon 未删除对应主题文件` });
      return;
    }
    set({ customPresets: get().customPresets.filter((p) => p.id !== id) });
    // 删的是当前选中主题：切回第一张内置卡（它若也被改过则用其 override 定义）
    if (get().presetId === id) {
      const fallbackCard = get().allPresets()[0];
      if (fallbackCard) get().applyPreset(fallbackCard);
    }
  },

  resetThemeToFactory: async (id) => {
    const factory = APPEARANCE_PRESETS.find((p) => p.id === id);
    if (!factory) return;
    // override 文件删除（不存在时 daemon 返回 false，无碍）；再应用出厂常量。
    // 应用后状态 == 出厂定义，主题自动保存的一致性检查会跳过回写，不会假死复活
    await deleteThemeRpc(id);
    set({ customPresets: get().customPresets.filter((p) => p.id !== id) });
    get().applyPreset(factory);
  },

  setInk: (side, value) => {
    set(publish({ ...get(), ink: { ...get().ink, [side]: value } }));
  },

  resetInk: () => {
    const def = defaultAppearanceState();
    set(publish({ ...get(), ink: { ...def.ink } }));
  },

  reload: async () => {
    await hydrate();
  },

  importWallpaper: async (file: File) => {
    try {
      const relPath = await saveWallpaperFile(file);
      // 落盘成功后立刻把图读回来看效果；读不回来（比如 daemon 刚断）就只留路径，
      // 下次 poll 会补上
      const probe = await loadAppearance();
      const fresh = probe.state.wallpaper.source;
      const next = get();
      set(
        publish({
          ...next,
          wallpaper: {
            ...get().wallpaper,
            enabled: true,
            path: relPath,
            source: fresh ?? null,
          },
        }),
      );
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  importLogo: async (file) => {
    try {
      const relPath = await saveLogoFile(file);
      // source 直接用本地 File 转 data URL —— 刚落盘的文件 appearance.json 还没记，
      // 此时去 probe 读回来的只会是旧 logo；不等 4 秒轮询，导入当场生效
      const source = await fileToDataUrl(file);
      set(publish({ ...get(), logo: { mode: "custom", path: relPath, source } }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  setLogo: (key, value) => {
    set(publish({ ...get(), logo: { ...get().logo, [key]: value } }));
  },

  resetLogo: () => {
    set(publish({ ...get(), logo: { mode: "brand", path: null, source: null } }));
  },

  setMode: (mode) => {
    set(publish({ ...get(), mode }));
  },

  setAvatarFrame: (frame) => {
    set(publish({ ...get(), avatarFrame: frame }));
  },

  setChatStyle: (style) => {
    set(publish({ ...get(), chatStyle: style }));
  },

  setGlassBlur: (blur) => {
    set(publish({ ...get(), glassBlur: clamp(Math.round(blur), 0, 32) }));
  },

  setChatBgOpacity: (opacity) => {
    set(publish({ ...get(), chatBgOpacity: clamp(Math.round(opacity), 0, 100) }));
  },

  applyPreset: (preset) => {
    // 主题 = 完整档案（palette + surface + 三项透明度）。选中即编辑模型下
    // 主题文件存的就是完整档案，切回来必须整体还原——只换配色会让「在 A 主题
    // 调的圆角，切到 B 再切回 A」丢失。壁纸/艺术/文字色/头像框等全局项仍不动。
    const cur = get();
    // 消毒闸门（必须有，后端 listThemes 的形状兜底只是双保险）：themes/*.json 由
    // 用户/agent 手写，preset.light/dark 可能是 null、空对象或字段残缺 —— 类型断言
    // 挡不住运行时。先过 appearance.json 同款消毒器：坏侧回落当前对应侧档案
    //（外观不变），绝不 null 进 cloneProfile，也绝不把空 palette persist 进 appearance.json
    const presetLight = sanitizePresetProfile(preset?.light, cur.profiles.light);
    const presetDark = sanitizePresetProfile(preset?.dark, cur.profiles.dark);
    const presetMode: AppearanceMode =
      preset?.mode === "light" || preset?.mode === "dark" || preset?.mode === "auto"
        ? preset.mode
        : cur.mode;
    const presetChatStyle: ChatStyle =
      preset?.defaultChatStyle === "glass" || preset?.defaultChatStyle === "classic"
        ? preset.defaultChatStyle
        : cur.chatStyle ?? "classic";
    const next: AppearanceState = {
      ...cur,
      mode: presetMode,
      profiles: {
        light: cloneProfile(presetLight),
        dark: cloneProfile(presetDark),
      },
      presetId: preset.id,
      chatStyle: presetChatStyle,
    };
    set(publish(next));
  },

  setPaletteColor: (key, value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      palette: { ...profile.palette, [key]: value },
    }));
    set(publish(next));
  },

  resetPaletteColor: (key) => {
    // 重置基准 = 对应亮/暗档的出厂定义（温润羊皮纸浅色 / 黑曜石深色），
    // 不再按所选主题找——主题本身就是被编辑对象，重置回主题值等于没重置
    const resolved = resolveAppearance(get());
    const base = defaultAppearanceState().profiles[resolved].palette[key];
    get().setPaletteColor(key, base);
  },

  resetPalette: () => {
    const resolved = resolveAppearance(get());
    const base = defaultAppearanceState().profiles[resolved];
    const next = withProfile(get(), resolved, () => cloneProfile(base));
    set(publish(next));
  },

  setTransparency: (value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({ ...profile, transparency: value }));
    set(publish(next));
  },

  setOverlayTransparency: (value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({ ...profile, overlayTransparency: value }));
    set(publish(next));
  },

  setTerminalTransparency: (value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({ ...profile, terminalTransparency: value }));
    set(publish(next));
  },

  setSurface: (key, value) => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      surface: { ...profile.surface, [key]: value },
    }));
    set(publish(next));
  },

  resetSurface: () => {
    const resolved = resolveAppearance(get());
    const next = withProfile(get(), resolved, (profile) => ({
      ...profile,
      surface: { ...defaultAppearanceState().profiles[resolved].surface },
    }));
    set(publish(next));
  },

  setArt: (key, value) => {
    const next: AppearanceState = { ...get(), art: { ...get().art, [key]: value } };
    set(publish(next));
  },

  resetArt: () => {
    const next: AppearanceState = {
      ...get(),
      art: { ...defaultAppearanceState().art },
    };
    set(publish(next));
  },

  setWallpaper: (key, value) => {
    const next: AppearanceState = { ...get(), wallpaper: { ...get().wallpaper, [key]: value } };
    set(publish(next));
  },

  resetWallpaper: () => {
    const next: AppearanceState = {
      ...get(),
      wallpaper: { ...defaultAppearanceState().wallpaper },
    };
    set(publish(next));
  },

  resetAll: () => {
    set(publish(defaultAppearanceState()));
  },

  exportDreamSkinTheme: () => {
    const state = get();
    return toDreamSkinTheme(state, resolveAppearance(state));
  },
}));

function cloneProfile(profile: AppearanceProfile): AppearanceProfile {
  return {
    palette: { ...profile.palette },
    surface: { ...profile.surface },
    transparency: profile.transparency,
    overlayTransparency: profile.overlayTransparency,
    terminalTransparency: profile.terminalTransparency,
  };
}

/* --------------------------------------------------------------------------- 文件同步 */

/**
 * 从 appearance.json 读一次并上屏。
 *
 * hash 变了才动 —— 自己刚写完的那次 hash 会被 persist 记下来，
 * 所以这里不会把自己的回写当成「外部改动」再来一遍。
 */
async function hydrate(): Promise<void> {
  let result;
  try {
    result = await loadAppearance();
  } catch {
    return;
  }

  lastKnownHash = result.hash;
  lastPath = result.path;
  lastSource = result.source;
  // 采纳文件态后同步刷 localStorage 快路径：下次启动的首帧（index.html 内联
  // 脚本 / 本模块初始态）才能按这份最新真相上色，而不是按旧的 UI 兜底
  cacheAppearanceState(result.state);
  applyToDom(result.state);
  useAppearance.setState({
    ...result.state,
    resolvedAppearance: resolveAppearance(result.state),
    activeProfile: activeProfileOf(result.state),
    filePath: result.path,
    source: result.source,
    customPresets: result.customThemes ?? useAppearance.getState().customPresets,
  } as Partial<AppearanceStore>);
}

/**
 * 轮询盘上文件，把 agent 的改动接进来。
 *
 * 只在「上次读到的 hash 与本次不同」时才 set 状态，所以常驻开销只是一次小 RPC，
 * 不会引起任何重渲染。4 秒一轮：既能在 agent 保存后很快看到，又不至于把回环打满。
 */
const POLL_INTERVAL_MS = 4000;

async function pollExternalChanges(): Promise<void> {
  let result;
  try {
    result = await loadAppearance();
  } catch {
    return;
  }
  if (result.hash === lastKnownHash) {
    // 文件没变，提前返回；但 source 若曾被一次瞬断（或首启播种）挂在
    // fallback/defaults，必须在这里修回 file —— 之后 hash 不会再变，
    // 没有别的分支能撤下「daemon 没连上」的警告
    if (useAppearance.getState().source !== result.source) {
      lastSource = result.source;
      useAppearance.setState({ source: result.source, filePath: result.path } as Partial<AppearanceStore>);
    }
    return;
  }

  // 兜底层降级时 hash 恒为空字符串，这种"变化"不是外部编辑，别覆盖用户在界面上的即时调整
  if (!result.hash) {
    lastSource = result.source;
    useAppearance.setState({ source: result.source, filePath: result.path } as Partial<AppearanceStore>);
    return;
  }

  lastKnownHash = result.hash;
  lastPath = result.path;
  lastSource = result.source;
  // 外部（agent）改了文件：连 localStorage 快路径一起刷，下次启动首帧即新主题
  cacheAppearanceState(result.state);
  applyToDom(result.state);
  useAppearance.setState({
    ...result.state,
    resolvedAppearance: resolveAppearance(result.state),
    activeProfile: activeProfileOf(result.state),
    filePath: result.path,
    source: result.source,
    customPresets: result.customThemes ?? useAppearance.getState().customPresets,
  } as Partial<AppearanceStore>);
}

/* 首屏立即从文件取真实外观（此时界面已经用缓存/默认配色上色，不会闪） */
void hydrate();

if (typeof window !== "undefined") {
  window.setInterval(() => {
    void pollExternalChanges();
  }, POLL_INTERVAL_MS);

  // 切回这个窗口时立刻查一次：agent 改完文件、你切回来就看到了
  window.addEventListener("focus", () => {
    void pollExternalChanges();
  });
}

/* 系统明暗变化时，auto 模式要跟着重算 —— 与旧版 useTheme 的行为一致 */
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const state = useAppearance.getState();
    if (state.mode !== "auto") return;
    persist(state);
    applyToDom(state);
    useAppearance.setState({
      resolvedAppearance: resolveAppearance(state),
      activeProfile: activeProfileOf(state),
    });
  });
}