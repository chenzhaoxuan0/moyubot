# 外观设置 = 一个文件

> 对齐 DS 的 `theme.json`，但落盘形态是本项目自己的：`<homeDir>/appearance.json`，
> 默认 `~/.agent-workbench/appearance.json`（`AGENT_WORKBENCH_HOME` 可改）。
> 类型定义与取值域的源头是 `prototype/src/core/appearance.ts`。

## 为什么是文件

用户要的是「让 agent 调外观」。localStorage 里的东西 agent 碰不到，文件可以。
daemon 侧刻意**不做内存缓存**（对齐 `bots/registry.ts` 的「文件即数据库」）：
每次 `appearance.read` 都真读盘，所以

> agent 改完文件 → 应用 4 秒内自己跟进；切回窗口也立刻查一次

不需要任何失效机制，也不会出现两份真相打架。

## 文件长什么样

```jsonc
{
  "$meta": { "schemaVersion": 1, "generator": "agent-workbench", "note": "…" },
  "mode": "auto",            // auto | light | dark（auto = 跟随系统）
  "presetId": "parchment",   // 选中的预设；用户微调后变成 "__custom__"
  "profiles": {
    "light": {
      "palette": {           // 十组色，键名与 DS theme.json.colors 一字不差
        "background": "#f7f7f4", "panel": "#f2f1ed", "panelAlt": "#e6e5e0",
        "accent": "#f54e00", "accentAlt": "#e04500", "secondary": "#0d9488",
        "highlight": "#a855f7", "text": "#26251e", "muted": "#84847e", "line": "#cdcdc9"
      },
      "surface": {
        "radius": 12,        // 0..28px，按原比例联动 btn/input/card/chip 四档圆角
        "opacity": 1,        // 0.65..1
        "blur": 0,           // 0..30px
        "borderAlpha": 0.14, // 0..1
        "shadow": "soft",    // none | soft | strong
        "fontFamily": "system", // system | grotesk | serif | mono
        "fontScale": 1,      // 0.85..1.3
        "density": "standard",   // compact | standard | comfortable
        "motion": "standard"     // off | reduced | standard
      },
      "transparency": null   // 0..100；null = 跟随主题默认 30
    },
    "dark": { "palette": { … }, "surface": { … }, "transparency": null }
  },
  "art": {
    "focusX": null,          // 0..1；null = 按 safeArea 自动推断（left→0.72 right→0.28 其余→0.5）
    "focusY": null,
    "safeArea": "auto",      // auto | left | right | center | none
    "taskMode": "auto"       // auto | ambient | banner | full | off
  },
  "wallpaper": {
    "enabled": false,
    "path": null,            // 相对 homeDir 或绝对路径；图放在 <homeDir>/wallpapers/
    "zoom": 1,               // 1..2
    "dim": 0,                // 0..0.8
    "taskIntensity": 0.35    // 0..1
  }
}
```

`$` 开头的是元信息区（对齐 `bot.json` / `listBots` 的 `$meta` 约定），其余全是设置项本身。
`schemaVersion` 顶层和 `$meta` 里**放哪边都认** —— 手写文件时两种都有人用。

## 几条容易踩的语义

- **透明度方向反着**：`transparency` 是「底色有多透」，0 = 不透明，100 = 全透。
  内部换算是 `(100 - value) / 100`（与 DS `renderer-inject.js:364` 同款）。
- **透明度只在真的有壁纸时生效**。没壁纸时面板半透明会让整块 UI 变成能看见背后的层，
  那是 bug 不是特性，所以代码里按 `hasWallpaper` 短路。
- **透明度只改背景，不改文字与图标**。DS 有测试钉死这条
  （`tools/renderer-runtime.test.mjs:1123`），本项目照抄。
- **壁纸不进 JSON**。只存一个路径，图在 `<homeDir>/wallpapers/`。
  塞 data URL 会把文件撑到没法编辑，也没法进 git。
- **`art.*` 与 `image-*` 只在有壁纸时看得出效果**，没图时改它们界面不会有变化。

## 并发

写入带 sha256 前 16 位的乐观锁：前端写之前把自己读到的 `hash` 带上，
盘上文件被别人（多半是 agent）改过就返回 `conflict`，磁盘不发生任何变化。
写文件一律 tmp + rename 原子替换，不会留下半截 JSON。

## 降级

daemon 没起时依次退到 `localStorage`，再退到内置默认 —— 界面照常可用，
只是重启会丢。设置页「外观文件」卡片会显示当前处在哪一层。

`localStorage` 除了当降级层，还兼**首屏快路径缓存**：文件是唯一真相，但
要等 React 挂载 + daemon RPC 往返（dev 冷启动数秒）才读得到，首帧没人喂
的话会先按「跟随系统」上错色再被纠正（系统深色 + 应用钉浅色 = 每次启动
先黑一截）。所以：

- 每次采纳文件态（hydrate / 4 秒轮询发现外部改动）都会把 state 同步刷进
  `localStorage`（壁纸 / logo 的运行时 data URL 落缓存前剥掉，防占满配额）；
- 桌面端启动时主进程直接同步读 `appearance.json` 的 `mode`（不等 daemon）：
  决定窗口底色与初始图标，并经 `--aw-appearance=` 交给 preload，preload 在
  页面任何脚本执行前把 `mode` 合进这份缓存 —— `index.html` 首屏脚本与
  `useAppearance` 的模块初始态读到的就是「上次主题」；
- 纯浏览器访问没有这条接力，靠上一条刷出来的缓存（同样有效，只是 agent
  直接改文件后的下一次启动首帧可能短暂用旧档，几秒内被 hydrate 纠正）。

## 相关文件

| 位置 | 作用 |
|---|---|
| `backend/src/appearance/store.ts` | 落盘、原子写、乐观锁、壁纸目录 |
| `backend/src/appearance/smoke.ts` | 22 项冒烟自检（`pnpm exec tsx src/appearance/smoke.ts`） |
| `electron/main.cjs` / `electron/preload.cjs` | 启动代读 `appearance.json` 的 mode：窗口底色 / 图标 / 首屏缓存接力 |
| `prototype/index.html` | 首屏内联脚本：读缓存定主题、favicon 与 theme-color |
| `prototype/src/core/appearance.ts` | 类型、取值域、默认值、色彩推导 |
| `prototype/src/core/appearanceStore.ts` | 前端 RPC 封装与三层降级 |
| `prototype/src/store/useAppearance.ts` | 状态、落盘、4 秒轮询外部改动 |