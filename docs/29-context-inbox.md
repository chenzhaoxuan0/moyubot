# 29 —— 清单（Context Inbox）：个人 context 的唯一入口

> 2026-10-29。feat/context-inbox 分支。

## 问题

用户的 context 只从一个通道进来：他像编辑 Notepad++ 里那个 txt 一样，想有一个
**一直在编辑的同一个列表** —— 想法、内容、近期目标、杂事，全部写进这一处。
这个列表在 UI 上分块；写进去的东西不该都叫「待办」：

- 是某个想法 → 应该被准确归进想法库
- 是近期目标 → 应该进 GTD 的 to-do 列表，agent 在空闲时间自动完成

所以需要两个必要的东西：**基础分类**（通用分类 + 自定义）和**一个文本框**。
分类是枢纽 —— 单通道进来的一切都靠它分流。

## 设计

```
文本框（唯一编辑点）
   ↓ inbox.add
inbox_entries（清单，state.db）          ←—— UI 按分类分块展示
   ↓ routing bot 分类（InboxClassifier，批量一个会话）
   ├─ actionable（goal/todo/自定义）→ backlog_items（auto=true）→ autopilot 闲时直接执行
   └─ 非 actionable（idea/note/later）→ 留在清单按块归档
```

### 1. routing bot（常驻合成 bot）

对齐 steward / heartbeat 的模式（`backend/src/inbox/routingBot.ts`）：

- id `routing`，名字 `Routing`，resident；住在 `<homeDir>/routing/`
- AGENTS.md 是岗位说明书：分类依据、JSON 输出契约、红线（只分类不执行）
- 默认主绑定 zcode；inbox 配置显式指定时优先（设置页可改）
- 定位是「总管 + 心跳」：用户可以被指定的默认 bot

### 2. 分类器（InboxClassifier）

- 批量：pending 条目凑一批，routing 会话一次分完（3 分钟预算）
- 输出契约：JSON 数组，每条 `{id, category, title, reason, task{...}}`
- **用户预置字段（hints）必须尊重**：提交时可选指定 bot / 文件夹 / 执行器 /
  模型 / 执行方式 / 指定会话 —— routing 只补空缺，不改写
- 触发面：`inbox.add` 后 debounce 2.5s（autoClassify 可关）、启动 sweep、手动
  `inbox.classify.run`；单飞保护。**autoClassify 从关到开的 `inbox.config.set`
  也会补排一轮**（开关再开时，攒下的待分类条目不等下一次写入/重启）
- 优雅失败：会话失败/解析失败条目保持 pending（不是条目的错，下次再试）；
  分类 id 无效回落 todo/note 并在理由里注明

### 3. 闲时自动执行（autopilot）

「用量还有富余就持续把清单做完」的引擎面（`backlog/heartbeat.ts`）：

- 新配置 `autopilot { enabled, maxConcurrent, headroomFloorPercent, autoReview }`，默认开
- 引擎 tick（20s）：空闲（无运行会话 + 超过 idleMinutes）且余量 ≥ 地板 →
  直接派发下一条 `ready + auto` 的待办，**不进确认门**，跑完自动验收（autoReview）
- 与确认门（ADR-0001）的边界：auto 条目是托管执行语义；非 auto 条目照旧走
  心跳提议 + 用户确认，铁规则原样保留。心跳候选过滤掉 auto 条目（不重复提议）
- 余量门：条目指定了执行器看它（percent 未知放行，别把清单卡死）；没指定就在
  订阅执行器里挑剩余最多的

### 4. 数据模型

- 新表 `inbox_entries`：text（用户原话）/ category / category_note /
  hints_json / task_id（与 backlog_items 双向链接）/ status（pending |
  classified | failed）
- `backlog_items` 新列：`auto`（闲时自动执行）、`target_session_id`
  （指定已有会话执行 —— 接得上就 resume 发 prompt，接不上回落新开）

### 5. UI（2026-10-30 重构：单列时间轴）

原「清单」「待办」两个主视图先合为一页两栏，再收敛为**单列时间轴**
（侧栏单入口 Inbox 图标，`MainView="backlog"`）——「一个持续编辑的 txt」
愿景的最终形态：

- **顶部**：文本框（Enter 收进清单，IME 组合中不拦截；「可选项」预置字段）
- **HEAD 只放标题**（窄窗口不与最小化/最大化/关闭钮重叠）
- **状态带（StatusBand，三行）**——机器状态的「扫一眼」层，承接原状态分组的
  跨条目职能（**状态不是标签**：推送型注意力住带子，拉取型组织住标签行）：
  - 行1：工作相位 + `N 条活跃 · 今日完成 N` + 两侧总开关（**自动分类** =
    `inbox.autoClassify`、**闲时执行** = `backlog.autopilot.enabled`——都只挡
    未来的自动触发，不杀在跑的）+ 待办设置 / 强制忙碌 / 跳一跳 / 新建
  - 行2：**状态计数 chips**（执行中/待验收/待确认/退避/休眠，点击=状态过滤）
    + 「下一条」定位 + 当前判定（余量轴只给可验证条件不给假 ETA）+
    **定时带**（钟控轴下次发火确切时刻，双轴对照）
  - 行3：**双排序切换**（时间=日志态 / 队列=sortPos 调度态——捕获序与优先级
    序各有着落）+ 标签过滤行
- **一列事件块（TimelineColumn）**：
  - 行 = 清单条目（**事件块**）∪ 孤儿任务行（存量无源任务，带来源 chip），
    按捕获时间倒序，sticky 日期分段（今天/昨天/本周/更早），左侧时间沟
    （HH:mm，窄屏隐藏退进块内）
  - **事件块点开展示它拆解出的任务**（捕获→沉淀的空间化）：折叠态两行摘要 +
    标签 chip + 任务状态 + 紧急/已挂提醒徽章；展开态原话全文（点击编辑）+
    嵌套任务卡（勾门/上下移/立即执行/验收/运行历史全保留）
  - **已读展开**：classifiedAt 晚于 seenAt 的块默认展开——转化完成当场看见
    routing 把你的话理解成了什么任务（学写清单的反馈回路）；seenAt 每 5 分钟/
    离开页面前推
  - **待分类钉顶**（routing 队列第一屏可见，分类器状态 + 立即分类 + 清单设置
    就在块头）
  - **队列态**：sortPos 序任务队列，行 = 来源摘要 + 任务卡（#位次沟、下一条
    置顶、前置条件行贴顶），done 不进
  - 过滤组合定死：标签定块去留、状态定块内卡显隐、排序只动顺序
  - 视图偏好（排序/过滤/已读线）记 localStorage（`worklist-view-v1` /
    `worklist-seen-at`），跳转自动展开父块（导航动作不写偏好）
- **任务必有源**：手动新建与 GTD 统合也生成壳条目——时间轴上每个任务都挂在
  事件块下；删壳/改标签/重分类 = 清单侧撤销，一律摘勾（不再按 source 区分）
- **设置弹窗 ×2**：清单设置（分类执行器/模型、自定义标签可标「沉淀任务」）；
  待办设置（心跳 / 余量 / 统合 / 飞书 / autopilot 参数 / 主管日报）

## 方法面（`aw methods` 自描述见 methods.meta.ts）

`inbox.add / inbox.list / inbox.update / inbox.delete / inbox.classify.run /
inbox.reclassify / inbox.config.get / inbox.config.set`；
`backlog.create / backlog.update` 增 `auto`、`targetSessionId`；
`backlog.runs`（单条运行历史）。提醒 / 紧急检测 / 来源分级 / 主管日报的
落点见 docs/30（`reminder.create`、urgent 字段、provenance 参数、
`supervisor.*`）。

## 冒烟

`pnpm -C backend smoke:inbox` —— routing bot 注册、写条目 → pending、信号帧、
优雅失败（分类器指到不存在的执行器）、手动改分类、预置字段、自定义分类、
backlog auto/targetSessionId、删除、紧急检测（urgent 警告 / 任务不勾 / 忽略）、
来源分级（pasted 不勾）。**冒烟把分类执行器指到不存在的 id**：
routing bot 默认绑定 zcode，不这样做冒烟会真的拉起 zcode 会话烧额度。
提醒闭环与主管日报的冒烟/检查见 docs/30（smoke:reminder / check:reminder-catchup /
check:supervisor）。

## 信任模型（必须知道的事）

清单的执行链路 = 「你写的文字 → routing 分类 → auto 任务 → 无人值守执行」。
这条链路里**贴进清单的外部文本是最大的信任边界**：一篇带恶意指令的网页摘录
（间接提示注入）可能诱导 routing 把它分类成任务，而 auto 任务的执行会话是
`source=automation`（权限自动放行，deny 规则仍生效）。已收敛的边界：

- 分类会话本身跑在 **plan 模式**（只读闸：file_write/shell 自动拦截）——被注入的
  routing 会话最多「说」（输出一个任务 JSON）、不能当场「做」
- routing 的输出里，**会话目标（targetSessionId）、执行方式（launchMode）、
  工作目录（rootPath）零信任** —— 解析器不收；会话与目录只来自你亲手预置的
  hints 与单元注册表
- routing 建议的 bot 必须在可选清单里、执行器必须真实存在，未知一律回落系统自选
- 任务字段（goal/prompt/title）白名单截断；清单文本 8000 字符上限

**打勾门（2026-10-29 决策）**：闲时执行以卡片上的勾为准 —— 勾 = 空闲且余量够
时自动派发；**任何编辑保存后勾自动取消**，需重新打勾才会再进闲时队列；验收打回、
清单侧撤销（删除条目 / 改分类 / 重分类）同样摘勾。取消勾的任务默认完全静默
（心跳提议开关 `heartbeat.proposeNonAuto` 默认关），只能手动执行或重新勾选。

**勾的默认值按「紧急 × 来源」分级（2026-10-30，docs/30）**：
`auto = !urgent && provenance !== "pasted"` ——
- **紧急条目**（routing 嗅到时间压力给 `urgent:true`）：闲时执行构造性来不及，
  沉淀任务不默认勾，条目亮警告 + 三出口（现在就跑 / 挂提醒 / 忽略）；
- **粘贴条目**（`provenance:"pasted"`，输入框 onPaste 检测、粘后再改仍算）：
  外部文本是间接提示注入的最大落点，必须人工打勾才进无人值守队列；
- **键入条目**（typed）：用户亲笔，默认托付（原行为）。

仍是事实的事：**打勾任务的 prompt 会被原样执行**。给完全无人值守的自主执行留的
总闸是状态带的开关（**闲时执行** = autopilot，**自动分类** = autoClassify）
与「强制忙碌」；不放心外部文本时，把它以
「资料/想法」标签留存（非 actionable 分类不生成任务），或取消打勾改走手动执行。

## 分工口诀

- 清单页 = 写 + 看（时间轴一列看全部，事件块里管任务）；routing = 分（打标签、
  嗅紧急）；autopilot = 空闲时干；状态带 = 机器状态的扫一眼层 + 总闸。
