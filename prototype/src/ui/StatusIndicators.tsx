import { useState } from "react";
import { Check, HelpCircle, Info, Loader2, Radio, RotateCcw, Unplug } from "lucide-react";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkState, WORK_PHASE_DESCRIPTIONS } from "../store/useWorkState.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { cn } from "./cn.ts";

/**
 * 状态徽标与说明 —— 落点：全局底栏（GlobalStatusBar）。
 *
 * 遵循用户界面清晰原则：
 * 1. 所有的状态灯光只保留在「左侧栏历史会话列表」的最前方，用于反映单个会话的运行/通知状态；
 * 2. 底栏最左侧第 1 位提供「会话指示灯说明」弹层，详述每种灯光含义与右键控制方式；
 * 3. 底栏的「工作状态」与「后台守护」彻底去灯化，采用纯文字展示，避免不同区域的灯光产生概念混淆。
 *
 * popoverUp：栖在底栏时详情层朝上开（默认朝下，供其他位置复用）。
 * align：底栏内容居左，左锚定（"left"）避免弹层向左出窗。
 */

function popoverAnchorCls(up: boolean, align: "left" | "right"): string {
  const vertical = up ? "bottom-full mb-1.5" : "top-full mt-1.5";
  const horizontal = align === "left" ? "left-0" : "right-0";
  return `absolute ${vertical} ${horizontal} z-40`;
}

/**
 * 底栏最左侧第 1 位：会话列表指示灯说明徽标与图例弹层
 */
export function SessionLightLegendBadge({
  popoverUp = false,
  align = "left",
}: {
  popoverUp?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="会话列表指示灯说明"
        title="会话列表指示灯说明：点击了解蓝灯呼吸、绿灯、浅蓝灯、红灯的含义与控制方式"
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-btn text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <HelpCircle size={13} className="text-ash transition-colors hover:text-ink" />
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            className={cn(
              popoverAnchorCls(popoverUp, align),
              "w-88 rounded-card border border-line bg-canvas p-3.5 text-caption leading-relaxed shadow-subtle",
            )}
          >
            <div className="flex items-center justify-between border-b border-line-soft pb-2 text-body-sm font-medium text-ink">
              <span className="flex items-center gap-1.5">
                <HelpCircle size={14} className="text-teal" />
                会话列表状态灯说明
              </span>
              <span className="rounded bg-line-soft px-1.5 py-0.5 text-[10px] font-normal text-ash">
                左侧栏独占
              </span>
            </div>

            <p className="mt-2 text-[11px] text-graphite">
              为避免全局灯光混淆，工作台指示灯<b>仅在左侧栏会话标题最左侧</b>出现，用于提示任务状态与结果：
            </p>

            <div className="mt-3 space-y-2.5">
              {/* 蓝灯呼吸 */}
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500 animate-pulse" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">任务执行中</span>
                    <span className="rounded bg-blue-50 px-1 py-0.2 text-[10px] text-blue-600 dark:bg-blue-950 dark:text-blue-300">
                      蓝灯呼吸
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ash">
                    终端 CLI 正在运行/思考输出中，或后台自动化/待办任务正在执行。
                  </p>
                </div>
              </div>

              {/* 绿灯常亮 */}
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-gain" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">新结果未读</span>
                    <span className="rounded bg-emerald-50 px-1 py-0.2 text-[10px] text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300">
                      绿灯常亮
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ash">
                    任务已完成且有新产出，点击进入该会话查看后将自动消灯。
                  </p>
                </div>
              </div>

              {/* 浅蓝常亮 */}
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500/70" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">空闲在线</span>
                    <span className="rounded bg-sky-50 px-1 py-0.2 text-[10px] text-sky-600 dark:bg-sky-950 dark:text-sky-300">
                      浅蓝静态
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ash">
                    交互式会话仍挂在后台就绪，可随时切换并继续交互。
                  </p>
                </div>
              </div>

              {/* 红灯常亮 */}
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-loss" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">执行失败 / 异常</span>
                    <span className="rounded bg-rose-50 px-1 py-0.2 text-[10px] text-rose-600 dark:bg-rose-950 dark:text-rose-300">
                      红灯常亮
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ash">
                    任务执行出错或非正常退出，可进入会话或右键详情查看报错。
                  </p>
                </div>
              </div>

              {/* 无灯退格 */}
              <div className="flex items-start gap-2.5">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-line-strong bg-transparent" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">已查看历史</span>
                    <span className="text-[10px] text-ash">不显灯（退格占位）</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ash">
                    已读且已结束的正常会话，空出灯位保持列表整齐且不打扰视觉。
                  </p>
                </div>
              </div>
            </div>

            {/* 用户完全控制权提示卡片 */}
            <div className="mt-3 rounded-card border border-line-soft bg-line-soft/40 p-2 text-[11px] leading-relaxed text-graphite">
              <p className="flex items-center gap-1 font-medium text-ink">
                <Info size={12} className="text-teal" />
                用户自主控制权：
              </p>
              <p className="mt-0.5 text-ash">
                若任何会话灯未自动关闭或你想自定义状态，只需<b>右键点击该会话</b>，即可选择「取消此会话状态灯」、「标为已读/未读」或「恢复系统自动灯」。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 全局工作状态（纯文字展示，无状态灯）
 * 点开看判定依据、心跳信息，并可手动指定或恢复跟随系统。
 */
export function WorkPhaseBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const phase = useBacklog((s) => s.state?.phase ?? null);
  const reason = useBacklog((s) => s.state?.reason ?? null);
  const forceBusy = useBacklog((s) => s.state?.forceBusy ?? false);
  const lastOutcome = useBacklog((s) => s.state?.lastBeatOutcome ?? null);
  const nextBeat = useBacklog((s) => s.state?.nextBeatAt ?? null);
  const setForceBusy = useBacklog((s) => s.setForceBusy);
  const manual = useWorkState((s) => s.manual);
  const setManual = useWorkState((s) => s.setManual);

  const autoPhase = phase !== null ? phase : "busy";
  // 展示优先级：后端强制忙碌 > 手动指定 > 自动判定 > 未连接
  const shown = forceBusy ? "busy" : (manual ?? autoPhase);
  const label =
    forceBusy
      ? "强制忙碌"
      : shown !== null
        ? WORK_PHASE_DESCRIPTIONS.find((d) => d.phase === shown)?.label ?? "工作中"
        : "连接中";

  /** 手动指定一个状态 */
  const applyManual = (p: (typeof WORK_PHASE_DESCRIPTIONS)[number]["phase"]): void => {
    setManual(p);
    if (p === "busy" && !forceBusy) void setForceBusy(true);
    if (p !== "busy" && forceBusy) void setForceBusy(false);
  };
  const backToAuto = (): void => {
    setManual(null);
    if (forceBusy) void setForceBusy(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`工作状态：${label}，点击查看详情与全部状态`}
        title={forceBusy ? "工作状态：强制忙碌（免打扰模式生效中）" : `工作状态：${label}${manual !== null && !forceBusy ? "（手动指定，点击可改回跟随系统）" : ""}`}
        className={cn(
          "flex h-6 cursor-pointer items-center rounded-btn px-2 text-caption transition hover:bg-line-soft",
          (forceBusy || manual === "busy") && "bg-amber-500/10 hover:bg-amber-500/20",
        )}
      >
        <span
          className={cn(
            forceBusy || manual === "busy" ? "font-medium text-amber-700 dark:text-amber-400" : "text-graphite",
          )}
        >
          {label}
        </span>
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-80 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="border-b border-line-soft pb-1.5 text-body-sm font-medium text-ink">
              {forceBusy ? "强制忙碌（免打扰模式）" : `当前状态：${label}`}
            </div>
            <div className="mt-2 space-y-1.5 text-graphite">
              {reason !== null && manual === null && <p>{reason}</p>}
              {manual !== null && !forceBusy && (
                <p>
                  手动指定中 —— 后台自动判定继续在跑，只是不展示。
                </p>
              )}
              {nextBeat !== null && <p className="text-ash">下次心跳：{new Date(nextBeat).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</p>}
              {lastOutcome !== null && <p className="text-ash">上次心跳：{lastOutcome}</p>}
            </div>

            {/* 全部状态清单（纯文字列表，无小彩灯，避免与会话灯混淆） */}
            <div className="mt-2.5 border-t border-line-soft pt-2">
              <p className="mb-1 text-[10px] font-medium tracking-wide text-ash">全部工作状态（点击指定为当前状态）</p>
              <div className="space-y-0.5">
                {WORK_PHASE_DESCRIPTIONS.map((d) => {
                  const active = shown === d.phase;
                  return (
                    <button
                      key={d.phase}
                      onClick={() => applyManual(d.phase)}
                      title={`把当前状态指定为「${d.label}」`}
                      className={cn(
                        "flex w-full cursor-pointer items-start justify-between rounded-btn px-2 py-1.5 text-left transition hover:bg-line-soft",
                        active && "bg-teal-tint/60",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <span className={cn("block text-caption", active ? "font-medium text-ink" : "text-graphite")}>
                          {d.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-ash">{d.desc}</span>
                      </div>
                      {active && <Check size={12} className="mt-0.5 shrink-0 text-teal" aria-label="当前状态" />}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={backToAuto}
                disabled={manual === null && !forceBusy}
                className={cn(
                  "mt-1.5 flex w-full items-center justify-center gap-1 rounded-btn px-2 py-1.5 text-caption transition",
                  manual === null && !forceBusy
                    ? "cursor-default text-ash/60"
                    : "bg-line-soft text-graphite hover:text-ink cursor-pointer",
                )}
              >
                <RotateCcw size={10} />
                跟随系统（恢复自动判定）
              </button>
            </div>

            <p className="mt-2 border-t border-line-soft pt-1.5 text-[10px] text-ash">
              指定「工作中」= 强制忙碌（免打扰）：心跳不再提议、待办不自动执行；其余状态仅改变状态显示，判定继续。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 后台守护指示（纯文字展示，无绿灯）
 * 点开用人话讲清后台守护在无人值守时替你做什么。
 */
export function BackgroundGuardianBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "right" | "left" }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="后台守护在线：飞书 / Telegram 指令、定时任务、记忆蒸馏在无人值守时照常运行，点击了解详情"
        title="后台守护在线 —— 你不在电脑前时工作台仍在值班（点击了解它在做什么）"
        className="group flex h-6 cursor-pointer items-center gap-1.5 rounded-btn px-2 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <Radio size={12} className="text-ash transition group-hover:text-ink" />
        <span>后台守护在线</span>
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-76 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="text-body-sm font-medium text-ink pb-1.5 border-b border-line-soft">
              后台守护在线 —— 你不在时，工作台替你值班
            </div>
            <p className="mt-2 text-graphite">
              后台守护持续运行：即使你关掉前台、离开电脑，下面这些任务仍会照常进行并保留完整记录 ——
            </p>
            <div className="mt-1.5 space-y-1.5 text-graphite">
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>飞书 / Telegram 指令</b>：从手机发来的消息在后台无头执行，结果自动回传，不用开电脑。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>定时任务</b>：到点自动执行，产物与总结写进 bot 的文件夹。</span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className="text-teal font-bold">✓</span>
                <span><b>记忆蒸馏</b>：每天提取对话要点，更新单元记忆。</span>
              </p>
              <p className="mt-2 pt-1.5 border-t border-line-soft text-ash text-[10px]">
                它们都在独立后台进程里跑，与前台终端（TUI）完全隔离 —— 永不抢夺前台的输入输出。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * daemon 连接徽标（启动竞态的可见化）：连接中 = 等待提示（启动遮罩 8s 收起后
 * 由它接棒），未连接 = 警示 + 处置指引（快速退避段耗尽才到这里，后台仍在慢速
 * 重试，连上即自动接入）。connected 是常态，不渲染 —— 正常路径不占底栏一席。
 * 遵循本文件「底栏纯文字、去灯化」约定；不可点（无弹层），title 自解释。
 */
export function DaemonLinkBadge() {
  const status = useWorkbench((s) => s.daemonStatus);
  if (status === "connected") return null;
  const connecting = status === "connecting";
  return (
    <span
      aria-label={connecting ? "daemon 连接中" : "daemon 未连接"}
      title={
        connecting
          ? "正在等待本地 daemon 就绪（执行器 / bot / 设置数据都来自它），连上后界面自动填充"
          : "本地 daemon 不可达 —— bot、执行器与设置数据都来自它。启动后端（pnpm -C backend dev）后界面会自动接上，无需刷新"
      }
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-btn px-2 text-caption transition",
        connecting ? "text-graphite" : "font-medium text-amber-700 dark:text-amber-400",
      )}
    >
      {connecting ? (
        <Loader2 size={12} className="animate-spin text-ash" />
      ) : (
        <Unplug size={12} className="text-amber-600 dark:text-amber-400" />
      )}
      <span>{connecting ? "daemon 连接中" : "daemon 未连接"}</span>
    </span>
  );
}
