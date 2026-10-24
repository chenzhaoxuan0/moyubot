import { useEffect } from "react";
import { WorkspaceShell } from "./WorkspaceShell.tsx";
import { installGitAutoRefresh } from "./store/gitAutoRefresh.ts";

export function App() {
  // git 状态自动刷新（docs/16）：daemon 广播 git.changed → 徽章 / 改动 / 面板
  // 三面收敛。App 生命周期内装一次（安装器内部幂等）
  useEffect(() => installGitAutoRefresh(), []);
  return <WorkspaceShell />;
}
