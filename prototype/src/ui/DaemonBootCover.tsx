import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";

/**
 * daemon 启动遮罩 —— 启动竞态的可见化（app.tsx 挂在 WorkspaceShell 之上）。
 *
 * pnpm dev 下 vite 页面先出、daemon 后就绪是常态：没有这层遮罩时窗口期侧栏 /
 * 设置页全是空的，看起来像坏了。有它，「空」变成明确的「正在连」。
 *
 * 两个时间窗，都是组件本地计时（状态机真相仍在 store 的 daemonStatus）：
 * - 延迟 250ms 才显示：daemon 已在跑时（HMR 整页重载 / 二次打开）首轮重试
 *   百来毫秒就连上，不延迟会每次都闪一下遮罩再进界面；
 * - 8s 后自动收起：daemon 迟迟不来（比如只起了前端）时不能把人挡在界面外
 *   ——收起后由底栏 DaemonLinkBadge 接棒提示「连接中 / 未连接」，不挡操作。
 */
export function DaemonBootCover() {
  const status = useWorkbench((s) => s.daemonStatus);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== "connecting") return;
    const t = setInterval(() => setElapsed((ms) => ms + 250), 250);
    return () => clearInterval(t);
  }, [status]);

  if (status !== "connecting" || elapsed < 250 || elapsed >= 8000) return null;

  return (
    <div
      aria-label="正在连接本地 daemon"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-canvas-solid"
    >
      <Loader2 size={18} className="animate-spin text-teal" />
      <div className="text-body-sm text-ink">正在连接本地 daemon…</div>
      <div className="text-caption text-ash">等待后端就绪，执行器与 bot 清单就位后自动进入</div>
    </div>
  );
}
