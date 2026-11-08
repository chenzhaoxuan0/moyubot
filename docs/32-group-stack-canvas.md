# 组栈画布：orca 式「叶子=标签组」模型迁移 + 体验采纳

> 目标：把 docs/31 的会话画布从「叶子=窗格、组=标签」迁移到 orca 同型的
> **「叶子=标签组（栈）」**模型——每个分屏格子是一个完整标签栈（VSCode 编辑器
> 组式），拖标签入格 = 进栈，空组自动塌缩；同时采纳 orca 调研（2026-11-05，
> 对照 orca v1.4.214 源码实证）的 A 级五项体验与 B 级拖拽两项。
> 依据：orca `src/shared/tab-types.ts:5-16`（组栈模型）、`RetainedPaneHost.tsx:99-136`
> （常驻 overlay + dim）、`tab-drop-zone.ts:8-35`（五向几何）、`tab-types.ts:76-84`
> （MRU）。本文 supersede docs/31 §三/§六 的布局层条款（会话身份/焦点链/
> 快照注册表/弹出窗口语义全部保留，只换布局骨架）。

---

## 一、为什么迁移（与 docs/31 模型的差异收束）

| 维度 | docs/31（旧） | 本篇（新） |
|---|---|---|
| 分屏原子 | 叶子=窗格；组=标签（组内含分屏树） | **叶子=标签组**；窗格（终端/对话）是组栈里的标签 |
| 顶栏标签条 | 全局标签条切换组 | **退役**——每个分屏格子自带标签条 |
| 拖标签分屏 | 拖组整棵子树嫁接到窗格边 | 拖标签到格子：**中央=入栈**、四边=分出新组 |
| 混排语义 | chat|TUI 同一标签内部分屏 | 同一分屏两格并排（表达力等价，模型统一） |
| 空组 | 组空即消失（=关标签） | 组空**塌缩**（树收缩、兄弟继承焦点） |

用户理想（PS 式文档窗口自由组合）与组栈模型同构：组合的单位是"带标签条的
文档组"，而不是"标签内部的窗格碎片"。

## 二、数据模型（store 层）

```ts
/** 窗格 = 标签：终端（daemon PTY 视图）或对话（会话线视图） */
export type PaneKind = "terminal" | "chat";
export interface CanvasPane {
  readonly id: string;            // 终端 = terminalId（daemon 稳定）/ 对话 = paneKey（会话内瞬态）
  readonly kind: PaneKind;
  title: string;
  /* 终端专属（沿用 TerminalInstanceItem 字段） */
  shell?, profileId?, icon?, cwd?, executorId?, unitId?, createdAt?, attachScrollback?, reattached?
  /* 对话专属：身份仍在 useChatPanes 注册表，这里只引用 paneKey */
}

/** 组 = 分屏格子 = 标签栈 */
export interface PaneGroup {
  readonly id: string;
  tabOrder: readonly string[];     // 组内标签序（显示顺序）
  activePaneId: string | null;     // 组内激活标签（null = 空组，将被塌缩）
  recentPaneIds: readonly string[];// 组内 MRU（升序，尾=最近），关标签按此恢复
}

/** 分屏树：叶子=组（组栈模型的核心） */
export type GroupLayoutNode =
  | { type: "group"; groupId: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical";
      first: GroupLayoutNode; second: GroupLayoutNode; ratio?: number };
```

state：`panes: Record<id, CanvasPane>`、`groups: Record<id, PaneGroup>`、
`layout: GroupLayoutNode | null`（null = 单组全幅）、`activeGroupId`、
`maximizedPaneId`（保留双 kind 语义）。树纯函数组级化：
`replaceLeaf`（嫁接）、`removeGroupLeaf`（移叶塌缩）、`collapseGroupLayout`、
`moveGroupLeafBeside`——对齐 orca `tab-group-layout-tree.ts` 的操作面。

**焦点链不变**：`useChatPanes` 的「单活+快照注册表」原样保留；激活链改为
`activatePane(paneId)` = 置所属组 activePaneId + activeGroupId + （chat 时）
焦点链恢复。旧 `focusChatPaneTab` 更名保留兼容别名（2026-11-08：别名零消费，
已删除，见 §十一）。

## 三、渲染层

```
TerminalPanel（工具栏 + 空态；顶栏标签条退役）
└─ SplitTree(layout)
   ├─ split → 递归（Splitter：拖动中只写 DOM style，松手提交 store —— A4）
   └─ group → GroupPanel（每个分屏格子）
       ├─ 组标签条：tabOrder 的标签（可拖、中键/×关、右键三件套+弹出）、
       │   尾部「＋」直开组内新建；拖拽插入指示 + 五向 drop
       └─ 窗格层：组内全部标签**常驻挂载**（A1），仅 activePaneId 可见
           （display:none + inert；切标签零 remount、xterm/对话状态零迁移）
```

（2026-11-08 修订：TerminalPanel 的工具栏整行也已退役（e02ba37）——新建组与
动作组全部下沉到各格标签条尾，TerminalPanel 只剩树 + 空态，见 §十一）

- **非激活组 dim**（A3）：`activeGroupId` 之外的格子内容降不透明度
  （`--canvas-unfocused-dim: 0.75`，对齐 orca `UNFOCUSED_SPLIT_GROUP_OPACITY`）。
- 窗格 mini-bar 退役（标题/关闭上移组标签条；窗格级最大化钮挂组标签条右端）。
- 空态（layout=null 且无组）仍是 NewSessionPage；「＋」分组与旧一致
  （对话 / Agent TUI 派发 / 系统终端）。

## 四、拖拽语义（HTML5 DnD 保留，不引 dnd-kit）

1. **组内重排 / 跨组移动**：拖标签经组标签条——插入指示在条内；落到别组
   条上 = 移入该组（原组空则塌缩）。
2. **五向 drop**（落到格子 body，对齐 orca 几何 `tab-drop-zone.ts`）：
   中央 80% 内圈 = **入栈**（追加为该组标签并激活）；左/右 1/3 = 水平分屏
   （新组）；中 1/3 按上下半 = 垂直分屏（新组）。组标签条区域永远只做插入
   不产生分屏。
3. **空组塌缩**：tabOrder 空即从树摘叶，兄弟提升；整树只剩一组 → layout=null。
4. **悬停预览激活**（B）：拖拽 dragover 到目标组超过 ~300ms，该组临时激活
   被悬停标签的预览（组内 activePaneId 临时切换），drop/dragleave/dragend
   恢复——常驻挂载让预览零成本。
5. 防呆：拖组内最后一个标签到自身格子的四边 = no-op（`isSplitDropNoOp`）。

## 五、A 级采纳清单（本篇一并落地）

| # | 项 | 出处 | 落点 |
|---|---|---|---|
| A1 | 重表面常驻不 remount | RetainedPaneHost | GroupPanel 全标签挂载 + 可见性切换 |
| A2 | 关标签 MRU 恢复（非视觉邻居） | tab-types.ts:76-84 | PaneGroup.recentPaneIds |
| A3 | 非激活分屏格 dim | RetainedPaneHost | SplitTree/GroupPanel |
| A4 | Splitter 拖动中只写 style、松手提交 | TabGroupSplitNodeTree | SplitTree 本地 ratio state |
| A5 | beforeunload 布局补写（补去抖尾巴） | use-app-session-persistence | canvasLayout 安装器 |

B 级：五向 zone（§四.2）与悬停预览激活（§四.4）。

## 六、迁移面（消费点盘点）

store：useTerminalStore 重造（文件与主导出名保留）；useChatPanes 激活链与
`focusChatPaneTab` 更名兼容（别名已于 2026-11-08 删除）；canvasLayout **v2** 文档（panes/groups/layout/
activeGroupId；对话身份仍存 unitId+sessionId；**v1 布局不迁移**——升级后回
落 reattach 平铺 + 路由回放，一次性损失布局排列）；useCanvasPopouts.popoutTab
改为「从组摘标签」；reattach / created 认领 / splitPane / closeTab 族 /
releaseTerminalToPopout / readoptTerminal 全部组级化。

渲染：TerminalPanel 重造；TerminalSplitTree 适配；GroupPanel 新建；
TerminalPaneSlot/ChatPaneSlot 去 mini-bar 加 dim；NewSessionPage 空态条件。

保留不动：useShell 主视图、useChatPanes 注册表与快照、sessionRoute hash、
sessionForeground、useTaskbar 口径、PopoutShell、Electron 放行、移动端布局。

## 七、验收场景（在 docs/31 §七 之上叠加）

1. 顶栏标签条不存在；每个分屏格自带标签条，格子间可任意左右/上下组合。
2. 拖标签到别格**中央** = 收进该组并激活；拖到**四边** = 分出新组；原组空
   自动塌缩、焦点落到兄弟格。
3. chat 与 TUI 并排 = 两个格子（各自标签条）；关一格标签不影响另一格。
4. 切组内标签 / 切焦点格：已开终端零重挂（buffer/选区不丢）、对话窗格
   状态不闪。
5. 关标签回到**最近使用**的标签，不是视觉邻居。
6. 非焦点格内容 dim；Splitter 拖动过程 60fps 不触发 store 写；松手才落盘。
7. F5：布局（含分组/分屏比例/激活格/组内激活标签）完整恢复；关闭前 <400ms
   的改动不丢（beforeunload 补写）。
8. 拖拽悬停别格 ≥300ms 该格预览被悬标签内容；取消拖拽恢复原状。
9. 弹出/归拢、派发认领、侧栏直达、hash 回放在新模型下语义不变。

## 八、落地记录（2026-11-05，typecheck / build 全绿）

- **store**：useTerminalStore 整体重造（文件与主导出名保留）——`panes/
  groups/layout` 三张表 + 树纯函数组级化（replaceGroupLeaf / removeGroupLeaf
  / splitGroupNode / collectGroupIds）；焦点**单轨化** activePaneId（旧双轨
  activeInstanceId↔activeChatPaneKey 收敛，useChatPanes 同步器投影
  chatKeyOf 后比对）；normalize 统一做空组塌缩/单组收平/焦点自愈；MRU =
  PaneGroup.recentPaneIds（nextActiveAfterClose）。splitPane 语义 = 拆**激活
  组**，新组承载新标签。
- **渲染**：GroupPanel（组标签条：拖拽插入指示/中键关/右键四件套含弹出/
  尾部＋小菜单/窗格级最大化；窗格层全标签**常驻挂载** display:none+inert）；
  TerminalSplitTree 叶子=组（key=groupId，组挪位置不重挂）；Splitter 改
  **pointer 提交式**（拖动只写本地 style，pointerup 才 setSplitRatio）；
  TerminalPanel 顶栏标签条退役，只剩工具栏+树+空态；两 PaneSlot 去 mini-bar。
- **拖拽**：canvasDnd 改 draggingPaneId；五向几何（中央 80% 内圈=入栈 /
  左右 1/3 / 中 1/3 上下半）；悬停 ≥300ms 焦点预览（setActiveGroup，取消
  无需回滚）；isSplitDropNoOp（拖组内最后标签到自身四边拒收）。
- **持久化 v2**（canvas-layout-v2）：对话标签序列化为稳定 id
  （chat:unit:sid / chat:unit:draft-N），恢复时 restoreRecord 换新 paneKey
  再映射回组序列；比例 ±0.005 容差省略；弹窗台账同存；**beforeunload 同步
  补写**（A5）；v1 布局不迁移（回落 reattach 平铺，一次性损失排列）。
- **周边**：popoutTab→popoutPane（标签级，无整组解析——多标签格弹出单个
  标签，摘走后原格塌缩如常）；Sidebar/ArchivedTasks 的 TUI 活标签激活统一
  activatePane 一步到位；reattach / created 认领落激活组；usePaneDropZone
  删除（并入 GroupPanel）。
- **已知近似**：F5 恢复后组内 recentPaneIds 重建为标签全序（MRU 历史精度
  损失一档，只影响恢复后第一次关标签的回落选择）；悬停焦点预览采用组激活
  而非 orca 的目标标签内容预览（标签即窗格的模型下语义等价、实现稳）；
  v1→v2 布局一次性重排。

## 九、落地后修订（2026-11-05 ~ 06，用户实测驱动）

| 提交 | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| `ab3ff7a` | 新建对话/终端「无反应」 | 「单组全幅 layout=null」约定下 TerminalSplitTree 对 null 直接 return null，首标签画布空白 | null 时渲染唯一组 |
| `a61c404` | 拖标签四边分屏后**同一标签同时挂两边**、标签混杂分不清归属 | dropPaneOnGroup 残留旧模型嫁接写法 `order=[...target.tabOrder, paneId]`，目标组被整组复制进新组 | 新组只装拖动标签 |
| 本修订 | 关掉的标签残留成孤儿：侧栏「TUI 恢复」点了没反应、终端弹窗归拢静默失效 | normalize 返回值漏了 panes，closePane/closeGroup/closeOtherPanes/releaseTerminalToPopout 的删除被丢弃 | normalize 一并返回 panes |

**回归防线**：`pnpm check:canvas`（`prototype/scripts/check-canvas.ts`，并入
`pnpm check`）——store 源码复制进项目内工作目录、两条重依赖 import 改指
桩模块后 node 直跑，13 条断言覆盖建栈/同组重排/四边分屏/no-op 守卫/对话
拆分/最大化往返/关格塌缩/末标签收平/center 入栈/readopt 幂等，外加两条
全局不变式：**标签唯一性**（无 pane 挂多组）与**无脱组窗格**（无孤儿）——
上表后两个缺陷正是被这两条不变式定性/抓出的。

## 十、用户实测二轮（2026-11-06）

| 问题 | 根因 | 处置 |
|---|---|---|
| 分屏并排时失焦侧对话格塌成空白（输入框/头像消失） | 「单活+快照」把**任何**焦点离开都当对话失焦：焦点移到终端窗格时对话格被降级成只读快照，快照态没有输入区/草稿空态 | **live 归属与画布焦点解耦**（installChatPaneSync 只在焦点落到**另一个对话格**时交接——终端从不争用全局对话链路）；快照态补齐外观：本窗格 bot 的空态头像（EmptyState 可传 unit）+ 休眠输入框占位（点击接管）+ 快照态不再套全局 bot 的强调色 |
| 切换标签时画面闪烁 | 任务栏「切走运行中对话→自动压缩进底栏」的离开侦测与 ghost 动画在每次焦点切换时触发 | **任务栏机制整体退役**（用户拍板：会话全量由画布标签管理）——删 useTaskbar/Taskbar/TaskChip/CompressGhost/compressAnim、头部「折叠到底栏」钮、底栏拉高手柄与高度锁定设置（useShell 的 statusBar 状态一并移除）；GlobalStatusBar 固定 28px 纯状态条（会话灯说明/工作状态/后台守护/toast/通知铃）。后台会话可见性由：对话格快照实时滚动 + 侧栏历史状态灯 + 通知中心承担（docs/31 §九 审批口径同步更新） |
| **点回对话标签被重置成头像+问候+空输入框的初始态**（并排对照全毁） | focus() 的 `sessionOverride !== undefined` 判定把画布游标切换（handleCanvasFocusChange）传来的 `null` 当成「强制草稿」——每次点回对话标签都走草稿分支 selectUnit 清空时间线，而不是恢复窗格自身会话 | `targetSid = sessionOverride ?? pane.sessionId`（null 与 undefined 都回落窗格自身）；仿真复现+验证见下 |
| **单条消息「发了两条」**（用户初判 chatui 侧） | a61c404 修复前的拖拽 bug 已把「同一标签挂多个组」写进了**存量**布局文档——修复只防新增不清洗存量；同一对话格渲染两份全局时间线（两组并排各一条），后端实际只有一条 | 双层净化：restoreCanvasLayout 恢复时跨组/组内去重（同标签只留首个归属组）+ normalize 运行时自愈兜底（未刷新的脏状态经任意布局操作即清）；check:canvas 补「脏布局跨组重复自愈」断言 |

**回归防线（二）**：`pnpm check:canvas-focus`（`prototype/scripts/check-canvas-focus.ts`，
并入 `pnpm check`）——useChatPanes/useTerminalStore 源码复制+import 改桩
（useWorkbench/useShell 换可控桩，openSession 按 sessionId 回放假时间线），
仿真「对话 A 有内容 → 焦点到终端 → 点回 → 切对话 B → 点回 A」全序列，
6 条断言：首开即回放 / 终端焦点不清内容（live 归属解耦）/ 点回不重置 /
切走快照封存 / 往返后 openSession 权威重建内容完整。最后一条正是本表
第三行的验收点。

## 十一、顶栏退役与整周评审修订（2026-11-08）

| 问题 | 根因 | 处置 |
|---|---|---|
| 画布顶栏整行占纵向空间（e02ba37） | 新建区 + 工具条在格子之外另起一行，分屏后格子越小越挤 | **顶栏整行退役**：新建组（对话 / 终端 / 选择▾ 派发菜单 / 归拢弹窗）与动作组（新对话 / 历史 / 清屏 / 重启 / 拆分 / 最大化）下沉到各格标签条尾，按本格激活标签出钮；§三 的 TerminalPanel 只剩树 + 空态 |
| 移动端格内出现「对话」与拆分入口 | 顶栏迁入标签条时没带 `!isMobile` 门控（docs/31 §九：画布内再开对话窗格会与移动端对话页双头） | 对话快捷钮 / 菜单对话组与拆分组 / 条尾新对话与最大化在移动端恢复隐藏 |
| 选择▾ 菜单在矮/窄格子里被裁切 | 菜单 absolute 挂在格子根（overflow-hidden）内；画布层 @container 的 containment 也会困住 fixed 遮罩 | 菜单与遮罩 portal 到 body，按触发钮 rect 落 fixed 坐标（下方不够向上翻，左缘夹视口） |
| `pnpm check:canvas-focus` 自 94e1c05 起整体挂掉 | 脚本按 import 行原文做字符串替换，useChatPanes 的 import 行一改就静默失配（残留相对导入 → ERR_MODULE_NOT_FOUND），`pnpm check` 实际一直是红的 | 替换串与桩对齐；新增「同目录导入漏网」守卫让失配当场报错；⑥ 改快照直通口径，新增 ⑦ 门禁不过回落 openSession |
| 兼容别名 / 死状态残留 | 单轨 activatePane 迁移后 focusChatPaneTab 零消费；pendingUnitDispatch 的唯一读者（旧「终端跟随 bot」effect）随 docs/31 一期删除 | 两者删除；findGroupOfPane / allPaneIds / id 生成改为导出复用（canvasLayout 内联副本收口），splitPane 与 createTab 共用终端标签构造 |

**回归防线（三）**：check:canvas-focus 增至 7 条断言（新增直通门禁回落）；
`check:canvas` 14 条不变。两脚本的替换目标是 useTerminalStore / useChatPanes 的
import 行原文——改这两个文件的 import 行时必须同步脚本（守卫会当场指出漏网行）。
