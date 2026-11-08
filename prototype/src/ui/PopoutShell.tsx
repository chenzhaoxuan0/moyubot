import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import { adoptTermRow, type CanvasPane, type DaemonTermRow } from "../store/useTerminalStore.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { asSessionId, asUnitId } from "../core/units.ts";
import { runtimeIdOfSession } from "../store/useChatPanes.ts";
import { parsePopoutRoute } from "../store/useCanvasPopouts.ts";
import { useChatAccentStyle } from "./useChatAccentStyle.ts";
import { TerminalPaneSlot } from "./TerminalPaneSlot.tsx";
import { Timeline } from "./Timeline.tsx";
import { Composer } from "./Composer.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { cn } from "./cn.ts";

/**
 * 会话画布弹出窗口壳（docs/31 三期）—— `#/popout/...` 路由下的精简顶层：
 * 只有一个窗格 + 自绘拖拽头/关闭钮（window.close() 对 JS 打开的窗口两栖可用，
 * Electron 与浏览器一致）。不装 WorkspaceShell 的任何全局机制（路由镜像 /
 * 通知 / 布局持久化）——它是别人窗口里的一片叶子，不是工作台。
 *
 * 关闭通告：beforeunload 向 opener postMessage 自身 URL，主窗口按 URL 对账
 * 重认领（终端 readoptTerminal / 对话 openChatPane），不依赖它的内存台账。
 */

export type PopoutRoute =
  | { kind: "terminal"; terminalId: string }
  | { kind: "chat"; unitId: string; sessionId: string | null };

export function PopoutShell({ route }: { route: PopoutRoute }) {
  // 关闭通告：挂载即装、卸载即拆。窗口关闭时 beforeunload 先于 React 卸载触发，
  // 拆监听不影响通告送达；拆是为了 StrictMode 双挂 / 路由内重挂时不叠两份监听
  useEffect(() => {
    const onBeforeUnload = (): void => {
      try {
        window.opener?.postMessage({ type: "awb:canvas-popout-closed", url: window.location.href }, "*");
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const title =
    route.kind === "terminal" ? "终端窗格" : route.sessionId === null ? "新对话" : "对话窗格";

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-canvas text-ink select-none">
      {/* 自绘窗口头：拖拽热区（Electron 无边框子窗）+ 标题 + 关闭 */}
      <header className="titlebar-drag flex h-9 shrink-0 items-center justify-between border-b border-line/60 bg-rail px-3">
        <span className="truncate text-caption text-graphite">{title}</span>
        <button
          onClick={() => window.close()}
          aria-label="关闭窗口（内容会自动回到工作台标签栏）"
          title="关闭窗口（内容会自动回到工作台标签栏）"
          className="titlebar-no-drag rounded-btn p-1 text-ash transition hover:bg-rose-500/20 hover:text-rose-400"
        >
          <X size={13} />
        </button>
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col">
        {route.kind === "terminal" ? (
          <TerminalPopout terminalId={route.terminalId} />
        ) : (
          <ChatPopout unitId={route.unitId} sessionId={route.sessionId} />
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------- 终端弹出 */

/**
 * 终端窗格弹出：按 terminalId 从 daemon 台账重认领（subscribe + scrollback
 * 回放——与 F5 重挂同一套语义）。轮询台账发现 PTY 退出 → 就地展示「已退出」。
 */
function TerminalPopout({ terminalId }: { terminalId: string }) {
  const [inst, setInst] = useState<CanvasPane | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const client = DaemonClient.get(defaultDaemonEndpoint());
        await client.ensureConnected().catch(() => {});
        const list = await client.rpc<DaemonTermRow[]>("terminal.list", null, 10000);
        if (!alive) return;
        const row = list.find((t) => t.terminalId === terminalId);
        if (row === undefined) {
          setDead(true);
          return;
        }
        setInst((prev) => prev ?? adoptTermRow(row, useWorkbench.getState().units));
      } catch {
        /* daemon 抖动：下轮再试 */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [terminalId]);

  if (dead) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-body-sm text-ink font-medium">终端已退出</p>
        <p className="text-caption text-ash">进程结束了 —— 关掉这个窗口即可（无需归拢）。</p>
      </div>
    );
  }
  if (inst === null) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-caption text-ash">正在连接终端…</div>;
  }
  return <TerminalPaneSlot pane={inst} />;
}

/* ------------------------------------------------------------- 对话弹出 */

/** 对话窗格弹出：等 units 就位 → selectUnit →（有段则）openSession 谱系重放 */
function ChatPopout({ unitId, sessionId }: { unitId: string; sessionId: string | null }) {
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  const unit = useWorkbench(selectActiveUnit);
  const accentStyle = useChatAccentStyle();

  useEffect(() => {
    let alive = true;
    void (async () => {
      // units 由 useWorkbench 的模块级 bootstrap 加载；弹窗只等它到位
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && useWorkbench.getState().units.every((u) => u.id !== unitId)) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!alive) return;
      const exists = useWorkbench.getState().units.some((u) => u.id === unitId);
      if (!exists) {
        setMissing(true);
        return;
      }
      useWorkbench.getState().selectUnit(asUnitId(unitId));
      if (sessionId !== null) {
        // runtimeId 从台账查（openSession 必填）；查不到就留在 bot 空态，输入框首发即开新段
        const runtimeId = await runtimeIdOfSession(sessionId);
        if (runtimeId !== null && alive) {
          await useWorkbench.getState().openSession({
            sessionId: asSessionId(sessionId),
            unitId: asUnitId(unitId),
            runtimeId,
          });
        }
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [unitId, sessionId]);

  if (missing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-body-sm text-ink font-medium">找不到这个 bot</p>
        <p className="text-caption text-ash">它可能已被删除。关掉这个窗口即可。</p>
      </div>
    );
  }

  return (
    <div
      className={cn("chat-conversation-root relative flex min-h-0 flex-1 flex-col", !ready && "opacity-60")}
      style={accentStyle}
    >
      <Timeline />
      <PermissionDialog />
      <Composer />
    </div>
  );
}
