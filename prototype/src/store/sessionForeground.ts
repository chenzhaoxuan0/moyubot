import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type { RuntimeEvent } from "../core/events.ts";
import { useChatPanes } from "./useChatPanes.ts";

/**
 * 「对话页」派发的前台拉起安装器（docs/23）—— 与 installGitAutoRefresh 同款
 * store 层安装模式：App 挂载时装一次，多组件不重复订阅。
 *
 * daemon 侧 launchMode=chat 的自动化/待办到点后广播 `session.foreground`
 * （broadcast-only，不落账本）；这里把那个会话**开成/聚焦到对话窗格**
 * （docs/31 会话画布的幂等口径）：已有窗格就聚焦，没有就开标签 ——
 * 用户此刻停在终端窗格的话也会被带到对话窗格。
 *
 * 当前对话正「等回答/待输入」时 openSession 自己会拒绝并弹 warn 通知 ——
 * 前台拉起不抢裁决权，这正是想要的退化形态（会话照跑，事后从侧栏历史 / 通知中心点开）。
 */

let installed = false;

export function installSessionForeground(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const client = DaemonClient.get(defaultDaemonEndpoint());
  const onForeground = (e: RuntimeEvent): void => {
    if (e.type !== "session.foreground") return;
    useChatPanes.getState().openChatPane({
      unitId: String(e.unitId),
      sessionId: String(e.sessionId),
      runtimeId: String(e.runtimeId),
    });
  };
  const unsub = client.onEvent(onForeground);
  return () => {
    unsub();
    installed = false;
  };
}
