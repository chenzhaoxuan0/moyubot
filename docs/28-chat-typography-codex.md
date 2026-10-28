# 28 · 对话页排版体系升级（Codex 真值对齐）

> 2026-10 · chat UI 的字号/行距/间距/气泡/MD 元素样式全面换血。
> 数值真值来源：Codex 桌面版（OpenAI.Codex 26.1013）的包拆解产物
> `codexskin/codex-clone`（tokens.css + ANALYSIS.md，从 app.asar 的
> app-shared-*.css 与 codex-ui-kit@0.1.2 交叉验证）。
>
> 来源协议备注（2026-10-28 核查）：Suk1u/codex-clone 本身**无许可证**
> （README 明言 "No license is granted by default"）——本项目只采用其中
> 实测得到的数值事实（字号/行高/间距等参数不受版权保护），**未复制其任何
> 代码**；若日后要复用它的 CSS/组件代码，需先取得作者许可。其上游
> codex-ui-kit 为 MIT。Codex-Dream-Skin 为 MIT（macos/LICENSE）。

## 为什么改

旧版排版三个"不高级"的根源：

1. **彩虹标题**：h1 用强调色、h2 天蓝、h3 靛蓝、h4 翠绿——颜色当层级用，
   视觉噪音大，主题色被稀释。
2. **节奏失度**：段落 my-2（8px）+ leading-relaxed，列表项 space-y-1 塞在
   一起，长回复密不透风；气泡 padding 16/12 偏松，与正文步调不一致。
3. **过程层语言不统一**：终端卡硬编码深色（#13151a）不跟主题，工具卡带
   阴影、思考块又另一套，三种"卡片"三种样子。

## 真值表（Codex 桌面版拆解值 → 本项目落地）

| 项 | Codex 真值 | 本项目 token/类 |
|---|---|---|
| 正文 | 14px / 22px（`.875rem` / `1.375rem`） | `--text-thread` + `--text-thread--line-height` |
| 段落间距 | `0 0 11px` | `p.mb-[11px].last:mb-0` |
| 列表 | 缩进 20px、项间距 4px | `pl-5 space-y-1` |
| 轮次间距 | 12px（`--thread-turn-gap`） | 单元容器 `space-y-3` |
| 用户轮间距 | 34px（`--user-turn-gap`） | `12 + 22(pt) = 34` |
| 用户气泡 | surface-3 底 + hairline 边 + 16px 圆角 + 9/14 内边距，右对齐 78% | `rounded-2xl bg-rail border-line px-3.5 py-2.5 max-w-[80%]`，无阴影无小切角 |
| 行内代码 | 12.5px、5px 圆角、hairline 边 | `text-[0.875em] rounded-[5px] border-line bg-rail/60 px-[5px]` |
| 代码块 | mono 12px / 1.65 | `text-[12px] leading-[1.65]`，语言栏压到 11px |
| 标题 | 单色、字重/字号分层 | `text-[1.25em/1.1em/1em/0.95em] font-semibold text-ink` |
| 正文栏宽 | 768px | **三档模式**（2026-10-28 第二轮）：standard=768（默认）/ wide=900（超宽，旧默认）/ custom（滑杆），设置页「外观 → 对话列宽」分段控件 |

宽度特意保留本项目自己的：Codex 的 768px 是它的产品选择，本工作台是
多栏重型工具，阅读列更宽是既定设定（外观设置里用户可调）。
（第二轮更新：768 成为默认档「标准」，900 保留为「超宽」档——用户可一键切换。）

## 排版纪律（新规则，后续改动请遵守）

- **颜色不当层级用**：标题/正文/列表只有 ink → graphite → ash 的明度阶；
  强调色只出现在：链接、运行中状态、行内代码不占色。
- **对话正文一律 `text-thread`**（14/22），不要用 `text-body leading-*` 手拼。
- **过程层统一卡片语言**：思考块、工作组、工具卡全部
  `rounded-input(12px) + border-line + bg-card|rail/15~30`，无阴影；
  阴影只留给浮层（菜单/弹窗）。
- **mono 一律 12px**（工具输出、代码块、思考正文），行距 1.65。

## 折叠/展示策略（本轮确认不变，仅视觉统一）

| 内容 | 策略 |
|---|---|
| 最终助手回复 | 永远展开，全宽渲染 |
| 思考过程 | 折叠一行（shimmer 摘要），点开 12px mono 正文，max-h-96 |
| 工具调用 | 折叠进「执行过程」工作组（计数 + 用时摘要），展开后逐卡 |
| 过程叙述文本 | 折叠进工作组，摘要如实计数 |
| 超长用户 prompt | 气泡内钳 6 行，「展开全文」按消息记忆 |
| 表格/代码块 | 不折叠；代码块横向滚动 |

## 涉及文件

- `prototype/src/styles.css` —— `--text-thread` token（跟随外观字号缩放）
- `prototype/src/ui/MarkdownContent.tsx` —— 组件映射全套重写
- `prototype/src/ui/Composer.tsx` —— 输入区正文对齐 `text-thread`（14/22，桌面端）
- `prototype/src/ui/chat/items/UserMessageBubble.tsx` —— 气泡 Codex 化
- `prototype/src/ui/chat/ChatViewport.tsx` —— 轮次节奏 + 工作组卡片
- `prototype/src/ui/chat/items/ReasoningShimmerBlock.tsx` —— 思考块对齐
- `prototype/src/ui/chat/items/ContextInjectionCard.tsx` —— 对齐过程层卡片语言
- `prototype/src/ui/chat/tools/{BashToolCard,GenericToolCard,FileDiffToolCard,SearchToolCard,DeliverablesSummaryCard}.tsx`
  —— 统一卡片语言，Bash 卡去硬编码深色，交付卡去阴影、圆角归 12px
  （teal tint 保留——交付物是强调色唯一合理的落点之一）
- Composer 的阴影保留（`shadow-subtle` + 聚焦 teal 光晕）：它是合法的浮层，
  例外于"对话流内无阴影"规则。

## 第二轮（2026-10-28）：表现形式对齐 + 两个修复

对照 codex-clone 截图与 CSS 真值逐项补齐 Codex 的"表现形式"：

| 项 | Codex 形式 | 落点 |
|---|---|---|
| 思考过程 | "Thought for Ns" **无卡片轻量披露行** | `ReasoningShimmerBlock` 去边框卡 → 一行灰字（✨ + 思考了 N 秒 + 字数），展开内容走左侧细线缩进 |
| 执行过程折叠 | 同上披露行语言 | `WorkGroupRow`（ChatViewport）去卡片，展开工具明细走左细线，工具卡本身仍是卡片 |
| 用户气泡宽 | 78% | 80% → 78% |
| 列顶 inset | 33px | 阅读列 `@min-[720px]:pt-[33px]` |
| 发送按钮 | 圆形 + 前景反色（dark 白底黑箭头） | `bg-ink text-canvas rounded-full`（Composer + 气泡编辑态） |
| Composer 圆角 | 25px（radius-composer） | 16 → 20px（带顶栏结构略收） |
| 列宽 | 768 默认 | useShell `chatColumnMode: standard(768)/wide(900)/custom`，设置页分段控件 |

**修复：问卷卡（QuestionnaireCard）主题不跟随**——根因是它用了 Tailwind `dark:`
变体 + 硬编码色（`dark:bg-[#18181c]` 等）。本项目的主题机制是 `data-theme` +
语义 token，`dark:` 跟随的是**操作系统**深浅偏好——OS 在深色时无论应用切到
什么主题这张卡都是暗的。全部替换为语义 token（含发送钮 `text-white` →
`text-on-accent`）。同类隐患一并清理：`StatusIndicators`（图例徽标）、
`UnitContextEditor`（amber 徽标）。**规则：chat UI 禁用 `dark:` 变体，颜色
一律走语义 token。**


## 第三轮（2026-10-28）：逻辑对齐——元信息的归属权

原则：**元信息跟着它的语义位置走，不跟着每条消息走**（Codex 逻辑）。
分区并行审计（两个子 agent 分区扫描 + 仲裁）后落地：

| 元信息 | 归属（Codex 逻辑） | 改动 |
|---|---|---|
| 时间戳 | 会话边界行独有；消息不显示 | 删用户气泡/助手回复/系统通知的时间戳；保留「会话开始」行 |
| 耗时 | 思考行（"思考了 N 秒"）与工具状态独有 | 删助手回复落定耗时、工具卡头部耗时；流式期间保留实时秒表 |
| 分叉/复制 | 落定回复的操作，**悬停才现** | `opacity-0 group-hover/msg:opacity-100` |
| 用户气泡操作 | 悬停才现，平时完全隐藏 | `opacity-0 group-hover/user:opacity-100`，时间戳删除 |
| 模型名/执行器 | 不上时间线（在 Composer 全局选） | 删 meta 行模型名、UsageFallbackRow 改中性文案 |
| 过程文本 | 纯文本，零元信息 | AssistantMessageBlock 增 `variant: final/process`；工作组内过程叙述不渲染 meta 行 |
| 工具卡复制 | 头部不放操作 | 删 Bash/Generic/FileDiff 头部复制按钮（展开区内容可选中复制） |
| 状态文案 | 终端卡 `exit 0`（Codex 形态）；通用卡保留「完成」 | BashToolCard |
| cwd | 上下文不是状态 | Bash 卡头部 cwd chip 移入展开区 |
| 轮次导轨 | Codex 无此元素；保留功能但降为幽灵态 | `opacity-25 hover:opacity-100` |
| 字数统计 | 思考行无此项 | 删 `(N 字)`，保留「思考了 N 秒」（即 Thought for Ns）+ 流式 shimmer 摘要 |
| 通知行 | 中性底，彩色装饰移除 | SystemNoticeRow 统一 `border-line bg-line-soft`，语义色只在图标 |

仲裁保留项：SessionStartRow 的 modelActual/modelHintDropped（会话头一次性上下文/回落告警，
非过程噪音）；FileDiff 头部 +N/−N（Codex diff 文件头同样有统计）。mono 核心 11px→12px
一并统一（Bash 命令/Generic 摘要/检索词/交付路径）；AttachmentsBar 非语义黑 → ink。


## 第四轮（2026-10-28）：用户反馈五项修复

1. **撤回后页面"卡死"**：根因不是撤回逻辑——撤回把超长 prompt 回填输入框，
   Composer 高度上限是 `viewport - 170`，PC 端输入框能长到全屏高把对话页挤没了。
   修复：PC 端上限钳 60% 视口（移动端保留原顶到导航栏的逻辑）。撤回本身走
   前端编排（cancel + 截时间线 + revision 意图），后端复用分叉通道，无需新代码。
2. **流式文本带分叉/复制**：上轮 variant 只覆盖工作组内条目；LiveTail 独立流式块
   （无工具包裹的 streaming 消息）仍走 final。修复：流式期间一律不渲染操作组
   （流式文本是过程，不是可操作对象），落定后才悬停浮现。
3. **模型名回归**：按用户要求恢复显示，与分叉/复制同组悬停浮现（流式中不出现）。
4. **执行过程耗时补全**：单条目组（仅一段思考）此前无耗时——reasoning.delta
   合并时记录 `lastDeltaAt`，单条目组用它算跨度，回放的思考块也能显示
   "思考了 N 秒"（每次回放从账本现算，历史自动受益）；亚秒显示"不足 1 秒"。
   已知局限：外部会话批量导入（native-sync）时间戳坍缩的组仍无耗时可算。
5. 双子 agent 审计的仲裁保留项不变。

- **过程文本操作行彻底归零（第四轮补丁）**：上轮 variant 只覆盖工作组内条目，
  漏了 `flushTurn` 未落定轮分支——轮次未以最终回复收口（以问卷/中断/异常结尾）时，
  中间正文被独立发射且不带 process 标记，悬停仍浮现模型/分叉/复制。
  修复在分组层：`RenderUnit` item 变体增 `itemIsProcess`，未落定轮的独立正文
  一律标记 process。实测：问卷型会话（全部轮次未落定）操作行 0；
  正常会话落定回复悬停操作保留。**最终判定规则：只有"以非流式助手回复收口的
  轮次的最后一条正文"才是 final，其余正文一律 process。**
