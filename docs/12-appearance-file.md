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
  "presetId": "parchment",   // 选中的主题（内置或自定义）。选中即编辑：改动自动保存回该主题
  "ink": {                   // 全局文字色（亮/暗各一），独立于主题——切任何主题都不变
    "light": "#26251e", "dark": "#faf9f6"
  },
  "profiles": {
    "light": {
      "palette": {           // 十一键，键名与 DS theme.json.colors 对齐（glass 为本项目扩展）
        "background": "#f7f7f4", "panel": "#f2f1ed", "panelAlt": "#e6e5e0",
        "accent": "#f54e00", "accentAlt": "#e04500", "secondary": "#0d9488",
        "highlight": "#a855f7", "text": "#26251e", "muted": "#84847e", "line": "#cdcdc9",
        "glass": "#cdcdc9"   // 液态玻璃卡片底色（独立配色，此前派生自 line）
                              // text 是主题缺省文字色：仅旧数据迁移来源，实际生效看 ink
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

## 主题（themes/）与「选中即编辑」

外观预设主题以独立文件存放在 `<homeDir>/themes/<id>.json`，形状与
`createPresetFromState` 的产物一致（`{$meta, id, name, desc, mode, light, dark,
defaultChatStyle}`，light/dark 各含完整 palette + surface + 三项透明度）。

- **选中即编辑**：`appearance.json` 的 `presetId` 指向当前主题。在外观设置里
  每改一项，除 `appearance.json` 照常落盘外，还会防抖（500ms）把完整档案写回
  该主题文件——不需要手动「保存预设」。与主题当前定义完全一致的写会被跳过
  （免得只是选中就凭空造文件）。
- **内置主题可编辑**：改内置主题（parchment / obsidian / twilight-mirror）以
  同 id 的 `themes/<内置id>.json` override 落盘，卡片标「已修改」；「恢复初始」
  = 删除该 override 文件（`appearance.theme.delete`）并应用出厂常量。
- **新建 / 改名 / 删除**：新建主题从出厂默认定义起步；自定义主题可改名
  （同 id 覆盖写 `name` 字段）与删除；删除当前选中的会切回默认主题。
- **主题文件无乐观锁**：同 id 保存是 last-writer-wins 覆盖（与 appearance.json
  的 hash 锁不同）。agent 手改 `themes/*.json` 后请顺手 touch 一下
  `appearance.json`（或等下一次 appearance.json 变化），否则运行中的界面最长
  4 秒轮询只在 appearance.json hash 变化时才刷新主题列表。

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
| `backend/src/appearance/store.ts` | 落盘、原子写、乐观锁、壁纸目录、themes/ 主题文件读写 |
| `backend/src/appearance/smoke.ts` | 25 项冒烟自检（`pnpm exec tsx src/appearance/smoke.ts`，含内置 id override 用例） |
| `electron/main.cjs` / `electron/preload.cjs` | 启动代读 `appearance.json` 的 mode：窗口底色 / 图标 / 首屏缓存接力 |
| `prototype/index.html` | 首屏内联脚本：读缓存定主题、favicon 与 theme-color |
| `prototype/src/core/appearance.ts` | 类型、取值域、默认值、色彩推导 |
| `prototype/src/core/appearanceStore.ts` | 前端 RPC 封装与三层降级 |
| `prototype/src/store/useAppearance.ts` | 状态、落盘、4 秒轮询外部改动 |