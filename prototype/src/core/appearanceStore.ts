/**
 * 外观设置的落盘层 —— 唯一真相是 <homeDir>/appearance.json，浏览器 localStorage 只是没 daemon 时的兜底。
 *
 * 为什么要文件而不是 localStorage：用户要的是「让 agent 改外观」。
 * localStorage 里的东西 agent 根本碰不到；appearance.json 在磁盘上，agent 用 Read/Write 直接改，
 * 应用下一次读到就是新的。daemon 侧刻意不做内存缓存（对齐 bots/registry.ts 的「文件即数据库」），
 * 所以这条链路不需要任何失效机制。
 *
 * 三层降级，逐层更弱但绝不把界面搞崩（沿用本项目 fail-open 的既有约定）：
 *   文件（daemon 在跑） → localStorage（daemon 没了但上次存过） → 内置默认
 *
 * 外部改动检测：每次 read 拿回 hash，与上次不同就认定为「被 agent 改了」并采用。
 * 前端自己写的时候会把 hash 记下来，所以自己的回写不会被误判成外部改动。
 */

import {
  defaultAppearanceState,
  sanitizeAppearanceState,
  toDreamSkinTheme,
  type AppearancePreset,
  type AppearanceState,
  type ResolvedAppearance,
} from "../core/appearance.ts";

/** daemon 没起来时的兜底键。只在文件不可用时读写，不是主存储。 */
const FALLBACK_STORAGE_KEY = "agent-workbench:appearance:fallback";
/** 旧版三档键，只为一次性迁移用，读完就不再关心 */
const LEGACY_THEME_KEY = "agent-workbench:theme-mode";

const RPC_TIMEOUT_MS = 8000;

export interface AppearanceFileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string;
  readonly hash: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  readonly wallpaperRel: string | null;
  readonly wallpaperPath: string | null;
  /** daemon 把壁纸读成 data URL 一起带回来（图不进 JSON） */
  readonly wallpaperDataUrl: string | null;
  /** daemon 把自定义 logo 读成 data URL 一起带回来（图不进 JSON） */
  readonly logoDataUrl: string | null;
  /** daemon 从 themes/ 目录读出的所有自定义预设主题 */
  readonly themes?: AppearancePreset[];
}

export type AppearanceLoadSource = "file" | "fallback" | "defaults";

export interface AppearanceLoadResult {
  readonly state: AppearanceState;
  readonly source: AppearanceLoadSource;
  /** 文件的绝对路径，设置页要显示它，用户才知道该让 agent 改哪个文件 */
  readonly path: string | null;
  readonly hash: string;
  readonly customThemes?: AppearancePreset[];
}

async function call<T>(
  method: string,
  params: unknown = {},
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  const { DaemonClient, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
  return DaemonClient.get(defaultDaemonEndpoint()).rpc<T>(method, params, timeoutMs);
}

/* --------------------------------------------------------------------------- 序列化 */

/**
 * 落盘形态：$ 开头的是元信息（对齐 bot.json / listBots 的 $meta 约定），
 * 其余全是 AppearanceState 的原样字段 —— 这样 agent 读这个文件时看到的就是设置页上那几项。
 */
export function serializeAppearance(state: AppearanceState): string {
  return `${JSON.stringify(
    {
      $meta: {
        schemaVersion: 1,
        generator: "agent-workbench",
        // 提示直接写在这里，agent 打开文件就知道这份 schema 是什么
        note: "外观设置。改完保存，应用会自动读取。appearance/art/surface/wallpaper/logo 的可选项见 prototype/src/core/appearance.ts",
      },
      mode: state.mode,
      presetId: state.presetId,
      profiles: state.profiles,
      art: state.art,
      avatarFrame: state.avatarFrame,
      logo: {
        mode: state.logo.mode,
        path: state.logo.path,
      },
      wallpaper: {
        enabled: state.wallpaper.enabled,
        // 只写 path，不写 source：source 是 daemon 回的运行时 data URL，
        // 把它留在文件里等于邀请 agent 往这塞一整张图的 base64 —— 既没意义也撑爆文件
        path: state.wallpaper.path,
        zoom: state.wallpaper.zoom,
        dim: state.wallpaper.dim,
        taskIntensity: state.wallpaper.taskIntensity,
      },
    },
    null,
    2,
  )}\n`;
}

/** 读回来时把 wallpaper.path / logo.path（文件路径）与图（data URL）合成前端要的那个 source。 */
function deserializeAppearance(
  json: AppearanceState,
  wallpaperDataUrl: string | null,
  logoDataUrl: string | null,
): AppearanceState {
  let next = json;
  if (!wallpaperDataUrl) {
    // 文件里声明了壁纸但字节拿不到（路径越界/文件不在位）：关掉它，别留一个空壳开关
    next = next.wallpaper.source
      ? { ...next, wallpaper: { ...next.wallpaper, enabled: false, source: null } }
      : next;
  } else {
    next = { ...next, wallpaper: { ...next.wallpaper, source: wallpaperDataUrl } };
  }
  if (json.logo.mode === "custom" && !logoDataUrl) {
    // 自定义 logo 声明了但字节拿不到：回落品牌标（渲染端 source 为空本来也会回落），
    // mode 一并翻回 brand，免得设置页显示「自定义」却啥也看不到
    next = { ...next, logo: { mode: "brand", path: next.logo.path, source: null } };
  } else if (logoDataUrl) {
    next = { ...next, logo: { ...next.logo, source: logoDataUrl } };
  }
  return next;
}

/* --------------------------------------------------------------------------- 降级层 */

function readFallbackState(): AppearanceState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (raw) return sanitizeAppearanceState(JSON.parse(raw));

    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === "light" || legacy === "dark") {
      return { ...defaultAppearanceState(), mode: legacy };
    }
    if (legacy === "system") {
      // 旧版叫 system，DS 词汇里叫 auto，顺手对齐免得同一个概念两个名字
      return { ...defaultAppearanceState(), mode: "auto" };
    }
  } catch {
    // localStorage 不可用（隐私模式）或 JSON 损坏 —— 退回默认值，不阻断渲染
  }
  return null;
}

function writeFallbackState(state: AppearanceState): void {
  if (typeof localStorage === "undefined") return;
  try {
    // source 是运行时 data URL（壁纸 / 自定义 logo，可能几 MB），读回时 sanitize
    // 也会把它清掉 —— 落缓存前先剥掉，别让一张图占满 localStorage 配额
    const lean = {
      ...state,
      wallpaper: { ...state.wallpaper, source: null },
      logo: { ...state.logo, source: null },
    };
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(lean));
  } catch {
    // 配额超限时静默失败：设置仍在内存里生效，只是这次没能兜底存下来
  }
}

/**
 * 同步读「上次记住的外观」（localStorage 快路径），不碰 daemon、不等网络。
 * 给首屏两处用：index.html 的内联脚本（裸读裸解析）与 useAppearance 的模块
 * 初始态 —— 让第一帧就按上次主题上色，而不是等 appearance.read 往返后再纠正。
 * 返回 null = 没有任何缓存（首启 / 隐私模式），调用方回落内置默认。
 */
export function readCachedAppearance(): AppearanceState | null {
  return readFallbackState();
}

/**
 * 把一份可信的外观刷进 localStorage 快路径缓存。采纳文件态时调用
 * （hydrate / 轮询发现外部改动）；UI 自己改设置的路径 writeAppearance 已自带。
 * 不刷的话缓存只反映「用户上次在界面上动了什么」，agent 直接改 appearance.json
 * 的场景它永远是旧的，下次启动首帧还是会用错主题。
 */
export function cacheAppearanceState(state: AppearanceState): void {
  writeFallbackState(state);
}

/* --------------------------------------------------------------------------- 公开接口 */

/**
 * 读外观。永远返回一份可用的 AppearanceState —— 拿不到文件就退到 localStorage，再拿不到退默认。
 */
export async function loadAppearance(): Promise<AppearanceLoadResult> {
  try {
    const snapshot = await call<AppearanceFileSnapshot>("appearance.read");
    if (snapshot?.exists) {
      const parsed = JSON.parse(snapshot.content) as AppearanceState;
      const state = deserializeAppearance(
        sanitizeAppearanceState(parsed),
        snapshot.wallpaperDataUrl,
        snapshot.logoDataUrl,
      );
      // 文件里没有 wallpaper.path 但历史上走过兜底 —— 以文件为准，别把两处状态混起来
      return { state, source: "file", path: snapshot.path, hash: snapshot.hash, customThemes: snapshot.themes ?? [] };
    }

    // 文件还没有（首次启动）：把兜底里那份迁上去，之后文件就是唯一真相
    const fallback = readFallbackState();
    const seed = fallback ?? defaultAppearanceState();
    // 首次启动就落一份默认 —— 用户要的是「随时有个文件能交给 agent 改」，
    // 要是等他先动一次设置才出现文件，那这个能力等于没有
    const write = await call<{ hash: string }>("appearance.write", {
      content: serializeAppearance(seed),
      expectedHash: null,
    });
    return {
      state: seed,
      source: fallback ? "fallback" : "defaults",
      path: snapshot.path,
      hash: write.hash,
    };
  } catch {
    // daemon 没起 / 鉴权失败 / 网络断 —— 一律降级，绝不让外观把整个界面拖垮
    const fallback = readFallbackState();
    return {
      state: fallback ?? defaultAppearanceState(),
      source: fallback ? "fallback" : "defaults",
      path: null,
      hash: "",
    };
  }
}

/** 我方写盘后的落点。只在文件可用时有意义。 */
export interface AppearanceWriter {
  readonly write: (state: AppearanceState, expectedHash: string | null) => Promise<void>;
  readonly conflict: () => boolean;
}

export class AppearanceConflict extends Error {
  constructor(readonly current: AppearanceState) {
    super("appearance.json changed on disk");
    this.name = "AppearanceConflict";
  }
}

export async function writeAppearance(
  state: AppearanceState,
  expectedHash: string | null,
): Promise<{ hash: string; path: string }> {
  // 先落兜底：daemon 此刻不可用也不至于丢掉用户刚做的调整
  writeFallbackState(state);
  const result = await call<{ hash: string; path: string }>("appearance.write", {
    content: serializeAppearance(state),
    expectedHash,
  });
  return result;
}

/**
 * 存一张壁纸：先让 daemon 落盘到 <homeDir>/wallpapers/，再把返回的相对路径写回 state。
 * 这样 appearance.json 里只有一个路径字符串，图本身不进文件，agent 改起来毫无负担。
 */
export async function saveWallpaperFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const base64 = toBase64(buffer);
  const result = await call<{ relPath: string }>(
    "appearance.wallpaper.save",
    { name: file.name, base64 },
    // 大图要给足超时，32MB 的 base64 走回环也要一会儿
    30_000,
  );
  return result.relPath;
}

/**
 * 存一张自定义 logo：先让 daemon 落盘到 <homeDir>/logos/，再把返回的相对路径写回 state。
 * 与壁纸同一套口径 —— appearance.json 里只有一个路径字符串，图本身不进文件。
 */
export async function saveLogoFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const base64 = toBase64(buffer);
  const result = await call<{ relPath: string }>("appearance.logo.save", {
    name: file.name,
    base64,
  });
  return result.relPath;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export { toDreamSkinTheme };
export type { ResolvedAppearance };
/* --------------------------------------------------------------------------- 主题预设 RPC */

export async function listThemesRpc(): Promise<AppearancePreset[]> {
  try {
    return await call<AppearancePreset[]>("appearance.theme.list");
  } catch {
    return [];
  }
}

export async function saveThemeRpc(
  preset: AppearancePreset,
): Promise<{ id: string; path: string; preset: AppearancePreset }> {
  return await call<{ id: string; path: string; preset: AppearancePreset }>(
    "appearance.theme.save",
    { preset },
  );
}

export async function deleteThemeRpc(id: string): Promise<boolean> {
  try {
    const res = await call<{ deleted: boolean }>("appearance.theme.delete", { id });
    return Boolean(res?.deleted);
  } catch {
    return false;
  }
}
