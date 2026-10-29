# 待办独立建表，复用 automation 执行链路

GTD 待办（目标导向、心跳提议、确认门放行）不扩展 `automations` 表，而是建独立的待办表，状态机（草稿/就绪/待确认/执行中/待验收/完成/休眠 + 忽略计数）全部落 DB；但执行层完全复用 automation 的 headless 会话链路（`host.startSession`、运行历史、`healAutomationRuns` 式重启自愈），运行记录标记 GTD 来源。理由：待办的状态机比定时任务复杂一个量级（确认门、验收、休眠计数），塞进 `automations` 两边都拧巴；而执行层复用意味着不新造进程模型。产品定位（2026-10 设计共识）：待办与定时任务是"同一台执行机器的两种触发方式"——待办是给定目标下的 agent 自主性，定时任务是给定过程下的 agent 执行。

## Considered Options

- **扩展 `automations` 表加触发类型**：看似更省（调度器、表结构都现成），被否——`next_run_at` 是时间驱动的权威字段，而待办由条件（空闲+余量）驱动，且待办多出确认/验收/休眠等生命周期态，硬塞会导致两套语义互相污染。

## Consequences

- UI 上待办是独立清单页，与定时任务页并存；"待确认"等中间态必须落 DB（不能像 `automationRunBySession` 那样只靠内存映射），否则 daemon 重启会丢确认门状态。

## Amendment（2026-10-29，feat/context-inbox）

「确认门 = 任何待办启动前必须用户明确同意」在本修订后收敛为**按条目区分**：
`backlog_items` 新增 `auto` 列，`auto=true` 的条目由闲时自动执行（autopilot）在
空闲且余量足够时**直接派发**，不进确认门，跑完按 `autopilot.autoReview` 自动验收
—— 这是「清单（inbox）分类沉淀的任务由 agent 在闲置用量里持续完成」的产品语义
（docs/29）。`auto=false` 的条目照旧走心跳提议 + 用户确认，铁规则原样保留；
心跳候选过滤掉 auto 条目（不重复提议）。

派发面同时新增 `target_session_id`（指定已有会话执行，接不上回落新开），其余
执行链路（headless 复用、运行记录、重启自愈）不变。
