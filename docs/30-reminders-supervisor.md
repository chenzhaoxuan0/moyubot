# 30 —— 提醒闭环与主管日报：注意力自动化

> 2026-10-30。五阶段合批：推进面板 / 提醒闭环 / 紧急检测 / 主管日报 / 来源分级。

## 总纲：四原语与双轴

五轮讨论的收口。这套体系的四个原语：

```
清单   —— 捕获与预算分配（空间浮现，pull：想看时一切在一处）
autopilot —— 余量轴执行（Q2 排水机，软承诺：空闲+余量才动）
钟控总线 —— 时间轴动作总线（硬承诺：到点必发；三种载荷）
主管   —— 周期汇报（Q2 战报，批量浮现：失联后一次性对账）
```

**双轴承诺语义**（一切设计分野的根）：

| | 钟控轴（automations） | 余量轴（autopilot） |
|---|---|---|
| 何时跑 | 钟说了算，到点必发 | 资源说了算，空闲+余量≥地板 |
| 撞用量墙 | 照发（quotaResume 恢复后续跑） | 不发，原地等下一拍 |
| 语义 | 硬承诺（"周五 17:00 一定"） | 软承诺（"有空就做"） |
| UI 语态 | 确切时间（nextRunAt） | 前置条件（当前判定，不给假 ETA） |

**错过语义的分野**（scheduler.ts misfire 分支）：任务错过超 5 分钟宽限 =
跳过不补跑（迟到的执行无意义还烧余量）；**提醒错过 = 绕过宽限立即补发**
（载荷是注意力不是副作用，3 点的提醒 3:20 送到仍救得了「忘了这件事」）。

**Q2 定位**：清单是 Q2 孵化器（重要、无死线的事才值得托付给闲时机制）。
机制本身证明象限——autopilot 在空闲时执行的任务构造性不紧急，sortPos 声明
重要性，**Q2 = ready + auto + 排序靠前**，无需任何象限标签。系统唯一要拦截
的是伪装成 Q2 的 Q1（紧急检测）。

## 1. 推进面板（WorklistPage 右栏）

过滤 chips 改**状态分组**：执行中 / 待验收 / 待确认 / 排队 / 休眠 / 草稿 /
今日完成（默认收起）/ 更早完成（默认收起），空组隐藏——分组沿用左栏分块的
视觉语言。排队组：

- 队列头亮「下一条」徽章（autopilot 的挑法：sortPos 序第一条 ready+auto、
  失败退避跳过）
- 前置条件行「当前判定」：总开关关 / 全退避 / 强制忙碌 / 心跳让路 /
  提议挂起 / 忙因 / 余量低于地板+最近重置时刻。**余量轴不给假 ETA**——
  条件可验证，预测是撒谎

卡片升级：跑过 N 次（`runCount`，store 一行 COUNT）+ 运行历史懒加载
展开（`backlog.runs` RPC 直出 `backlog_runs`：trigger 来源闲时/手动/心跳、
起止时长、失败 detail、监控入口）。栏头行1 并入今日完成计数，行2 状态行
并入**定时带**（enabled automations 最小 nextRunAt，`formatAbsoluteHuman`
确切时刻——与余量轴的「当前判定」双轴对照）。

跳转全局化：`useTaskJump` 信箱（`backlog-card-{id}` / `inbox-entry-{id}`
锚点 + 高亮环）——左栏任务链接、通知深链共用一个入口。

## 2. 提醒闭环（钟控轴第三种载荷 notify）

```
DispatchTarget：new_session（开新会话）| existing_session（续发老对话）
             | notify（新增：不拉会话不烧额度，收件人是人）
```

- **创建**：`reminder.create {text, runAt|delayMinutes, link?}` —— 内部造
  automations 行（quotaResume 同款先例：合成单元 `reminder`、origin=reminder、
  一次性、launchMode 无关紧要），不暴露 automation.create 全参数面。link
  深链目标必须真实存在（悬空即拒——通知点开落空是最差的提醒体验）。
  origin=reminder **不占 20 条创建额度**（额度只数 origin=manual）。
- **捕获入口**：清单可选项「提醒时间」（`inbox.add` 的 reminderAt，即时挂、
  链回条目、不依赖分类完成）+ 条目菜单「挂提醒」（15 分钟/1 小时/明天 9 点/
  自定义）。提醒不是 routing hint——分类器不管它。
- **派发**（runAutomation notify 分支）：`startAutomationRun` → 三通道扇出
  → 立即 `finishAutomationRun done`——运行记录照写，主管日报看得见。
- **三通道扇出**（index 的 `notifyUser`，docs/30 打断预算的执行点）：
  ① 应用内通知账本（`notifications.notifyPush`，新 kind=reminder，自然键
  `rem:{automationId}` 重复发火原位刷新）——永远有；
  ② IM（飞书）——复用 backlog.feishu 配置，未配置静默跳过；
  ③ 桌面 toast——daemon 发不了，渲染端收到 reminder 帧经 Electron
  `notify:desktop` IPC 桥代发（Notification 优先、tray 气泡兜底、点击聚焦
  主窗；Web 模式自然降级为仅应用内）。
- **深链**：通知行带 link（`link_json` 列）→ `useNotificationJump` →
  `useTaskJump` 直达清单条目/待办卡片——「送回」必须走完最后一步。
- **诚实边界**：daemon 在本机，电脑关机一切通道皆哑（飞书也是本机发的）。
  真·离线提醒需要云端组件——边界写在明处，不装作解决了。

## 3. 紧急检测 + Q2 判定基准（分类器面）

分类契约增 `urgent:true` + `urgencyHint`（时间线索一句话）。两处生效：
逐次 prompt（即时）与 routing AGENTS.md（新装机一致性；它是用户数据只在
缺省时播种）。判定基准同时写入：**actionable 认长期价值型任务**（维护/
整理/学习/准备/复盘），一时琐事归想法。

**紧急条目的处置**：条目亮 amber「紧急」警告条 + 三出口——现在就跑（右栏
任务卡 runNow）/ 挂提醒（复用提醒面板）/ 忽略（`inbox.update urgent=false`，
用户比 routing 懂轻重）。**沉淀任务 `auto=false`**：闲时执行构造性来不及，
迟到的执行 + autoReview 无人看见是这条链路最坏的组合——系统把「用错了
象限」拦下来交给人。

## 4. 主管日报（只报「从未经过你手」的）

`automation/supervisor.ts`。口径：手动起的事用户自己知道，心跳提议→确认
过的确认那一刻也知道了——黑箱只有无人值守的部分：

- **① 自动执行**：autopilot 待办运行（闲时托管标注）+ 钟控发火（定时 /
  用量续跑 / 提醒送达分别标注）
- **② 该跑而没跑**：misfire 跳过、重试多次被停用（enabled=0 且窗口内有
  新失败戳）、autopilot 失败退避
- **三节全空 → 整体沉默**（不发 IM、不写通知行）——报告的噪音比沉默更伤，
  每天一条「今日无自动活动」会让主管变成垃圾邮件源

工程口径：报告构造纯函数（buildSupervisorReport / renderSupervisorReport，
`check:supervisor` 直测）；watcher 60s tick 每日到点（atMinutes 幂等键**先
落盘再干活**）；窗口固定 24h 回看（漏发几天不膨胀成黑洞），手动 `force`
自上次发报时刻收敛、连按不重唱票。送达走 notifyUser（应用内 + 飞书）。
默认开、21:00，待办设置里可调 + 立即生成预览。

## 5. 来源分级打勾门（信任模型的最后一格）

`inbox_entries.provenance`：**typed**（用户键入——默认可信，沉淀任务自动
打勾进闲时队列）/ **pasted**（粘贴的外部文本——间接提示注入的最大落点，
沉淀任务 `auto=false`，必须人工打勾）。InboxComposer 的 onPaste 检测：本条
草稿粘过即按 pasted 提交，粘后再手改也保持 pasted（保守方向：宁可多一道
勾，不给注入放行）。auto 总规则：**`!urgent && provenance !== "pasted"`**。

## 分工口诀

- 清单 = 写 + 预算分配；routing = 分（+嗅紧急）；autopilot = 空闲时干；
  钟控总线 = 到点必发（任务/消息/提醒三载荷）；主管 = 每日对账；
  提醒 = 定点浮现，通知深链把人送回原处。
- 打断预算：用户挂的提醒花得起强通道（桌面+IM）；系统推断的走弱通道
  （应用内 + 主管日报），显式升级才走强通道。

## 冒烟与检查

`smoke:inbox`（分类全链路 + 紧急 + 来源分级）、`smoke:reminder`（端到端：
过去 runAt 拒 / 悬空 link 拒 / 到点送达通知账本带深链 / 行收口 / 无 skipped。
**先关 autoClassify**——routing 默认绑 zcode，不关会真拉 zcode 会话烧额度；
config.set 入参是 `{patch}` 包着的）、`check:reminder-catchup`（调度器双轴
错过语义直测）、`check:supervisor`（报告口径 + 沉默纪律 + 窗口收敛 + 每日
gate 受控时钟）。
