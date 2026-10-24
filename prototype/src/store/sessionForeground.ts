import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type { RuntimeEvent } from "../core/events.ts";
import { useShell } from "./useShell.ts";
import { useWorkbench } from "./useWorkbench.ts";

/**
 * 「对话页」派发的前台拉起安装器（docs/23）—— 与 installGitAutoRefresh 同款
 * store 层安装模式：App 挂载时装一次，多组件不重复订阅。
 *
 * daemon 侧 launchMode=chat 的自动化/待办到点后广播 `session.foreground`
 * （broadcast-only，不落账本）；这里把那个会话打开到聊天时间线前台：
 * openSession 自带跨 bot 切换（selectUnit + selectRuntime + 谱系回放），
 * 再把对话视图切到 chat —— 用户此刻停在终端视图的话也要被带到对话页。
 *
 * 当前对话正「等回答/待输入」时 openSession 自己会拒绝并弹 warn 通知 ——
 * 前台拉起不抢裁决权，这正是想要的退化形态（会话照跑，事后从历史/任务栏点开）。
 */

let installed = false;

export function installSessionForeground(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const client = DaemonClient.get(defaultDaemonEndpoint());
  const onForeground = (e: RuntimeEvent): void => {
    if (e.type !== "session.foreground") return;
    useShell.getState().setConversationView("chat");
    void useWorkbench.getState().openSession({
      sessionId: e.sessionId,
      unitId: e.unitId,
      runtimeId: e.runtimeId,
    });
  };
  const unsub = client.onEvent(onForeground);
  return () => {
    unsub();
    installed = false;
  };
}
