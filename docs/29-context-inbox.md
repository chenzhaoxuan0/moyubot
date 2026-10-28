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
  `inbox.classify.run`；单飞保护
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

### 5. UI

- 新主视图「清单」（侧栏 Inbox 图标，待办旁边）：
  - 顶部文本框：Enter 收进清单（IME 组合中不拦截），可展开「可选项」预置字段
  - 列表按分类分块（目标 / 待办 / 想法 / 资料 / 以后再说 / 自定义），待分类置顶
  - 行内：点击编辑原话、点分类 chip 改分类、routing 理由、任务链接（实时状态）、
    重新分类 / 删除
  - 设置：自动分类开关、分类执行器/模型、自定义分类（可标「沉淀任务」）
- 待办页：卡片带「闲时自动执行」徽章与指定会话标记；设置弹窗加 autopilot 组；
  新建/编辑弹窗加 auto 与指定会话两个可选项

## 方法面（`aw methods` 自描述见 methods.meta.ts）

`inbox.add / inbox.list / inbox.update / inbox.delete / inbox.classify.run /
inbox.reclassify / inbox.config.get / inbox.config.set`；
`backlog.create / backlog.update` 增 `auto`、`targetSessionId`。

## 冒烟

`pnpm -C backend smoke:inbox` —— routing bot 注册、写条目 → pending、信号帧、
优雅失败（分类器指到不存在的执行器）、手动改分类、预置字段、自定义分类、
backlog auto/targetSessionId、删除。**冒烟把分类执行器指到不存在的 id**：
routing bot 默认绑定 zcode，不这样做冒烟会真的拉起 zcode 会话烧额度。

## 分工口诀

- 清单页 = 写；routing = 分；待办页 = 管任务；autopilot = 空闲时干。
