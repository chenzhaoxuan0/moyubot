---
name: agent-workbench
description: 操作 agent-workbench 工作台本身——用 aw CLI 驱动会话、定时任务、待办、git、通知、出图等全部操作面。当用户提到「工作台」「别的 bot」「待办」「定时 / 每天 / 自动跑」「通知」，或需要跨 bot 协作、查工作台状态时使用。
---

<!-- agent-workbench-skill: v3（daemon 维护，升级会覆盖；自定义请复制改名） -->

# agent-workbench —— 驾驶你所在的工作台

你正运行在 agent-workbench 的一台 bot 工作区里（本文件夹）。这台工作台本身
**可以被你操作**：GUI 能做的每件事，你都能用一条命令完成——包括指挥别的 bot。

## 入口（按优先级）

1. `aw`（在 PATH 则直接用；`aw --help` 看全部命令）
2. curl 兜底（零安装，任何执行器可用）：

```bash
TOKEN=$(cat ~/.agent-workbench/token)
curl -s -X POST http://127.0.0.1:5281/rpc -H "x-awb-token: $TOKEN" \
  -H "content-type: application/json" -d '{"v":1,"method":"health"}'
```

## 第一条命令：发现，不背诵

```bash
aw methods                 # 160+ 方法的自描述（说明 / 参数形状 / 危险标记），daemon 注册表实时生成
aw methods --domain git    # 按域过滤
```

任何操作先查 `aw methods`——它永远比任何文档（包括本技能）新。

## 高频动作

```bash
aw doctor                                              # 工作台健康自检
aw session chat --bot <id> --text "…" --attach 文件路径  # 指挥另一个 bot 干活（等它回话）
aw call notifications.list --json                      # 你不在时发生了什么（跨端通知事实源）
aw git status --root <路径>                             # 仓库状态
aw call memory.search --params '{"query":"…"}'         # 检索这台工作台的记忆
aw call memory.project.read --params '{"rootPath":"…"}'        # 读这个工作区的 MEMORY.md
aw call memory.project.write --params '{"rootPath":"…","content":"…"}'  # 写 MEMORY.md（备份+上限校验）
aw call context.user.read                              # 读全局 USER.md（用户级事实）
aw call bot.initWorkspace --params '{"rootPath":"…"}'  # 补齐工作区（memory 目录 + 官方技能 ×2）
aw call workbench.skill.sync                           # 官方技能升级兜底（agent-workbench + workbench-context）
aw call image.generate --params '{"profileId":"…","prompt":"…"}'  # 出图（结果落盘回路径）
aw events --session <sid> --follow                      # 实时跟随某个会话的事件流
```

## 定时任务与待办（你能建、能停、能管）

```bash
aw automation list                                     # 清单：#id 开关 下次触发 名字
aw automation add --unit <id> --root <路径> --runtime zcode \
                  --prompt "…" --in 30                 # 建定时任务：--in N 分钟后（一次性）
                                                       #   或 --at 2026-10-25T09:00（指定时刻）
                                                       #   或 --cron "0 9 * * 1-5"（循环，本地时区）
aw automation off --id 3                               # 停用（保留定义，不再触发）
aw automation on --id 3                                # 重新启用
aw automation run --id 3                               # 立即跑一次（不等调度）
aw automation runs --id 3                              # 运行记录（每次的终态与会话）
aw automation rm --id 3                                # 删除
aw call automation.update --params '{"id":3,"prompt":"…"}'   # 改定义（prompt/调度/执行方式等）

aw backlog list                                        # 待办清单
aw backlog add --goal "…" --unit <id> --root <路径>     # 登记一条待办（心跳确认门后执行）
aw backlog run --id 5                                  # 立即执行一条待办
aw backlog done --id 5                                 # 验收通过（仅「待验收」态）
aw backlog reject --id 5 --note "原因"                  # 验收打回，回就绪重新排队
```

## 纪律

- **stdout 只有数据**，诊断走 stderr；`--json` 拿机器口径；
  退出码 0 成功 / 2 用法错 / 3 RPC 错 / 4 传输错（daemon 不在或 401）。
- 危险面（daemon.stop、git.push、bot.put…）非交互不拦，`--yes` 跳过 TTY 确认。
- 定时任务 / 待办的 prompt 要**自包含**：直接描述最终工作、说明预期产出、
  无人值守期间没人回答问题；不得要求再建定时任务（总量上限 20 条）。
- token 与 GUI 等权（`~/.agent-workbench/token`，`AGENT_WORKBENCH_HOME` 可改家）——
  它就是钥匙，别写进日志、别外传。
- 本 SKILL.md 由 daemon 维护（见顶部版本标记行），升级会覆盖；想定制请复制一份改名。

## 什么时候用我

- 用户说「让 XX bot 做…」「看看通知 / 待办」「这台工作台…」
- 用户说「每天 / 每小时 / N 分钟后自动…」「定时…」「到时候提醒」——排定时任务
  （时刻循环用 --cron，一次性用 --in / --at）
- 你需要跨 bot 协作、查工作台状态、或对其他工作区做 git / 记忆操作
- 你想给用户登记待办、查刚才发生了什么、或发起一次出图
