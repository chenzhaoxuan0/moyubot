# 22 · bot 级联网搜索（workbench-search 桥）

> 2026-10-24 引入。浏览器控制（docs/14）的第三个兄弟能力，但作用域从全局换成
> **per-bot**：每个 bot 独立选提供商、独立存密钥、独立看余量。本文记架构决策与口径。

## 一、需求与约束

- 用户要在**新建 bot（init 流）与 bot 设置**里管理这个 bot 的搜索能力；全局设置页
  看总览（含免费额度余量）。
- 搜索是 bot 的能力而非工作台的能力——没配搜索的 bot 不该看到搜索工具。
- 首批四家：Tavily（1,000 credits/月免费）、DeepSeek 搜索（免费期至 2026-11-01，
  后 $0.75/千次）、豆包搜索 Custom 版（每火山账号 500 次/月免费）、元宝搜索
  （腾讯云联网搜索 API，每账号 2,000 次/月免费）；后续低成本接更多家。
- 密钥遵守全项目铁律（README「密钥放在哪」）：daemon 侧文件、浏览器永不持有明文。

## 二、核心决策：与 bot 无关的全局条目 + 运行时按 cwd 收口

执行器原生 MCP 配置（ADR 0004 的唯一真相源）是**用户级全局**的——同一个
`~/.claude.json` 没法给不同工作目录的会话不同的条目。三条候选路线：

| 路线 | 否决/采纳理由 |
|---|---|
| 每个 bot 写一个条目（`workbench-search-<botId>`） | 全局配置里所有 bot 的条目对每个会话可见，互相污染 |
| 项目级配置（claude 的 `.mcp.json` 等） | 13 家执行器支持面参差，口径碎裂 |
| **一条 bot 无关条目 + 桥在运行时收口（采纳）** | 一条 `workbench-search` 条目对全部执行器统一扇出；按 bot 开关发生在工具可见性这一层 |

### 桥的形状（`backend/src/searchctl/bridge.ts` → `<homeDir>/mcp/search-bridge.mjs`）

- 零依赖 node 脚本（node ≥22 原生 fetch），被执行器按 MCP stdio 拉起；
  daemon 实际端口**烘焙进内容**，端口变更 = 内容 hash 变更 = 启动时自动重装
  （安装纪律对齐 ctrl/skills.ts：只写自己的文件、hash 不变不写）。
- 工具面只有 `web_search`。`tools/list` 时问一次 daemon（`search.sessionTools`，
  带 2.5s 超时）：这个工作区（进程 cwd，dsh 时带 `--root`）没配搜索 → 回**空工具
  清单**，对该 bot 完全不可见；daemon 不可达 → **fail-open** 照常列出（调用时把
  「连不上工作台」如实报给模型，比空清单的哑服务器诚实）。
- `tools/call` 转发 daemon `search.query`（带 cwd/root），token 从
  `<homeDir>/token` 自取——与 `aw` CLI 同权同级，不新增鉴权豁免面。

### daemon 侧定位（`service.ts` 的 `resolveBotByPath`）

cwd → 注册 bot 的**最深祖先匹配**（rootPath == cwd 或其祖先，嵌套注册取最内层）。
dsh 的 ACP 注入在 `session/new` 时带上 `--root`（`acpMcpServers(rootPath)`），
把身份钉死到会话工作目录；注入判定**有意宽松**（同步、不扫盘，只看密钥槽非空），
精确收口统一发生在桥的 tools/list——一个口径，不搞两套。

## 三、密钥与配置的存放

`<homeDir>/search-keys.json`，按 botId 分槽：`{ bots: { <botId>: { provider,
apiKey, updatedAt } } }`。

- **不进 bot.json**：工作区目录会被 git/push 带出去；密钥落那里在形态上就可能
  泄漏（渠道密钥「只填变量名」的同一条教训，ChannelSection 头注释）。
- 支持字面量与 `env:NAME` 引用（secrets.ts 统一解析，改 `.env` 立即生效）。
- 浏览器侧只见掩码（`tvly-••••0111`，头 4 尾 4）；明文只在 daemon 进程内出现。
- `search.configure` 的密钥语义：apiKey **缺省 = 不动**、**空串 = 清除**、非空 =
  替换；**换提供商且未显式给 key → 自动清旧 key**（key 是按家发的，留着必错）。

## 四、条目对账

- 任一**存活** bot 配置了搜索 → `workbench-search`（`node <homeDir>/mcp/search-bridge.mjs`）
  扇出进全部 MCP_EXECUTORS（复用 mcpadmin 的 cmd /c 包装与停用库）；一个都没有 →
  条目移入停用库。configure 后与 daemon boot 时对账。
- bot 被注销后其密钥槽成为孤儿——**不**驱动扇出（对账只数存活 bot），槽留着无害。

## 五、提供商注册表（`providers.ts`）

一家一个 def：`{ id, label, keyHint, docsUrl, freeTierNote, quotaSupported,
search(), quota() }`。加新家 = 加一个 def（core/search.ts 的 `SearchProviderId`
同步扩）。各家报文归一成 `formatRows` 的统一文本（标题/链接/摘要/日期/站点逐条列）。

2026-10-24 核实的接入要点（详见各 def 注释）：

| | endpoint | 认证 | 免费额度 | 余量 API |
|---|---|---|---|---|
| tavily | `POST api.tavily.com/search` | Bearer `tvly-…` | 1,000 credits/月（月 1 日重置） | `GET /usage` → `key.usage/limit` |
| deepseek | `POST api.deepseek.com/v1/tools/search` | Bearer `sk-…`（与 chat 同 key） | 免费至 2026-11-01（北京时间） | `GET /user/balance`（仅账户总余额） |
| doubao | `POST open.feedcoopapi.com/search_api/web_search`（PascalCase 字段） | Bearer 搜索控制台 key（**≠ 方舟 ARK key**） | 500 次/月/火山账号 | 无（控制台看；超额报 10406/10412） |
| yuanbao | `POST api.wsa.cloud.tencent.com/SearchPro`（PascalCase 字段） | Bearer 服务 API KEY `sk-…`（**≠ 云 API SecretId/SecretKey**） | 2,000 次/月/账号（活动期可提至 6,000）；超出极速版 14 元/千次 | 无（控制台监控页看） |

元宝搜索两个接入特记：响应的 `Pages` 是**JSON 字符串数组**（每个元素要二次
`JSON.parse`，官方文档口径，def 里已处理且单条坏串不毒化整页）；它家另有官方
remote MCP（`https://api.wsa.cloud.tencent.com/Mcp`，同 key 鉴权）——本项目仍走
统一桥（配额口径 / 密钥隔离 / 工具面一致），直连 MCP 属用户自由。

## 六、配额与用量口径

- **余量快照**（`search.quota`）：有余量 API 的家 60s 缓存（Tavily usage 接口有
  限速，失败快照也缓存 60s）；两种入参——`{botId}`（已存密钥）或
  `{provider, apiKey}`（**草稿预检**：保存前验 key 有效性）。
- **本机月计数**（kv `search_usage_v1`）：只统计经桥的调用，按 botId × 月分桶，
  只留当前月。豆包这类没有余量 API 的家，UI 如实显示「本机计数 + 控制台口径说明」，
  **绝不用本机计数冒充官方余量**。

## 七、UI 面

- **bot 设置 / 新建 bot**（AddBotDialog「搜索」分区，新建编辑同表单）：提供商下拉
  （含各家 key 提示/免费额度/文档链接）、密钥输入（`留空保持已存`，placeholder 显
  掩码）、余量卡（预检/刷新）。随「保存」生效——密钥在保存链路里由调用方
  （BotSettingsPane / NewBotPane）调 `search.configure` 落盘，**不进 bot.json、
  不进 WorkUnit 往返**。
- **全局设置 → bot 能力 → 搜索**（SearchSettingsSection）：各 bot 状态总览（提供商/
  掩码/余量/本机计数）、桥条目安装状态、扇出结果（复用 FanoutCard/ActionLogCard）、
  提供商目录。
- 已开的会话拿不到新工具（执行器在会话启动时读 MCP 配置与 tools/list）——UI 文案
  明示「新开会话生效」。

## 八、RPC 面（docs/07 §四）

`search.providers / overview / status / configure / quota / sessionTools / query`
七个方法，`aw methods` 自描述。桥只消费后两个。

## 九、测试

- `pnpm -C backend smoke:search`：服务层——假提供商打全编排（扇出/回收、密钥语义、
  env: 解析、cwd 收口、用量计数、dsh 注入形状），并**真跑桥子进程**（假 daemon 上的
  MCP 协议环 + daemon 不可达 fail-open）。
- `pnpm -C backend smoke:search-live`：自起**真实 daemon**（临时家 + 临时
  USERPROFILE/LOCALAPPDATA 隔离执行器配置），走 bot.put → configure → 真实
  `.claude.json`/codex TOML 落盘 → sessionTools → 回收全程。
  （脚内 freePort 必须 `srv.close()` 再放行端口——占着端口 daemon 会 EADDRINUSE，
  health fetch 连上的是探测服务器本身，整场挂死；已踩过，注释勿删。）
