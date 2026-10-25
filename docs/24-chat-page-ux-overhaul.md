# 24 · 对话页面消息显示与交互全量重构（对齐 ZCode / DeepSeek Harness / Hermes）

> 2026-10-25 引入。基于对 ZCode（v4 架构）、DeepSeek Harness（ui-chat 规范）与
> Hermes Agent 的源码级深度比对，全面重构 MoyuBot 的主聊天会话视口。

## 一、背景与问题诊断

当前工作台主聊天视图集中在单一文件 [`prototype/src/ui/Timeline.tsx`](../prototype/src/ui/Timeline.tsx)（1408 行），在承载重度编码与长会话时暴露四大体验瓶颈：

1. **无虚拟滚动，长会话性能崩塌**：全量 DOM 挂载，当 Agent 执行 50+ 次工具调用或对话超过 30 轮时，DOM 节点数破千，滚动掉帧，打字响应迟钝。
2. **工具调用（Tool Call）裸露丑陋**：仅用通用折叠条包裹 `JSON.stringify(input)` 与原始文本输出，缺乏命令行终端模拟、内联文件 Diff、结构化搜索结果等语义化渲染。
3. **思考过程（Reasoning）呈黑盒等待**：仅显示 `(N 字)` 与静态斜体文本，长思考期间用户无法感知模型正在分析哪个切面，产生严重的黑盒等待焦虑。
4. **长文本导览与微交互缺失**：流式生成中滚动容易被粗暴吸底打断；缺乏类似 ZCode 的划选悬浮操作条（一键引用/追问）、轮次导航大纲与对话内检索（Ctrl+F）。

## 二、目标体验与对齐矩阵

| 体验维度 | 参照物 | 目标实现 |
|---|---|---|
| **长文本流畅度** | ZCode `ConversationTimeline` | 基于 `@tanstack/react-virtual` 的虚拟滚动 + `LiveTail` 架构（流式尾段独立挂载，零抖动） |
| **滚动意图与吸底** | ZCode `timelineScrollAnchor` | 意图追踪（Wheel/Touch/Key 独立 TTL）+ 悬浮“回到底部”FAB（含生成未读脉冲） |
| **命令执行呈现** | ZCode `BashCall` / Hermes TUI | 仿终端深色卡片、带工作目录（cwd）、一键复制、退出码徽标、实时耗时 |
| **文件编辑呈现** | ZCode `ToolCallBlocks` | 语法高亮内联 Diff（红删绿增）、代码行号、外链编辑器（VS Code / Explorer） |
| **联网搜索呈现** | ZCode `WebSearch` | 结构化搜索卡片（Favicon、域名、标题、摘要超链） |
| **思考过程呈现** | DeepSeek `ReasoningRow` | 流式抽取当前思考段落首句，呈现 CSS Shimmer 微光流动动画；结算后紧凑收缩带耗时 |
| **划选悬浮工具栏** | ZCode `SelectionTooltip` | 选中文本自动浮出气泡菜单：一键引用到输入框（Blockquote）、针对此段追问、复制代码 |
| **轮次导览与检索** | ZCode `TurnNavigator` / `Find` | 右轨轮次迷你大纲（Q1/Q2/Q3 悬停预览瞬移）+ Ctrl+F 对话内高亮查找定位 |
| **上下文透明感知** | DeepSeek `ContextInjection` | 紧凑上下文注入徽章（对齐 ADR 0014：显式查看 SOUL/USER/MEMORY 注入字符） |

## 三、架构分解与模块目录设计

重构后的代码组织收拢至 `prototype/src/ui/chat/`：

```
prototype/src/ui/chat/
├── ChatViewport.tsx                  # 对话主视口（虚拟滚动 + LiveTail 双段布局）
├── scroll/
│   ├── useChatScroll.ts              # 滚动意图模型与自动贴底控制器
│   └── BackToBottomFab.tsx           # 悬浮回到底部按钮（带未读脉冲）
├── items/
│   ├── UserMessageBubble.tsx         # 用户消息（气泡、附件、定时徽标、就地编辑）
│   ├── AssistantMessageBlock.tsx     # 助手消息（Markdown 渲染、底部 Meta、分叉）
│   ├── ReasoningShimmerBlock.tsx     # 思考流动微光摘要组件（DeepSeek 模式）
│   ├── SegmentDividerRow.tsx         # 执行器切换点与会话段边界
│   ├── SystemNoticeCard.tsx          # 系统与终态通知卡片
│   └── ContextInjectionCard.tsx      # 上下文注入透明检查卡
├── tools/
│   ├── ToolCardHost.tsx              # 工具卡片路由分发器
│   ├── BashToolCard.tsx              # 仿终端命令行执行卡
│   ├── FileDiffToolCard.tsx          # 紧凑内联语法 Diff 卡
│   ├── SearchToolCard.tsx            # 结构化联网搜索结果卡
│   ├── GenericToolCard.tsx           # 格式化 JSON/键值通用卡
│   └── DeliverablesSummaryCard.tsx   # 轮次交付物聚合卡
├── interaction/
│   ├── SelectionTooltip.tsx          # 划选文本浮动操作栏（引用/追问）
│   ├── TurnNavigator.tsx             # 右轨轮次大纲导航器
│   └── InChatFindBar.tsx             # 对话内 Ctrl+F 高亮检索条
└── types.ts                          # 统一事件与聚合项类型定义
```

## 四、核心技术设计

### 1. `LiveTail` 双段渲染：虚拟滚动与流式高频更新解耦

虚拟滚动组件（如 `@tanstack/react-virtual`）在项目尺寸频繁突变时会进行昂贵的动态度量（`measureElement`）。如果将每秒 30+ Token 的流式输出放入虚拟列表中，会引发剧烈的掉帧与滚动条抖动。
- **解法**：
  - 历史已结算轮次（Settled Turns）进入 `virtualizer`；
  - 正在生成的当前轮次（Active/Running Turn）作为 `LiveTail` 单独渲染在虚拟列表下方。
  - 当前轮生成完毕（Settled）后，原子性合并入历史虚拟列表，兼顾超长列表性能与流式渲染丝滑度。

### 2. 思考微光（Reasoning Shimmer）算法

在流式接收 `<think>` 片段时：
```ts
function extractStreamingThoughtSummary(text: string): string {
  // 匹配最近一个换行后非空的第一句，剥离 Markdown 强调符 **
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const latest = lines[lines.length - 1] ?? "";
  return latest.replace(/\*\*/g, "").slice(0, 80);
}
```
折叠态标题旁以 Tailwind 自定义 `animate-shimmer` 显示流动光效文本，长思考瞬间转变为清晰可见的 Agent 思维脉动。

### 3. 划选文本悬浮菜单（Selection Tooltip）

监听视口内的 `selectionchange` 与 `mouseup` 事件：
- 计算 `window.getSelection()` 的 `getBoundingClientRect()`，绝对定位浮标。
- 提供“引用”：调用 `useWorkbench.getState().setComposerDraft(prev => \`> \${selected}\\n\\n\${prev}\`)` 并聚焦输入框。
- 点击非选区或开始打字自动隐去。

## 五、验证标准

1. `pnpm -C prototype typecheck` 全项目零类型错误。
2. 50+ 轮长会话、包含大量长命令输出与 Diff 的极端场景下，滚动 60fps 不卡顿。
3. 流式生成中，用户向上翻看历史不会被强行拽回底部；生成新内容时回到底部 FAB 呼吸灯点亮。
4. 所有既有功能（分叉、编辑重发、定时消息徽标、系统通知、权限审批）100% 行为保持不变。
