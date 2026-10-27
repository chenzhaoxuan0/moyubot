# 27 · 执行器新版本检测与升级通知

> 2026-10-28 引入。设置页本来就有「升级」按钮（把各家官方升级命令派发到
> 内置终端可见执行，`ProviderInstancesPanel.tsx` 的 PROVIDER_INSTALL_GUIDES
> 是命令事实源），缺的是**新版本感知**——用户不知道有新版，按钮再顺手
> 也没人点。本文补的只是这一半：检测 + 通知 + 徽标。参考 T3 Code 的
> maintenanceResolver 思路（npm registry 查 latest + advisory + 通知），
> 按本项目哲学裁剪为轻量增强版（用户确认）：**升级动作仍走终端派发**，
> 不做 T3 式后台静默升级（进度推送 + 结果复核）。

## 一、分工：daemon 只拥有网络面

| 职责 | 归属 | 理由 |
|---|---|---|
| 当前版本（`<cli> --version`） | **前端**传入 | 探测状态活在前端 runtimeRegistry（启动一次性探测）；daemon 刻意不做启动探测（index.ts 的既有决策），无 spawn |
| 最新版本（npm/PyPI latest） | **daemon** | 网络 IO + 缓存归一处；内存 + 磁盘缓存 `<homeDir>/updates-cache.json`，TTL 1h，force 直查 |
| 比对与结论 | daemon | 启发式 semver（取第一段 `\d+.\d+.\d+` 数值比；解析不出诚实报 `unknown`，不猜） |
| 升级执行 | 前端（不变） | 终端可见执行；`useExecutorUpdates.refresh()` 在 2 分钟补探测后重算结论，behind→current 徽标即灭 |

RPC `adapter.updates`（params `{force?, current}`）：current 是「裸执行器 id →
版本串」清单（只放 ready 的）。检测源白名单在
`backend/src/runtime/updates.ts` 的 EXECUTOR_UPDATE_SOURCES——npm 系
（claude/codex/cursor/openclaw/opencode/pi/mcode/kimi/dsh/grok）+ PyPI
（hermes）；zcode/agy/antigravity 不检测（无可靠 latest 源，不产生噪音）。
5s 超时、单飞去重、失败静默（检测是增强不是功能路径）。

## 二、通知面（三处，全前端）

1. **侧栏设置入口红点**（IconNavBtn `dot`）：`hasUnseenUpdates(report,
   dismissed)`——落后集合指纹（`runtimeId@latest` 排序拼接）与 localStorage
   `awb-executor-updates-dismissed` 比对。消隐 = 用户进到「执行器与模型」
   分区看到 banner；**新版本出现（指纹变化）红点自动再亮**（T3 的
   per-version dismissal 同思路）。
2. **设置页「执行器与模型」顶部琥珀 banner**：`N 个执行器有新版本：
   claude → v2.1.0、…` + 「重新检查」（force 直查）。
3. **执行器卡片徽标**：版本 chip 旁「有新版本 vX.Y.Z」琥珀 chip（悬停含
   检测源与当前→最新）；「升级」按钮琥珀高亮 + 文案变「升级（有新版）」；
   升级条显示 `当前 vX → 最新 vY`。

启动检测：`useExecutorUpdates` 模块加载后延迟 12s 拉一次（等启动探测收敛；
daemon 侧 latest 有 1h 缓存，每会话一次网络面可忽略）。

## 三、明确不做（轻量增强的边界）

- 不做后台静默升级/进度推送/结果复核（T3 全套）：终端派发可见性更好，
  且升级命令表已存在、直接复用。
- 不做 5 分钟周期轮询（T3 默认）：本地工作台非多机服务端，打开设置页/
  启动时各一次 + 手动 force 足够。
- 不做安装归属判定（T3 按二进制路径推断包管理器）：升级命令表按平台
  （upgradeWindows/upgradePosix）已覆盖，误配的代价只是命令不适用，用户
  在终端里看得见失败。
