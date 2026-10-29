import { useState, type ReactElement } from "react";
import { HeartPulse, RefreshCw, Settings2, Zap } from "lucide-react";
import type { BacklogConfig } from "../core/backlog.ts";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { NumField } from "./NumField.tsx";
import { railInputCls } from "./WorklistBits.tsx";
import { cn } from "./cn.ts";

/** 待办设置弹窗（心跳 / 余量 / 统合 / 飞书，原 BacklogPage 内嵌弹窗独立成文件）。
 * 闲时自动执行（autopilot）的启用开关在右栏待办栏头，这里只留参数。 */

export function BacklogSettings({ onClose }: { onClose: () => void }): ReactElement {
  const config = useBacklog((s) => s.config);
  const saveConfig = useBacklog((s) => s.saveConfig);
  const refreshQuotas = useBacklog((s) => s.refreshQuotas);
  const consolidate = useBacklog((s) => s.consolidate);
  const quotas = useBacklog((s) => s.quotas);
  const runtimes = useWorkbench((s) => s.runtimes);

  const hb = config?.heartbeat;
  // 旧 daemon / 旧前端状态里可能还没有 autopilot —— 兜一份默认值，别让设置页崩
  const ap = config?.autopilot ?? { enabled: false, maxConcurrent: 1, headroomFloorPercent: 10, autoReview: true };
  const [busy, setBusy] = useState(false);
  if (config === null || hb === undefined) {
    return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />;
  }

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    await saveConfig(patch);
    setBusy(false);
  };

  const minutesToClock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const clockToMinutes = (v: string): number => {
    const parts = v.split(":");
    const h = Number(parts[0] ?? NaN);
    const m = Number(parts[1] ?? NaN);
    return (Number.isFinite(h) ? h : 22) * 60 + (Number.isFinite(m) ? m : 0);
  };

  const hbRuntimes = ["", ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))];

  const runtimeIds = [...new Set([...Object.keys(config.runtimes), ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))])];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="待办设置（心跳与余量）"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Settings2 size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">待办设置（心跳与余量）</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-body-sm">
          {/* 心跳 */}
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <HeartPulse size={13} className="text-teal" />
              心跳
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
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="心跳周期（分钟）" value={hb.intervalMinutes} min={5} max={1440} inputClassName={railInputCls} onSave={(n) => void save({ heartbeat: { ...hb, intervalMinutes: n } })} />
              <NumField label="空闲阈值（分钟）" value={hb.idleMinutes} min={1} max={1440} inputClassName={railInputCls} onSave={(n) => void save({ heartbeat: { ...hb, idleMinutes: n } })} />
              <NumField label="提议超时（分钟）" value={hb.proposalTimeoutMinutes} min={1} max={120} inputClassName={railInputCls} onSave={(n) => void save({ heartbeat: { ...hb, proposalTimeoutMinutes: n } })} />
              <NumField label="连续忽略上限（次→休眠）" value={hb.maxIgnoreCount} min={1} max={10} inputClassName={railInputCls} onSave={(n) => void save({ heartbeat: { ...hb, maxIgnoreCount: n } })} />
            </div>
            <label className="flex cursor-pointer items-start gap-1.5 text-caption text-graphite" title="默认关：取消打勾的任务不执行也不被打扰，打勾模型是主流程。打开后恢复旧的提议-确认门（空闲时心跳 agent 为未打勾任务弹提议，你确认才执行）。">
              <input
                type="checkbox"
                checked={hb.proposeNonAuto}
                disabled={busy}
                onChange={(e) => void save({ heartbeat: { ...hb, proposeNonAuto: e.target.checked } })}
                className="mt-0.5 accent-teal"
              />
              <span>
                为未打勾的任务弹提议（旧确认门流程，默认关）—— 关闭时，取消打勾的任务完全静默，只能手动执行或重新打勾
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="block text-body-sm text-ink" title="建议指到有冗余的订阅执行器。">
                  心跳会话的执行器
                </span>
                <select
                  value={hb.runtimeId}
                  disabled={busy}
                  onChange={(e) => void save({ heartbeat: { ...hb, runtimeId: e.target.value } })}
                  className={railInputCls}
                >
                  {hbRuntimes.map((id) => (
                    <option key={id} value={id}>
                      {id === "" ? "（跟随心跳 bot 的主绑定）" : id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">模型（缺省跟随执行器）</span>
                <ModelSelect
                  runtimeId={`daemon:${hb.runtimeId}`}
                  value={hb.model ?? ""}
                  onChange={(v: string) => void save({ heartbeat: { ...hb, model: v === "" ? null : v } })}
                  className={railInputCls}
                  disabled={busy || hb.runtimeId === ""}
                />
              </div>
            </div>
          </section>

          {/* 闲时自动执行（autopilot）—— 清单升级的引擎面 */}
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <Zap size={13} className="text-teal" />
              闲时自动执行
              <span className="ml-auto text-[10px] text-ash">启用开关在右栏待办头部「闲时执行」</span>
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <NumField
                label="同时在跑的上限"
                value={ap.maxConcurrent}
                min={1}
                max={4}
                inputClassName={railInputCls}
                onSave={(n) => void save({ autopilot: { ...ap, maxConcurrent: n } })}
              />
              <NumField
                label="余量地板（%，低于不再派发）"
                value={ap.headroomFloorPercent}
                min={0}
                max={100}
                inputClassName={railInputCls}
                onSave={(n) => void save({ autopilot: { ...ap, headroomFloorPercent: n } })}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
              <input
                type="checkbox"
                checked={ap.autoReview}
                disabled={busy}
                onChange={(e) => void save({ autopilot: { ...ap, autoReview: e.target.checked } })}
                className="accent-teal"
              />
              跑完自动验收（关了仍进待验收，人工过目）
            </label>
            <p className="text-[10px] leading-relaxed text-ash">
              只作用于勾了「闲时执行」的待办（清单分类沉淀的任务默认勾上）：工作台空闲且余量 ≥ 地板时直接派发，持续把清单做完。
              没勾的照旧走心跳提议 + 确认门。
            </p>
          </section>

          {/* 订阅执行器余量 */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <RefreshCw size={13} className="text-teal" />
              订阅执行器余量
              <button onClick={() => void refreshQuotas()} className="ml-auto rounded-btn px-2 py-0.5 text-caption text-graphite hover:bg-line-soft hover:text-ink">
                刷新读数
              </button>
            </h3>
            <div className="space-y-1.5">
              {runtimeIds.map((id) => {
                const q = config.runtimes[id];
                const live = quotas.find((x) => x.runtimeId === id);
                return (
                  <div key={id} className="flex flex-wrap items-center gap-2 rounded-btn bg-rail px-2.5 py-2">
                    <label className="flex items-center gap-1.5 text-caption text-ink">
                      <input
                        type="checkbox"
                        checked={q?.subscribed ?? false}
                        disabled={busy}
                        onChange={(e) => void save({ runtimes: { [id]: { ...(q ?? { probeCmd: null, probeFormat: "raw", windowHours: 5, limit: null }), subscribed: e.target.checked } } })}
                        className="accent-teal"
                      />
                      <span className="font-mono">{id}</span>
                    </label>
                    {live !== undefined && (
                      <span className={cn("text-caption tnum", live.percent === null ? "text-ash" : live.percent > 30 ? "text-gain" : "text-loss")}>
                        {live.percent !== null ? `${live.percent}%` : "未知"}
                      </span>
                    )}
                    <input
                      defaultValue={q?.probeCmd ?? ""}
                      placeholder="配额命令（如 zcode quota）"
                      disabled={busy}
                      onBlur={(e) => void save({ runtimes: { [id]: { ...(q ?? { subscribed: true, probeFormat: "raw", windowHours: 5, limit: null }), probeCmd: e.target.value.trim() === "" ? null : e.target.value.trim() } } })}
                      className="min-w-0 flex-1 rounded-input border border-transparent bg-canvas px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
                    />
                    <select
                      defaultValue={q?.probeFormat ?? "raw"}
                      disabled={busy}
                      onChange={(e) => void save({ runtimes: { [id]: { ...(q ?? { subscribed: true, probeCmd: null, windowHours: 5, limit: null }), probeFormat: e.target.value } } })}
                      className="rounded-input border border-transparent bg-canvas px-1.5 py-1 text-caption text-ink outline-none"
                    >
                      <option value="zcode-quota">zcode 解析</option>
                      <option value="mmx-json">mmx JSON</option>
                      <option value="raw">原文</option>
                    </select>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-ash">
              有配额命令走实时探针（默认缓存 5 分钟）；没有的按本地账本 + 自配窗口上限估算，口径仅含本工作台会话。
            </p>
          </section>

          {/* 统合与飞书 */}
          <section className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <h3 className="text-body-sm font-medium text-ink">收件箱统合</h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={config.consolidate.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ consolidate: { ...config.consolidate, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                每日统合各单元 GTD.md
              </label>
              <div className="flex items-center gap-2 text-caption text-graphite">
                <input
                  type="time"
                  value={minutesToClock(config.consolidate.atMinutes)}
                  disabled={busy}
                  onChange={(e) => void save({ consolidate: { ...config.consolidate, atMinutes: clockToMinutes(e.target.value) } })}
                  className={cn(railInputCls, "w-28")}
                />
                <span>触发</span>
              </div>
              <button
                onClick={() => void consolidate()}
                className="rounded-btn border border-line px-2.5 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
              >
                立即统合一次
              </button>
            </div>
            <div className="space-y-2">
              <h3 className="text-body-sm font-medium text-ink">飞书通知与确认</h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-caption text-graphite">
                <input
                  type="checkbox"
                  checked={config.feishu.enabled}
                  disabled={busy}
                  onChange={(e) => void save({ feishu: { ...config.feishu, enabled: e.target.checked } })}
                  className="accent-teal"
                />
                提议/结果发飞书
              </label>
              <div className="space-y-1.5">
                <input
                  defaultValue={config.feishu.botId}
                  placeholder="出站 bot id（默认 steward）"
                  disabled={busy}
                  onBlur={(e) => void save({ feishu: { ...config.feishu, botId: e.target.value.trim() } })}
                  className={railInputCls}
                />
                <input
                  defaultValue={config.feishu.receiveId}
                  placeholder="确认会话 chat_id（飞书里 @机器人 发「确认」也生效）"
                  disabled={busy}
                  onBlur={(e) => void save({ feishu: { ...config.feishu, receiveId: e.target.value.trim() } })}
                  className={railInputCls}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
