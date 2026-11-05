# 会话画布统一：chat 并入终端标签体系（对话 / TUI 共存）

> 目标：消灭 `conversationView` 的对话/终端互斥——结构化对话与终端 TUI 在主区
> 作为**同一张标签画布的两种窗格**并存：可同屏分屏、可各开各的标签、从侧栏点
> 任意形态的 session 直接落到对应窗格，无需任何「形态切换」动作。
> 依据：现状走查（useShell / useWorkbench / useTerminalStore / TerminalPanel /
> Sidebar / sessionRoute，2026-11-05）+ 交互讨论收敛（三项拍板见 §二）。
> 本文 supersede docs/13 中「终端画布保留为可切换的并行形态」条款（其「新会话
> 默认结构化聊天」的契约层结论不受影响）。

---

## 一、现状诊断：互斥的根源是 chat 单例，不是 UI 选择

| 层 | 现状 | 位置 |
|---|---|---|
| 切换开关 | `conversationView: "chat" \| "terminal"` 全局枚举 | `useShell.ts:41` |
| 主区挂载 | chat 视图与终端画布同处 `ConversationSlot`，`flex/hidden` 二选一（均常驻挂载，仅切可见性） | `WorkspaceShell.tsx:324-354` |
| **chat 是单例** | Timeline / Composer / PermissionDialog 全读全局 `activeUnitId + activeSessionId + timeline`，全应用只有一份 chat 视图 | `useWorkbench.ts:116,141,145` |
| 终端画布已是完整多标签系统 | `groups[]`（标签组）× `rootLayout`（递归分屏树）+ 最大化 + F5 重挂 + created 帧认领 + 跟随 bot | `useTerminalStore.ts:53-57`、`TerminalPanel.tsx:101-163` |
| 侧栏本就双形态混排 | 点历史行 → `openEntryInChat` / `openEntryInTui`，靠 `setConversationView` 搬运互斥开关 | `Sidebar.tsx:590-693` |

**关键结论**：终端侧已经是「会话画布」的完整体（标签 + 分屏树 + 会话生命周期
管理），chat 侧是绑定全局状态的单例组件。因此「对话并入终端标签」不只是 UI
重组——**前置工程是把 chat 视图从单例改造成可多实例的窗格组件**。只要 chat
还是单例，任何 split / 共存都是假的（两个窗格显示同一份全局状态）。

## 二、已拍板决策（本轮讨论收敛）

1. **chat 标签 = session 级粒度**（不是 bot 级去重）。每条会话线一个标签，像
   浏览器一样平铺；点侧栏不同历史行开不同标签，直达性优先。精确形式化见 §四。
2. **一期只做统一画布**。拖拽重排、drag-to-split、弹出独立窗口全部后置（§八）。
   靠现有 split 按钮（向右/向下拆分）已满足「左右组合、上下组合、并排查看」。
3. **头部「对话/终端」切换钮（ConversationViewSwitch）直接退役**。原位置换
   「新建会话」入口。互斥既亡，开关无所指。
4. ChatTerminalDock（对话页小终端）**保留不动**——它是「对话时查个东西」的轻
   终端，与画布 TUI 的 CHAT_DOCK_UNIT_ID 隔离设计依然成立。
5. WorkspaceHeader 保留为**全局 bot 语境条**（显示焦点窗格所属 bot；侧栏高亮、
   右栏跟随、路由镜像全部继续依赖 `activeUnitId`）。
6. 三入口分工，互不冗余：**侧栏 = 查表**（所有 session，点了开/激活标签）、
   **标签栏 = 浏览**（已打开的窗格）、**底栏 = 运行状态**（任务 chip 跳转聚焦）。

## 三、目标模型：从「终端画布」泛化为「会话画布」

```
LayoutNode.leaf: { instanceId }                         // 现状：只能指终端
          ↓ 泛化
LayoutNode.leaf: { kind: "terminal", instanceId }       // 系统终端 / Agent TUI
              | { kind: "chat", chatKey }               // 结构化对话（会话线）
```

- `TerminalSplitTree` 渲染按 `kind` 分发到 `TerminalPaneSlot` / 新的 `ChatPaneSlot`；
  标签栏、「+」下拉、右键三件套（关闭/关闭其它/关闭全部）、分屏 / 最大化、
  F5 重挂骨架全部复用。
- 「+」下拉分组顺序：**对话会话（新建对话）→ Agent CLI (TUI·派发) → 原生系统
  终端 → 自由分屏**。对话组列为第一组。
- **空态 = 新建会话页**：无标签时画布中央落一页选择器（选 bot × 选形态：
  对话 / Agent TUI / 系统终端），替代现在「当前没有打开的终端实例」的终端
  专属空态。
- 终端工具条按焦点窗格类型自适应：焦点在终端窗格 → 清屏/重启；焦点在 chat
  窗格 → chat 动作（新会话/切历史/清屏）；分屏/最大化常驻全局。

## 四、chat 标签的身份 = 会话线（session 级的正确形式化）

用户感知的「一个会话」是**一条会话线**：`openSession` 按 `conversationId`
聚合整条谱系回放（`useWorkbench.ts:1344-1351`），续聊跨执行器开新段时时间线
也不清空（段边界只是 divider）。daemon 的 `sessionId` 是「段」，不是用户嘴里
的「会话」。因此：

- **chatKey = `${unitId}:${conversationId ?? sessionId}`**。同线不同段的侧栏
  历史行，点击落到同一个标签（并在窗格内 openSession 到那段）。
- **草稿标签**：新对话在首条消息前没有 conversationId（新段在 send 的新段
  分支才铸造，`useWorkbench.ts:1889+`）。草稿窗格持有本地 key
  （`chat_<rand>` + `{unitId, sessionId:null}`），首发落段后**就地 re-key**
  为会话线 key，窗格不重挂载。同一 bot 允许多个草稿标签并存——session 级
  粒度的题中之义。
- **幂等开标签**：侧栏/路由/前台拉起统一走 `openChatPane(unitId, sessionId)`：
  按 chatKey 找窗格 → 找到就激活（并 openSession 到指定段）；找不到就新建
  标签。终端侧维持现状口径（`terminalId` 活实例优先激活，TUI 恢复按
  `notePendingUnitDispatch` 防双发）。
- **关闭语义**：关 chat 标签只是关窗格，不杀会话（历史永远可回，与关终端
  标签杀 PTY 的语义**刻意不同**——对话没有进程可杀）。末签关闭 = 回空态
  （新建会话页）。
- 标签标题：会话摘要（daemon 台账有则用），回落 `${bot 名} · 对话`。

## 五、store 层改造（成本大头）

1. **画布 store**：`useTerminalStore` 泛化为会话画布 store——`groups / rootLayout /
   activeGroup / activeInstance / split / maximize` 的管理逻辑不变，leaf 类型
   扩为双 kind；终端实例的生命周期（xterm registry、F5 重挂、派发认领）仍归
   `TerminalSessionManager`，chat 窗格无进程语义、直接查注册表。
2. **chat 会话注册表**：新增 per-pane 会话状态存储
   `Map<chatKey, { timeline, busy, status, turnContext, draft }>`，ChatPaneSlot
   按自己的 chatKey 订阅。这是「全局单会话 → 会话注册表 + 焦点指针」的形态
   迁移：渲染事实源从 useWorkbench 的全局字段搬进注册表。
3. **全局镜像保留**：`activeUnitId / activeSessionId` 不删，语义降级为「焦点
   窗格的会话」镜像——焦点切窗格时同步。侧栏高亮、右栏跟随
   （`handleUnitChange`）、sessionRoute 的 hash 镜像全部继续读它，不用改消费方。
4. **写入定向**：Composer / 审批弹窗 / 队列操作从「读全局 active」改为「定向
   到所属窗格的 chatKey」。`useWorkbench` 的 send 家族（续聊 / 新段 / fork）
   参数化目标会话；事件泵 `consumeEvents` 按事件里的 sessionId 路由到对应
   注册表条目（多窗格并行收流）。
5. **广播入口适配**：`sessionForeground`（对话页前台拉起）从
   `setConversationView("chat") + openSession` 改为 `openChatPane(...)`（开/
   激活标签）；created 帧认领只认终端 kind，chat 无推送。

## 六、迁移清单（涉及面盘点）

| 触点 | 改动 |
|---|---|
| `useShell` | `conversationView` 退役：桌面全链路删读；MobileLayout 一期保留（降级为移动端内部态，桌面不再消费） |
| `WorkspaceShell` | `ConversationSlot` 的 chat/terminal 双分支合并为单一画布挂载；空态换新建会话页 |
| `WorkspaceHeader` | 摘除 ConversationViewSwitch，换「新建会话」入口 |
| `Sidebar` | `openEntryInChat / openEntryInTui / openNewChatForUnit / openNewTuiForUnit` 四个入口统一改 `openChatPane / 终端激活`，删全部 `setConversationView` |
| `TerminalPanel` | 「+」下拉加对话组；工具条按焦点窗格自适应；跟随 bot 的 effect 对 chat 窗格不生效（chat 不自动起会话） |
| `sessionRoute` | hash 语义不变（镜像焦点会话），回放目标从「切视图」改为「开/激活窗格」 |
| `useTaskbar` / `HistoryPane` / `ArchivedTasksSettingsSection` / `SourceControlPage` / `MobileLayout` | 各自的 `setConversationView` 调用点同口径替换（grep 全量清零为验收项） |
| 持久化 | 打开的标签 + 分屏布局落 localStorage；F5 恢复：chat 标签按 chatKey 经 openSession 回放，终端标签照旧 reattachFromDaemon |

## 七、一期验收场景

1. 侧栏点 chat 历史行 → 开/激活 chat 标签，主区直接显示，全程无形态切换。
2. 同一 bot 同时挂 chat 标签 + TUI 标签，向右拆分后并排；各自独立刷新。
3. 「+」下拉第一组新建当前 bot 对话标签（草稿）；两个 bot 的 chat 标签分屏
   并排，时间线与输入互不串线。
4. 续聊开新段不弹新标签（chatKey 稳定在会话线）；同线另一段的历史行点击
   落进同一标签。
5. 关 chat 标签不杀会话（侧栏历史可回）；关全部标签落新建会话页。
6. 头部无「对话/终端」切换钮；F5 后焦点会话按 hash 恢复 + 存活终端重挂。
7. 审批弹窗、`session.foreground` 前台拉起、底栏任务 chip 跳转，都落到对应
   会话的窗格（不存在则开标签）。
8. `grep conversationView` 在桌面链路零残留（MobileLayout 除外）。

## 八、后置期预告（一期不做）

- **二期 · 拖拽**：标签拖动重排、拖标签到窗格边缘吸附分屏（drag-to-split）。
- **三期 · 弹出独立窗口（PS 式）**：以明确动作替代自由拖拽手势——右键标签
  「弹出为独立窗口」+ 标签栏「一键归拢」。技术上：Electron 子窗口 + daemon
  事件同步；终端侧复用 reattach 机制在弹出窗口重新认领 PTY（scrollback 有
  daemon 回放，损失小），chat 侧 openSession 重放即可。xterm 实例不可跨窗口
  搬移，「弹出」实质是重新认领——这是与 PS 浮窗的本质差异，交互文案要如实。

## 九、一期落地记录（2026-11-05，typecheck / build 全绿）

§五 store 层设计在实现时收敛为**「单活 + 快照注册表」**口径（比「全量会话
注册表」省掉整个 send 家族的参数化改造，风险大幅收窄）：

- 全局 `useWorkbench.activeUnitId/activeSessionId/timeline/busy/draft` 语义
  降级为「**焦点 chat 窗格的会话**」镜像，send/续聊/fork/审批/openSession
  全链路零改动；焦点窗格（`ChatPaneSlot` live 态）直接渲染全局原班人马。
- 非焦点窗格渲染 `useChatPanes` 注册表快照：失焦拍照（snapshotFromGlobal）
  + 事件泵转投（consumeEvents 原本丢弃的「已切走运行中会话」事件现在进
  `routeEvent`）——分屏并排时后台窗格照常滚动；重新聚焦 = openSession
  谱系回放权威重建，restoring 期间先渲染快照防闪。
- 画布 store：`LayoutNode` 泛化 `{leaf|chatLeaf|branch}`；焦点游标双轨互斥
  （`activeInstanceId` ↔ `activeChatPaneKey`），chat 窗格聚焦/关闭/最大化与
  终端平权；`useChatPanes.installChatPaneSync()` 订阅画布游标驱动快照/恢复。
- 拆分语义：窗格 mini-bar 拆分按钮 = 造**同 kind 兄弟窗格**（chat → 内嵌
  bot 选择器的草稿窗格，选完即成该 bot 对话——两 bot 并排由此达成）；chat
  窗格另有「旁开终端」、终端窗格有「旁开对话」，对话|TUI 混排一步到位。
- 删除项：终端「跟随 bot 自动派发 TUI」effect（触发点「进入终端视图」随
  互斥开关消亡）；无 bot 首启自动建默认终端标签（新建会话页空态接管）。

**与 §六 的偏差**：持久化降级为 chat 窗格种子（sessionStorage：unitId +
当前段 id，F5 后 reattach 完成再重建标签、首个种子激活走 openSession）；
**分屏布局不持久化**——与终端 F5 重挂的现行口径一致，布局持久化归二期。

**移动端**：MobileLayout 维持自有二态（conversationView 保留为移动端内部
态）；移动端画布内隐藏「对话」新建入口（手机的对话页是顶栏切换的另一分支，
画布内再开对话窗格会双头）。

**已知近似（接受）**：草稿文本不跨 F5（种子只存身份不存正文）；单元级 hash
目标（`#/u/<id>` 无段）只切全局上下文不动窗格；侧栏「历史详情 / bot 设置」
里的 selectUnit 仍会清全局时间线（焦点窗格受影响，与改造前同口径）。

## 十、二期 / 三期落地记录（2026-11-05，typecheck / build 全绿）

**二期 · 拖拽与布局持久化**：

- **标签拖动重排**：HTML5 DnD——拖动态进 `store/canvasDnd.ts`（dragover 里
  getData() 恒空，指示层只能靠共享 store）；悬停标签中点前/后计算插入位，
  行内细条指示；`moveGroup` 的下标是「摘除后」语义（右移减一）。
- **拖标签吸附分屏**：`ui/usePaneDropZone.tsx` 挂在两类窗格上，指针落在窗格
  30% 边缘带内显示四向吸附高亮（取离边最近的一侧）；放手 =
  `dropTabOntoPane`：拖动组的**整棵布局子树**经 `replaceTreeNode` 嫁接到目标
  叶子位（`first/second` 按吸附方向），原组注销、目标组激活。中央区无动作
  （光标如实显示不可放置）。自己组 onto 自己组的窗格 = 无操作。
- **布局持久化**（`store/canvasLayout.ts`，localStorage `canvas-layout-v1`，
  替换一期的 sessionStorage 种子机制）：终端叶按 instanceId 匹配重挂产物
  （daemon terminalId 跨刷新稳定），对话叶按身份（unitId + 当前段）经
  `restoreRecord` 重建（paneKey 是会话内瞬态 id，不跨刷新）；失效叶子剪枝、
  分支塌缩；重挂找回的文档外终端追加平铺标签不丢；激活组 + 焦点方向
  （activeIsChat）一并恢复。WorkspaceShell 三步时序：重挂 → 整树重建 →
  持久化订阅（400ms 去抖），顺序不可乱。
- 「未选 bot」窗格（unitId=""）与草稿正文不持久化（身份存、文本不存——
  草稿窗格 F5 后回来是空草稿）。

**三期 · 弹出独立窗口**：

- **形态**：`#/popout/t/<terminalId>` 与 `#/popout/c/<unitId>/<sessionId|->`
  两路由 → `PopoutShell`（app.tsx 分流，不装任何工作台全局机制：路由镜像 /
  任务栏 / 通知 / 前台拉起都不进弹窗）。Electron 侧 main.cjs 的
  setWindowOpenHandler 放行 app origin 为无边框子窗口（带 preload）；浏览器
  侧 window.open popup 特征串原生可用。
- **交接语义（与 PS 浮窗的本质差异如实落地）**：终端弹出 = 主窗
  `releaseTerminalToPopout`（**释放不杀**——TerminalSessionManager 新增
  release：退订帧/卸 DOM/dispose xterm，不发 terminal.kill）+ 弹窗按
  terminalId 从 daemon 台账重认领（scrollback 回放，与 F5 重挂同款）；对话
  弹出 = 摘窗格（不杀会话）+ 弹窗内 openSession 谱系重放。**xterm 不可跨窗口
  搬移，弹出实质是重新认领**——交互文案（title/关闭钮提示）如实标注。
- **归拢**：弹窗关闭 = 重认领回标签（终端 `readoptTerminal` / 对话
  `openChatPane`）。关闭侦测双保险：弹窗 beforeunload → postMessage 携带
  自身 URL（主窗口 F5 后也能按 URL 对账）+ 每秒 win.closed 轮询。标签栏在
  有弹窗时出现「归拢 (N)」按钮一键全收。
- **F5 与弹窗共存**：弹窗台账进布局文档——主窗刷新时不把已弹出的终端重挂
  成标签（两处 xterm 抢同一 PTY）；恢复出的是无 Window 引用的台账条目
  （归拢可用、轮询失效）。右键「弹出为独立窗口」仅单窗格标签可用，分屏组
  弹出会明确提示（多窗格弹窗要整套注册表跨窗口，超出三期口径）。

**三期已知近似（接受）**：F5 后对无引用弹窗条目点「归拢」会在弹窗还开着时
重认领终端（双活至弹窗关闭，关闭通告幂等收口）；弹窗里的对话草稿文本随窗
口关闭丢失（会话身份可回）。
