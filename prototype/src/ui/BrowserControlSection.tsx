import { useCallback, useEffect, useState } from "react";
import type { BrowserControlState } from "../core/control.ts";
import {
  controlTime,
  getBrowserControl,
  setBrowserChannel,
  setBrowserEnabled,
  setBrowserMode,
  startSharedChrome,
  stopSharedChrome,
} from "../store/useControl.ts";
import { GroupCard, SettingsRow, Toggle } from "./SettingsPage.tsx";

/**
 * 浏览器控制分区（docs/14 §2）—— playwright-mcp 的扇出开关与模式管理。
 *
 * 工作台不内置浏览器：启用 = 把官方 playwright-mcp 条目写进各执行器原生配置
 * （mcpadmin 外科手术式写入，「MCP 服务」分区里能看到同名条目）；执行器内的
 * 具体 click/type 不经过 daemon，动作日志只记工作台侧事件（模式切换 / 条目
 * 写入 / 共享 Chrome 生命周期），这是诚实边界，UI 上写明。
 */
export function BrowserControlSection() {
  const [state, setState] = useState<BrowserControlState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 计数而非布尔：重叠操作时第一个 finally 不该提前解锁（评审收敛）
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;

  const refresh = useCallback(() => {
    getBrowserControl()
      .then(setState)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // 打开期间 5s 轮询（共享 Chrome 状态 / 动作日志尾巴）；分区关闭即停
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = (label: string, fn: () => Promise<BrowserControlState>): void => {
    setBusyCount((c) => c + 1);
    setErr(null);
    fn()
      .then(setState)
      .catch((e) => setErr(`${label}失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusyCount((c) => Math.max(0, c - 1)));
  };

  const cfg = state?.config;
  const shared = state?.sharedChrome;

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        工作台不内置浏览器：启用后把官方 <span className="font-mono text-ink">playwright-mcp</span> 写进
        每个执行器的原生 MCP 配置，所有执行器的模型都获得 browser_* 工具。
        条目在「MCP 服务」分区可见可管（真相源仍是各家原生配置文件）。
      </p>

      <GroupCard>
        <SettingsRow
          label="启用浏览器控制"
          description="一键扇出到全部受支持执行器（12 家写原生配置；dsh 随会话动态注入）。停用 = 条目移入停用库，可随时恢复。"
          control={<Toggle on={cfg?.enabled === true} disabled={busy} onChange={(v) => run("启用切换", () => setBrowserEnabled(v))} />}
        />
        <SettingsRow
          label="模式"
          description="隔离 = 每执行器独立持久 profile（登录态按执行器保留）；接管 = 全执行器共享一个由工作台拉起的 Chrome（登录态互通）"
          control={
            <select
              value={cfg?.mode ?? "isolated"}
              disabled={busy}
              onChange={(e) => run("模式切换", () => setBrowserMode(e.target.value as "isolated" | "takeover"))}
              className="h-8 rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none"
            >
              <option value="isolated">隔离</option>
              <option value="takeover">接管（共享 Chrome）</option>
            </select>
          }
        />
        {cfg?.mode === "isolated" && (
          <SettingsRow
            label="浏览器通道"
            description="直接使用系统已装的浏览器，零下载（Windows 每机必有 Edge）"
            control={
              <select
                value={cfg?.browser ?? "msedge"}
                disabled={busy}
                onChange={(e) => run("通道切换", () => setBrowserChannel(e.target.value as "msedge" | "chrome"))}
                className="h-8 rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none"
              >
                <option value="msedge">Edge（msedge）</option>
                <option value="chrome">Chrome（chrome）</option>
              </select>
            }
          />
        )}
        {cfg?.mode === "takeover" && (
          <SettingsRow
            label="共享 Chrome"
            description={
              shared?.running === true
                ? `运行中 @127.0.0.1:${shared.port}（${shared.kind === "edge" ? "Edge 兜底" : "Chrome"}，调试端点已就绪）`
                : shared?.lastError != null
                  ? `未运行：${shared.lastError}`
                  : shared?.exitReason != null
                    ? `已停止：${shared.exitReason}`
                    : "未运行（接管模式需要它活着，各执行器才连得上）"
            }
            control={
              <div className="flex gap-2">
                <button
                  onClick={() => run("启动共享 Chrome", startSharedChrome)}
                  disabled={busy || shared?.running === true}
                  className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
                >
                  启动
                </button>
                <button
                  onClick={() => run("停止共享 Chrome", stopSharedChrome)}
                  disabled={busy || shared?.running !== true}
                  className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-line-soft disabled:opacity-40"
                >
                  停止
                </button>
              </div>
            }
          />
        )}
      </GroupCard>

      <FanoutCard state={state} />
      <ActionLogCard actions={state?.actions ?? []} />

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}
    </div>
  );
}

/** 扇出结果 + 特例说明（dsh 动态注入 / sdk-bridge 不支持）—— 电脑控制分区复用 */
export function FanoutCard({ state }: { state: { fanout: readonly { executorId: string; ok: boolean; error?: string }[]; notes: readonly { executorId: string; note: string }[] } | null }): React.JSX.Element | null {
  if (state === null) return null;
  const okCount = state.fanout.filter((o) => o.ok).length;
  return (
    <GroupCard>
      <div className="px-4 pb-2.5 pt-3">
        <p
          className="text-caption font-medium text-graphite"
          title="条目按执行器分别写入原生配置（隔离模式的 profile 目录逐家不同）。"
        >
          扇出状态
        </p>
      </div>
      <div className="space-y-1 px-4 pb-3">
        {state.fanout.length === 0 && (
          <p className="text-caption text-ash">尚未扇出（启用后这里显示逐家写入结果）。</p>
        )}
        {state.fanout.length > 0 && (
          <p className="text-caption text-graphite">{okCount}/{state.fanout.length} 家写入成功</p>
        )}
        {state.fanout
          .filter((o) => !o.ok)
          .map((o) => (
            <p key={o.executorId} className="text-caption text-loss">
              {o.executorId}：{o.error}
            </p>
          ))}
        {state.notes.map((n) => (
          <p key={n.executorId} className="text-caption text-ash">
            {n.executorId}：{n.note}
          </p>
        ))}
      </div>
    </GroupCard>
  );
}

/** 动作日志卡片（两分区共用） */
export function ActionLogCard({ actions }: { actions: readonly { seq: number; at: number; action: string; detail: string }[] }): React.JSX.Element {
  const tail = [...actions].reverse().slice(0, 30);
  return (
    <GroupCard>
      <div className="px-4 pb-2.5 pt-3">
        <p
          className="text-caption font-medium text-graphite"
          title="只记工作台可见的事件：配置变更、条目写入、生命周期、工具调用（电脑控制）。"
        >
          动作日志（工作台侧事件，最近 30 条）
        </p>
      </div>
      <div className="max-h-56 overflow-y-auto px-4 pb-3">
        {tail.length === 0 && <p className="py-2 text-caption text-ash">（暂无）</p>}
        {tail.map((a) => (
          <p key={a.seq} className="border-t border-line-soft py-1.5 text-caption leading-relaxed text-graphite first:border-t-0">
            <span className="tnum text-ash">{controlTime(a.at)}</span>{" "}
            <span className="font-mono text-ink">{a.action}</span>
            <span className="text-ash"> · </span>
            {a.detail}
          </p>
        ))}
      </div>
    </GroupCard>
  );
}
