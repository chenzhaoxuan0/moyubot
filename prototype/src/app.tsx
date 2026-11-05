import { useEffect } from "react";
import { WorkspaceShell } from "./WorkspaceShell.tsx";
import { PopoutShell, type PopoutRoute } from "./ui/PopoutShell.tsx";
import { parsePopoutRoute } from "./store/useCanvasPopouts.ts";
import { installGitAutoRefresh } from "./store/gitAutoRefresh.ts";
import { installSessionForeground } from "./store/sessionForeground.ts";

/**
 * 是否处于「会话画布弹出窗」形态（docs/31 三期）：#/popout/... 路由下渲染
 * 精简的 PopoutShell（单窗格 + 自绘头），不装任何工作台全局机制。
 * useState 初始化一次：hash 不会在运行中变进出 popout 形态（那必然是 reload）。
 */
function useIsPopout(): boolean {
  return parsePopoutRoute(window.location.hash) !== null;
}

export function App() {
  const isPopout = useIsPopout();
  // git 状态自动刷新（docs/16）：daemon 广播 git.changed → 徽章 / 改动 / 面板
  // 三面收敛。App 生命周期内装一次（安装器内部幂等）。弹出窗不装——它是
  // 叶子不是工作台，git 面板不在它的世界里
  useEffect(() => {
    if (isPopout) return;
    return installGitAutoRefresh();
  }, [isPopout]);
  // 「对话页」派发的前台拉起（docs/23）：daemon 广播 session.foreground →
  // 把到点的自动化/待办会话打开到聊天时间线前台。弹出窗不装——前台拉起
  // 该落主窗口的画布，不该把弹窗顶掉
  useEffect(() => {
    if (isPopout) return;
    return installSessionForeground();
  }, [isPopout]);

  if (isPopout) {
    const route = parsePopoutRoute(window.location.hash);
    if (route !== null) return <PopoutShell route={route} />;
  }
  return <WorkspaceShell />;
}
