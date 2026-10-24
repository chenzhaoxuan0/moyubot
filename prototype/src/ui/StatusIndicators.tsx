import { useCallback, useEffect, useState } from "react";
import { Check, HelpCircle, Info, Radio, RotateCcw } from "lucide-react";
import { useBacklog } from "../store/useBacklog.ts";
import { useWorkState, WORK_PHASE_DESCRIPTIONS } from "../store/useWorkState.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { fetchAutomations, fetchChannelStatus } from "../adapters/daemon/client.ts";
import { getGuardianConfigRpc } from "../store/useMemoryPanel.ts";
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
 * 后台守护徽标 —— 三态纯文字（刻意去灯化：灯只属于左侧栏会话列表，见文件头
 * 原则 3；不引入任何彩色灯/圆点/状态色，状态差异全靠文字本身）。真实运行态
 * 数据源是三个 daemon 内存读数 RPC（都便宜）：
 * - 徽标头三态：channel.status（网关账号数）—— 离线 = daemon 未连接；
 *   待机 = 在线但 0 路网关；在线 · N 路渠道 = 网关账号总数
 * - 弹层三行清单逐行跟真（不再是写死的能力介绍）：
 *   渠道指令 ← channel.status；定时任务 ← automation.list（启用数 + 最近发火时刻）；
 *   记忆蒸馏 ← memory.guardian.get（设置页「每日总结」开关的权威值）
 * daemon 连着才轮询（30s 一刷 + 弹层打开补拉一次）；各项独立容错——单项拉取
 * 失败保留上次读数，偶发抖动不误翻状态。首拉未返回前该项显示「读取中」。
 */
const CHANNEL_KIND_NAMES: Readonly<Record<string, string>> = {
  feishu: "飞书",
  telegram: "Telegram",
  weixin: "微信",
  discord: "Discord",
};

/** MM-DD HH:mm（只用于弹层里「下次发火时刻」，不值得引日期库） */
function fmtClock(t: number): string {
  const d = new Date(t);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function BackgroundGuardianBadge({ popoverUp = false, align = "right" }: { popoverUp?: boolean; align?: "right" | "left" }) {
  const [open, setOpen] = useState(false);
  const daemonStatus = useWorkbench((s) => s.daemonStatus);
  const [gateways, setGateways] = useState<Readonly<Record<string, number | undefined>> | null>(null);
  const [autoInfo, setAutoInfo] = useState<{ enabled: number; total: number; nextRunAt: number | null } | null>(null);
  const [digestEnabled, setDigestEnabled] = useState<boolean | null>(null);

  // 三路并行、各自容错：一行抖动不连坐另外两行
  const refresh = useCallback((): void => {
    void fetchChannelStatus()
      .then((r) => setGateways(r.gateways))
      .catch(() => undefined); /* daemon 抖动：保留上次读数，不误翻状态 */
    void fetchAutomations()
      .then((list) => {
        const enabled = list.filter((a) => a.enabled);
        const nexts = enabled.map((a) => a.nextRunAt).filter((t): t is number => typeof t === "number");
        setAutoInfo({ enabled: enabled.length, total: list.length, nextRunAt: nexts.length > 0 ? Math.min(...nexts) : null });
      })
      .catch(() => undefined);
    void getGuardianConfigRpc()
      .then((c) => setDigestEnabled(c.digestEnabled))
      .catch(() => undefined);
  }, []);

  // daemon 连着才轮询：连接建立 / 重连各拉一次，之后 30s 一刷
  useEffect(() => {
    if (daemonStatus !== "connected") return;
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [daemonStatus, refresh]);

  // 弹层打开时补拉：点开看到的就是当下读数
  useEffect(() => {
    if (open && daemonStatus === "connected") refresh();
  }, [open, daemonStatus, refresh]);

  const connected = daemonStatus === "connected";
  const total = gateways === null ? 0 : Object.values(gateways).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const label = !connected
    ? "后台守护离线"
    : gateways === null
      ? "后台守护在线"
      : total === 0
        ? "后台守护待机"
        : `后台守护在线 · ${total} 路渠道`;
  const title = !connected
    ? daemonStatus === "connecting"
      ? "正在连接本地 daemon —— 后台守护（渠道网关 / 定时任务 / 记忆蒸馏）尚未就绪"
      : "本地 daemon 不可达 —— 后台守护不在运行；后台仍在慢速重试，后端起来后自动接上"
    : gateways !== null && total === 0
      ? "daemon 在线，但没有任何渠道网关在跑 —— 配置并启用飞书 / Telegram 等渠道后转在线"
      : "你不在电脑前时工作台仍在值班（点击了解它在做什么）";
  const onlineKinds =
    gateways === null
      ? []
      : Object.entries(gateways)
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([kind, n]) => `${CHANNEL_KIND_NAMES[kind] ?? kind} ${n}`);
  const autoNext = autoInfo !== null && autoInfo.nextRunAt !== null ? `，下次 ${fmtClock(autoInfo.nextRunAt)}` : "";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`后台守护状态：${label}，点击了解详情`}
        title={title}
        className="group flex h-6 cursor-pointer items-center gap-1.5 rounded-btn px-2 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <Radio size={12} className="text-ash transition group-hover:text-ink" />
        <span>{label}</span>
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className={cn(popoverAnchorCls(popoverUp, align), "w-76 rounded-card border border-line bg-canvas p-3 shadow-subtle text-caption leading-relaxed")}>
            <div className="text-body-sm font-medium text-ink pb-1.5 border-b border-line-soft">
              {!connected
                ? "后台守护离线"
                : total === 0
                  ? gateways === null ? "后台守护在线" : "后台守护待机 —— 没有渠道在跑"
                  : `后台守护在线 —— ${total} 路渠道值班中`}
            </div>
            {!connected ? (
              <p className="mt-2 text-graphite">
                本地 daemon 未连接，以下能力当前均未在运行；连接恢复后自动接上（无需刷新页面）。
              </p>
            ) : (
              <p className="mt-2 text-graphite">
                即使你关掉前台、离开电脑，下面带 <span className="text-teal font-bold">✓</span> 的项仍会照常进行并保留完整记录 ——
              </p>
            )}
            <div className="mt-1.5 space-y-1.5 text-graphite">
              <p className="flex items-start gap-1.5">
                <span className={cn("font-bold", connected && total > 0 ? "text-teal" : "text-ash")}>
                  {connected && total > 0 ? "✓" : "—"}
                </span>
                <span>
                  <b>渠道指令</b>：
                  {!connected
                    ? "daemon 未连接，不在运行"
                    : total > 0
                      ? `${onlineKinds.join(" · ")} 在线 —— 手机发来的消息在后台无头执行，结果自动回传，不用开电脑`
                      : "没有一路渠道在线 —— 配置并启用飞书 / Telegram 等渠道后，手机消息即可后台执行"}
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className={cn("font-bold", connected && (autoInfo?.enabled ?? 0) > 0 ? "text-teal" : "text-ash")}>
                  {connected && (autoInfo?.enabled ?? 0) > 0 ? "✓" : "—"}
                </span>
                <span>
                  <b>定时任务</b>：
                  {!connected
                    ? "daemon 未连接，不在运行"
                    : autoInfo === null
                      ? "清单读取中"
                      : autoInfo.enabled > 0
                        ? `${autoInfo.enabled} 个启用${autoNext} —— 到点自动执行，产物与总结写进 bot 的文件夹`
                        : `${autoInfo.total} 个任务全部停用 —— 启用后到点自动执行，产物写进 bot 的文件夹`}
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <span className={cn("font-bold", connected && digestEnabled === true ? "text-teal" : "text-ash")}>
                  {connected && digestEnabled === true ? "✓" : "—"}
                </span>
                <span>
                  <b>记忆蒸馏</b>：
                  {!connected
                    ? "daemon 未连接，不在运行"
                    : digestEnabled === null
                      ? "配置读取中"
                      : digestEnabled
                        ? "每日总结已开启 —— 每天提取对话要点，更新单元记忆"
                        : "每日总结已关闭 —— 可在设置页「每日总结」开关重新开启"}
                </span>
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

