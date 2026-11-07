# 33 —— 派发与通知：router-worker 体系定稿

> 2026-11-07。四参照系收口：dsh-superagent 原型（领域模型）/ DeepSeek Harness 本体（派发契约）/ orca（唤醒式协调）/ Grok Bot·Muse（产品形态观察）→ moyubot 的 **gate-thread / report-run / mandate-assignment / 唤醒式调度** 四件套。本文是设计定稿，未实施；分期表见文末。

## 总纲：一条产品公理与一条派发管线

**产品公理**（本轮讨论的最高结论，建议进 north star）：

> **清单的第一读者是 router，不是人。人只写不读；「读」的职责转交给两个推送面——需要行动的走 IM 即时通知，已收口的走主管日报。**

推论：一切依赖「人主动打开清单页」的流程都是死流（用户特性：从不回看 todo list）。
提醒的最高形态不是「该看了」，而是**「已经做完了，这是结果」**（自动消化）；其次才是
「需要你回答/验收」（IM 推送带按钮）。确认门的 UI 住在 IM，不住在页面。

**派发管线全景**（本文各节拼出的最终形态）：

```
任务(带 assignment_json: executor / model / memory 档 / prompt+skills / launchMode)
  → 派发器：事件触发优先（上一 run 结算 / 新任务落库 / 用户确认 → 立即调调度入口；
            20s tick 降为兜底对账）                          …… §4
  → gate()：幂等 → Thread 订阅直通（不过分类器）→ 未命中走分类器   …… §1
  → ExecutorAdapter.start(spec)：非交互参数集 + 环境 scrub + cwd 断言   …… §4
  → 运行：powerSaveBlocker 防睡；人续聊占额外槽
  → 结算：stopReason(completed/aborted/error/limit/refusal)
          + report state(ready/blocked/failed/dropped) + attention   …… §2
  → backlog_runs 一行落库：outcome/summary/model/usage_json/deliverable …… §2
  → 同一事务尾部：L1 通知(仅 attention/失败/urgent) + 唤醒下一环 + 日报数据面  …… §2/§4
```

## 0. 参照系与概念对照

四个参照系各自的贡献，一张表说清：

| 参照系 | 一句话贡献 | 关键出处（外部仓库） |
|---|---|---|
| dsh-superagent 原型 | 领域模型：Source→Trigger→Thread→Eval(gate+assessment)→Ticket(Mandate)→Assignment→Executor；Subscription 扇出；Effects 先存后做 | docs/001-domain、002-authorization、003-execution；prompts/admission.md；src/app/tools/executor.ts:77-83 |
| DeepSeek Harness 本体 | 派发契约：SubagentProvider one-shot + 无人值守裁剪（禁问人）+ stopReason 结算 + 环境 scrub + 进程组取消阶梯 | packages/subagent/subagent/src/types.ts:241,321；subagent-claude-code/src/run.ts:331-368；subprocess/src/index.ts:47-80 |
| orca | 唤醒式协调（router 派完即休眠，事件到达才被唤醒）；Dispatch=尝试身份(retry_of/fence/circuit_broken)；per-run 用量归因；precheck；防睡眠 | src/main/runtime/orchestration/（records.ts:286-327、skill-guides/orchestration.md:33-35）；automations-types.ts:58-101；power/agent-awake-service.ts |
| Grok Bot / Muse（产品观察） | chief-of-staff 管专家 bot 的分层；Sentinel 独立监督者；routine 示范教学；渐进信任 | 2026-08/09 发布页（无代码，仅形态印证） |

**概念对照表**（原型概念 → moyubot 现有物 → 缺口 → 本文章节）：

| 原型概念 | moyubot 现有物 | 缺口 | 章节 |
|---|---|---|---|
| Source → Trigger（不可变，幂等） | `inbox.add` / GTD 统合 / 手动（`backend/src/backlog/consolidate.ts`） | channels 四家不进 inbox；无事件指纹，同一件事说两遍成两个条目 | §1 |
| Thread + Subscription（任务↔话题多对多扇出） | `targetSessionId`、时间盒续跑 `resumeTargetFor`（heartbeat.ts:739,809） | 后续上下文无法直达已有任务，全部重过分类器 | §1 |
| Eval = Gate（确定性）+ Assessment（LLM） | classifier.ts 纯 LLM 批量分类 | 缺程序层 Fast Path | §1 |
| Mandate + acceptMode(off/observe/auto) | `auto` 旗 = `!urgent && provenance!=="pasted"` 硬规则 | 授权是布尔不是记录；无「先观察只记录」渐进信任 | §3 |
| Report(progress/waiting/ready/blocked/failed/dropped) + Attention | done/failed + lastError 自由文本 | 执行器无法说「卡住了需要你答一个问题」/「这事不用做」 | §2 |
| Effects（副作用先存后做，合并/退避/三连败上报） | notifyUser 直调；派发直调 startSession | 重启丢在途动作；重复通知无合并 | 暂缓（见「不做的事」） |
| Hand-back（超范围交回路由） | 无 | 执行器只能硬做或失败 | §2 |
| Worker slot（人占额外槽，handoff 即释槽） | maxConcurrent 简单计数 | 自动任务占满时人无法续聊已有任务 | §5 |

**orca 的负空间确认**：orca 没有任何用户级清单/分类消化功能（全库 grep inbox/backlog/todo
无用户级概念）；docs/29-30 的「注意力自动化」体系在参照项目里是最领先的，不需要再找对标。
另两条负借鉴：日报保持系统功能形态（orca 把汇报写成协调者提示词，我们没有日报反而落后——
保持 supervisor）；汇报不由各 bot 自由发挥（原型铁律：Worker 不直接对人说话，统一出口）。

## 1. Gate 与 Thread 订阅（一期：后续事件直达任务）

**改什么**：

1. `inbox_entries` 加 `thread_key` 列（`backend/src/store/db.ts:221` 附近）。来源指纹由各
   入口自生成，格式仿原型 `feishu:<chat>:<root>`：
   - 文本框 = `manual:<sessionId|日期>`
   - GTD.md = `gtd:<rootPath>:<标题slug>`
   - 飞书 = `feishu:<chat>:<rootMessageId>`
2. `backlog_items` 加 `subscriptions` JSON 列（thread_key 数组）。分类器沉淀任务的事务里
   （classifier.ts:232-263）顺手订阅其源条目的 thread。
3. 新文件 `backend/src/inbox/gate.ts`，`inbox.add` 入口前按原型 Intake 顺序执行：
   - **幂等**：同 thread_key + 同文本指纹 → `duplicate`，不建条目；
   - **订阅直通**：thread_key 命中未 done 任务的 subscriptions → 不进分类器，作为 Input
     投递：任务 executing → resume 会话发消息（复用 `resumeTargetFor` 通路）；ready →
     并入任务 prompt 上下文；done → 按原型「人的消息可唤醒已结束任务」回 ready；
   - 未命中 → 原路进分类器。
4. channels 开进 inbox 的路：`askBot.ts:40` 的 `runBotTurn` 前过 gate——仅 @bot 或白名单
   发送者的消息成为候选条目（原型 002 的 `addressed` 准入）。飞书「确认 N」关键词拦截
   （index.ts:1060）是 gate 的特例，合并进去。

**为什么**：解决「说两遍变两个任务」和「执行中补充信息送不进去」；同时省分类器调用
（原型消融实验：直通机制为 Router 省 37% token）。清单是首屏输入 ⇒ inbox 是主 API，
这期是全体系的地基。分类契约（docs/29）零改动——thread_key 是纯新增列。

## 2. Report 协议、backlog_runs 事实源、两级通知（二期）

三个面是同一条结算链路，一起交付。

**2.1 Report 协议**（抄原型 `src/app/tools/executor.ts:77-83` 的 schema）：

```
state: progress | ready | blocked | failed | dropped | handback
summary: string
human_action?: string   // 给人的一个具体问题，≤1000 字；progress 也可带；null 清除
```

- 通道：经 FileMemoryInjector 注入前缀约定（末条消息输出 JSON 块），13 家执行器零适配；
  MCP 工具形态留给后续。
- 状态机（`prototype/src/core/backlog.ts:27-44`）加两态：`blocked`（attention 字段存问题
  文本）、`dropped`（执行器判定无需处理，静默结束不通知）。`handback` = 超范围交回：
  任务回 ready + 摘 auto 旗，源条目重进分类器。
- 执行层另记 stopReason（dsh 契约 `types.ts:241`）：`completed/aborted/error/limit/refusal`
  ——limit（预算/轮数耗尽）与 refusal 不再混入 failed，watchTurnSettle（heartbeat.ts:830）
  按此分类。

**2.2 backlog_runs 升级为结果事实源**（现表 `db.ts:206` 只有 status/detail）：

```
追加列：outcome TEXT       -- ready|blocked|failed|dropped（语义层）
        summary TEXT       -- 执行器 report summary，≤200 字
        model TEXT         -- 实际使用的模型
        usage_json TEXT    -- tokens/费用，按 sessionId+时间窗从 host usage 事件归因（orca 法）
        deliverable TEXT   -- 产物深链（文件/会话/PR）
```

一张表三个消费者：L1 即时通知、L2 日报（supervisor executed 行从「✓ 标题」升级为
「✓ 标题·一句话结果」，supervisor.ts:114）、统计面（哪些类别任务成功率低 → 反哺分类器
auto 判据）。Engine 唯一写者，通知与日报都只是视图。

**2.3 两级通知**（出口统一为 `notifyUser`，index.ts:913，模板统一，bot 不各自发挥）：

| 层 | 触发 | 渠道 | 准入标准 |
|---|---|---|---|
| L1 即时 | blocked（有 attention）/ 失败 / urgent·显式任务完成 | IM 三通道 + 应用内 | **发出后人有一个具体动作要做**；例行自动完成只进 L2 |
| L2 日报 | 全部已收口 run 聚合 | supervisor 定时（默认 21:00） | 三节全空整体沉默（保持 docs/30 原则：「报告的噪音比沉默更伤」） |

L1 模板：`✓/⚠ 任务标题（bot·执行器/模型）· 一句话结果 · [验收/回答] 深链`。

**通知工程面**（orca 借鉴，notification-delivery-service.ts）：单点分发 + cooldown 防突发 +
去重键（task+outcome+时间窗）+ 「agent 等人」独立开关（最易关/调频的一档）+ 桌面在场时
不打扰 IM/手机。

## 3. Mandate、observe 模式与派发单 assignment_json（三期）

**3.1 Mandate**：`backlog_items` 加 `mandate` JSON：

```
{ strength: "explicit" | "inferred"
  basis: "typed" | "gtd" | "channel" | "classifier"
  rulesMatched: []          // 分类器命中的类别规则
  acceptedAt }
```

现 `auto` 旗变为 mandate 的派生值。**acceptMode**（backlog.config）`off / observe / auto`：
observe 下 inferred 条目只记「would auto-run」不设 auto；explicit（typed、带 category 的
add）不受模式影响。这是 ADR-0001 铁律（引擎无权启动非 auto 待办）的渐进放宽形态——
铁律本身不动，observe 提供安全的观察期。

**3.2 分类器提示词吸收三硬规则**（原型 prompts/admission.md）：① 接单前确立三个独立
事实（针对这个项目、表达了要改的意图、方向已定到能小步执行）；② 设计讨论不成工单
（「也许我们该像 X 那样」是偏好不是请求）；③ reason 必须引用源文本片段而非复述。

**3.3 派发单 assignment_json**（设置点：执行器/模型/记忆/提示词，原型「少设置」原则：
默认档 + 一屏覆盖，不做大表单）：

```
executor:  runtimeId          默认 = 配额最闲执行器（pickAutopilotRuntime 已有）
model:     string             默认 = 执行器默认模型
memory:    none|minimal|full  默认 minimal（AGENTS.md + MEMORY.md）；full = bot 的
                             contextManifest 整套；bot 亲生任务默认 full
prompt:    appendPrompt + skills[]（白名单校验，走 discovery.ts）
launchMode / targetSessionId  已有，归口进同一 JSON
```

优先级：用户 hints > 任务编辑面板 > 分类器建议（白名单零信任，parseTask 已有）> 默认档。
与 mandate 同存 = 派发可追溯（「这个结果是按什么配置跑出来的」）。

**3.4 IM 确认门**：heartbeat 提议确认接通 Telegram Inline Keyboard / 微信数字审批
（基建已在 telegram.ts/weixin.ts，缺 backlog 提议的接入）。确认门的 UI 住在 IM。

## 4. 唤醒式调度与无人值守裁剪（并入二期）

**4.1 结算即唤醒**（orca 核心借鉴）：watchTurnSettle/settleExecution 尾部直接调
maybeAutopilot + L1 通知，不等 20s tick；tick 降为兜底对账（对齐 dsh-superagent 原型
Passes 的「定时 + 命令触发即跑」混合模式）。心跳提议同理由「tick 扫」改「事件触发」。

**4.2 无人值守裁剪**（dsh 核心借鉴，**本节是无人值守执行的真前提**）：

- `ExecutorAdapter` 契约（runtime/adapters/types.ts:190）加必填能力
  `nonInteractiveArgs(): string[]`——13 家逐一审计非交互模式参数（codex approvalPolicy、
  claude permission-mode、各家 `--yes`/headless 等价物）。现状「权限闸全放行」≠「不卡死」：
  任一 CLI 无人时弹交互确认，autopilot 任务就挂到超时。dsh 的做法是三层封死
  （disallowedTools + canUseTool deny + elicitation decline）。
- 环境 scrub：automation 派发的子进程环境剔除 `KEY|PASSWORD|SECRET|TOKEN` 模式变量，
  任务显式声明才放行（dsh subprocess scrub 法）。
- 取消阶梯：abort → close → terminate → waitForExit，等**进程组**静止而非顶层退出；
  disposeGraceMs 默认 3000。
- 结果只认严格终态：不把「进程退出」当「任务完成」（校验成功子类型/非空/非 is_error）。

**4.3 防睡眠**（orca power/ 借鉴，此前全部方案的系统层漏洞）：executing>0 期间
`powerSaveBlocker`（Electron 主进程）+ 系统唤醒广播后补一次调度入口——否则 idleMinutes
等到深夜电脑睡了，autopilot 永远不跑。

## 5. 杂项借鉴（三期半）

| 项 | 借自 | 做法 | 落点 |
|---|---|---|---|
| precheck 条件门 | orca automations-types.ts:84 | 发火前跑一条命令，非 0 即 skip 且 skip 进历史；条件复杂化的出口是配置不是 if | autopilot/automation 派发前 |
| retry_of 尝试身份 | orca records.ts:302 | backlog_runs 加 retry_of 列；重试前 fence 检查旧会话活性（双占守卫显式化） | backlog_runs |
| 人的额外槽 | 原型 003 §Concurrency | 人的续聊占 maxConcurrent+1 槽；report 为 ready/blocked 时立即释槽 | maybeAutopilot 并发门 |
| IM 确认门 | §3.4 | 同三期 | channels |
| usage 时间窗归因 | orca automations-types.ts:58 | 按 sessionId+时间窗从 usage 事件切账 | backlog_runs.usage_json |

## 分期总表

| 期 | 内容 | 触及面 |
|---|---|---|
| 一期 | gate.ts + thread_key + subscriptions + 订阅直通 + channels 候选准入 | db.ts 两列迁移、inbox/、askBot.ts；不碰状态机 |
| 二期 | Report 协议 + blocked/dropped 态 + backlog_runs 五字段 + 两级通知 + 结算即唤醒 + 无人值守裁剪 + 防睡眠 | heartbeat.ts 结算链、adapters 契约、notifications、supervisor、electron 主进程 |
| 三期 | mandate + acceptMode(observe) + 分类器三硬规则 + assignment_json + IM 确认门 | classifier、routingBot 提示词、backlog.config、channels |
| 三期半 | precheck / retry_of / 人的额外槽 / usage 归因 | 调度门、db.ts |
| 暂缓 | Effects 副作用队列（先存后做/合并/退避） | 收益在重启丢失与通知合并，非功能性；已有「状态全落 DB」垫底 |

**第一刀**：一期第 3 条 gate() + 两列迁移——两个文件、不碰状态机，一周内见效
（「同一话题的后续话直接挂到任务下」），且是二期 Report 回源问话、三期 mandate 记
basis 的地基。同时当天可做：分类器提示词塞三硬规则（零代码改动）。

## 不做的事（负借鉴清单）

- **常驻 Router LLM 会话**：BacklogEngine（确定性 tick）+ routing bot（按需批量起会话）
  已是原型「Router 层部分不必调 LLM」的更省形态。
- **Policy 版本化 + Mandate 重验证**：单用户场景过重；mandate 只记录不重验。
- **per-ticket 大表单**：默认档 + 一屏覆盖为限（原型 "Few settings"）。
- **日报改 agent 行为**：supervisor 保持系统功能形态。
- **通用事件总线改造**：「结算即唤醒」以三个调用点达到目的，不动 wsd.ts 帧体系。

## 与既有决策的关系

- **ADR-0001**（引擎无权启动非 auto 待办）：不动。observe 模式是它的观察期补丁，
  不是废除。
- **docs/29**（清单契约）：零改动；thread_key/subscriptions 是纯新增。
- **docs/30**（双轴承诺语义）：不变。本文全部落在余量轴的执行与汇报面；
  L2 日报三节全空沉默原则原样保持。
- **dsh subagent 均为 one-shot 无续接**：moyubot 的 codex 常驻 thread + 时间盒续跑是
  超出参照系的能力，保持，不回退。

## 冒烟与检查（各期验收现象）

- **一期**：同一飞书话题再说一句 → 时间轴上不出现新条目，旧任务事件块内多一条追加
  （直通生效）；同文本重复提交 → `duplicate` 无新增；未 @bot 的群聊消息不进清单。
- **二期**：造一个会中途提问的任务 → IM 收到带 [回答] 按钮的 L1，状态带亮 blocked；
  例行 auto 任务完成 → IM 安静、日报 executed 行带一句话结果；执行中任务期间系统不睡眠；
  拔掉某执行器交互参数 → 审计清单里该项标红（nonInteractiveArgs 全家 13 项非空）。
- **三期**：observe 模式下分类器判 actionable → 清单出现「would auto-run」标记且
  autopilot 不动它；切 auto 后同类条目直接进队列；Telegram 上按按钮完成一次提议确认；
  assignment_json 在日报里能回答「这是按什么配置跑出来的」。
- **回归不变量**：daemon 重启后 executing 任务走 heal（现状不退化）；分类器 plan 模式
  与输出白名单零信任不变；三节全空日报整体沉默。

## 分工口诀

gate 管进门（幂等+直通），thread 管追认（后续直达不重判）；
report 管说话（blocked 会提问、dropped 会沉默），runs 管记账（一行落定五个字段）；
mandate 管授权（observe 先看后放），assignment 管配置（默认档+一屏覆盖）；
结算即唤醒（不等 tick），无人值守先断问路（nonInteractive 是前提），
通知只发要人动的事，其余全进日报。
