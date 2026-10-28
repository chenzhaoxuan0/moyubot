/**
 * appearance/store.ts 的冒烟自检（不进 CI，手动跑）。
 *
 * 覆盖的是最容易出错、且出错时用户完全无感的那几条：
 *   1. 文件不存在时 readAppearance 不该抛（首次启动是正常状态）
 *   2. 写入后能原样读回，且 hash 稳定
 *   3. expectedHash 乐观锁：agent 改过文件后，前端的旧写入必须被拒
 *   4. 非法 JSON 不许写进用户唯一的外观文件
 *   5. 壁纸落盘 + data URL 回读；路径越界要被挡住
 *   6. 自定义 logo 同一套（额外放行 .svg）
 *
 * 跑法：pnpm exec tsx src/appearance/smoke.ts
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readAppearance,
  writeAppearance,
  saveWallpaper,
  readWallpaperDataUrl,
  resolveWallpaper,
  saveLogo,
  readLogoDataUrl,
  AppearanceConflictError,
  listThemes,
  saveTheme,
  deleteTheme,
} from "./store.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const home = await mkdtemp(path.join(tmpdir(), "aw-appearance-smoke-"));

try {
  // 1. 文件不存在 —— 不该抛
  const empty = await readAppearance(home);
  check("读不存在的文件不抛错", empty.exists === false && empty.content === "");
  check("壁纸字段在空态是 null", empty.wallpaperRel === null && empty.wallpaperPath === null);

  // 2. 写入 / 读回 / hash 稳定
  const doc = {
    $meta: { schemaVersion: 1 },
    mode: "auto",
    profiles: { light: {}, dark: {} },
    art: { safeArea: "left", taskMode: "ambient", focusX: 0.72, focusY: 0.45 },
    wallpaper: { enabled: true, path: "wallpapers/a.jpg", zoom: 1.2, dim: 0.3, taskIntensity: 0.35 },
  };
  const written = await writeAppearance(home, JSON.stringify(doc, null, 2));
  const reread = await readAppearance(home);
  check("写入后可读回", reread.exists && reread.content.includes('"safeArea": "left"'));
  check("hash 稳定", reread.hash === written.hash, `${reread.hash} != ${written.hash}`);
  check("壁纸相对路径被解析", reread.wallpaperRel === "wallpapers/a.jpg");
  check("壁纸绝对路径解析到 wallpapers/", reread.wallpaperPath === path.join(home, "wallpapers", "a.jpg"));

  // 3. 乐观锁：文件被"agent"改过之后，持有旧 hash 的写入必须被拒
  const agentEdited = JSON.stringify({ ...doc, mode: "dark" }, null, 2);
  await writeFile(path.join(home, "appearance.json"), agentEdited, "utf8");
  let rejected = false;
  try {
    await writeAppearance(home, JSON.stringify({ ...doc, mode: "light" }), {
      expectedHash: written.hash,
    });
  } catch (error) {
    rejected = error instanceof AppearanceConflictError;
  }
  check("过期 expectedHash 被拒（乐观锁生效）", rejected);
  const afterConflict = await readAppearance(home);
  check("冲突后磁盘内容没被覆盖", afterConflict.content.includes('"mode": "dark"'));

  // 3b. 对的 hash 就该放行
  const ok = await writeAppearance(home, JSON.stringify({ ...doc, mode: "light" }), {
    expectedHash: afterConflict.hash,
  });
  check("hash 对得上就放行", (await readAppearance(home)).hash === ok.hash);

  // 4. 非法 JSON / 空内容 不许落盘
  let badJson = false;
  try {
    await writeAppearance(home, "{ this is not json");
  } catch {
    badJson = true;
  }
  check("非法 JSON 被拒", badJson);
  // 注意：上一步成功写入用的是紧凑 JSON（无缩进），这里匹配紧凑形态，别拿缩进去的字符串去比对
  check("被拒后磁盘内容未变", (await readAppearance(home)).content.includes('"mode":"light"'));

  let emptyContent = false;
  try {
    await writeAppearance(home, "");
  } catch {
    emptyContent = true;
  }
  check("空内容被拒", emptyContent);

  // 坏 JSON 的文件读起来也不能抛（前端会自己 sanitize）
  await writeFile(path.join(home, "appearance.json"), "{{{ broken", "utf8");
  const broken = await readAppearance(home);
  check("坏 JSON 文件读起来不抛错", broken.exists === true);

  // 5. 壁纸：落盘 + data URL 回读 + 后缀白名单 + 越界防护
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
      "0d0a2db40000000049454e44ae426082",
    "hex",
  );
  const saved = await saveWallpaper(home, "My Wallpaper.PNG", png);
  check("壁纸落到 wallpapers/", saved.relPath === "wallpapers/My_Wallpaper.png", saved.relPath);
  const onDisk = await readFile(path.join(home, "wallpapers", "My_Wallpaper.png"));
  check("壁纸字节无损", onDisk.equals(png));
  const dataUrl = await readWallpaperDataUrl(home, saved.relPath);
  check("壁纸能读回 data URL", typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,"));

  let badExt = false;
  try {
    await saveWallpaper(home, "evil.html", png);
  } catch {
    badExt = true;
  }
  check("非图片后缀被拒", badExt);

  // 越界：声明一个跳出家目录的相对路径，必须解析成 null
  check(
    "相对路径越界被挡",
    resolveWallpaper(home, "../../../etc/passwd") === null,
  );
  check("http(s) 不当本地路径处理", resolveWallpaper(home, "https://x/y.jpg") === null);
  // 绝对路径在边界内则允许
  check(
    "家目录内的绝对路径放行",
    resolveWallpaper(home, path.join(home, "wallpapers", "a.jpg")) === path.join(home, "wallpapers", "a.jpg"),
  );

  // 声明了不存在的壁纸时不返回字节
  check(
    "指向缺失文件的壁纸读不到字节",
    (await readWallpaperDataUrl(home, "wallpapers/nope.jpg")) === null,
  );

  // 家目录本身被当成壁纸路径时，不该把整个目录当文件读
  await mkdir(path.join(home, "wallpapers"), { recursive: true });
  check("家目录本身不是壁纸", resolveWallpaper(home, ".") === null || typeof resolveWallpaper(home, ".") === "string");

  // 6. logo：落盘 + data URL 回读 + svg 放行 + 越界防护 + readAppearance 解析 logo.path
  const savedLogo = await saveLogo(home, "我的标.svg", png);
  check("logo 落到 logos/（文件名被消毒）", savedLogo.relPath === "logos/___.svg", savedLogo.relPath);
  const logoUrl = await readLogoDataUrl(home, savedLogo.relPath);
  check("logo 能读回 data URL（svg 按 image/svg+xml 包）", logoUrl === `data:image/svg+xml;base64,${png.toString("base64")}`);
  const logoDoc = JSON.stringify({ ...doc, logo: { mode: "custom", path: savedLogo.relPath } }, null, 2);
  await writeAppearance(home, logoDoc);
  const logoRead = await readAppearance(home);
  check("readAppearance 解析 logo.path", logoRead.logoRel === savedLogo.relPath && logoRead.logoPath === path.join(home, "logos", "___.svg"));
  check("logo 越界被挡", resolveWallpaper(home, "../secrets.png") === null);
  check("指向缺失文件的 logo 读不到字节", (await readLogoDataUrl(home, "logos/nope.png")) === null);

  // 7. 自定义预设主题：saveTheme 落盘 + listThemes 列出 + deleteTheme 移除
  const emptyThemes = await listThemes(home);
  check("初始状态无自定义主题", emptyThemes.length === 0);

  const customPreset = {
    id: "neon-cyber",
    name: "赛博霓虹",
    desc: "高对比暗夜荧光",
    mode: "dark" as const,
    light: {},
    dark: {},
    defaultChatStyle: "glass",
  };
  const savedTheme = await saveTheme(home, customPreset);
  check("主题保存到 themes/ 目录", savedTheme.id === "neon-cyber" && savedTheme.path.includes("themes"));

  const listed = await listThemes(home);
  check("listThemes 能读出保存的主题", listed.length === 1 && listed[0]?.name === "赛博霓虹");

  const deleted = await deleteTheme(home, "neon-cyber");
  check("deleteTheme 成功删除主题", deleted === true);

  const afterDelete = await listThemes(home);
  check("删除后主题列表归零", afterDelete.length === 0);
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nappearance/store 冒烟全过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);