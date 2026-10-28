# 28 · 对话页排版体系升级（Codex 真值对齐）

> 2026-10 · chat UI 的字号/行距/间距/气泡/MD 元素样式全面换血。
> 数值真值来源：Codex 桌面版（OpenAI.Codex 26.1013）的包拆解产物
> `codexskin/codex-clone`（tokens.css + ANALYSIS.md，从 app.asar 的
> app-shared-*.css 与 codex-ui-kit@0.1.2 交叉验证）。

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
| 正文栏宽 | 768px | **不采用**——沿用本项目 `chatColumnWidth`（默认 900px，用户可调） |

宽度特意保留本项目自己的：Codex 的 768px 是它的产品选择，本工作台是
多栏重型工具，阅读列更宽是既定设定（外观设置里用户可调）。

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
