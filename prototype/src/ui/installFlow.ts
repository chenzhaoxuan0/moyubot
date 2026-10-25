/**
 * 安装 / 升级的终端派发与完成监听 —— 设置页安装卡、升级条、零就绪引导横幅共用。
 *
 * 派发不再赌定时器：createTab 只是把标签写进 store，真正的 PTY 要等 React 挂载
 * TerminalSession、daemon 起好 shell 才存在。固定 800ms 后注入赌的是运气，
 * PTY 慢半拍命令就注进空气里。daemon 推来的第一帧（created/data）才是
 * 「终端真的活着」的信号；等不到也有兜底超时，超时后照样补注一次 ——
 * 命令文本同时躺在剪贴板里，用户手动粘贴也有退路。
 */

import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type { ConnectionState } from "../core/adapter.ts";
import { runtimeRegistry } from "../core/registry.ts";
import { asRuntimeId } from "../core/units.ts";
import { useShell } from "../store/useShell.ts";
import { useTerminalStore } from "../store/useTerminalStore.ts";
import { useWorkbench } from "../store/useWorkbench.ts";

/** 注入命令前等首帧的兜底上限：真等不到（PTY 起不来 / WS 断了）也别把调用方挂死 */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

/** 首帧之后的小缓冲：prompt 通常就在第一段 data 里，但慢机器上偶尔分两段 */
const SETTLE_MS = 200;

export async function dispatchTerminalCommand(cmd: string, title: string): Promise<string> {
  // 剪贴板兜底：注入失败时用户还有一条手动粘贴的退路
  void navigator.clipboard?.writeText(cmd).catch(() => {});
  const termId = useTerminalStore.getState().createTab({ profileId: "pwsh", title });
  // 关设置页切到终端，让用户直接看安装输出（原行为，保留）
  useShell.getState().closeSettings();

  const client = DaemonClient.get(defaultDaemonEndpoint());
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      setTimeout(resolve, SETTLE_MS);
    };
    const off = client.onTerminalFrame((f) => {
      if (f.terminalId === termId && (f.kind === "created" || f.kind === "data")) finish();
    });
    const timer = setTimeout(finish, FIRST_FRAME_TIMEOUT_MS);
  });
  await client.rpc("terminal.input", { terminalId: termId, data: `${cmd}\r` }).catch(() => {});
  return termId;
}

/**
 * 安装完成监听：轮询单家探测，直到状态离开 not_installed（或超时放弃）。
 *
 * 为什么不用终端 exit 帧：安装命令注入的是**常驻 shell**，命令结束 shell 不退出，
 * exit 帧永远不来。为什么不在输出里找完成标记：pwsh 与 bash 的引号拼接规则不同，
 * 命令回显还会先于执行包含标记文本，误判面比收益大。轮询 probe（一次
 * `--version` 子进程，零 token 零计费）最笨但最可靠：5 秒一轮、5 分钟封顶、
 * 状态一翻就停；装完了 UI 徽标就地翻绿，没装完静默退出不扰民。
 *
 * @returns 翻转后的状态；null = 到超时仍是未安装
 */
export async function watchRuntimeProbeUntilResolved(
  bareId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<ConnectionState["status"] | null> {
  const fullId = bareId.startsWith("daemon:") ? bareId : `daemon:${bareId}`;
  const runtimeId = asRuntimeId(fullId);
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (Date.now() >= deadline) return null;
    try {
      const adapter = await runtimeRegistry.getOrCreate(runtimeId);
      const probe = await adapter.probe();
      if (probe.state.status === "not_installed") continue;
      runtimeRegistry.setState(runtimeId, probe.state);
      // 新装的执行器第一次被看见 —— 模型清单也跟一轮。注册快照里只有内置兜底
      // 的 3 条模型，不刷的话界面会把兜底清单当全部家当展示
      void useWorkbench.getState().syncModelsAll();
      return probe.state.status;
    } catch {
      // daemon 暂不可达 / 探测异常 —— 继续下一轮，别把整个监听掐死
    }
  }
}
