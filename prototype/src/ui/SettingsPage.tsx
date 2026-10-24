import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock,
  Anchor,
  Archive,
  BookOpen,
  Brain,
  ChartBar,
  ChevronLeft,
  Globe,
  History,
  ImagePlus,
  Keyboard,
  Layers,
  Minus,
  Monitor,
  Package,
  Palette,
  Plug,
  Plus,
  Search,
  Settings2,
  Shield,
  Smartphone,
  SquareTerminal,
  Wand,
} from "lucide-react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  useShell,
  type SettingsSectionDef,
  type SettingsSectionId,
} from "../store/useShell.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import type { WorkUnit } from "../core/units.ts";
import { UnitContextBadge, UnitContextEditor } from "./UnitContextEditor.tsx";
import { useMemorySettings } from "../store/useMemoryPrefs.ts";
import { getGuardianConfigRpc, readProjectMemory, runDigestDryRun, setGuardianConfigRpc, type DigestResult } from "../store/useMemoryPanel.ts";
import { listDaemonExecutors, type DaemonExecutorInfo } from "../adapters/daemon/client.ts";
import { ProviderInstancesPanel } from "./ProviderInstancesPanel.tsx";
import { SkillsSettingsSection } from "./SkillsSettingsSection.tsx";
import { CliSettingsSection } from "./CliSettingsSection.tsx";
import { McpSettingsSection } from "./McpSettingsSection.tsx";
import { BrowserControlSection } from "./BrowserControlSection.tsx";
import { ComputerControlSection } from "./ComputerControlSection.tsx";
import { SearchSettingsSection } from "./SearchSettingsSection.tsx";
import { RemoteControlDialog } from "./RemoteControlDialog.tsx";
import { ImageSettingsSection } from "./ImageSettingsSection.tsx";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection.tsx";
import { HeartbeatSettingsSection } from "./HeartbeatSettingsSection.tsx";
import { ImportSessionsSection } from "./ImportSessionsSection.tsx";
import { ArchivedTasksSettingsSection } from "./ArchivedTasksSettingsSection.tsx";
import { useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useChatTerminal } from "../store/useChatTerminal.ts";
import { SUPPORTED_TERMINAL_PROFILES } from "../store/useTerminalStore.ts";
import { cn } from "./cn.ts";

const ICONS: Record<string, typeof Settings2> = {
  settings: Settings2,
  image: ImagePlus,
  palette: Palette,
  package: Package,
  keyboard: Keyboard,
  alarm: AlarmClock,
  wand: Wand,
  brain: Brain,
  anchor: Anchor,
  shield: Shield,
  chart: ChartBar,
  history: History,
  archive: Archive,
  layers: Layers,
  book: BookOpen,
  plug: Plug,
  terminal: SquareTerminal,
  globe: Globe,
  monitor: Monitor,
  search: Search,
  smartphone: Smartphone,
};

/** 居中内容列：max-w-5xl 给予多列执行器与模型管理更充裕的呼吸空间。
 *  pt-6 与分区头 mb-6 同值：说明行收进悬停后标题独占一行，上方留白至少
 *  与到下方内容的间距相等，否则标题贴着面包屑顶带、视觉上吊在最上缘 */
const FRAME = "mx-auto w-full max-w-5xl px-6 pb-12 pt-6";
/**
 * 头部行专用：只有水平规格。FRAME 的 pt-2/pb-12 是给可滚动内容列的，
 * 混进固定 h-12 的面包屑行会把内容盒压塌（8+48=56px padding > 48px 高），
 * 文字被顶出/裁掉在顶缘 —— 面包屑上顶格的根因。
 */
const FRAME_HEAD = "mx-auto w-full max-w-5xl px-6";

/**
 * 设置页 —— 骨架对齐 ZCode 的 settingsPageConfig + SettingsPageParts：
 *   左导航三组（基础 / bot 能力 / 数据与统计）
 *   max-w-4xl 内容列 + 面包屑头
 *   SettingsRow（label + description ｜ control，border-t 分隔）
 *   SettingsGroupCard 包裹
 *
 * 与 ZCode 的差异：分区清单按本项目资产重排，
 * 「执行器」进基础设置（六家工具是一等公民），「自动化」是bot模式的心脏故排首位。
 */
export function SettingsPage() {
  const section = useShell((s) => s.settingsSection);
  const openSettings = useShell((s) => s.openSettings);

  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div className="flex h-full min-h-0">
      {/* 左导航：宽度 264px 与侧边栏一致，顶栏高 48px 与工作台顶栏完全对齐。
          桌面端无边框窗口：这一行同时是左列的窗口拖拽热区（titlebar-drag） */}
      <nav className="flex h-full w-[264px] shrink-0 min-h-0 flex-col border-r border-line bg-rail">
        <div className="titlebar-drag flex h-12 shrink-0 items-center border-b border-line/60 px-3">
          <button
            onClick={() => useShell.getState().closeSettings()}
            className="flex h-8 w-full items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 text-body-sm font-medium text-teal transition hover:bg-teal/15"
          >
            <ChevronLeft size={14} />
            <span>返回工作台</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {SETTINGS_GROUPS.map((g) => {
            const items = SETTINGS_SECTIONS.filter((s) => s.groupId === g.id);
            if (items.length === 0) return null;
            return (
              <div key={g.id} className="mb-4">
                <p className="px-2 pb-1.5 text-caption text-ash">{g.title}</p>
                {items.map((it) => {
                  const Icon = ICONS[it.icon] ?? Settings2;
                  const active = it.id === current.id;
                  return (
                    <button
                      key={it.id}
                      onClick={() => openSettings(it.id)}
                      aria-current={active}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-body-sm",
                        active ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft hover:text-ink",
                      )}
                    >
                      <Icon size={12} className="shrink-0" />
                      <span className="truncate">{it.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </nav>

      {/* 内容列。头部**必须**在滚动容器之外（flex 列：固定 48px 头 + 下方
          flex-1 滚动）：之前头是 scroller 里的 sticky 行，滚动条轨道跟着
          scroller 顶到窗口最上缘，从设置页 HEAD 上面穿出去、压住右上角的
          最小化/关闭钮 —— 顶栏那一带必须是标题栏，不能有内容层的东西 */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* 面包屑头，对齐 ZCode 的 SettingsHeaderBreadcrumb —— 只呈现路径，
            返回动作在左导航列顶部。h-12 与内容列顶带同高。
            titlebar-drag 挂整宽外层条；no-drag 占位绝对锚定行右缘（落在窗口
            按钮带正下方——留在居中列里会在头右侧挖出一个拖不动的洞） */}
        <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-rail">
          <div className={cn(FRAME_HEAD, "flex h-12 items-center gap-2")}>
            <span className="text-body-sm text-ink">设置</span>
            <span className="text-line">/</span>
            <span className="text-body-sm font-medium text-ink">{current.title}</span>
          </div>
          <div
            aria-hidden
            className="titlebar-no-drag absolute right-0 top-0 h-full"
            style={{ width: "var(--wco-w, 0px)" }}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={FRAME}>
            <header className="mb-6">
              <h1 className="text-body-lg font-medium text-ink" title={current.desc}>
                {current.title}
              </h1>
            </header>

            <SectionBody section={current} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 原语 */

/** 对齐 ZCode 的 SettingsRow：左 label，右 control，border-t 分隔。
 *  说明文字收进 label 的悬停提示——行高统一单行，页面才不会被说明文字淹没 */
export function SettingsRow({
  label,
  description,
  control,
  detail,
  wide,
}: {
  label: ReactNode;
  description?: string;
  control: ReactNode;
  detail?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="border-t border-line px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          wide ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]" : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-body-sm font-medium text-ink" title={description}>
            {label}
          </div>
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">{control}</div>
      </div>
      {detail && <div className="mt-3">{detail}</div>}
    </div>
  );
}

/** 对齐 ZCode 的 SettingsGroupCard（浏览器/电脑控制分区也从这里取，保持单一来源） */
export function GroupCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-card border border-line bg-card">{children}</div>;
}

/**
 * 开关已抽到独立的 Toggle.tsx（AppearanceSettingsSection 也要用，放本页会让
 * 它 import SettingsPage 绕成环）。此处 re-export 维持既有导入路径（渠道账号区
 * 等从本页取的不再改）。
 */
export { Toggle } from "./Toggle.tsx";
import { Toggle } from "./Toggle.tsx";

/* ------------------------------------------------------------- 分区内容 */

/** 导入外部会话的全局形态：先选 bot（外部会话按它的工作目录匹配），再走共享查询/导入区 */
function ImportSessionsGlobalSection() {
  const units = useWorkbench((s) => s.units).filter((u) => u.rootPath !== "");
  const [unitId, setUnitId] = useState<string>(units[0] !== undefined ? String(units[0].id) : "");
  const current = units.find((u) => String(u.id) === unitId) ?? units[0];

  if (units.length === 0) {
    return <p className="text-caption text-ash">还没有任何 bot —— 先在侧栏添加（指向已有文件夹即为认领）。</p>;
  }
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-caption text-ash">
        导入到哪个 bot
        <select
          value={current !== undefined ? String(current.id) : ""}
          onChange={(e) => setUnitId(e.target.value)}
          className="rounded-input border border-line bg-canvas px-2 py-1 text-body-sm text-ink outline-none focus:border-teal"
        >
          {units.map((u) => (
            <option key={String(u.id)} value={String(u.id)}>
              {u.name}
            </option>
          ))}
        </select>
        {current !== undefined && <span className="font-mono text-[10px] text-ash/70">{current.rootPath}</span>}
      </label>
      {current !== undefined && <ImportSessionsSection unitId={String(current.id)} />}
    </div>
  );
}

function SectionBody({ section }: { section: SettingsSectionDef }) {  switch (section.id) {
    case "appearance":
      return <AppearanceSettingsSection />;
    case "models":
      return (
        <div className="space-y-6">
          <ProviderInstancesPanel />
        </div>
      );
    case "shortcuts":
      return <ShortcutsSection />;
    case "cli":
      return <CliSettingsSection />;
    case "history":
      return (
        <div className="space-y-6">
          <HistorySettingsSection />
          {/* 外部会话导入：全局入口（bot 设置页有同款、免选 bot 的版本）。
              单元选择在这里做，查询/导入本体共用 ImportSessionsSection */}
          <section className="space-y-3 rounded-card border border-line bg-rail/60 p-4">
            <div>
              <h2 className="font-medium text-ink" title="收入在工作台外、直接用 CLI 在 bot 工作目录里跑过的会话（查询面参照 cc-switch）">
                导入外部会话
              </h2>
            </div>
            <ImportSessionsGlobalSection />
          </section>
        </div>
      );
    case "archivedTasks":
      return <ArchivedTasksSettingsSection />;
    case "heartbeat":
      return <HeartbeatSettingsSection />;
    case "terminal":
      return <TerminalSettingsSection />;
    case "context":
      return <ContextSettingsSection />;
    case "skills":
      return <SkillsSettingsSection />;
    case "mcp":
      return <McpSettingsSection />;
    case "browserControl":
      return <BrowserControlSection />;
    case "computerControl":
      return <ComputerControlSection />;
    case "search":
      return <SearchSettingsSection />;
    case "remoteControl":
      /* 移动端远控（原右侧栏状态条入口迁入）：低频设置项归设置页。
          embedded 形态去掉全屏遮罩直接填充内容列；FRAME 的 px-6 与弹窗自身的
          内边距会叠加，改用负外边距抵消弹窗 p-6 的横向内边距 */
      return (
        <div className="-mx-6">
          <RemoteControlDialog embedded onClose={() => undefined} />
        </div>
      );
    case "memory":
      return <MemorySettingsSection />;
    case "image":
      /* 出图供应商 profile 管理（gpt_image_playground 字段全集） */
      return <ImageSettingsSection />;
    default:
      return null;
  }
}

/**
 * 「上下文清单」分区（用户 2026-10-22 反馈第 2 点）：选任意一个 bot，
 * 在一处完成注入矩阵 + 全部上下文文件（SOUL/AGENTS/MEMORY/STANDING/USER）的
 * 查看与编辑。编辑本体在共享组件 UnitContextEditor——与 bot 设置对话框、
 * 右栏 Context 面板同一份实现，三个面永远长一样。
 */
function ContextSettingsSection() {
  const units = useWorkbench((s) => s.units);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const [picked, setPicked] = useState<string | null>(null);
  // 默认跟随当前激活的 bot；若无激活项则默认第一个 bot；用户手动选过后尊重选择，所选 bot 被注销则回落
  const unitId =
    picked !== null && units.some((u) => String(u.id) === picked)
      ? picked
      : activeUnitId !== null && units.some((u) => String(u.id) === String(activeUnitId))
        ? String(activeUnitId)
        : units.length > 0 && units[0] !== undefined
          ? String(units[0].id)
          : null;

  const selectedUnit = units.find((u) => String(u.id) === unitId);

  if (units.length === 0) {
    return <p className="text-caption text-ash">还没有任何 bot —— 左侧栏新建后这里就能管理它们的上下文。</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-canvas p-3">
        <div className="flex items-center gap-2.5">
          <span className="text-caption font-medium text-graphite">选择 bot</span>
          <select
            value={unitId ?? ""}
            onChange={(e) => setPicked(e.target.value)}
            className="min-w-0 max-w-xs flex-1 rounded-btn border border-line bg-rail px-2.5 py-1 text-caption font-medium text-ink outline-none focus:border-teal/60"
          >
            {units.map((u) => (
              <option key={String(u.id)} value={String(u.id)}>
                {u.name}
                {u.kind === "project" ? "（项目）" : ""}
              </option>
            ))}
          </select>
        </div>
        {selectedUnit && <UnitContextBadge unit={selectedUnit} />}
      </div>
      {unitId === null ? (
        <p className="text-caption text-ash">没有选中的 bot——从上面选一个。</p>
      ) : (
        <UnitContextEditor unitId={unitId} />
      )}
    </div>
  );
}

/**
 * 记忆分区 —— 项目记忆上限 + 逐 bot 跨项目检索授权 + 每日总结（docs/10 §七 WP-8）。
 *
 * 上一版这里是「8 种记忆后端注册表 + 三层路由 + 检索门控」，其中 5 种还标着 coming。
 * **整套在新架构下作废**：记忆是项目文件夹里的普通 Markdown（`MEMORY.md` /
 * `memory/daily/` / `skills/`），跨会话检索是现场扫 CLI 的源目录 ——
 * 既没有「注册到」这回事，也不需要向量库和门控小模型。注册表与 coming 标记一并移除。
 */

/**
 * 记忆系统设置（ADR 0014 拆分后）。
 *
 * 专注于全局记忆配置（上限、每日总结、Guardian 守护引擎、跨项目检索授权）。
 * 单 bot 的会话注入范围、上下文清单已移至「上下文清单」分区（UnitContextEditor）。
 */
function MemorySettingsSection() {
  const prefs = useMemorySettings((s) => s.prefs);
  const setPrefs = useMemorySettings((s) => s.setPrefs);
  const units = useWorkbench((s) => s.units);
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const activeRoot = useWorkbench(selectActiveUnit)?.rootPath ?? null;

  const [usage, setUsage] = useState<{ chars: number; limit: number; exists: boolean } | null>(null);
  const [digest, setDigest] = useState<DigestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [executors, setExecutors] = useState<DaemonExecutorInfo[]>([]);
  const [customModelMode, setCustomModelMode] = useState(false);

  // 挂载时拉取真实探测到的 CLI 执行器列表
  useEffect(() => {
    let alive = true;
    listDaemonExecutors()
      .then((l) => {
        if (!alive) return;
        setExecutors(l.filter((e) => !e.testOnly));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 挂载时用 daemon kv 里的权威配置校准显示。localStorage 只是离线兜底——
  // 换浏览器 / 清缓存 / agent 直改配置文件后，不同步就会显示一个假状态，
  // 用户「再保存一次」旧值就把权威配置悄悄改回去了。
  useEffect(() => {
    let alive = true;
    getGuardianConfigRpc()
      .then((c) => {
        if (!alive) return;
        setPrefs({
          guardianRunner: c.runner,
          guardianModel: c.model,
          autoConsolidate: c.autoConsolidate,
          digestEnabled: c.digestEnabled,
        });
      })
      .catch(() => {
        /* daemon 没起：保持 localStorage 兜底值，不报错不打断页面 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时同步一次；setPrefs 是 zustand 稳定引用
  }, []);

  // 当前项目的真实用量。**分母永远取后端给的 limit**（limits.ts 的 MEMORY_CHAR_LIMIT），
  // 上面那个可编辑数字只是工作台侧的提醒阈值 —— 两者不是一回事，别混着显示
  useEffect(() => {
    let alive = true;
    if (activeRoot === null) {
      setUsage(null);
      return;
    }
    void readProjectMemory(activeRoot)
      .then((f) => {
        if (alive) setUsage({ chars: f.chars, limit: f.limit, exists: f.exists });
      })
      .catch(() => {
        if (alive) setUsage(null);
      });
    return () => {
      alive = false;
    };
  }, [activeRoot]);

  /**
   * 跨项目检索开关落盘到 `<rootPath>/.agent-workbench/bot.json` 的 crossSearch 字段
   * （后端 memory/steward.ts 的权限入口就在读它）。
   *
   * `WorkUnit` 没声明这个字段 —— `core/units.ts` 由后端共享（host.ts 从那里 import），
   * 这次不动它；bot.list 会把 bot.json 的额外字段原样带回，bot.put 也会原样落盘。
   */
  const setCrossSearch = async (u: WorkUnit, on: boolean): Promise<void> => {
    setErr(null);
    const next: WorkUnit & { crossSearch: boolean } = { ...u, crossSearch: on };
    try {
      // 乐观锁用进页面时看到的盘上真值：别人改过就抛 conflict，不静默覆盖
      await updateUnit(next, { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash ?? "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const runDigest = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      setDigest(await runDigestDryRun());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const usagePct = usage !== null && usage.limit > 0 ? Math.round((usage.chars / usage.limit) * 100) : null;

  const currentExecutor = executors.find((e) => e.id === prefs.guardianRunner);
  const currentModels = currentExecutor?.models ?? [];
  const modelInCurrentList = currentModels.some((m) => m.id === prefs.guardianModel);

  const handleRunnerChange = (newRunner: string) => {
    // 切执行器不带模型：留空 = 跟随该 CLI 自己的默认模型（与总管同款口径）。
    // 绝不自动替用户挑一个名字——占位名会被存进配置，看着像用户自己选的。
    setPrefs({ guardianRunner: newRunner as any, guardianModel: "" });
    void setGuardianConfigRpc({ runner: newRunner as any, model: "" });
  };

  return (
    <div className="space-y-6">
      {/* 上限 */}
      <GroupCard>
        <SettingsRow
          label="项目记忆上限"
          description="MEMORY.md 的字符上限。参照 hermes（2200 字符 ≈ 800 tokens）—— 限额的意义不是省 token，而是「满了写不进去」逼着 agent 先整合"
          control={
            <Stepper
              value={prefs.memoryCharLimit}
              min={1000}
              max={8000}
              step={100}
              onChange={(v) => setPrefs({ memoryCharLimit: v })}
            />
          }
          detail={
            usage === null ? null : (
              <p className="text-caption leading-relaxed text-ash">
                当前项目实际：
                <span className="tnum text-graphite">
                  {usage.chars.toLocaleString("zh-CN")}/{usage.limit.toLocaleString("zh-CN")}
                </span>{" "}
                字符{usagePct === null ? "" : `（${usagePct}%）`}
                {usage.exists ? "" : " · MEMORY.md 还不存在，派发时自动创建"}。
                <span className="text-graphite">
                  分母由后端 limits.ts 的 MEMORY_CHAR_LIMIT 决定（编译期常量 2200）
                </span>
                —— 改上面的数字只改工作台侧的「先整合」提醒阈值，不改后端的拒绝阈值。
              </p>
            )
          }
        />
      </GroupCard>

      {/* 会话记忆注入范围与 USER.md 已并入「上下文清单」分区（集中编辑，ADR 0014）。
          这里只保留记忆系统的全局配置（上限提醒阈值 / 每日总结 / 守护 / 跨项目检索）。 */}

      {/* 跨项目检索：逐 bot 授权 */}
      <GroupCard>
        <div className="px-4 pb-1 pt-3">
          <p
            className="text-caption font-medium text-graphite"
            title="默认全关。全局记忆曾经让 A 项目里冒出 B 项目的记忆，直接摧毁对 agent 的信任。铁律：搜到 ≠ 注入 —— 检索结果只出现在它主动查的那一轮，永远不会进项目的 prompt。"
          >
            跨项目检索
          </p>
        </div>
        <ul className="divide-y divide-line-soft">
          {units.length === 0 && <li className="px-4 py-2.5 text-caption text-ash">没有已注册的 bot。</li>}
          {units.map((u) => {
            const a = u as WorkUnit & { crossSearch?: boolean; role?: string };
            const steward = a.role === "steward";
            return (
              <li key={u.id} className="flex items-center gap-2.5 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{u.name}</span>
                {steward ? (
                  // 管家是干这个的，权限写死在后端（stewardDefinition.crossSearch），不给关
                  <span className="shrink-0 text-caption text-ash">管家 · 常开</span>
                ) : (
                  <Toggle on={a.crossSearch === true} onChange={(v) => void setCrossSearch(u, v)} />
                )}
              </li>
            );
          })}
        </ul>
      </GroupCard>

      {/* 后台守护引擎配置 */}
      <GroupCard>
        <div className="px-4 pb-1 pt-3">
          <p
            className="text-caption font-medium text-graphite"
            title="配置用于后台合并压缩（Auto-Consolidator）、每日总结与健康审查的轻量执行器与小模型。"
          >
            后台守护引擎 (Guardian Engine)
          </p>
        </div>
        <SettingsRow
          label="守护执行器 (Runner)"
          description="调度哪家 CLI 执行后台轻量任务（推荐本机已有免鉴权环境的 CLI）"
          control={
            <select
              value={prefs.guardianRunner}
              onChange={(e) => handleRunnerChange(e.target.value)}
              className="h-8 rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none"
            >
              {executors.length > 0 ? (
                executors.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName || e.id} ({e.id})
                  </option>
                ))
              ) : (
                <>
                  <option value="zcode">ZCode (zcode)</option>
                  <option value="claude">Claude (claude)</option>
                  <option value="codex">Codex (codex)</option>
                  <option value="pi">Pi (pi)</option>
                  <option value="mcode">MiniMax (mcode)</option>
                  <option value="agy">Antigravity (agy)</option>
                  <option value="custom">Custom (custom)</option>
                </>
              )}
              {executors.length > 0 && !executors.some((e) => e.id === prefs.guardianRunner) && (
                <option value={prefs.guardianRunner}>{prefs.guardianRunner}</option>
              )}
            </select>
          }
        />
        <SettingsRow
          label="轻量模型名称 (Model)"
          description={
            prefs.guardianModel === ""
              ? "未设置 —— 跟随总管：不向 CLI 传模型参数，用所选执行器自己的默认模型"
              : currentModels.length > 0
                ? `当前执行器 (${prefs.guardianRunner}) 探测到 ${currentModels.length} 个模型；清空则跟随 CLI 默认模型`
                : "指定后台执行合并压缩使用的模型名称；留空则跟随 CLI 默认模型"
          }
          control={
            currentModels.length > 0 && !customModelMode ? (
              <div className="flex items-center gap-1.5">
                <select
                  value={modelInCurrentList ? prefs.guardianModel : prefs.guardianModel === "" ? "" : "__custom__"}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") {
                      setCustomModelMode(true);
                    } else {
                      const m = e.target.value;
                      setPrefs({ guardianModel: m });
                      void setGuardianConfigRpc({ model: m });
                    }
                  }}
                  className="h-8 max-w-[210px] truncate rounded-btn border border-line bg-canvas px-2 font-mono text-body-sm text-ink focus:border-teal focus:outline-none"
                >
                  {/* 空选项 = 未设置：跟随 CLI 默认模型（与总管同款口径）。不显示任何占位模型名 */}
                  {prefs.guardianModel === "" && (
                    <option value="">（未设置 · 跟随 CLI 默认）</option>
                  )}
                  {!modelInCurrentList && prefs.guardianModel && (
                    <option value="__custom__">自定义: {prefs.guardianModel}</option>
                  )}
                  {currentModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </option>
                  ))}
                  <option value="__custom__">✍️ 手动输入其他模型…</option>
                </select>
                <button
                  type="button"
                  onClick={() => setCustomModelMode(true)}
                  className="rounded-btn border border-line px-2 py-1 text-caption text-ash hover:text-ink hover:border-teal"
                  title="切换为手动自由输入"
                >
                  手输
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={prefs.guardianModel}
                  onChange={(e) => {
                    const model = e.target.value;
                    setPrefs({ guardianModel: model });
                  }}
                  onBlur={() => {
                    void setGuardianConfigRpc({ model: prefs.guardianModel });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void setGuardianConfigRpc({ model: prefs.guardianModel });
                    }
                  }}
                  placeholder="留空 = 跟随 CLI 默认模型（与总管同款）"
                  className="h-8 w-44 rounded-btn border border-line bg-canvas px-2.5 font-mono text-body-sm text-ink focus:border-teal focus:outline-none"
                />
                {currentModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCustomModelMode(false)}
                    className="rounded-btn border border-line px-2 py-1 text-caption text-ash hover:text-ink hover:border-teal"
                    title="从已探测模型列表中选择"
                  >
                    选单
                  </button>
                )}
              </div>
            )
          }
        />
        <SettingsRow
          label="超限自动自愈合并"
          description="当 MEMORY.md 接近或超过 2200 字符时，由上述配置的小模型在后台自动合并同类项并剔除失效事实，避免硬拒绝写入"
          control={
            <Toggle
              on={prefs.autoConsolidate}
              onChange={(v) => {
                setPrefs({ autoConsolidate: v });
                void setGuardianConfigRpc({ autoConsolidate: v });
              }}
            />
          }
        />
      </GroupCard>

      {/* 每日总结 */}
      <GroupCard>
        <SettingsRow
          label="每日总结"
          description="每天 1–2 次增量读当天会话 → 写 memory/daily/<日期>.md。同日重跑整份重写（幂等）；失败只记日志，绝不影响日常对话"
          control={
            <Toggle
              on={prefs.digestEnabled}
              onChange={(v) => {
                setPrefs({ digestEnabled: v });
                // 写穿到 daemon kv —— 调度器每 tick 动态读，改完即生效，无需重启。
                // 只存 localStorage 的话这就是个假开关：daemon 根本看不见它。
                void setGuardianConfigRpc({ digestEnabled: v });
              }}
            />
          }
        />
        <SettingsRow
          label="立即运行（dryRun）"
          description="只报不写：今天会扫到哪些文件、多少块、会写到哪些项目"
          control={
            <button
              onClick={() => void runDigest()}
              disabled={busy}
              className="rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
            >
              {busy ? "扫描中…" : "试跑"}
            </button>
          }
          detail={digest === null ? null : <DigestReport result={digest} />}
        />
      </GroupCard>

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}
    </div>
  );
}

/** 试跑报告 —— dryRun 只报不写，所以这一屏全是「本来会发生什么」 */
function DigestReport({ result }: { result: DigestResult }) {
  return (
    <div className="space-y-1 text-caption leading-relaxed text-graphite">
      <p className="tnum">
        {result.date} · 扫了 {result.scannedFiles} 个文件 / {result.freshBlocks} 块（{result.freshFiles} 个文件有新改动）
      </p>
      {result.wrote.length > 0 && <p>会写到：{result.wrote.join("、")}</p>}
      {result.wrote.length === 0 && result.skipReason === undefined && !result.ran && <p className="text-ash">没有可跑的内容。</p>}
      {result.skipped.map((s) => (
        <p key={s.project} className="text-ash">
          跳过 {s.project}：{s.reason}
        </p>
      ))}
      {result.skipReason !== undefined && <p className="text-ash">{result.skipReason}</p>}
      {result.error !== undefined && <p className="text-loss">{result.error}</p>}
    </div>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max(min, value - step))}
        aria-label="减少"
        className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
      >
        <Minus size={10} />
      </button>
      <span className="tnum w-10 text-center text-body-sm text-ink">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + step))}
        aria-label="增加"
        className="rounded-btn border border-line p-1 text-graphite hover:bg-line-soft"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

// 注：原「权限」分区（默认审批策略与信任范围）已删除。它当时只有两行：
// 「错过时补跑」是个 onChange={() => {}} 的假开关，拨了什么都不发生；
// 「常驻调度」是「待实现」徽标。整个分区 100% 是假内容。

function ShortcutsSection() {
  // 与 bindShellShortcuts（useShell.ts）和 Electron 层的缩放绑定逐一对应。
  // 旧表里的「打开终端 ⌘`」「发送 Enter / 换行 Shift+Enter」随终端抽屉与
  // 输入框的移除一并删除 —— 列死快捷键比不列更误导。
  const items: readonly (readonly [string, readonly string[], string])[] = [
    ["命令面板", ["⌘", "K"], "全局"],
    ["搜索", ["⌘", "F"], "全局"],
    ["收起 / 展开侧栏", ["⌘", "B"], "全局"],
    ["打开设置", ["⌘", ","], "全局"],
    ["关闭弹层", ["Esc"], "全局"],
    ["内容缩放", ["Ctrl", "="], "全局（Electron）"],
    ["内容缩小", ["Ctrl", "-"], "全局（Electron）"],
    ["缩放复位", ["Ctrl", "0"], "全局（Electron）"],
  ];
  return (
    <GroupCard>
      {items.map(([label, keys, scope]) => (
        <SettingsRow
          key={label}
          label={label}
          description={scope}
          control={
            <span className="flex shrink-0 gap-1">
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="rounded-btn border border-line bg-canvas px-2 py-1 font-mono text-caption text-ink"
                >
                  {k}
                </kbd>
              ))}
            </span>
          }
        />
      ))}
    </GroupCard>
  );
}

function HistorySettingsSection() {
  const prefs = useHistoryPrefs((s) => s.prefs);
  const setPrefs = useHistoryPrefs((s) => s.setPrefs);

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="text-body-sm font-semibold text-ink"
          title="标为红色或执行失败的会话通常无法重现或继续交互。默认隐藏失败会话以保持界面整洁，可在需要排查故障或复盘时随时重新开启。"
        >
          历史会话展示偏好
        </h3>
      </div>

      <GroupCard>
        <SettingsRow
          label="在左侧栏中隐藏失败会话"
          description="侧边栏 Bot 展开的历史时间轴中隐藏标红或执行失败的会话，避免占据侧栏有限空间。"
          control={
            <Toggle
              on={prefs.hideFailedInSidebar}
              onChange={(v) => setPrefs({ hideFailedInSidebar: v })}
            />
          }
        />
        <SettingsRow
          label="在历史会话弹窗中隐藏失败会话"
          description="点击进入完整历史会话弹窗时默认隐藏失败会话；在弹窗顶部也可快捷临时切换查看。"
          control={
            <Toggle
              on={prefs.hideFailedInDialog}
              onChange={(v) => setPrefs({ hideFailedInDialog: v })}
            />
          }
        />
        <SettingsRow
          label="自动归档旧任务"
          description={`超过 ${prefs.autoArchiveOlderThanDays} 天未更新的已完成任务自动移入归档抽屉（对齐 ZCode 自动归档）。`}
          control={
            <Toggle
              on={prefs.autoArchiveEnabled}
              onChange={(v) => setPrefs({ autoArchiveEnabled: v })}
            />
          }
        />
        {prefs.autoArchiveEnabled && (
          <SettingsRow
            label="归档保留时长"
            description="任务完成或更新时间早于该时长后，才会自动归档。"
            control={
              <select
                value={prefs.autoArchiveOlderThanDays}
                onChange={(e) => setPrefs({ autoArchiveOlderThanDays: Number(e.target.value) })}
                className="h-8 rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal focus:outline-none"
              >
                <option value={3}>3 天后归档</option>
                <option value={7}>7 天后归档</option>
                <option value={14}>14 天后归档</option>
                <option value={30}>30 天后归档</option>
              </select>
            }
          />
        )}
        <SettingsRow
          label="已归档任务抽屉"
          description="把完成或不常用的任务放进抽屉里，保留全部历史但不在左侧栏占用空间。"
          control={
            <button
              type="button"
              onClick={() => useShell.getState().openSettings("archivedTasks")}
              className="flex items-center gap-1.5 rounded-btn bg-teal-tint px-2.5 py-1 text-caption font-medium text-teal transition hover:bg-teal/15 cursor-pointer"
            >
              <Archive size={12} />
              <span>查看归档抽屉</span>
              <span className="rounded-full bg-teal/20 px-1.5 py-0.2 text-[10px] text-teal">
                {prefs.archivedKeys.length}
              </span>
            </button>
          }
        />
      </GroupCard>
    </div>
  );
}

/**
 * 终端分区 —— 对话页小终端（Composer 左下角 SquareTerminal 唤起）的 Shell 档案。
 *
 * Windows daemon 侧 defaultShell 本就优先 PowerShell 7（backend/src/terminal/terminals.ts），
 * 前端默认档与其对齐：profileId 缺省 "pwsh"，落不到 pwsh 时 daemon 自动回退
 * powershell → cmd，终端永远起得来。改动立即生效：现有对话终端会被杀掉重建。
 */
function TerminalSettingsSection() {
  const profileId = useChatTerminal((s) => s.profileId);
  const setProfileId = useChatTerminal((s) => s.setProfileId);
  const open = useChatTerminal((s) => s.open);

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="text-body-sm font-semibold text-ink"
          title="对话页输入框工具栏的终端按钮唤起的快捷小终端（与「终端」主视图的 TUI 标签页互相独立）。默认 PowerShell 7；机器上没装 pwsh 时 daemon 会自动回退到 Windows PowerShell / CMD。"
        >
          对话终端
        </h3>
      </div>

      <GroupCard>
        <SettingsRow
          label="Shell 类型"
          description="对话终端新会话使用的 Shell。切换后现有对话终端立即按新 Shell 重建（未打开则下次打开生效）。"
          control={
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              aria-label="对话终端 Shell 类型"
              className="h-8 w-full max-w-[200px] rounded-btn border border-line bg-canvas px-2 text-body-sm text-ink focus:border-teal/60 focus:outline-none"
            >
              {SUPPORTED_TERMINAL_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === "pwsh" ? "（默认）" : ""}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          label="进程保留"
          description="收起对话终端面板时进程保持运行，再次打开瞬达不丢现场；点面板里的重启按钮才会真正结束进程。"
          control={<Toggle on disabled />}
        />
      </GroupCard>

      {open && (
        <p className="text-caption text-ash">
          对话终端当前已打开 —— 刚才的 Shell 变更已立即生效。
        </p>
      )}
    </div>
  );
}

