import { useEffect } from "react";
import { WorkspaceShell } from "./WorkspaceShell.tsx";
import { DaemonBootCover } from "./ui/DaemonBootCover.tsx";
import { installGitAutoRefresh } from "./store/gitAutoRefresh.ts";

export function App() {
  // git 状态自动刷新（docs/16）：daemon 广播 git.changed → 徽章 / 改动 / 面板
  // 三面收敛。App 生命周期内装一次（安装器内部幂等）
  useEffect(() => installGitAutoRefresh(), []);
  return (
    <>
      {/* daemon 启动遮罩：连接就绪前盖住整窗（见组件头注释），Shell 照常在底下挂载预热 */}
      <DaemonBootCover />
      <WorkspaceShell />
    </>
  );
}
