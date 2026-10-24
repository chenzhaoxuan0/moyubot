/**
 * RPC 方法元数据集中表（docs/21 D6）——rpc.methods / aw methods / docs/07 §四生成表的
 * 数据源。与注册点旁的第三参（registerMethod 可选 meta）并存：高频域的形状提示沉淀在
 * 这里，个别方法的就地标注走注册点。
 *
 * 纪律：
 * - index.ts 在全部 registerMethod 之后调 applyMethodMeta(METHOD_META)——本表出现
 *   注册表里没有的键 = 漂移，daemon 启动直接掀桌（fail-fast）。
 * - description 禁用 `|`（进 markdown 表格）；paramsHint 只写从 handler 实读出的形状，
 *   拿不准就省略（省略 ≠ 无参数，只是不提示）。
 * - danger 只标真危险面：不可逆 / 越过工作台改外部事实（写执行器原生配置、推远端、
 *   删工作树、停 daemon、开电脑控制）。CLI 交互确认用，agent 非交互不受阻。
 */

import type { MethodMeta } from "./wsd.ts";

export const METHOD_META: Record<string, MethodMeta> = {
  // ---- 基础 / 自描述 -------------------------------------------------------
  "health": { description: "daemon 健康自检，result 同 GET /healthz", paramsHint: "null" },
  "daemon.stop": {
    description: "优雅退出 daemon（ack 后退出码 0）。Windows 跨进程信号不可投递，程序化退出唯一通道",
    paramsHint: "null",
    danger: "high",
  },
  "rpc.methods": { description: "方法自描述：全量方法与元数据（说明/params 形状/danger）清单", paramsHint: "null" },
  "driver.catalog": { description: "列已知执行器驱动的安装注册状态与提示", paramsHint: "null" },
  "network.interfaces": { description: "列网卡拓扑，配对码与远程控制用", paramsHint: "null" },
  "permission.resolve": {
    description: "裁决执行器的权限请求（allow/deny/always，always 落规则表）",
    paramsHint: "{sessionId, requestId, decision}",
  },

  // ---- 会话 ---------------------------------------------------------------
  "session.start": {
    description: "起会话跑一轮：按 bot 的 contextManifest 注入上下文、spawn 执行器；worktree 命中则会话 rootPath 全程指向该工作树",
    paramsHint: "{runtimeId, unitId, rootPath, prompt, unitName?, model?, mode?, reasoningLevel?, worktree?, memoryOptions?}",
  },
  "session.send": { description: "向既有会话续聊发一条文本（agent loop，上下文连续）；attachments 为本地文件路径，daemon 侧内联", paramsHint: "{sessionId, text, attachments?, reasoningLevel?, contextLength?}" },
  "session.chat": {
    description: "headless 一轮对话闭环：附件内联 + 续聊判定（显式 sessionId > 最近可续段 > 新段谱系延续）+ 模型解析（auto=执行器自决），等轮落定回全文",
    paramsHint: "{botId | unitId+rootPath, text, attachments?, model?, runtimeId?, sessionId?, newSession?, mode?, waitMs?}",
  },
  "session.cancel": { description: "取消会话当前执行轮", paramsHint: "{sessionId}" },
  "session.list": { description: "列后端台账中的全部会话（按开始时间倒序，含累计 stats）", paramsHint: "null" },
  "session.resumable": { description: "列可续接的会话（有 cli_ref 的那些）", paramsHint: "{runtimeId?, limit?}" },
  "session.resume": { description: "按 cli_ref 续接既有会话，之后 send/cancel 照常", paramsHint: "{sessionId}" },
  "session.messages": { description: "读会话消息流（user/assistant，落盘事实）", paramsHint: "{sessionId}" },
  "session.trace": { description: "读会话轨迹 NDJSON 账本（跨日期落盘），afterSeq 游标续拉", paramsHint: "{sessionId, afterSeq?}" },
  "session.events.since": { description: "断线补拉会话事件（热环直出，游标滑出环回落账本）", paramsHint: "{sessionId, afterSeq?}" },
  "session.gc": { description: "列超龄死会话的回收候选，默认 14 天", paramsHint: "{maxAgeDays?}" },
  "session.forget": { description: "遗忘指定会话（删台账行与消息，轨迹文件永不删）", paramsHint: "{sessionId}" },
  "session.queue.remove": { description: "从会话待发送队列删一条", paramsHint: "{sessionId, id}" },
  "session.queue.resume": { description: "恢复会话的待发送队列投递", paramsHint: "{sessionId}" },
  "session.queue.sendNow": { description: "立即发送会话队列中的某条消息", paramsHint: "{sessionId, id}" },

  // ---- 执行器与模型配置 -------------------------------------------------------
  "adapter.list": { description: "已注册执行器摘要（id/显示名/模型清单/能力位）", paramsHint: "null" },
  "adapter.probe": { description: "探测执行器安装/认证/版本现状（只探测，不碰模型清单）", paramsHint: "{runtimeId}" },
  "adapter.models": { description: "刷新模型清单（只读列清单命令或本地目录，零用量）；省略 runtimeId = 全部", paramsHint: "{runtimeId?}" },
  "adapter.commands": { description: "列执行器在某目录下的原生命令面", paramsHint: "{runtimeId, rootPath}" },
  "adapter.modelcatalog.get": { description: "读执行器的模型目录清单", paramsHint: "{runtimeId}" },
  "adapter.modelcatalog.set": { description: "写模型目录进 CLI 目录文件并刷模型清单", paramsHint: "{runtimeId, rows}" },
  "adapter.modeldefaults.get": { description: "读执行器原生模型默认值配置", paramsHint: "{runtimeId}" },
  "adapter.modeldefaults.set": { description: "写模型默认值进 CLI 配置文件并刷清单", paramsHint: "{runtimeId, values}" },
  "adapter.providers.get": { description: "读供应商级模型配置（pi、opencode）", paramsHint: "{runtimeId}" },
  "adapter.providers.set": { description: "写供应商配置并顺带刷新模型清单", paramsHint: "{runtimeId, rows}" },

  // ---- bot ------------------------------------------------------------------
  "bot.list": { description: "列全部已注册 bot", paramsHint: "null" },
  "bot.put": {
    description: "写 bot 定义落盘到 .agent-workbench/bot.json（含 contextManifest），三把乐观锁",
    paramsHint: "{unit, ifRevision?, ifAgentsMdHash?, ifSoulMdHash?, createRoot?}",
    danger: "high",
  },
  "bot.inspect": { description: "纯读探测目录现状（bot.json 有无、可导入项三分支）", paramsHint: "{rootPath}" },
  "bot.initWorkspace": {
    description: "初始化/补齐工作区（memory/daily 目录）并同步官方基础技能 ×2（agent-workbench + workbench-context，版本标记契约）；MD 正文不落骨架——未经编辑不落盘不注入",
    paramsHint: "{rootPath}",
  },
  "bot.ask": { description: "向 bot 发一条文本并等轮落定拿回全文（webhook/MCP 共用内核）", paramsHint: "{botId, text, waitMs?, memoryOptions?}" },
  "bot.defaultRoot": { description: "查新建 bot 的默认安置目录与可浏览根（幂等建 bots 目录）", paramsHint: "null" },
  "bot.roots.add": { description: "登记一个 bot 扫描根目录", paramsHint: "{dir}" },
  "bot.gitignore.ensure": { description: "确保 bot 目录 .gitignore 覆盖密钥文件", paramsHint: "{rootPath}" },

  // ---- 渠道 ------------------------------------------------------------------
  "channel.status": { description: "读各渠道网关运行态与 bot 声明渠道对照", paramsHint: "null" },
  "channel.send": { description: "让 bot 主动向飞书会话发文本", paramsHint: "{botId, receiveId, text, accountId?}" },
  "channel.profiles": { description: "列本机已配的飞书机器人 profile", paramsHint: "null" },
  "channel.profile.add": { description: "新建飞书机器人 profile，密钥走 stdin 不落盘", paramsHint: "{name, appId, appSecret}" },
  "channel.identity": { description: "把飞书 profile 解析成机器人名称与头像", paramsHint: "{profiles?}" },
  "channel.diagnose": { description: "诊断 bot 的飞书账号连通性", paramsHint: "{botId, accountId?}" },
  "channel.weixin.qr.begin": { description: "发起微信 iLink 扫码登录", paramsHint: "null" },
  "channel.weixin.qr.poll": { description: "轮询微信扫码状态，成功且带 botId 存凭据", paramsHint: "{qrCode, botId?}" },

  // ---- git ------------------------------------------------------------------
  "git.status": {
    description: "仓库状态摘要（porcelain v2 解析；非仓库返回 isRepo:false 不报错；isRepo 即挂文件监听）",
    paramsHint: "{rootPath}",
  },
  "git.branches.list": { description: "分支列表（local/remote、短哈希、检出归属 checkedOutIn）", paramsHint: "{rootPath}" },
  "git.branch.create": { description: "新建分支并立即切换（checkout -b --no-track）", paramsHint: "{rootPath, name, ref?}" },
  "git.branch.checkout": { description: "切换分支（本地改动会被覆盖时报 dirty_worktree）", paramsHint: "{rootPath, name}" },
  "git.worktrees.list": { description: "工作树清单（逐树脏探测，含 isMain）", paramsHint: "{rootPath}" },
  "git.worktree.create": {
    description: "创建工作树（branch 与 commitish 至少其一；路径缺省走 VSCode 约定）",
    paramsHint: "{rootPath, path?, branch?, commitish?}",
  },
  "git.worktree.remove": {
    description: "删工作树（脏树报 worktree_dirty 可 force 重试；活跃会话占用拒删）",
    paramsHint: "{rootPath, path, force?}",
    danger: "high",
  },
  "git.worktree.reveal": { description: "在系统文件管理器中显示目录", paramsHint: "{path}" },
  "git.changes": { description: "三区改动清单（staged/unstaged/untracked，含增删行数）", paramsHint: "{rootPath}" },
  "git.diff": {
    description: "单文件 patch（staged=索引 vs HEAD / unstaged=工作区 vs 索引；未跟踪合成新增 patch）",
    paramsHint: "{rootPath, path, sourceId}",
  },
  "git.stage": { description: "把路径暂存（add -A，覆盖已删除）", paramsHint: "{rootPath, paths}" },
  "git.unstage": { description: "把路径移出暂存区", paramsHint: "{rootPath, paths}" },
  "git.commit": {
    description: "提交（默认 stagedOnly 只提交索引；否则先 add 指定 paths 再提交）",
    paramsHint: "{rootPath, message, paths?, stagedOnly?}",
  },
  "git.push": {
    description: "推送（remote 判定：显式 → upstream → 唯一远端；无 upstream 自动 -u）",
    paramsHint: "{rootPath, remote?}",
    danger: "high",
  },
  "git.identity": { description: "提交身份（name/email），任一缺失返回 null", paramsHint: "{rootPath}" },
  "git.graph": { description: "可见历史提交图（HEAD+branches+tags+remotes，不用 --all）", paramsHint: "{rootPath, skip?, maxCount?}" },

  // ---- 待办（GTD）与自动化 ------------------------------------------------------
  "backlog.list": { description: "拉待办全量视图：条目、提议、状态、配置、配额", paramsHint: "null" },
  "backlog.create": {
    description: "新建待办项并落库",
    paramsHint: "{goal, unitId, rootPath, title?, prompt?, unitName?, runtimeId?, model?, mode?, size?, launchMode?}",
  },
  "backlog.update": {
    description: "按 id 编辑待办字段（执行中的禁改）",
    paramsHint: "{id, title?, goal?, prompt?, unitId?, unitName?, rootPath?, runtimeId?, model?, mode?, size?, launchMode?}",
  },
  "backlog.delete": { description: "按 id 删待办，执行中的不可删", paramsHint: "{id}" },
  "backlog.reorder": { description: "传全量 id 数组重排待办优先级", paramsHint: "{ids}" },
  "backlog.sleep": { description: "让某条待办休眠暂停调度", paramsHint: "{id}" },
  "backlog.wake": { description: "唤醒休眠中的待办", paramsHint: "{id}" },
  "backlog.runNow": { description: "立即派发执行某条待办", paramsHint: "{id, runtimeId?, model?}" },
  "backlog.proposal.confirm": { description: "确认当前待办执行提议，可改选执行器模型", paramsHint: "{runtimeId?, model?}" },
  "backlog.proposal.reject": { description: "拒绝当前待办执行提议", paramsHint: "null" },
  "backlog.review": { description: "验收待办，pass 关闭否则打回重排队", paramsHint: "{id, pass, note?}" },
  "backlog.config.get": { description: "读待办引擎配置", paramsHint: "null" },
  "backlog.config.set": { description: "以补丁更新待办引擎配置并落盘", paramsHint: "{patch}" },
  "backlog.quotas": { description: "查执行器配额余量，refresh 强制探测", paramsHint: "{refresh?}" },
  "backlog.heartbeat.force": { description: "手动触发一跳待办心跳，受理即返", paramsHint: "null" },
  "backlog.state.forceBusy": { description: "设强制忙碌开关，暂停待办自动派发", paramsHint: "{on}" },
  "backlog.consolidate.run": { description: "立即跑一次待办清单归并整理，默认强制", paramsHint: "{force?}" },
  "quotaResume.state": { description: "读配额续跑判定快照，只读不触发探测", paramsHint: "null" },
  "notifications.list": {
    description: "通知事实源：daemon 聚合的通知行（会话终态/审批/报错/产出/git/待办，自然键去重）；已读与「你不在它面前」是客户端呈现，行里不带 read",
    paramsHint: "{limit?}",
  },
  "workbench.skill.sync": {
    description: "同步官方基础技能 ×2（agent-workbench 驾驶工作台 + workbench-context 记忆检索）到 bot 工作区（bot init 已自动播种；这里兜底存量 bot、版本升级与 force 重装；无标记的用户自建同名技能不碰）",
    paramsHint: "{botId? | rootPath?, force?}",
  },
  "automation.create": {
    description: "新建定时任务（5 字段 cron，创建时即校验）",
    paramsHint: "{unitId, unitName?, runtimeId, rootPath, prompt, model?, mode?, cron}",
  },
  "automation.update": {
    description: "按 id 更新定时任务定义（cron/prompt/模型/调度规则/派发目标等）",
    paramsHint: "{id, ...定义字段}",
  },
  "automation.list": { description: "定时任务定义清单", paramsHint: "null" },
  "automation.runs": { description: "指定定时任务的运行记录（一行一次，含 sessionId 与终态）", paramsHint: "{id}" },
  "automation.setEnabled": { description: "启停定时任务", paramsHint: "{id, enabled}" },
  "automation.delete": { description: "删除定时任务", paramsHint: "{id}" },
  "automation.runNow": { description: "立即跑一次定时任务（runId + sessionId，终态回灌运行记录）", paramsHint: "{id}" },

  // ---- 记忆 / 上下文 ------------------------------------------------------------
  "memory.save": { description: "写一条记忆（三柱 semantic/episodic/procedural 之一）并广播" },
  "memory.search": { description: "跨柱检索记忆并集（sqlite LIKE 兜底，WeKnora 语义增强不可达时记错不炸）" },
  "memory.list": { description: "逐柱列记忆清单" },
  "memory.mirror": { description: "读 .waku/memory/MEMORY.md（语义柱写入时自动重生成）" },
  "memory.routing.get": { description: "读 pillar → backends[] 路由表（kv 落盘，可 per-bot 覆盖）" },
  "memory.routing.set": { description: "写 pillar → backends[] 路由表", paramsHint: "{routing}" },
  "memory.weknora.config.get": { description: "读 WeKnora baseUrl/apiKey（掩码）/kbIds 配置" },
  "memory.weknora.config.set": { description: "写 WeKnora 配置" },
  "memory.consolidate": { description: "对项目记忆跑超限自愈合并，结果写回记忆文件", paramsHint: "{rootPath, force?}" },
  "memory.digest.run": { description: "跑每日记忆总结任务，dryRun 只报不写", paramsHint: "{date?, dryRun?, force?}" },
  "memory.dispatches": { description: "查某会话本轮记忆注入内容的分发日志，只读", paramsHint: "{sessionId}" },
  "memory.guardian.get": { description: "读记忆后台守护引擎配置（跑哪家 CLI）", paramsHint: "null" },
  "memory.guardian.set": { description: "以补丁方式更新记忆守护引擎配置并落盘", paramsHint: "{runner?, model?, customCommand?}" },
  "memory.project.read": { description: "读项目长期记忆文件，只读", paramsHint: "{rootPath}" },
  "memory.project.write": { description: "写项目长期记忆文件，带备份落盘", paramsHint: "{rootPath, content}" },
  "memory.project.daily": { description: "读项目每日记忆，传 date 读指定日否则列索引", paramsHint: "{rootPath, date?, limit?}" },
  "memory.standing.read": { description: "读项目 STANDING.md 常置红线，只读", paramsHint: "{rootPath}" },
  "memory.standing.write": { description: "写 STANDING.md，带备份与上限校验", paramsHint: "{rootPath, content}" },
  "memory.telemetry": { description: "列记忆条目遥测元数据，不传 rootPath 列全部", paramsHint: "{rootPath?}" },
  "curator.run": { description: "跑记忆策展归档，报告落 logs/curator 目录", paramsHint: "{rootPath?, dryRun?}" },
  "steward.recent": { description: "读管家自身最近 7 天的每日记录文件", paramsHint: "null" },
  "steward.search": {
    description: "跨项目追溯搜索 CLI 会话语料，按 bot 定权限",
    paramsHint: "{query, botId?, limit?, pathHint?, withContext?}",
  },
  "context.user.read": { description: "读全局 USER.md（关于用户的常置文件）", paramsHint: "null" },
  "context.user.write": { description: "写全局 USER.md", paramsHint: "{content}" },

  // ---- 历史 ------------------------------------------------------------------
  "unit.history": { description: "查 bot 单元历史，合并自动化运行等多源条目", paramsHint: "{unitId?, limit?}" },
  "history.rename": { description: "覆盖历史行显示名，空 title 撤销改名", paramsHint: "{key, title}" },
  "history.native.list": { description: "只读列各 CLI 自己会话存储的会话", paramsHint: "{unitId?, executorIds?, limit?}" },
  "history.native.detail": { description: "读某原生会话的完整转录详情", paramsHint: "{executorId, sessionId}" },
  "history.import.list": { description: "列 bot 工作区外部会话并标注已知与否", paramsHint: "{unitId, runtimeId?, limit?}" },
  "history.import.apply": { description: "把勾选的外部 CLI 会话导入 sessions 表", paramsHint: "{unitId, runtimeId, sessions, unitName?}" },

  // ---- 技能与 MCP ---------------------------------------------------------------
  "skills.inventory": { description: "按源分组列全部技能，含已停用", paramsHint: "{rootPath?}" },
  "skills.copy": { description: "把技能复制到另一源并失效命令缓存", paramsHint: "{fromSourceDir, dirName, toSourceDir, rootPath?}" },
  "skills.setDisabled": { description: "停用或恢复技能（搬进搬出源内 .disabled 目录，全局生效）", paramsHint: "{sourceDir, dirName, disabled, rootPath?}" },
  "mcp.inventory": { description: "汇总各执行器的 MCP 服务器清单", paramsHint: "null" },
  "mcp.read": { description: "原样读执行器的 MCP 配置文件", paramsHint: "{executorId}" },
  "mcp.save": {
    description: "保存或更新 MCP 条目（外科手术式写执行器原生配置，SHA 乐观锁）",
    paramsHint: "{executorId, entry, expectedSha?}",
    danger: "high",
  },
  "mcp.remove": {
    description: "删 MCP 条目，默认移入停用库待恢复",
    paramsHint: "{executorId, name, toVault?, expectedSha?}",
    danger: "high",
  },
  "mcp.setEnabled": { description: "启停某个 MCP 条目（写回执行器原生配置）", paramsHint: "{executorId, name, enabled, expectedSha?}" },
  "mcp.copy": { description: "把 MCP 条目复制到其他执行器配置文件", paramsHint: "{fromExecutorId, name, toExecutorIds, expectedShas?}" },

  // ---- 浏览器 / 电脑控制 ----------------------------------------------------------
  "browserControl.get": { description: "读浏览器控制当前状态", paramsHint: "null" },
  "browserControl.setEnabled": { description: "开关浏览器控制能力（扇出 playwright-mcp 进各执行器配置）", paramsHint: "{enabled}" },
  "browserControl.setMode": { description: "设浏览器模式，isolated 或 takeover", paramsHint: "{mode}" },
  "browserControl.setBrowser": { description: "选接管浏览器，msedge 或 chrome", paramsHint: "{browser}" },
  "browserControl.sharedChrome.start": { description: "启动共享 Chrome 实例", paramsHint: "null" },
  "browserControl.sharedChrome.stop": { description: "停止共享 Chrome 实例", paramsHint: "null" },
  "computerControl.get": { description: "读电脑控制当前状态", paramsHint: "null" },
  "computerControl.setEnabled": {
    description: "开关电脑控制能力（默认停用；开启即扇出 computer MCP 条目进执行器配置）",
    paramsHint: "{enabled}",
    danger: "high",
  },
  "computerControl.actions": { description: "拉 afterSeq 之后的电脑控制动作审计流", paramsHint: "{afterSeq?}" },
  "computerControl.panic": { description: "紧急停止电脑控制（急停按钮）", paramsHint: "null" },

  // ---- 搜索（bot 级）--------------------------------------------------------------
  "search.providers": { description: "搜索提供商目录（tavily/deepseek/doubao/yuanbao：key 提示、文档、免费额度说明）", paramsHint: "null" },
  "search.overview": { description: "搜索总览：全部 bot 的配置状态 + 桥条目扇出结果 + 动作日志", paramsHint: "null" },
  "search.status": { description: "单个 bot 的搜索状态（提供商 / 密钥掩码 / 本月本机调用次数 / 缓存配额）", paramsHint: "{botId}" },
  "search.configure": {
    description: "配置某个 bot 的搜索（密钥存 daemon 侧 search-keys.json；apiKey 缺省=不动，空串=清除，换家自动清旧 key）",
    paramsHint: "{botId, provider: tavily|deepseek|doubao|yuanbao|none, apiKey?}",
  },
  "search.quota": { description: "查余量/余额：{botId}（60s 缓存，force 绕过）或 {provider, apiKey}（保存前草稿预检）", paramsHint: "{botId} 或 {provider, apiKey}" },
  "search.sessionTools": { description: "搜索桥 tools/list 收口：这个工作区（cwd/--root）配了搜索才暴露 web_search", paramsHint: "{cwd, root?}" },
  "search.query": { description: "执行一次 web 搜索（daemon 定位 bot → 用该 bot 的提供商与密钥；bridge 的工具面）", paramsHint: "{cwd|root, query, maxResults?}" },

  // ---- 出图 / 外观 ---------------------------------------------------------------
  "image.profiles.list": { description: "列出图供应商 profile，密钥打码不回传", paramsHint: "null" },
  "image.generate": {
    description: "出图（编排唯一源与 GUI 同份）：直连供应商、结果落盘 <homeDir>/images/<taskId>/，任务入历史；params 同 GUI 生成参数",
    paramsHint: "{profileId, prompt, params?, inputImagePaths?, inputImageDataUrls?, outDir?}",
  },
  "image.tasks.list": { description: "出图任务历史（daemon 事实源）；文件经 GET /api/image/file?path= 取", paramsHint: "null" },
  "image.profiles.put": { description: "按 id 新增或更新出图 profile", paramsHint: "{id, ...profile 字段}" },
  "image.profiles.delete": { description: "按 id 删出图供应商 profile", paramsHint: "{id}" },
  "appearance.read": { description: "读 appearance.json 及壁纸 dataURL", paramsHint: "null" },
  "appearance.write": { description: "整体写 appearance.json，hash 乐观锁", paramsHint: "{content, expectedHash?}" },
  "appearance.wallpaper.save": { description: "落一张 base64 壁纸到 wallpapers 目录", paramsHint: "{name, base64}" },
  "appearance.wallpaper.delete": { description: "删 wallpapers 目录下的壁纸文件", paramsHint: "{path?}" },

  // ---- 终端 / 工作区 / 网络 ---------------------------------------------------------
  "terminal.create": { description: "新建 PTY 终端会话，数据经 terminal 帧推送", paramsHint: "{cwd?, shell?, cols?, rows?}" },
  "terminal.input": { description: "向终端写入输入", paramsHint: "{terminalId, data}" },
  "terminal.resize": { description: "调整终端窗格尺寸", paramsHint: "{terminalId, cols, rows}" },
  "terminal.kill": { description: "杀终端会话，exit 帧随后到达", paramsHint: "{terminalId}" },
  "terminal.list": { description: "活跃终端清单", paramsHint: "null" },
  "terminal.transcript": { description: "读终端落盘转录全文", paramsHint: "{terminalId}" },
  "workspace.paths.list": {
    description: "对话输入 @ 提及的路径建议（一层目录 + 末段过滤，安全闸拒越界）",
    paramsHint: "{rootPath, token, limit?}",
  },
  "workspace.openFolder": { description: "用系统文件管理器打开目录或 bot 根目录", paramsHint: "{path?, botId?}" },
  "workspace.openInEditor": { description: "用指定编辑器打开目录或 bot 根目录", paramsHint: "{path?, botId?, editorId?}" },
  "workspace.listEditors": { description: "列本机已装编辑器，打开方式菜单用", paramsHint: "null" },
  "tunnel.status": { description: "读隧道当前状态", paramsHint: "null" },
  "tunnel.start": { description: "启动外网隧道，cloudflared 或自定义", paramsHint: "{provider?, customUrl?}" },
  "tunnel.stop": { description: "停止隧道", paramsHint: "null" },
};
