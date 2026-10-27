# 统一 Web 化改造计划

> 目标：借鉴 pi-web 的架构原则，把 workbench 从「终端画布为主」升级为
> 「结构化聊天 + 全量会话历史 + 移动端可用」的多 CLI 统一 Web 工作台。
> 依据：pi-web 源码走查、13 家 CLI SDK 支持矩阵（源码实证 + npm/PyPI 确认，
> 2026-10-14）、mcode/zcode 专项查证。结论散见本轮调研记录，本文是收敛后的执行计划。

---

## 一、背景与三原则

pi-web（pi 的官方浏览器 UI）没有包装 TUI，它做对的三件事：

1. **契约是引擎级结构化接口**（SDK / stream-json / ACP / app-server），
   永不搬运终端画面；
2. **会话事实源在磁盘上**（CLI 自己的 session 文件），Web 是另一个
   读者/续写者——只读浏览零成本、覆盖所有入口（TUI/后台/渠道）产生的会话；
3. **前端消费归一化事件流做结构化渲染**，而不是 ANSI 字符流。

对照现状：原则 1 的后端已具备（RuntimeAdapter SPI + RuntimeEvent 归一化
+ trace 落盘 + seq 断线补拉）；原则 3 的前端被 `d09a34d` 砍掉（砍因正是
违反原则 2：内存事件流刷新即空、TUI 会话不进）；原则 2 完全缺失。

**本计划的主线就是补原则 2，重建原则 3 的前端，并用各家的官方 SDK/协议
把原则 1 的接入面升级换代。**

---

## 二、总体评估

### 已就绪（不重做）

| 资产 | 状态 |
|---|---|
| RuntimeAdapter SPI + RuntimeEvent union（前端 core/ + 后端镜像 types） | ✅ 现成 |
| daemon 事件广播 + seq 游标补拉 + `traces/<date>.jsonl` 账本 | ✅ 现成 |
| 13 家执行器适配器（ACP ×5、headless JSONL ×7、zcode fork app-server） | ✅ 现成 |
| 权限闸（规则表 + always 落规则）、`cli_ref` 续命链路 | ✅ 现成 |
| 浏览器可访问（vite 0.0.0.0 + daemon token 鉴权 + xterm over WS） | ✅ 现成 |
| 被删的聊天渲染层（Timeline/Composer/PermissionDialog 等） | 📦 git 历史可捞（`d09a34d^`） |

### 缺失（本计划要做的）

| 缺口 | 对应阶段 |
|---|---|
| 各 CLI 原生会话的统一读取层（SessionReader / 协议取历史） | Phase 1 |
| 结构化聊天前端（重建 + 挂到持久事实源） | Phase 2 |
| 移动端适配 / PWA / 远程访问鉴权 | Phase 3 |
| 接入面升级：各家官方 SDK / 常驻协议（事件更富、审批更真、历史走协议） | Phase 4（可并行） |

### 工作量估算（单人全职，粗粒度）

| 阶段 | 估算 | 说明 |
|---|---|---|
| Phase 1 事实源层 | 2–4 周 | 9 个文件型 reader + 3 个协议型 reader + RPC/下钻 |
| Phase 2 聊天前端 | 3–5 周 | 恢复+重构+双源接线+能力矩阵 |
| Phase 3 移动端/远程 | 1–2 周 | 主要是前端体力活 + 鉴权 |
| Phase 4 SDK 升级 | T1 2–3 周、T2 2–3 周、T3 3–4 周、zcode 客户端抽取 1 周 | 与 1–3 并行、按 tier 独立交付 |
| **合计** | **约 3–4 个月**（Phase 4 并行则主线 6–11 周） | |

---

## 三、Phase 1：会话事实源层（历史统一读取）

**这是整个计划的灵魂。** 没有它，重建的聊天视图会重蹈「刷新即空、形同虚设」。

### 1.1 设计

```
backend/src/history/
  reader.ts          SessionReader SPI：list(root) / read(id) → 统一消息模型
  readers/           每家一个：只读、无副作用、可独立测试
  registry.ts        executorId → reader(s)，与 AdapterRegistry 同构
```

- 统一输出**复用 RuntimeEvent / 现有 messages 模型**，不发明第三套；
- **只读浏览零进程成本**（pi-web 模式）：不启动引擎、不 spawn CLI；
- 与 daemon 自存 messages 的关系：原生文件是事实源，自存的是索引/兜底，
  两者按 `cli_ref` 对齐，冲突以原生文件为准；
- 并发写口径：检测「磁盘比内存新」（mtime/末条 entry id）时标记会话
  为 external-changed，禁止直接续写（pi-web 的 `evictIfDiskAhead` 同款思路）。

### 1.2 各家来源与优先级

**文件型（先做，格式已在调研中查证）：**

| CLI | 来源 | 格式要点 |
|---|---|---|
| pi | `~/.pi/agent/sessions/<cwd>/*.jsonl` | session/parentId entry 树，最简单，先行样板 |
| claude | `~/.claude/projects/<munged-cwd>/*.jsonl` | 行式 transcript，无兼容承诺，宽容解析 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | RolloutLine{item}，官方 `rollout` crate 有公开解析 API 可对照 |
| grok | `~/.grok/sessions/<cwd>/<id>/{summary.json,updates.jsonl}` | updates.jsonl 即权威 ACP 日志 |
| mcode | `~/.minimax/v2/sessions/*/{manifest.json,messages.jsonl}` | 明文，无 schema 承诺 |
| kimi | `~/.kimi-code/sessions/**/wire.jsonl` | 官方 transcript 包有读取器可对照 |
| dsh | `$DSH_HOME/sessions/**/session.v3.jsonl` | 默认 zstd 压缩帧，需解码或配 `compression:none` |
| hermes | `~/.hermes/state.db` | SQLite+FTS5，表语义公开文档化 |
| agy | SDK `save_dir` + conversation_id | 本地模式产物，待实测目录确认 |

**协议型（Phase 4 对应 tier 完成后接入，历史走协议优于读文件）：**

| CLI | 通道 | 前置 |
|---|---|---|
| opencode | 按需 spawn `opencode serve` + `/session` REST；或读 `opencode.db` | 无（serve 可临时起） |
| openclaw | Gateway RPC `sessions.list` / `chat.history` | 需 Gateway 在跑（本来就要升） |
| zcode | fork app-server 的 `session/list|read|messages` | 已有子进程 |

**待调研：** cursor（本地 cursor-agent 的会话存储未查证，SDK 侧走云端
工作区，两者关系待确认）——低优先级，先显示 daemon 自存记录即可。

### 1.3 交付物与验收

- RPC：`session.history.list`（跨 bot 统一时间轴，含 TUI 产生的会话）、
  `session.history.detail`（富下钻：消息/工具卡片/diff/usage）；
- HistoryDialog 升级为富渲染下钻（替换现在的纯文本 messages）；
- 跨 bot 搜索索引覆盖原生会话内容。
- **验收：** 在 TUI 里聊的会话，Web 历史列表可见、可下钻看到工具调用；
  刷新不丢；daemon 重启不丢。

---

## 四、Phase 2：结构化聊天前端

### 4.1 做法与纪律

- 从 `d09a34d^` 捞回 Timeline/Composer/PermissionDialog 等作**起点**，
  不直接复活——重挂数据源；
- **双源模型**：历史视图读 Phase 1 事实源；live 会话走现有 WS RuntimeEvent
  流（seq 补拉已就绪）；两者用同一渲染组件；
- **能力矩阵驱动渐进增强**（`RuntimeCapabilities` 已表达）：fileDiff 只有
  部分家有、streaming=batch 的家（zcode 降级路径、openclaw）渲染轮末卡片、
  permissions 缺失的家隐藏审批 UI；
- **视图口径**：每个 bot 可配默认视图（结构化聊天 / 终端画布），执行器
  capabilities 太弱的默认终端；终端画布保留为一级公民，不砍；
- **反向请求原语**：把 `permission.requested` 泛化为通用
  `host.request`（对齐 pi-web 的 extension_ui_request 模式与 ACP 的
  request_permission、zcode 的 interaction/*）：挂起 Promise + WS 外置 +
  前端应答，未来各家新交互请求不再改 SPI。

### 4.2 交付物与验收

- 聊天视图：发起/续聊（resume 走现有 cli_ref）、流式文本、思考折叠、
  工具卡片、diff 视图（有能力的家）、usage 展示、审批对话、steer/cancel；
- Composer 恢复（RuntimePicker/LoopParamsPicker 等按需捞回）。
- **验收：** 在 Web 发起新会话全程不碰终端；审批在 Web 完成；
  能力弱的家自动降级显示而不是报错。

---

## 五、Phase 3：移动端与远程访问

借鉴 pi-web 的成熟经验（其 `docs/agents/client-platform.md` + 鉴权设计）：

- **响应式**：侧栏/命令面板/聊天的触控适配，软键盘视口高度（`100dvh` 类）；
- **PWA**：manifest + service worker（离线壳）；终端画布加移动端额外按键行
  （Esc/Tab/Ctrl，pi-web 的 TerminalExtraKeys 同款）；
- **远程访问**：daemon 增加密码鉴权（`PI_WEB_PASSWORD` 同款：启动时随机/
  配置密码 + 失败节流），文档明确「明文 HTTP 只限可信 LAN，公网走反代 TLS」；
  daemon 会话空闲回收（pi-web 的 idle reaper 思路，防远程挂后台占资源）。

**验收：** 手机浏览器（含 iOS Safari 16.x）完成一轮「看历史→发消息→审批」；
带密码的远程会话节流生效。

---

## 六、Phase 4：接入面升级（并行轨道，按 tier 独立交付）

### 4A · Tier 1：常驻协议进程（收益最大，官方嵌入先例）

| CLI | 从 → 到 | 新增能力 |
|---|---|---|
| codex | `exec --json` 一次性 → **`codex app-server` 常驻 JSON-RPC** | 常驻多线程、双向审批（命令/文件变更/工具）、turn 级聚合 diff、`thread/list/read/search` 历史走协议、steer |
| opencode | `acp` → **`opencode serve` + `@opencode-ai/sdk`** | 162-path OpenAPI、SSE、diff、审批/question 全 API |
| openclaw | `agent exec --json` 轮末信封 → **Gateway 子进程 + `@openclaw/gateway-client`** | 官方 embedding 指南、流式、审批、会话历史 RPC |

### 4B · Tier 2：官方 SDK 包装

| CLI | 从 → 到 | 注意 |
|---|---|---|
| claude | 手拼 `-p --output-format stream-json` → **`@anthropic-ai/claude-agent-sdk`** | canUseTool 审批回调、resume、结构化输出官方化；仍是子进程但生命周期由 SDK 管 |
| cursor | `cursor-agent -p stream-json` → **`@cursor/sdk`** | ⚠ SDK 用 CURSOR_API_KEY，云/本地工作区语义与本地 CLI 有差异，升级前先做语义对齐 POC |
| grok | `-p streaming-messages-json` → **`grok agent stdio`（ACP）** | ACP 事件流 + `x.ai/*` 扩展（git diff/worktree/terminal） |

### 4C · Tier 3：特殊路径

| CLI | 路径 | 说明 |
|---|---|---|
| pi | **进程内 SDK**（`@earendil-works/pi-coding-agent`，pi-web 同款） | pi 是 TS 库可直接 import；白得 fork/branch、扩展、models.json 全套 |
| kimi | 先 **`kimi web`** HTTP+WS（live OpenAPI，experimental）；`@moonshot-ai/kimi-code-sdk` 上 npm 后转进程内 | SDK 目前 npm 404、要求 Node≥24；ACP 路径保留为兜底 |
| agy | **`google-antigravity`**（PyPI）：Python sidecar 子进程，或按其公开 proto 自写 WS 客户端 | wheel 自带引擎二进制（localharness），不需要 agy CLI；hooks/policies 审批、resume、自定义工具 |

### 4D · 维持现状

- **mcode**：`mcode acp`（已查证：与 pi 只共享进程内零件，CLI/事件/会话
  格式全部自有契约，pi 兼容不可行，ACP 即官方 SDK）；
- **dsh**：`dsh acp`（官方 TS/Python SDK 的协议无审批，是文档明说的死能力，
  ACP 更优）；
- **zcode**：维持 fork 子进程；**叠加协议客户端抽取**——从
  `packages/services/src/zcode-agent/{zcodeProtocolClient,zcodeStdioTransport,zcodeStorageStartupGate}.ts`
  + `@zcode/shared` 协议子集（依赖仅 zod）抽独立 TS 库 ≈1k 行 + schema，
  替换现有 854 行手写宽松类型适配器；协议 v3→v4 漂移从运行时故障变编译期
  错误。fork 补丁（16 行，2 文件）整理成可重放 patch 文件，盯 origin/main
  出现 standalone 等价物即退回官方版。

**不做（明确出界）：** zcode 引擎进程内嵌入（闭包约 22 万行 + 原生依赖，
零收益）；用 pi 跑 MiniMax 模型（是另一件事，不是驱动 mcode）；
多用户/SaaS 化。

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 原生会话格式无兼容承诺（claude/mcode/kimi） | reader 宽容解析 + 未知行跳过 + 每家金样本测试；坏格式只降级该会话不崩列表 |
| TUI 与 headless 指向同一会话的并发写 | Phase 1 的 external-changed 检测；续写前校验末条 entry id |
| zcode 协议 v3→v4 迁移 | 抽 schema 客户端库后为编译期问题；patch 文件 + 升级检测 |
| kimi SDK 跳票 / cursor 云语义不符预期 | 两者都有 ACP/-p 兜底路径，升级项独立可回退 |
| openclaw SQLite schema 演进快（已到 v24） | 历史一律走 Gateway RPC，不直读库 |
| 远程暴露安全 | 默认仅回环；密码 + 节流；文档钉死「公网必须 TLS 反代」 |
| 重建的聊天视图再度「形同虚设」 | 验收口径以 Phase 1 事实源为准：TUI 会话必须可见，刷新/重启不丢 |

---

## 八、里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| **M1 历史全量可见** | Phase 1：跨 bot 历史含 TUI 会话 + 富下钻 | 无 |
| **M2 Web 聊天闭环** | Phase 2：新会话全程 Web 操作 + 审批 + 双源渲染 | M1（历史部分可后补） |
| **M3 手机可用** | Phase 3：PWA + 响应式 + 远程鉴权 | M2 |
| **M4a 协议升级** | Tier 1 三家常驻协议 | 独立，随时可做 |
| **M4b SDK 升级** | Tier 2/3 + zcode 客户端抽取 | 独立，按家交付 |

主线关键路径：**M1 → M2 → M3**（6–11 周）；Phase 4 全程可并行插入。

---

## 九、已拍板的决策（2026-10-14）

1. **默认视图口径**：✅ **新会话默认结构化聊天**——作为区别于终端形式的
   另一种新形态；终端画布保留为可切换的并行形态（按 bot 可覆盖默认）。
2. **远程访问**：✅ **后置到下期**。Phase 3 的响应式/PWA 只随聊天视图做
   最小顺手适配，不作为独立工作包；远程鉴权（3b）下期再做。
3. **Phase 4 范围**：✅ **全做**（T1/T2/T3 + zcode 客户端抽取，按 tier 独立交付）。
4. **opencode 历史读取**：✅ 按需 spawn `opencode serve` 走 `/session` REST。

**执行顺序（决策后收敛）**：主线 = 结构化聊天垂直切片（Phase 2 骨干先行，
live 会话接现有 RuntimeEvent 流）→ Phase 1 历史层（让聊天视图的历史区
「刷新不空、TUI 会话可见」）→ 各 tier SDK 升级并行插入。Phase 3 整体后置。

---

## 十、落地记录（2026-10-14 实施完成）

一期范围（Phase 1/2/4 全量 + 决策 1/3/4）全部落地，11 个提交，全量
typecheck 与 daemon 冒烟通过。

| 计划项 | 提交 | 实测 |
|---|---|---|
| Phase 2 结构化聊天（默认形态） | 8585086 | typecheck + vite 全模块转换通过；组件与状态机自 `d09a34d^`/`39e4e81^` 恢复并重接 |
| Phase 1 会话事实源层（9 家 reader + RPC + 原生会话页签） | dfccc56 | 本机 8 家真实数据列表+下钻全通过；WS RPC 实测 |
| T1 codex app-server | 6c0450e | E2E 全事件链（delta→completed→ref→usage→idle） |
| T2 claude Agent SDK | 595743a | E2E 链路通；本机 ~/.claude 默认模型过期如实上报（环境问题） |
| T1 opencode serve | a9c4db4 | E2E 全事件链（reasoning.delta→delta→completed→usage） |
| T2 grok ACP | 37d8682 | E2E 全事件链 |
| T1 openclaw Gateway | 892fa7b | E2E 全事件链；顺带修历史双发 bug |
| T3 pi 进程内 SDK | 1ff2815 | E2E 全事件链，未触发回落 |
| T3 kimi web 双传输 | 60c1ad6 | 传输机制全通；本轮无回复系本机 kimi 登录态过期（kimi login 恢复） |
| 4D zcode 类型面抽取（b1） | d1090c6 | 编译通过；app-server 降级系 ZCode 桌面端占用 Built-in Release（环境冲突，桌面退出恢复） |
| T3 antigravity sidecar + T2 cursor 标注 | 399eae6 | 探针门控（本机未装两 SDK；agy sidecar 装即用，cursor 待 POC 环境） |

**未做/后置（与计划一致）**：Phase 3 远程访问（决策 2 后置）；opencode 历史走
按需 serve（决策 4）——serve 传输已就位，历史 reader 接入是下一步小项；
反向请求原语泛化（Phase 2 扩展项）——现有 permission.requested 已覆盖各家
审批流，泛化留待第二个真实用例。

---

## 十一、补充：外部会话自动收录（2026-10-27）

「会话事实源在磁盘上，Web 是另一个读者」补上发现层：此前外部终端跑的 CLI
会话只有**手动导入**一条路（history.import.\* 查询面），新会话不会自己出现。
现在 daemon 周期扫描（30s 一轮，`backend/src/history/autocollect.ts`）各 bot
目录匹配的原生存储，把未认识的外部会话自动落为导入行（imp_ 前缀，与手动导入
共用 `materializeImportedSession` 与 known 去重口径），广播 `session.started`
（source="imported"）让侧栏即时刷新。

保守规则（自动收录比手动导入更严格，误收会凭空污染侧栏）：cwd 不明不收、
read() 无正文的执行器不收（antigravity/cursor）、空会话不收（stat messages.jsonl
size=0，挡 mcode 模型探测残留）；差集前先回填该单元 terminal_runs 的 resumeRef
（与 unit.history 同款回溯），工作台自己派发的 TUI 会话不会被重复收录。
开关在 bot 设置「导入会话」分区（bot.json `autoCollect`，缺省 = 开）；
`history.import.apply` 落库即 `watchSession`（手动导入 = 显式关注，立即开始
实时同步）。自动收录**不**自动 watch——25 个的 watch 上限是给「正在看 /
刚导入」的会话的，打开（session.resume / events.since）才同步的语义不变。

**实测收口（2026-10-27 当天，三处修正）**：
1. **loop-stall**——首版每轮裸跑 14 家 reader 的同步 fs + mcode read() 兜底的
   3 个月×7 天目录扫，daemon 主循环实测停顿 5.7s×2，前端点会话要等很久甚至
   「打不开」。改为：候选列表走 cachedNativeList 的 30s TTL 通道（与
   unit.history 共享一次扫描）、负探测按 (sessionId, updatedAt) 记忆、收录间
   setImmediate 让行——同负载零停顿，unit.history 稳定 18ms。
2. **运行期导入行不可见**——host.listSessions 只返回内存表，loadPersisted 只在
   启动时回灌：daemon 存活期内落库的导入行（自动收录/手动导入）不在
   session.list 里，前端 historyOnly 回落「打不开这个会话」、events.since 按
   unknown_session 抛错。host 新增 adoptPersisted（单行收编，与 loadPersisted
   共用 adoptRow），收录/导入落库即收编。
3. **影子行**——工作台自己开的会话，cliRef 要等首个 turn 事件才落账，窗口期内
   收录会产生「同一段对话两行」。三层收口：45s 年龄门槛（太年轻不收）+ 每轮
   清扫（真会话/终端运行认领了同一原生会话的 imp_ 行删除并广播，只清 status=done
   的、reattach 过的不动）+ unit.history 展示层过滤兜底。

已知深度限制（沿 reader 既有口径，非本次回归）：mcode 列表取全局最近 50 条，
安静目录里的很久以前的会话进不了候选——这类会话手动导入同样列不出，
属 reader 分页深度问题，留待后续按目录查询优化。

