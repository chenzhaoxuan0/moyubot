/**
 * 外观设置的唯一落盘形态：<homeDir>/appearance.json（默认 ~/.agent-workbench/appearance.json）。
 *
 * 沿用本项目「文件即数据库」的既有约定（docs/08 存储归位 / bots/registry.ts）：
 * daemon 不做内存缓存，每次调用都真读盘，所以
 * 「用户让 agent 改 appearance.json → 应用里立刻看到新外观」天然成立，
 * 不需要任何失效机制，也不会有两份真相打架。
 *
 * 为什么不是 localStorage：浏览器存的东西 agent 碰不到，用户也就没法用 agent 调外观。
 *
 * 两个刻意的设计：
 *  1. **壁纸 / logo 不进 JSON**。appearance.json 里只存一个 `wallpaper.path` / `logo.path`
 *     （相对 homeDir 或绝对路径），图本身放 <homeDir>/wallpapers/ 与 <homeDir>/logos/。
 *     否则一张图就是几百 KB 的 data URL，这个文件会被撑到没法用 agent 编辑、也没法进 git。
 *  2. **写入带 hash 乐观锁**。前端写之前把它读到的 hash 带上；盘上文件被别人改过
 *     （多半就是 agent 改的）就抛 conflict，绝不静默覆盖掉对方的编辑。
 */

import { mkdir, readFile, rename, stat, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { log } from "../log.ts";

const APPEARANCE_FILE = "appearance.json";
const WALLPAPER_DIR = "wallpapers";
const LOGO_DIR = "logos";

/** 单张壁纸的上限。32 MiB 与 DS 主题包归档上限同档，再大基本是误操作。 */
const MAX_WALLPAPER_BYTES = 32 * 1024 * 1024;
/** 单张 logo 的上限。logo 显示位都是小方图，8 MiB 已绰绰有余。 */
const MAX_LOGO_BYTES = 8 * 1024 * 1024;
/** appearance.json 自身的上限，防止一个坏循环把 daemon 写爆。 */
const MAX_APPEARANCE_BYTES = 1024 * 1024;

const ALLOWED_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
/** logo 额外放行 .svg —— 品牌标本身就是 SVG，用户拿同源文件来换装是合理诉求。 */
const ALLOWED_LOGO_EXT = new Set([...ALLOWED_IMAGE_EXT, ".svg"]);

export interface AppearanceFileMeta {
  /** 绝对路径——设置页要显示它，用户才知道"让 agent 改哪个文件" */
  readonly path: string;
  readonly exists: boolean;
  readonly content: string;
  /** sha256 前 16 hex；乐观锁的比对基准 */
  readonly hash: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  /** appearance.json 里写的 wallpaper.path 原样（相对 homeDir 或绝对路径） */
  readonly wallpaperRel: string | null;
  /** wallpaper.path 解析出来的绝对路径；越界或不是图就为 null */
  readonly wallpaperPath: string | null;
  /** 同上，logo.path 的原样与解析结果 */
  readonly logoRel: string | null;
  readonly logoPath: string | null;
}

export interface WriteAppearanceResult {
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface SaveWallpaperResult {
  /** 写进 appearance.json 的 wallpaper.path（相对 homeDir） */
  readonly relPath: string;
  readonly absPath: string;
  readonly bytes: number;
}

/** 外部修改（多半是 agent）撞上了前端手改：抛这个，前端拿它弹「覆盖 / 重新加载」 */
export class AppearanceConflictError extends Error {
  readonly code = "conflict";
  readonly data: { expected: string; current: string };
  constructor(expected: string, current: string) {
    super(`appearance.json changed on disk since it was read (expected ${expected}, got ${current})`);
    this.name = "AppearanceConflictError";
    this.data = { expected, current };
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function appearancePath(homeDir: string): string {
  return path.join(homeDir, APPEARANCE_FILE);
}

export function wallpaperDir(homeDir: string): string {
  return path.join(homeDir, WALLPAPER_DIR);
}

export function logoDir(homeDir: string): string {
  return path.join(homeDir, LOGO_DIR);
}

/**
 * 把 wallpaper.path 解析成绝对路径。
 * 相对路径以 homeDir 为基准（agent 写 "wallpapers/x.jpg" 就够了，不必写绝对路径）；
 * 绝对路径原样使用；http(s)/data URL 不是本方法的管辖范围，返回 null。
 */
export function resolveWallpaper(homeDir: string, rel: string | null | undefined): string | null {
  if (typeof rel !== "string") return null;
  const value = rel.trim();
  if (!value || /^(https?:|data:|blob:)/i.test(value)) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  // 相对路径不允许越出 homeDir —— 防手改 JSON 时把 daemon 变成任意文件读取器
  const norm = path.normalize(path.join(homeDir, value));
  const root = path.resolve(homeDir);
  const resolved = path.resolve(norm);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/* --------------------------------------------------------------------------- 读 */

/**
 * 读 appearance.json。不存在时返回 exists:false + 空串，**不抛错** ——
 * 首次启动没这个文件是正常状态，不是故障。
 */
export async function readAppearance(homeDir: string): Promise<AppearanceFileMeta> {
  const file = appearancePath(homeDir);
  let content = "";
  let mtimeMs = 0;
  let bytes = 0;

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a regular file");
    if (s.size > MAX_APPEARANCE_BYTES) {
      throw new Error(`appearance.json exceeds ${MAX_APPEARANCE_BYTES} bytes`);
    }
    content = await readFile(file, "utf8");
    mtimeMs = s.mtimeMs;
    bytes = Buffer.byteLength(content, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // 文件坏了不该让前端整页崩：log 出来，当成「没有」处理，前端会落回默认值
      log.warn("appearance.json unreadable, falling back to defaults", {
        path: file,
        error: error instanceof Error ? error.message : String(error),
      });
      content = "";
      bytes = 0;
      mtimeMs = 0;
    }
  }

  let wallpaperRel: string | null = null;
  let wallpaperPath: string | null = null;
  let logoRel: string | null = null;
  let logoPath: string | null = null;
  if (content) {
    try {
      const parsed = JSON.parse(content) as { wallpaper?: { path?: unknown }; logo?: { path?: unknown } };
      const rel = parsed?.wallpaper?.path;
      if (typeof rel === "string" && rel.trim()) {
        wallpaperRel = rel;
        const abs = resolveWallpaper(homeDir, rel);
        // 相对路径解析出来却越不出 homeDir —— 文件被手改坏了，只保留声明不提供字节
        wallpaperPath = abs && ALLOWED_IMAGE_EXT.has(path.extname(abs).toLowerCase()) ? abs : null;
      }
      const logoRelRaw = parsed?.logo?.path;
      if (typeof logoRelRaw === "string" && logoRelRaw.trim()) {
        logoRel = logoRelRaw;
        const abs = resolveWallpaper(homeDir, logoRelRaw);
        logoPath = abs && ALLOWED_LOGO_EXT.has(path.extname(abs).toLowerCase()) ? abs : null;
      }
    } catch {
      // JSON 坏了同样不抛，交给前端 sanitizeAppearanceState 兜底
      wallpaperRel = null;
      wallpaperPath = null;
      logoRel = null;
      logoPath = null;
    }
  }

  return {
    path: file,
    exists: content.length > 0,
    content,
    hash: hashOf(content),
    mtimeMs,
    bytes,
    wallpaperRel,
    wallpaperPath,
    logoRel,
    logoPath,
  };
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/** 读一张图并包成 data URL（壁纸/logo 共用）。文件不在位 / 超限 / 读失败一律返回 null。 */
async function readImageAsDataUrl(abs: string, maxBytes: number): Promise<string | null> {
  if (!existsSync(abs)) return null;
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > maxBytes) return null;
    const buf = await readFile(abs);
    const mime = IMAGE_MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * 读壁纸字节并包成 data URL，供前端 <img>/CSS 直接用。
 * 不走第二条网络请求，也不把图塞进 appearance.json。
 */
export async function readWallpaperDataUrl(homeDir: string, rel: string | null): Promise<string | null> {
  const abs = resolveWallpaper(homeDir, rel);
  if (!abs) return null;
  const dataUrl = await readImageAsDataUrl(abs, MAX_WALLPAPER_BYTES);
  if (dataUrl === null) {
    log.warn("wallpaper read failed", { path: abs });
  }
  return dataUrl;
}

/** 读 logo 字节并包成 data URL，口径与壁纸一致（图不进 appearance.json）。 */
export async function readLogoDataUrl(homeDir: string, rel: string | null): Promise<string | null> {
  const abs = resolveWallpaper(homeDir, rel);
  if (!abs) return null;
  const dataUrl = await readImageAsDataUrl(abs, MAX_LOGO_BYTES);
  if (dataUrl === null) {
    log.warn("logo read failed", { path: abs });
  }
  return dataUrl;
}

/* --------------------------------------------------------------------------- 写 */

/** 原子写：先写临时文件再 rename，避免半截文件被 agent 或前端读到。 */
async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // tmp 名带随机后缀：只有 pid 的话，同进程并发写同一目标会共用 tmp 路径，
  // 两边先后 rename 各自内容时产生竞态（后写的 tmp 被先 rename 掉就 ENOENT）
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * 覆盖写 appearance.json。
 *
 * @param expectedHash 前端读到的 hash。给了就做乐观锁：盘上文件已被第三方（agent）改过就抛
 *   AppearanceConflictError，磁盘不发生任何变化。传 null 表示无条件覆盖（首次落盘 / 用户明确选了覆盖）。
 */
export async function writeAppearance(
  homeDir: string,
  content: string,
  opts: { expectedHash?: string | null } = {},
): Promise<WriteAppearanceResult> {
  if (typeof content !== "string" || content.length === 0) {
    throw Object.assign(new Error("content is required"), { code: "bad_params" });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_APPEARANCE_BYTES) {
    throw Object.assign(new Error(`appearance.json exceeds ${MAX_APPEARANCE_BYTES} bytes`), {
      code: "bad_params",
    });
  }
  // 写之前先验 JSON，别把前端的一个半截对象写到用户唯一的外观文件上
  try {
    JSON.parse(content);
  } catch {
    throw Object.assign(new Error("content is not valid JSON"), { code: "bad_params" });
  }

  if (opts.expectedHash) {
    const current = await readAppearance(homeDir);
    if (current.exists && current.hash !== opts.expectedHash) {
      throw new AppearanceConflictError(opts.expectedHash, current.hash);
    }
  }

  const file = appearancePath(homeDir);
  await atomicWrite(file, content);
  const s = await stat(file);
  const result: WriteAppearanceResult = {
    path: file,
    hash: hashOf(content),
    bytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: s.mtimeMs,
  };
  log.info("appearance.json written", { path: file, bytes: result.bytes });
  return result;
}

/**
 * 扩展名白名单 —— 不靠声明，靠后缀本身，避免有人往这个目录塞 .html
 * 然后被当图片下发给浏览器。
 *
 * 注意大小写：用户文件多半是 My Wallpaper.PNG，而白名单是小写比较，
 * 所以「用来剥掉后缀的那一段」必须用**原始大小写的** extname，
 * 否则 basename("x.PNG", ".png") 剥不掉，基名会连着 .PNG 一起留下，
 * 拼出来就成了 x.PNG.png 这种双后缀。
 */
function imageExtOf(name: string, allow: Set<string>): { raw: string; lower: string } | null {
  const raw = path.extname(name);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return allow.has(lower) ? { raw, lower } : null;
}

/**
 * 落一张壁纸到 <homeDir>/wallpapers/<name>，返回可直接写进 appearance.json 的相对路径。
 */
export async function saveWallpaper(
  homeDir: string,
  name: string,
  bytes: Buffer,
): Promise<SaveWallpaperResult> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw Object.assign(new Error("bytes is required"), { code: "bad_params" });
  }
  if (bytes.length > MAX_WALLPAPER_BYTES) {
    throw Object.assign(new Error(`wallpaper exceeds ${MAX_WALLPAPER_BYTES} bytes`), {
      code: "bad_params",
    });
  }

  const ext = imageExtOf(name, ALLOWED_IMAGE_EXT);
  if (!ext) {
    throw Object.assign(
      new Error(`wallpaper must be one of ${[...ALLOWED_IMAGE_EXT].join(", ")}`),
      { code: "bad_params" },
    );
  }

  // 只取基名，杜绝 ../ 穿越；非 [a-z0-9._-] 一律换成 _
  const stem = name.slice(0, name.length - ext.raw.length);
  const base = path.basename(stem).replace(/[^a-z0-9._-]/gi, "_").slice(0, 48) || "wallpaper";
  const fileName = `${base}${ext.lower}`;
  const dir = wallpaperDir(homeDir);
  await mkdir(dir, { recursive: true });
  const absPath = path.join(dir, fileName);
  await atomicWrite(absPath, bytes);
  log.info("wallpaper saved", { path: absPath, bytes: bytes.length });
  return { relPath: `${WALLPAPER_DIR}/${fileName}`, absPath, bytes: bytes.length };
}

/** 删一张壁纸（切回无壁纸时调用）。文件不在位就算了，不报错。 */
export async function deleteWallpaper(homeDir: string, rel: string | null): Promise<boolean> {
  const abs = resolveWallpaper(homeDir, rel);
  if (!abs || !existsSync(abs)) return false;
  const { rm } = await import("node:fs/promises");
  await rm(abs, { force: true });
  log.info("wallpaper deleted", { path: abs });
  return true;
}

/* --------------------------------------------------------------------------- logo */

export interface SaveLogoResult {
  /** 写进 appearance.json 的 logo.path（相对 homeDir） */
  readonly relPath: string;
  readonly absPath: string;
  readonly bytes: number;
}

/**
 * 落一张自定义 logo 到 <homeDir>/logos/<name>。口径与壁纸一致：
 * 文件名消毒、扩展名白名单（logo 额外放行 .svg）、原子写、返回相对路径。
 */
export async function saveLogo(homeDir: string, name: string, bytes: Buffer): Promise<SaveLogoResult> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw Object.assign(new Error("bytes is required"), { code: "bad_params" });
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    throw Object.assign(new Error(`logo exceeds ${MAX_LOGO_BYTES} bytes`), { code: "bad_params" });
  }

  const ext = imageExtOf(name, ALLOWED_LOGO_EXT);
  if (!ext) {
    throw Object.assign(
      new Error(`logo must be one of ${[...ALLOWED_LOGO_EXT].join(", ")}`),
      { code: "bad_params" },
    );
  }

  const stem = name.slice(0, name.length - ext.raw.length);
  const base = path.basename(stem).replace(/[^a-z0-9._-]/gi, "_").slice(0, 48) || "logo";
  const fileName = `${base}${ext.lower}`;
  const dir = logoDir(homeDir);
  await mkdir(dir, { recursive: true });
  const absPath = path.join(dir, fileName);
  await atomicWrite(absPath, bytes);
  log.info("logo saved", { path: absPath, bytes: bytes.length });
  return { relPath: `${LOGO_DIR}/${fileName}`, absPath, bytes: bytes.length };
}

/** 删一张自定义 logo（切回品牌标时调用）。文件不在位就算了，不报错。 */
export async function deleteLogo(homeDir: string, rel: string | null): Promise<boolean> {
  const abs = resolveWallpaper(homeDir, rel);
  if (!abs || !existsSync(abs)) return false;
  const { rm } = await import("node:fs/promises");
  await rm(abs, { force: true });
  log.info("logo deleted", { path: abs });
  return true;
}


/* --------------------------------------------------------------------------- 自定义预设主题 */

const THEMES_DIR = "themes";

export function themesDir(homeDir: string): string {
  return path.join(homeDir, THEMES_DIR);
}

export interface StoredThemePreset {
  id: string;
  name: string;
  desc?: string;
  mode?: string;
  light?: unknown;
  dark?: unknown;
  defaultChatStyle?: string;
  filePath?: string;
  builtin?: boolean;
}

/**
 * 内置预设的保留字 id —— 与 prototype/src/core/appearance.ts 的 APPEARANCE_PRESETS
 * （parchment / obsidian / twilight-mirror）保持同步。它们**允许**出现在 themes/ 里：
 * 选中即编辑模型下，内置主题被编辑就以 themes/<id>.json override 落盘，前端
 * allPresets() 按 id 把 override 定义吸收进内置卡片并标「已修改」。此清单供
 * 诊断与 smoke 对照用。
 */
export const BUILTIN_PRESET_IDS = new Set(["parchment", "obsidian", "twilight-mirror"]);

/**
 * light/dark 侧的最小形状：非空对象、带非空 palette 对象。
 * themes/*.json 由用户或 agent 手写，缺侧/空对象是常态而非异常 ——
 * 这个检查只拦「两侧都不合格」的空壳文件，单侧缺失的主题照常下发，
 * 由前端 applyPreset 的消毒闸门负责让缺的那一侧回落当前档案。
 */
function looksLikeProfileSide(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const palette = (value as { palette?: unknown }).palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return false;
  return Object.keys(palette).length > 0;
}

/**
 * 列出所有存放在 <homeDir>/themes/*.json 中的预设主题文件。
 * 每个文件都可由用户或 agent 直接用 read/write 工具读取或编辑。
 */
export async function listThemes(homeDir: string): Promise<StoredThemePreset[]> {
  const dir = themesDir(homeDir);
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const presets: StoredThemePreset[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const absPath = path.join(dir, entry.name);
      try {
        // 与 readAppearance 同款上限：一个坏循环塞进来的超大文件不许拖垮每次 4 秒的轮询读
        const s = await stat(absPath);
        if (!s.isFile() || s.size > MAX_APPEARANCE_BYTES) {
          log.warn("theme file skipped (not a regular file or too large)", {
            path: absPath,
            bytes: s.size,
          });
          continue;
        }
        const raw = await readFile(absPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<StoredThemePreset>;
        if (!looksLikeProfileSide(parsed.light) && !looksLikeProfileSide(parsed.dark)) {
          log.warn("theme file skipped (no usable light/dark profile)", { path: absPath });
          continue;
        }
        const id =
          typeof parsed.id === "string" && parsed.id.trim()
            ? parsed.id.trim()
            : path.basename(entry.name, ".json");
        presets.push({
          id,
          name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id,
          desc: typeof parsed.desc === "string" ? parsed.desc : "",
          mode: parsed.mode === "light" ? "light" : parsed.mode === "auto" ? "auto" : "dark",
          light: parsed.light ?? null,
          dark: parsed.dark ?? null,
          defaultChatStyle: parsed.defaultChatStyle === "classic" ? "classic" : "glass",
          filePath: absPath,
          builtin: false,
        });
      } catch (err) {
        log.warn("failed to read theme file", { path: absPath, error: String(err) });
      }
    }
    return presets;
  } catch (error) {
    log.warn("failed to list themes", { dir, error: String(error) });
    return [];
  }
}

/**
 * 保存一份自定义主题预设到 <homeDir>/themes/<id>.json。
 */
export async function saveTheme(
  homeDir: string,
  preset: {
    id?: string;
    name: string;
    desc?: string;
    mode?: string;
    light?: unknown;
    dark?: unknown;
    defaultChatStyle?: string;
  },
): Promise<{ id: string; path: string; preset: StoredThemePreset }> {
  if (!preset || typeof preset !== "object") {
    throw Object.assign(new Error("preset is required"), { code: "bad_params" });
  }
  const name = typeof preset.name === "string" ? preset.name.trim() : "";
  if (!name) {
    throw Object.assign(new Error("theme name is required"), { code: "bad_params" });
  }

  // 消毒 ID：如未指定则根据时间戳生成
  let id = typeof preset.id === "string" ? preset.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") : "";
  if (!id) {
    id = `theme-${Date.now().toString(36)}`;
  }
  // 内置 id（parchment 等）不再拒绝：那是内置主题的 override 文件，同 id 覆盖写，
  // 删除该文件即「恢复初始」。真正撞车的场景由前端 allPresets 的 id 合并兜底。

  const dir = themesDir(homeDir);
  await mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${id}.json`);

  const doc = {
    $meta: {
      schemaVersion: 1,
      generator: "agent-workbench",
      note: "预设主题配置文件。agent 可直接阅读并编辑此文件中的 palette / surface / transparency。",
    },
    id,
    name,
    desc: typeof preset.desc === "string" ? preset.desc.trim() : "",
    mode: preset.mode === "light" ? "light" : preset.mode === "auto" ? "auto" : "dark",
    light: preset.light ?? {},
    dark: preset.dark ?? {},
    defaultChatStyle: preset.defaultChatStyle === "classic" ? "classic" : "glass",
  };

  // 与 writeAppearance 同款上限：主题文件走的是同一条 4 秒轮询读取链路，坏循环同样能把它撑爆
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_APPEARANCE_BYTES) {
    throw Object.assign(new Error(`theme file exceeds ${MAX_APPEARANCE_BYTES} bytes`), {
      code: "bad_params",
    });
  }
  await atomicWrite(absPath, serialized);
  log.info("theme saved", { path: absPath, id });

  const resultPreset: StoredThemePreset = {
    ...doc,
    filePath: absPath,
    builtin: false,
  };
  return { id, path: absPath, preset: resultPreset };
}

/**
 * 删除一份自定义主题预设。
 */
export async function deleteTheme(homeDir: string, id: string): Promise<boolean> {
  if (typeof id !== "string" || !id.trim()) return false;
  const cleanId = path.basename(id.trim()).replace(/[^a-z0-9_-]/gi, "-");
  const absPath = path.join(themesDir(homeDir), `${cleanId}.json`);
  if (!existsSync(absPath)) return false;
  await rm(absPath, { force: true });
  log.info("theme deleted", { path: absPath, id: cleanId });
  return true;
}
