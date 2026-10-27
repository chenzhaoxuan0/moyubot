# 26 · 会话分享（导出 / 导入）

> 2026-10-28 引入。侧栏会话右键「分享 / 导出」把整条会话的执行历史打包成
> `.awb.json` 文件：可存到电脑本地，也可传给别的机器（执行器/工作台）在
> 设置 → 历史会话 → 从分享文件导入，导入即**完整回放**。灵感来自 T3 Code 的
> 会话链接分享，但实现路线是「文件即数据」——T3 没有（也不做）整线程导出，
> 它分享的是 prompt link；我们能做全量导出是因为轨迹账本本身就是全量
> RuntimeEvent 流。

## 一、需求与口径

- 单条会话 → 一个文件；文件跨机器传递（网盘/IM/拷盘均可），接收方导入后
  消息/工具卡/思考/用量全部回放——不是摘要 handoff，是原样时间线。
- 导出 = 「保存到电脑本地」或传给别的执行器环境，两种诉求同一个文件。
- 导入后继续对话：原生续跑（cliRef）跨机器不可能，继续走既有
  conversation_id **换代开新段**（ADR 0012），与现有 imp_ 导入行为一致，
  无新逻辑。

## 二、格式：awb-session bundle（v1）

```jsonc
{
  "v": 1,                       // 版本号；解析端遇到更高版本直接拒绝并提示升级
  "format": "awb-session",
  "exportedAt": 1730000000000,
  "exportedBy": "agent-workbench",
  "session": {                  // 台账行快照（originId/runtimeId/rootPath/stats…）
    "originId": "sess_xxx", "title": "…", "runtimeId": "claude",
    "rootPath": "C:/repo", "source": "workbench",
    "startedAt": 0, "endedAt": 0, "turnCount": 3, "stats": { … }
  },
  "messages": [ { "at": 0, "role": "user", "text": "…" } ],
  "events":   [ { "seq": 1, "at": 0, "event": { /* RuntimeEvent 原样 */ } } ]
}
```

- 版本纪律沿 trace.ts 的文件头升版口径：演进靠升 `v`，行内容不重排。
- 规模闸（防手工拼的巨型文件把导入 RPC 卡成 DoS）：events ≤ 200k、
  messages ≤ 50k、正文 ≤ 512MB（`backend/src/history/shareImport.ts`）。

## 三、导出链路

- RPC `session.export`（backend/src/index.ts）：`store.getSession` +
  `store.listMessages` + `traceSink.readSessionNdjson`（容错读，坏行跳过）
  → `buildSharedBundle`。
- 前端（Sidebar 右键菜单「分享 / 导出」）：`exportSession` → `saveTextFile`
  （prototype/src/ui/fileSave.ts）——桌面端走 Electron `dialog:save-file`
  （preload `saveFile`，主进程写盘，app:// 下渲染进程没有 fs 权限），
  纯浏览器回落 Blob 下载。
- 文件名 `<标题>-<YYYYMMDD>.awb.json`。

## 四、导入链路

- RPC `session.importFile`（params: `{bundle, unitId}`）：
  - `parseSharedBundle` 校验形状/版本/规模 → `importSharedSession`：
  - 台账行：id = `impf_<originId>`（**impf_ 前缀刻意不落入 imp_ 隐式解析空间**，
    sync.ts 的 parseImplicitSessionId 只认 imp_）；source = `"shared"`
    （SESSION_SOURCE_LABEL → 「分享」）；**cliRef 剥离**；status = done；
    谱系/分叉列落 null（本机谱系 id 跨机器无意义）。
  - messages 逐条 `insertMessage`；events `projectSharedEvents` 重放：
    seq 重排 1..n、sessionId 换新行 id、`messageId`/`callId` 加 `impf_N`
    前缀重写（**同一原 id 恒映射同一新 id**——message.delta↔completed、
    tool.started↔completed 的配对因此保持），`traceSink.appendMany` 一次落账。
  - 幂等：同 originId 重复导入返回 `{imported:false, reason:"exists"}`；
    收编 `host.adoptPersisted`（执行器本机未装时失败不影响侧栏/回放）。
- 前端（设置 → 历史会话 → 从分享文件导入，ImportSharedSection.tsx）：
  选文件 → 预览（标题/执行器/起止/规模/rootPath）→ 目标 bot 按 rootPath
  自动匹配高亮可手改 → 导入 → 置顶（`pinKeys`）+ `awb:history-refresh` 广播
  （与外部会话导入同款收尾）。

## 五、安全注意

导出文件是明文 JSON，含完整执行历史（工具输出里可能有文件内容、路径、
密钥形态的字符串）。分享前自行确认内容可外传——与导出聊天记录同级的
常识约束，不做脱敏（脱敏会破坏「完整回放」的立身之本）。
