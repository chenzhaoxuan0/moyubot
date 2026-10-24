import { useEffect } from "react";
import { WorkspaceShell } from "./WorkspaceShell.tsx";
import { installGitAutoRefresh } from "./store/gitAutoRefresh.ts";
import { installSessionForeground } from "./store/sessionForeground.ts";

export function App() {
  // git 状态自动刷新（docs/16）：daemon 广播 git.changed → 徽章 / 改动 / 面板
  // 三面收敛。App 生命周期内装一次（安装器内部幂等）
  useEffect(() => installGitAutoRefresh(), []);
  // 「对话页」派发的前台拉起（docs/23）：daemon 广播 session.foreground →
  // 把到点的自动化/待办会话打开到聊天时间线前台
  useEffect(() => installSessionForeground(), []);
  return <WorkspaceShell />;
}
