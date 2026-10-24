# 线上协议 v1 —— 前端 ↔ daemon 的帧契约

> `prototype/src/core/events.ts` 定义的是**数据形态**（daemon 往外推什么）；
> 本文定义的是**传输语义**（帧怎么封包、方法怎么调用、错误怎么表达）。
> Phase 0 已实现并冻结，实现在 `backend/src/wsd.ts`，验收在 `backend/scripts/smoke-health.ts`。
>
> 与 `adapter.ts` / `events.ts` 同一纪律：改这份协议 = 两个会话先对齐。

---

## 一、通道划分

| 通道 | 载体 | 用途 |
|---|---|---|
| 事件流 | WebSocket `ws://<host>:<port>/ws` | daemon → 前端推 `RuntimeEvent`；前端 → daemon 调方法 |
| 管理面 | HTTP REST | `/healthz` 及后续配置类端点（无会话数据，重连由 WS 通道负责） |

默认 `127.0.0.1:5281`（前端 dev server 是 5280），环境变量见 `backend/README.md`。
**daemon 只绑回环**——它能 spawn 任意进程，不对外网开门。

## 二、信封（envelope）

所有 WS 帧都是单条 JSON 文本，`v` 固定为 `1`。

**前端 → daemon（请求）**

```json
{ "v": 1, "id": "c-17", "method": "health", "params": null }
```

- `id`：前端生成的任意字符串（建议单调），daemon 原样回填；并发调用靠它配对。
- `params`：可缺省；各方法的 schema 随方法定义，本文不集中枚举。

**daemon → 前端（响应，必与请求配对）**

```json
{ "v": 1, "id": "c-17", "ok": true,  "result": { "…": "…" } }
{ "v": 1, "id": "c-17", "ok": false, "error": { "code": "unknown_method", "message": "no such method: xyz" } }
```

**daemon → 前端（推送，无 id）**

```json
{ "v": 1, "type": "hello", "daemon": { "version": "0.1.0", "pid": 1234, "uptimeMs": 42 } }
{ "v": 1, "type": "event", "seq": 7, "event": { "type": "message.delta", "…": "…RuntimeEvent…" } }
{ "v": 1, "type": "terminal", "terminalId": "term_…", "kind": "data", "data": "…" }
```

- 客户端 TCP 连上即收到 `hello`，之后 `event` 帧里的 `event` 就是 `events.ts` 的 union 原样序列化。
- `event.seq`（WP-2 起）：会话内单调递增的事件序号，与落盘轨迹的 TraceRecord.seq 同源。
  客户端记录每会话已见最大 seq；**重连成功后**凭 `session.events.since` 补拉断线窗口，
  按 `(sessionId, seq)` 判重——这是"断线不丢事件"的协议面。
- **会话生命周期（agent loop 语义）**：`session.started` 之后，每一轮 turn 完成发
  `message.completed` + `usage` + `session.status`（idle/failed/running）——**会话保持开启**，
  同会话 `session.send` 续聊即 agent loop（上下文连续）。`session.ended` 只在真关闭时发：
  `session.closed` / 执行器退出。turn 失败可重试（同一会话再 send 即可）。
  这套语义与 T3 的编排一致（thread 长存、turn 完成是独立里程碑、会话开始后锁定模型实例、
  参数面只暴露执行器自告的旋钮——无采样位、无轮次预算），T3 源码考证见
  `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` 与
  `docs/internals/overview.md`。
- `terminal` 帧是终端数据流（`kind: "data" | "exit"`，exit 带 `exitCode`）——高频且非契约事件，独立于 `event` 流，不落轨迹。
- **`notifications` 帧是 daemon 聚合的通知推流**（docs/21 P4b）：`{v:1, type:"notifications", row}`，行形状即 `notifications.list` 的条目（自然键去重、**无 read 字段**——已读是客户端呈现）。无订阅者即丢弃，历史以 `notifications.list` 拉取为准，daemon 侧落 `<homeDir>/notifications.json`。
- **`git.changed`（docs/16）是无 `sessionId` 的 RuntimeEvent**：daemon 侧文件监听发现某仓库
  （`git.status` 心跳到达过的）工作树 / .git 有变化，节流后（默认 60s 一条，前沿即发、尾沿合并）
  广播 `{type:"git.changed", rootPath}`。它是「该刷新了」的信号不是数据本身，前端拉 `git.status` /
  `git.changes` 收敛；不落盘、不参与 `(sessionId, seq)` 判重补拉（seq 由独立计数器填充）。
- **`session.foreground`（docs/23）是前台拉起信号，broadcast-only**：`launchMode=chat` 的
  自动化/待办到点派发成功后广播 `{type:"session.foreground", sessionId, unitId, runtimeId,
  cause:"automation"|"backlog", title?}`，前端据此把该会话打开到聊天时间线前台
  （`installSessionForeground`）。与 `git.changed` 同款口径：带 `sessionId` 但用独立计数器
  填 seq，**不是会话账本 seq**——适配器会话泵显式跳过它，否则会污染判重游标；
  漏发的代价只是不自动跳前台（会话仍在历史/任务栏可点开）。
- **解析不出 `id` 的帧**（非 JSON / envelope 不合法）回 `id: null` 的错误帧——这是唯一允许 `id` 为 null 的场景。

## 三、错误码

| code | 语义 |
|---|---|
| `bad_frame` | 非 JSON，或 envelope 不满足 `{ v:1, id:string, method:string }` |
| `unknown_method` | 方法未注册 |
| `internal` | handler 抛错且未带 `code`；带 `Error.code` 属性时原样透传 |

## 四、方法注册表

> 本表由 `pnpm -C backend gen:methods` 从 daemon 注册表生成（docs/21 D6）——注册表是唯一真相，
> 手工表已退役（含历史陈旧的 ops.* 行）。深度语义（错误码、结果形状、行为细节）见各域文档
> 与源码注释；`rpc.methods` 是机器可读版，`aw methods` 是 CLI 版。

<!-- methods:begin（pnpm -C backend gen:methods 生成，勿手改） -->

### 基础

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `health` | daemon 健康自检，result 同 GET /healthz | null | — |

### adapter

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `adapter.commands` | 列执行器在某目录下的原生命令面 | {runtimeId, rootPath} | — |
| `adapter.list` | 已注册执行器摘要（id/显示名/模型清单/能力位） | null | — |
| `adapter.modelcatalog.get` | 读执行器的模型目录清单 | {runtimeId} | — |
| `adapter.modelcatalog.set` | 写模型目录进 CLI 目录文件并刷模型清单 | {runtimeId, rows} | — |
| `adapter.modeldefaults.get` | 读执行器原生模型默认值配置 | {runtimeId} | — |
| `adapter.modeldefaults.set` | 写模型默认值进 CLI 配置文件并刷清单 | {runtimeId, values} | — |
| `adapter.models` | 刷新模型清单（只读列清单命令或本地目录，零用量）；省略 runtimeId = 全部 | {runtimeId?} | — |
| `adapter.probe` | 探测执行器安装/认证/版本现状（只探测，不碰模型清单） | {runtimeId} | — |
| `adapter.providers.get` | 读供应商级模型配置（pi、opencode） | {runtimeId} | — |
| `adapter.providers.set` | 写供应商配置并顺带刷新模型清单 | {runtimeId, rows} | — |

### appearance

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `appearance.read` | 读 appearance.json 及壁纸 dataURL | null | — |
| `appearance.wallpaper.delete` | 删 wallpapers 目录下的壁纸文件 | {path?} | — |
| `appearance.wallpaper.save` | 落一张 base64 壁纸到 wallpapers 目录 | {name, base64} | — |
| `appearance.write` | 整体写 appearance.json，hash 乐观锁 | {content, expectedHash?} | — |

### automation

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `automation.create` | 新建定时任务（5 字段 cron，创建时即校验；总量上限 20 条。prompt 须自包含、直接描述最终工作、无人值守不问问题、不得要求再建定时任务 —— ZCode CronCreate 口径；launchMode：terminal=TUI / chat=对话页前台 / headless=纯后台；dispatchTarget：new_session / existing_session） | {unitId, unitName?, runtimeId, rootPath, prompt, model?, mode?, cron} | — |
| `automation.delete` | 删除定时任务 | {id} | — |
| `automation.list` | 定时任务定义清单 | null | — |
| `automation.runNow` | 立即跑一次定时任务（runId + sessionId，终态回灌运行记录） | {id} | — |
| `automation.runs` | 指定定时任务的运行记录（一行一次，含 sessionId 与终态） | {id} | — |
| `automation.setEnabled` | 启停定时任务 | {id, enabled} | — |
| `automation.update` | 按 id 更新定时任务定义（cron/prompt/模型/调度规则/派发目标/执行方式等） | {id, ...定义字段} | — |

### backlog

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `backlog.config.get` | 读待办引擎配置 | null | — |
| `backlog.config.set` | 以补丁更新待办引擎配置并落盘 | {patch} | — |
| `backlog.consolidate.run` | 立即跑一次待办清单归并整理，默认强制 | {force?} | — |
| `backlog.create` | 新建待办项并落库（launchMode：terminal=TUI / chat=对话页前台 / headless=纯后台；prompt 无人值守口径同 automation.create） | {goal, unitId, rootPath, title?, prompt?, unitName?, runtimeId?, model?, mode?, size?, launchMode?} | — |
| `backlog.delete` | 按 id 删待办，执行中的不可删 | {id} | — |
| `backlog.heartbeat.force` | 手动触发一跳待办心跳，受理即返 | null | — |
| `backlog.list` | 拉待办全量视图：条目、提议、状态、配置、配额 | null | — |
| `backlog.proposal.confirm` | 确认当前待办执行提议，可改选执行器模型 | {runtimeId?, model?} | — |
| `backlog.proposal.reject` | 拒绝当前待办执行提议 | null | — |
| `backlog.quotas` | 查执行器配额余量，refresh 强制探测 | {refresh?} | — |
| `backlog.reorder` | 传全量 id 数组重排待办优先级 | {ids} | — |
| `backlog.review` | 验收待办，pass 关闭否则打回重排队 | {id, pass, note?} | — |
| `backlog.runNow` | 立即派发执行某条待办 | {id, runtimeId?, model?} | — |
| `backlog.sleep` | 让某条待办休眠暂停调度 | {id} | — |
| `backlog.state.forceBusy` | 设强制忙碌开关，暂停待办自动派发 | {on} | — |
| `backlog.update` | 按 id 编辑待办字段（执行中的禁改；launchMode 三选 terminal/chat/headless） | {id, title?, goal?, prompt?, unitId?, unitName?, rootPath?, runtimeId?, model?, mode?, size?, launchMode?} | — |
| `backlog.wake` | 唤醒休眠中的待办 | {id} | — |

### bot

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `bot.ask` | 向 bot 发一条文本并等轮落定拿回全文（webhook/MCP 共用内核） | {botId, text, waitMs?, memoryOptions?} | — |
| `bot.defaultRoot` | 查新建 bot 的默认安置目录与可浏览根（幂等建 bots 目录） | null | — |
| `bot.gitignore.ensure` | 确保 bot 目录 .gitignore 覆盖密钥文件 | {rootPath} | — |
| `bot.initWorkspace` | 初始化/补齐工作区（memory/daily 目录）并同步官方基础技能 ×2（agent-workbench + workbench-context，版本标记契约）；MD 正文不落骨架——未经编辑不落盘不注入 | {rootPath} | — |
| `bot.inspect` | 纯读探测目录现状（bot.json 有无、可导入项三分支） | {rootPath} | — |
| `bot.list` | 列全部已注册 bot | null | — |
| `bot.put` | 写 bot 定义落盘到 .agent-workbench/bot.json（含 contextManifest），三把乐观锁 | {unit, ifRevision?, ifAgentsMdHash?, ifSoulMdHash?, createRoot?} | ⚠️ high |
| `bot.roots.add` | 登记一个 bot 扫描根目录 | {dir} | — |
| `bot.unregister` | — | — | — |

### browserControl

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `browserControl.get` | 读浏览器控制当前状态 | null | — |
| `browserControl.setBrowser` | 选接管浏览器，msedge 或 chrome | {browser} | — |
| `browserControl.setEnabled` | 开关浏览器控制能力（扇出 playwright-mcp 进各执行器配置） | {enabled} | — |
| `browserControl.setMode` | 设浏览器模式，isolated 或 takeover | {mode} | — |
| `browserControl.sharedChrome.start` | 启动共享 Chrome 实例 | null | — |
| `browserControl.sharedChrome.stop` | 停止共享 Chrome 实例 | null | — |

### channel

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `channel.diagnose` | 诊断 bot 的飞书账号连通性 | {botId, accountId?} | — |
| `channel.identity` | 把飞书 profile 解析成机器人名称与头像 | {profiles?} | — |
| `channel.profile.add` | 新建飞书机器人 profile，密钥走 stdin 不落盘 | {name, appId, appSecret} | — |
| `channel.profiles` | 列本机已配的飞书机器人 profile | null | — |
| `channel.send` | 让 bot 主动向飞书会话发文本 | {botId, receiveId, text, accountId?} | — |
| `channel.status` | 读各渠道网关运行态与 bot 声明渠道对照 | null | — |
| `channel.weixin.qr.begin` | 发起微信 iLink 扫码登录 | null | — |
| `channel.weixin.qr.poll` | 轮询微信扫码状态，成功且带 botId 存凭据 | {qrCode, botId?} | — |

### computerControl

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `computerControl.actions` | 拉 afterSeq 之后的电脑控制动作审计流 | {afterSeq?} | — |
| `computerControl.get` | 读电脑控制当前状态 | null | — |
| `computerControl.panic` | 紧急停止电脑控制（急停按钮） | null | — |
| `computerControl.setEnabled` | 开关电脑控制能力（默认停用；开启即扇出 computer MCP 条目进执行器配置） | {enabled} | ⚠️ high |

### context

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `context.user.read` | 读全局 USER.md（关于用户的常置文件） | null | — |
| `context.user.write` | 写全局 USER.md | {content} | — |

### curator

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `curator.run` | 跑记忆策展归档，报告落 logs/curator 目录 | {rootPath?, dryRun?} | — |

### daemon

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `daemon.stop` | 优雅退出 daemon（ack 后退出码 0）。Windows 跨进程信号不可投递，程序化退出唯一通道 | null | ⚠️ high |

### driver

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `driver.catalog` | 列已知执行器驱动的安装注册状态与提示 | null | — |

### git

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `git.branch.checkout` | 切换分支（本地改动会被覆盖时报 dirty_worktree） | {rootPath, name} | — |
| `git.branch.create` | 新建分支并立即切换（checkout -b --no-track） | {rootPath, name, ref?} | — |
| `git.branches.list` | 分支列表（local/remote、短哈希、检出归属 checkedOutIn） | {rootPath} | — |
| `git.changes` | 三区改动清单（staged/unstaged/untracked，含增删行数） | {rootPath} | — |
| `git.commit` | 提交（默认 stagedOnly 只提交索引；否则先 add 指定 paths 再提交） | {rootPath, message, paths?, stagedOnly?} | — |
| `git.diff` | 单文件 patch（staged=索引 vs HEAD / unstaged=工作区 vs 索引；未跟踪合成新增 patch） | {rootPath, path, sourceId} | — |
| `git.graph` | 可见历史提交图（HEAD+branches+tags+remotes，不用 --all） | {rootPath, skip?, maxCount?} | — |
| `git.identity` | 提交身份（name/email），任一缺失返回 null | {rootPath} | — |
| `git.push` | 推送（remote 判定：显式 → upstream → 唯一远端；无 upstream 自动 -u） | {rootPath, remote?} | ⚠️ high |
| `git.stage` | 把路径暂存（add -A，覆盖已删除） | {rootPath, paths} | — |
| `git.status` | 仓库状态摘要（porcelain v2 解析；非仓库返回 isRepo:false 不报错；isRepo 即挂文件监听） | {rootPath} | — |
| `git.unstage` | 把路径移出暂存区 | {rootPath, paths} | — |
| `git.worktree.create` | 创建工作树（branch 与 commitish 至少其一；路径缺省走 VSCode 约定） | {rootPath, path?, branch?, commitish?} | — |
| `git.worktree.remove` | 删工作树（脏树报 worktree_dirty 可 force 重试；活跃会话占用拒删） | {rootPath, path, force?} | ⚠️ high |
| `git.worktree.reveal` | 在系统文件管理器中显示目录 | {path} | — |
| `git.worktrees.list` | 工作树清单（逐树脏探测，含 isMain） | {rootPath} | — |

### history

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `history.import.apply` | 把勾选的外部 CLI 会话导入 sessions 表 | {unitId, runtimeId, sessions, unitName?} | — |
| `history.import.list` | 列 bot 工作区外部会话并标注已知与否 | {unitId, runtimeId?, limit?} | — |
| `history.native.detail` | 读某原生会话的完整转录详情 | {executorId, sessionId} | — |
| `history.native.list` | 只读列各 CLI 自己会话存储的会话 | {unitId?, executorIds?, limit?} | — |
| `history.rename` | 覆盖历史行显示名，空 title 撤销改名 | {key, title} | — |

### image

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `image.generate` | 出图（编排唯一源与 GUI 同份）：直连供应商、结果落盘 <homeDir>/images/<taskId>/，任务入历史；params 同 GUI 生成参数 | {profileId, prompt, params?, inputImagePaths?, inputImageDataUrls?, outDir?} | — |
| `image.profiles.delete` | 按 id 删出图供应商 profile | {id} | — |
| `image.profiles.list` | 列出图供应商 profile，密钥打码不回传 | null | — |
| `image.profiles.put` | 按 id 新增或更新出图 profile | {id, ...profile 字段} | — |
| `image.tasks.list` | 出图任务历史（daemon 事实源）；文件经 GET /api/image/file?path= 取 | null | — |

### mcp

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `mcp.copy` | 把 MCP 条目复制到其他执行器配置文件 | {fromExecutorId, name, toExecutorIds, expectedShas?} | — |
| `mcp.inventory` | 汇总各执行器的 MCP 服务器清单 | null | — |
| `mcp.read` | 原样读执行器的 MCP 配置文件 | {executorId} | — |
| `mcp.remove` | 删 MCP 条目，默认移入停用库待恢复 | {executorId, name, toVault?, expectedSha?} | ⚠️ high |
| `mcp.save` | 保存或更新 MCP 条目（外科手术式写执行器原生配置，SHA 乐观锁） | {executorId, entry, expectedSha?} | ⚠️ high |
| `mcp.setEnabled` | 启停某个 MCP 条目（写回执行器原生配置） | {executorId, name, enabled, expectedSha?} | — |

### memory

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `memory.consolidate` | 对项目记忆跑超限自愈合并，结果写回记忆文件 | {rootPath, force?} | — |
| `memory.digest.run` | 跑每日记忆总结任务，dryRun 只报不写 | {date?, dryRun?, force?} | — |
| `memory.dispatches` | 查某会话本轮记忆注入内容的分发日志，只读 | {sessionId} | — |
| `memory.guardian.get` | 读记忆后台守护引擎配置（跑哪家 CLI） | null | — |
| `memory.guardian.set` | 以补丁方式更新记忆守护引擎配置并落盘 | {runner?, model?, customCommand?} | — |
| `memory.list` | 逐柱列记忆清单 | — | — |
| `memory.mirror` | 读 .waku/memory/MEMORY.md（语义柱写入时自动重生成） | — | — |
| `memory.project.daily` | 读项目每日记忆，传 date 读指定日否则列索引 | {rootPath, date?, limit?} | — |
| `memory.project.read` | 读项目长期记忆文件，只读 | {rootPath} | — |
| `memory.project.write` | 写项目长期记忆文件，带备份落盘 | {rootPath, content} | — |
| `memory.routing.get` | 读 pillar → backends[] 路由表（kv 落盘，可 per-bot 覆盖） | — | — |
| `memory.routing.set` | 写 pillar → backends[] 路由表 | {routing} | — |
| `memory.save` | 写一条记忆（三柱 semantic/episodic/procedural 之一）并广播 | — | — |
| `memory.search` | 跨柱检索记忆并集（sqlite LIKE 兜底，WeKnora 语义增强不可达时记错不炸） | — | — |
| `memory.standing.read` | 读项目 STANDING.md 常置红线，只读 | {rootPath} | — |
| `memory.standing.write` | 写 STANDING.md，带备份与上限校验 | {rootPath, content} | — |
| `memory.telemetry` | 列记忆条目遥测元数据，不传 rootPath 列全部 | {rootPath?} | — |
| `memory.weknora.config.get` | 读 WeKnora baseUrl/apiKey（掩码）/kbIds 配置 | — | — |
| `memory.weknora.config.set` | 写 WeKnora 配置 | — | — |

### network

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `network.interfaces` | 列网卡拓扑，配对码与远程控制用 | null | — |

### notifications

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `notifications.list` | 通知事实源：daemon 聚合的通知行（会话终态/审批/报错/产出/git/待办，自然键去重）；已读与「你不在它面前」是客户端呈现，行里不带 read | {limit?} | — |

### permission

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `permission.resolve` | 裁决执行器的权限请求（allow/deny/always，always 落规则表） | {sessionId, requestId, decision} | — |

### quotaResume

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `quotaResume.state` | 读配额续跑判定快照，只读不触发探测 | null | — |

### rpc

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `rpc.methods` | 方法自描述：全量方法与元数据（说明/params 形状/danger）清单 | null | — |

### search

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `search.configure` | 配置某个 bot 的搜索（密钥存 daemon 侧 search-keys.json；apiKey 缺省=不动，空串=清除，换家自动清旧 key） | {botId, provider: tavily|deepseek|doubao|yuanbao|none, apiKey?} | — |
| `search.overview` | 搜索总览：全部 bot 的配置状态 + 桥条目扇出结果 + 动作日志 | null | — |
| `search.providers` | 搜索提供商目录（tavily/deepseek/doubao/yuanbao：key 提示、文档、免费额度说明） | null | — |
| `search.query` | 执行一次 web 搜索（daemon 定位 bot → 用该 bot 的提供商与密钥；bridge 的工具面） | {cwd|root, query, maxResults?} | — |
| `search.quota` | 查余量/余额：{botId}（60s 缓存，force 绕过）或 {provider, apiKey}（保存前草稿预检） | {botId} 或 {provider, apiKey} | — |
| `search.sessionTools` | 搜索桥 tools/list 收口：这个工作区（cwd/--root）配了搜索才暴露 web_search | {cwd, root?} | — |
| `search.status` | 单个 bot 的搜索状态（提供商 / 密钥掩码 / 本月本机调用次数 / 缓存配额） | {botId} | — |

### session

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `session.cancel` | 取消会话当前执行轮 | {sessionId} | — |
| `session.chat` | headless 一轮对话闭环：附件内联 + 续聊判定（显式 sessionId > 最近可续段 > 新段谱系延续）+ 模型解析（auto=执行器自决），等轮落定回全文 | {botId | unitId+rootPath, text, attachments?, model?, runtimeId?, sessionId?, newSession?, mode?, waitMs?} | — |
| `session.events.since` | 断线补拉会话事件（热环直出，游标滑出环回落账本） | {sessionId, afterSeq?} | — |
| `session.forget` | 遗忘指定会话（删台账行与消息，轨迹文件永不删） | {sessionId} | — |
| `session.gc` | 列超龄死会话的回收候选，默认 14 天 | {maxAgeDays?} | — |
| `session.list` | 列后端台账中的全部会话（按开始时间倒序，含累计 stats） | null | — |
| `session.messages` | 读会话消息流（user/assistant，落盘事实） | {sessionId} | — |
| `session.queue.remove` | 从会话待发送队列删一条 | {sessionId, id} | — |
| `session.queue.resume` | 恢复会话的待发送队列投递 | {sessionId} | — |
| `session.queue.sendNow` | 立即发送会话队列中的某条消息 | {sessionId, id} | — |
| `session.resumable` | 列可续接的会话（有 cli_ref 的那些；行带 source 供目标选择器标来源） | {runtimeId?, limit?} | — |
| `session.resume` | 按 cli_ref 续接既有会话，之后 send/cancel 照常 | {sessionId} | — |
| `session.send` | 向既有会话续聊发一条文本（agent loop，上下文连续）；attachments 为本地文件路径，daemon 侧内联 | {sessionId, text, attachments?, reasoningLevel?, contextLength?} | — |
| `session.start` | 起会话跑一轮：按 bot 的 contextManifest 注入上下文、spawn 执行器；worktree 命中则会话 rootPath 全程指向该工作树 | {runtimeId, unitId, rootPath, prompt, unitName?, model?, mode?, reasoningLevel?, worktree?, memoryOptions?} | — |
| `session.trace` | 读会话轨迹 NDJSON 账本（跨日期落盘），afterSeq 游标续拉 | {sessionId, afterSeq?} | — |

### skills

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `skills.copy` | 把技能复制到另一源并失效命令缓存 | {fromSourceDir, dirName, toSourceDir, rootPath?} | — |
| `skills.inventory` | 按源分组列全部技能，含已停用 | {rootPath?} | — |
| `skills.setDisabled` | 停用或恢复技能（搬进搬出源内 .disabled 目录，全局生效） | {sourceDir, dirName, disabled, rootPath?} | — |

### steward

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `steward.recent` | 读管家自身最近 7 天的每日记录文件 | null | — |
| `steward.search` | 跨项目追溯搜索 CLI 会话语料，按 bot 定权限 | {query, botId?, limit?, pathHint?, withContext?} | — |

### terminal

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `terminal.create` | 新建 PTY 终端会话，数据经 terminal 帧推送 | {cwd?, shell?, cols?, rows?} | — |
| `terminal.dispatch` | — | — | — |
| `terminal.input` | 向终端写入输入 | {terminalId, data} | — |
| `terminal.kill` | 杀终端会话，exit 帧随后到达 | {terminalId} | — |
| `terminal.list` | 活跃终端清单 | null | — |
| `terminal.resize` | 调整终端窗格尺寸 | {terminalId, cols, rows} | — |
| `terminal.transcript` | 读终端落盘转录全文 | {terminalId} | — |

### tunnel

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `tunnel.start` | 启动外网隧道，cloudflared 或自定义 | {provider?, customUrl?} | — |
| `tunnel.status` | 读隧道当前状态 | null | — |
| `tunnel.stop` | 停止隧道 | null | — |

### unit

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `unit.history` | 查 bot 单元历史，合并自动化运行等多源条目 | {unitId?, limit?} | — |

### workbench

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `workbench.skill.sync` | 同步官方基础技能 ×2（agent-workbench 驾驶工作台 + workbench-context 记忆检索）到 bot 工作区（bot init 已自动播种；这里兜底存量 bot、版本升级与 force 重装；无标记的用户自建同名技能不碰） | {botId? | rootPath?, force?} | — |

### workspace

| 方法 | 说明 | params | 危险 |
|---|---|---|---|
| `workspace.listEditors` | 列本机已装编辑器，打开方式菜单用 | null | — |
| `workspace.openFolder` | 用系统文件管理器打开目录或 bot 根目录 | {path?, botId?} | — |
| `workspace.openInEditor` | 用指定编辑器打开目录或 bot 根目录 | {path?, botId?, editorId?} | — |
| `workspace.paths.list` | 对话输入 @ 提及的路径建议（一层目录 + 末段过滤，安全闸拒越界） | {rootPath, token, limit?} | — |

<!-- methods:end -->

**git.* 的公共错误码**（全表见 prototype/src/core/git.ts 的 `GIT_ERROR_CODES`，daemon 与前端共用一份词表）：`bad_params`（参数缺失/类型不符）、`not_a_repo`、`invalid_branch_name`（含前导 "-" 的选项注入防护）、`git_unavailable`（PATH 无 git / spawn 失败；Windows NTSTATUS 级失败自动重试 3 次）、`git_timeout`、`git_error`（未识别话术原样透传首行）。工作树路径一律走 `--porcelain -z`（NUL 分隔，路径不 C-quote），中文/空格路径不会带引号脏数据。提交面另加 4 个（ADR 0010）：`nothing_to_commit`、`identity_missing`、`push_rejected`（`data.detail` 带远端原话）、`no_remote`。

**为什么有 `daemon.stop`**：Windows 上跨进程 SIGTERM 不可投递（冒烟实证，`child.kill("SIGTERM")` 后子进程无动于衷）。程序化退出一律走协议；SIGINT/SIGTERM 处理器保留给终端 Ctrl+C 与 Unix。这是 Phase 0 的一个硬结论，后续 PTY / 子进程管理会反复遇到，处置口径一致：**能走协议的走协议，信号只当人肉兜底**。

**Phase 1 执行器事实（zcode）**：daemon 的 zcode 执行器走 **`zcode app-server --stdio`（ZCode Protocol v1）全能力路径**——真流式 delta、工具事件、权限反向流（与 Phase 4 权限闸闭环）、真 usage、跨进程 resume。前提是本机安装的 zcode CLI 带有 fork 补丁 `awb/standalone-app-server`（app-server 入口补 standalone 引导 + 认证头端口内接；两处都在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`，已实测并提交到 zcode 克隆的该分支）。CLI 未打补丁时 daemon **自动降级**到 `zcode -p --json` 回退路径（真实回复/usage/多轮仍在，无流式/工具/权限事件），进程生命周期内不再回头。

## 五、版本与演进

- 不兼容变更升 `v`；届时 daemon 同时监听新旧 `v` 一个过渡期。
- 只加方法、只加可选字段不算不兼容，`v` 不动。
- `RuntimeEvent` 本体的演进仍走 `events.ts`（契约纪律见 `docs/06` §一/§九），本文只管封包层。

## 六、REST（管理面）

| 端点 | 说明 |
|---|---|
| `GET /healthz` | `{ ok, name, version, pid, uptimeMs }`（豁免鉴权） |
| `GET /bootstrap` | **仅回环**（WP-7）：`{ token, home }`——本机前端免配置自动取 token；非回环 401 |
| `GET /api/permissions/rules` | 权限规则清单（其余端点全部要求 `x-awb-token` 头或 `?token=`） |
| `POST /api/permissions/rules` | 新增规则 `{pattern, decision, runtimeId?, kind?}` → `{id}` |
| `DELETE /api/permissions/rules?id=N` | 删除规则 |
| `POST /api/permissions/resolve` | 审批决策 `{sessionId, requestId, decision}`（与 WS `permission.resolve` 同义） |
| `POST /webhook/bot` | per-bot 入站钩子（WP-9）：`{botId, secret, text}` → `{sessionId, reply}`；鉴权走 bot 自己的 webhook secret（豁免全局 token） |
| 其他 | JSON 404 `{ ok:false, error:{ code:"not_found", … } }` |

**鉴权（WP-7）**：默认开启——`AGENT_WORKBENCH_TOKEN` 显式指定，否则首启生成落盘
`<homeDir>/token`；`AGENT_WORKBENCH_INSECURE=1` 关闭（冒烟/本机调试）。WS 走
`?token=`（浏览器无法设 WS 头），REST 走头或 query。回环客户端凭 `/bootstrap`
自动取 token；手机/局域网客户端手动配置（localStorage `agent-workbench:daemon-token`）。

会话数据不走 REST（都在 WS 事件流），管理面只放配置与审批类端点。
