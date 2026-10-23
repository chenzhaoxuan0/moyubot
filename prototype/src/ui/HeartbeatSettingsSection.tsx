import { useEffect, useState } from "react";
import { HeartPulse } from "lucide-react";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { NumField } from "./NumField.tsx";
import { cn } from "./cn.ts";

/**
 * 设置页「心跳」分区 —— 心跳参数的正式入口（此前只藏在待办页头部的弹层里）。
 * 只搬心跳组：余量 / 统合 / 飞书与待办强相关，仍在待办页的「心跳与余量设置」里。
 * 权威在 daemon 的 backlog kv（backlog.config.set），daemon 侧负责钳制与生效。
 */

const inputCls =
  "w-full rounded-input border border-line bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal";

export function HeartbeatSettingsSection() {
  const config = useBacklog((s) => s.config);
  const state = useBacklog((s) => s.state);
  const saveConfig = useBacklog((s) => s.saveConfig);
  const refresh = useBacklog((s) => s.refresh);
  const runtimes = useWorkbench((s) => s.runtimes);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (config === null) void refresh();
  }, [config, refresh]);

  if (config === null) {
    return <p className="text-body-sm text-ash">后台未连接 —— 心跳配置由 daemon 保管，连上后在这里显示。</p>;
  }
  const hb = config.heartbeat;

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    await saveConfig(patch);
    setBusy(false);
  };

  const hbRuntimes = ["", ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))];

  return (
    <div className="space-y-5 text-body-sm">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HeartPulse size={14} className="text-teal" />
          <h2 className="font-medium text-ink">心跳</h2>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
            <input
              type="checkbox"
              checked={hb.enabled}
              disabled={busy}
              onChange={(e) => void save({ heartbeat: { ...hb, enabled: e.target.checked } })}
              className="accent-teal"
            />
            启用
          </label>
        </div>
        <p
          className="text-caption leading-relaxed text-graphite"
          title="心跳是周期性的检查循环：空闲且有余量时，评估要不要提议启动某条待办。任何启动都要经确认门（你点同意才动）；状态为「工作中 / 强制忙碌」时心跳让位，待办不会被自动提议。"
        >
          心跳是周期性的检查循环：空闲时评估是否提议启动待办，启动经确认门。
        </p>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <NumField
            label="心跳周期（分钟）"
            hint="多久跑一轮检查（5 - 1440）"
            value={hb.intervalMinutes}
            min={5}
            max={1440}
            disabled={busy}
            onSave={(n) => void save({ heartbeat: { ...hb, intervalMinutes: n } })}
          />
          <NumField
            label="空闲阈值（分钟）"
            hint="距你最近活动超过 N 分钟才算空闲（1 - 1440）"
            value={hb.idleMinutes}
            min={1}
            max={1440}
            disabled={busy}
            onSave={(n) => void save({ heartbeat: { ...hb, idleMinutes: n } })}
          />
          <NumField
            label="提议超时（分钟）"
            hint="提议摆出 N 分钟没被处理即视为本次忽略（1 - 120）"
            value={hb.proposalTimeoutMinutes}
            min={1}
            max={120}
            disabled={busy}
            onSave={(n) => void save({ heartbeat: { ...hb, proposalTimeoutMinutes: n } })}
          />
          <NumField
            label="连续忽略上限（次）"
            hint="连续被忽略 N 次的待办进入休眠，不再主动提议（1 - 10）"
            value={hb.maxIgnoreCount}
            min={1}
            max={10}
            disabled={busy}
            onSave={(n) => void save({ heartbeat: { ...hb, maxIgnoreCount: n } })}
          />
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="block text-body-sm text-ink" title="建议指到有冗余的订阅执行器。">
              心跳会话的执行器
            </span>
            <select
              value={hb.runtimeId}
              disabled={busy}
              onChange={(e) => void save({ heartbeat: { ...hb, runtimeId: e.target.value } })}
              className={inputCls}
            >
              {hbRuntimes.map((id) => (
                <option key={id} value={id}>
                  {id === "" ? "（跟随心跳 bot 的主绑定）" : id}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="block text-body-sm text-ink">模型（缺省跟随执行器）</span>
            <ModelSelect
              runtimeId={`daemon:${hb.runtimeId}`}
              value={hb.model ?? ""}
              onChange={(v: string) => void save({ heartbeat: { ...hb, model: v === "" ? null : v } })}
              className={inputCls}
              disabled={busy || hb.runtimeId === ""}
            />
          </label>
        </div>
      </section>

      <section className="space-y-1.5 rounded-card border border-line bg-rail/60 p-3 text-caption leading-relaxed text-graphite">
        <p className="font-medium text-ink">当前节拍</p>
        {state?.heartbeatEnabled ? (
          <p>
            心跳运行中
            {state.nextBeatAt !== null && (
              <> · 下次心跳 {new Date(state.nextBeatAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</>
            )}
            {state.lastBeatOutcome !== null && <> · 上次结果：{state.lastBeatOutcome}</>}
          </p>
        ) : (
          <p>心跳未启用 —— 待办只会在你手动执行或自动化触发时运行，不会被提议。</p>
        )}
        <p className={cn("text-[10px] text-ash", busy && "text-teal")}>
          {busy ? "保存中…" : "改动即时生效：配置写入 daemon 的 backlog kv，下一轮心跳按新节拍跑。"}
        </p>
      </section>
    </div>
  );
}
