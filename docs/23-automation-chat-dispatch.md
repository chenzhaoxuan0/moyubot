# 23 · 自动化/待办的「对话页」派发形态

> 2026-10-24 引入。定时任务与待办此前只有两种执行方式——终端 TUI（PTY 拉执行器
> 本尊）与纯后台（headless host 会话）。本文记录第三种「对话页」的口径：到点把
> 会话开在主聊天页前台，GUI 原生形态，可看可插话。附带给「发到已有对话」的
> 目标选择器补来源标识。

## 一、需求

- TUI 模式之外，用户要一种**不进终端、但前台可看可插手**的执行方式——headless
  会话本来就能在聊天页打开（历史列表 →「在聊天页继续」），缺的只是**到点自动
  打开**这一步。
- 「发到哪里」选了已有对话时，此前表单直接隐藏「执行方式」——用户分不清到点
  那条消息会以什么形态出现；且目标会话下拉里自动化的、飞书的、工作台手开的
  对话长得一样，难以辨认。
- 终端 TUI 与 host 会话是两套体系（终端无会话台账、不可续接）：**终端不是定时
  收件对象**，这个边界要在 UI 上说清楚，而不是让用户猜。

## 二、核心决策：chat = headless 派发 + 前台拉起广播

`launchMode` 从两态扩为三态（`prototype/src/core/automation.ts` 的 `LaunchMode`，
自动化与待办共用）：

| 值 | 语义 | 派发路径 |
|---|---|---|
| `terminal` | 前端 PTY 拉执行器 TUI（免审批，括号粘贴注入 prompt） | `launchExecutorTerminal`，终态走终端 exit 帧 |
| `chat`（新建默认） | 会话开在主聊天页前台，可看可插话（steer 队列天然支持） | **与 headless 完全同一条 host 派发路径**，成功后多广播一个 `session.foreground` |
| `headless` | 纯后台会话，不拉前台 | `host.startSession({source:"automation"})`，权限闸全放行 |

不新建会话体系：chat 会话就是普通的 host 会话（source=automation，时间线首行
带「来自自动化」徽标），daemon 重启可续挂（`heal()` 按 headless 同路处理）。
**chat 与 headless 的全部差异就是那一个广播**。

已有对话（`dispatchTarget=existing_session`）侧：执行方式子集只剩
chat（到点打开该对话并续发）/ headless（只发不打开）二选一——终端不是收件对象；
表单切到该目标时 terminal 值自动归一成 chat。

### `session.foreground` 事件口径

- 形状：`{type:"session.foreground", sessionId, unitId, runtimeId, cause:"automation"|"backlog", title?}`，
  定义在 RuntimeEvent union（`prototype/src/core/events.ts`），与 `git.changed` 同款
  **broadcast-only**：独立计数器填 seq、不落账本、不参与 `(sessionId, seq)` 判重补拉。
- **适配器会话泵必须显式跳过它**（`adapter.ts`，同 `git.changed` 的位置）：它带的
  sessionId 配的是全局广播序号而非会话账本 seq，进判重会写脏 `#lastSeq`——假游标
  会挡掉后续真账本帧，时间线丢事件。
- 消费方是 `installSessionForeground`（`prototype/src/store/sessionForeground.ts`，
  App 挂载时装一次）：`setConversationView("chat")` + `openSession({sessionId, unitId,
  runtimeId})`——openSession 自带跨 bot 切换与谱系回放；当前对话正「等回答/待输入」
  时它自己会拒绝并弹 warn 通知（前台拉起不抢裁决权，会话照跑，事后从历史/任务栏
  点开），这正是想要的退化形态。
- 漏发不致命：会话仍在历史列表/底栏任务条/监控面板里可点开，功能不缺失。

### 目标选择器的来源标识

`session.resumable` 行新增 `source` 字段；表单下拉每条前缀 `[自动化]`/`[飞书]`/
`[工作台]`（复用 `SESSION_SOURCE_LABEL`）并标注运行状态，hint 说明「列表均为对话页
会话；终端 TUI 不是定时收件对象」。

## 三、落点清单

| 层 | 文件 | 改动 |
|---|---|---|
| 共享类型 | `prototype/src/core/automation.ts` | `LaunchMode` 三态导出；`Automation.launchMode` 放宽 |
| 共享类型 | `prototype/src/core/events.ts` | `session.foreground` 变体（broadcast-only 注释） |
| daemon | `backend/src/index.ts` | create/update 枚举校验收 `chat`；`broadcastForeground` 助手；`runAutomation` 两个分支（existing_session 投递成功后 / host 派发成功后）chat 时广播；backlog 引擎注入 `foreground` 依赖；`session.resumable` 透出 `source`；unit.history 行按定义行 launchMode 展示 |
| daemon | `backend/src/backlog/heartbeat.ts` | `dispatch` 的 host 路径 chat 时调 `deps.foreground`（未注入退化为纯后台） |
| daemon | `backend/src/store/db.ts` | automations/backlog 行映射识别 `chat`（列本就可空 TEXT，无迁移） |
| 前端 | `prototype/src/ui/AutomationDialog.tsx` | 执行方式三选（chat 默认）；existing_session 显示 chat/headless 子集 + 切换归一；目标下拉来源前缀 + 状态 |
| 前端 | `prototype/src/ui/BacklogDialog.tsx` | 执行方式三选（chat 默认） |
| 前端 | `prototype/src/store/sessionForeground.ts` | 新文件：安装器订阅 `session.foreground` → openSession + 切 chat 视图 |
| 前端 | `prototype/src/adapters/daemon/adapter.ts` | 会话泵跳过 `session.foreground`（防 seq 污染） |
| 前端 | `prototype/src/app.tsx` | 挂载 `installSessionForeground` |
| 前端 | AutomationsPage / BacklogPage / HistoryPane | 「对话页」chip/徽标/标签 |

存量兼容：旧 `launch_mode` 行仍是 `terminal`/`headless`，读取缺省按 terminal，
行为不变；新建表单默认 chat 只影响初值。

## 四、没做的与原因

- **往真终端 TUI 里定时投消息**（`targetTerminalId` 之类）：`writeWhenQuiet` 只能判
  「输出静默」，判不了 TUI 处在输入就绪态（可能在跑任务/权限菜单/别的 pane），
  盲写会喂错地方。chat 形态已覆盖「前台可插手」的需求，此路不开。
- **ScheduleSendMenu 改 chat**：定时发送到本对话保持 headless——正开着的对话时间线
  事件本就实时进流，到点强拉前台反而打扰；要前台打开可后续把默认值换成 chat。
- **多条消息错峰定时**：无需新能力——每条就是一行一次性 automation
  （`runAt` + `dispatchTarget=existing_session` + 钉同一个 `targetSessionId`），
  会话正忙时落 steer 队列按序补发。

## 五、可追溯性升级 + ZCode 口径对齐（第二轮）

> 背景：用户要的是「可追溯 —— 知道将要发生什么、发生过什么」，不是派发机制
> 本身。参照源码实证于 ZCode（`zocdeusually/ZCode`）的 cron automations 与
> off-peak（闲时）两套体系，六个借鉴项 + 三件可追溯基座。

### 可追溯基座

1. **侧栏待触发行**（`Sidebar.tsx` `ScheduledTaskRow`）：bot 子列表最顶部混排
   「待触发」行（时钟图标 + 下次时间，≤30 天相对 / 更远绝对——ZCode 的 30 天
   阈值），与下方历史行（「发生过什么」）互补；点击直接打开编辑弹窗。
   数据复用 `automation.list` 客户端过滤，30s 与历史同节奏轮询。
2. **自动化会话行的常显时钟**（对齐 ZCode `data-cron-task-icon`）：`HistoryListRow`
   里 `kind==="automation" || source==="automation"` 的行标题前常显小时钟，
   不必 hover 才认得出。完成未读绿灯沿用既有 markViewed 机制（等价 ZCode
   `setTaskUnread`，零改动）。
3. **定时消息气泡徽标**：`message.delta` 加可选 `origin` 字段（daemon 的
   `sendMessage` 第 5 参透传，steer 队列快照不带）；existing_session 派发传
   `"automation"`，`UserMessageBubble` 据此在气泡上方亮「定时」小 pill。
   字段随事件进账本——回放与实时同样可见。
4. **全局自动化弹窗**：`useShell.automationDialog` 一份状态，挂载点在
   WorkspaceShell（不依赖 mainView）；AutomationsPage 本地 DialogState 退役，
   侧栏与自动化页共用。

### ZCode 对齐（定时任务）

5. **创建上限 20 条**（`automation.create`，对齐 `AUTOMATION_CREATE_LIMIT`，
   error code `automation_limit_reached`）：agent 能经 `aw` CLI 自建定时任务，
   无上限就是递归滥建的下限。
6. **失败态卡片口径**（对齐 `hasAutomationFailureState`）：失败横幅优先，下次
   运行时间弱化（停用任务的 nextRunAt 本就为 null，无过期显示问题）；新增
   「已跑 N 次」徽章（`runCount`，含手动，与 maxRuns 分母分离——ZCode
   「Ran N times」口径）。
7. **prompt 自包含约束**（对齐 CronCreate 的 modelInstructions 口径）：表单 hint
   与 `automation.create`/`backlog.create` 方法描述注明「自包含、直接描述最终
   工作、无人值守不问问题、不得要求再建定时任务」。

### ZCode 对齐（待办 ← 闲时任务）

8. **闲时边沿立即提议**：心跳原按 `intervalMinutes` 周期跳；现在 phase 从非
   idle → idle 的跳变沿武装一次「立即跳」（`maybeBeat` 放行周期门，beat 内的
   idle 判定/确认门/单飞/硬过滤全部照旧）。效果：任务跑完或用户离开达到阈值
   的那一刻就提议。**确认门铁规则（ADR-0001）不动**——闲时只调提议时机，
   这是与 ZCode 无人值守直跑的本质区别（用户拍板）。
9. **时间盒续跑**（对齐 `OFF_PEAK_RESUME_PROMPT` 语义）：待办重新执行时，若
   最近一次 run 失败、sessionId 是真会话（非 `autoterm_` 前缀）、执行器没换、
   且接得回来（live 或 cli_ref）→ 不新开会话，`resumeSession` + 发固定续跑
   提示词（「继续之前的任务，从中断处接着做，不要从头开始…」）。TUI 中断、
   首跑、换执行器、接不回都照旧新开。
10. **未搬的**：ZCode 闲时的服务端取号/队列位次/票生命周期（本地单机无对应
    物）；`keepAwakeWhileRunning` 的 powerSaveBlocker（Electron 壳可后续加）。

### 已知缺口：防递归

ZCode 靠 sendPrompt 的工具 denylist（`AUTOMATION_MUTATION_TOOL_NAMES`）拦
「自动化轮里再建自动化」，三层纵深。本项目的 RPC 通道没有调用方身份——
daemon 无法判定一条 `automation.create` 是否来自某个正在跑的 automation 会话。
缓解：创建上限 20 兜底 + permission deny 规则可配；根治要等 RPC 调用方标识
（后续 ADR）。
