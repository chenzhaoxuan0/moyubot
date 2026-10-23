import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileText,
  FolderSync,
  MessageSquareQuote,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { useWorkbench } from "../store/useWorkbench.ts";
import {
  hasSubstantiveContent,
  normalizeContextManifest,
  normalizeSkillBinding,
  resolveAgentsMdInjection,
  AUTO_PRESET_NAME,
  DEFAULT_CONTEXT_MANIFEST,
  sameContextManifest,
  type ContextManifest,
  type WorkUnit,
} from "../core/units.ts";
import {
  fetchSkillsInventory,
  listDaemonExecutors,
  readUserContext,
  writeUserContext,
  type DaemonExecutorInfo,
  type UserContextFile,
} from "../adapters/daemon/client.ts";
import { readProjectMemory, writeProjectMemory, readStandingMemory, writeStandingMemory } from "../store/useMemoryPanel.ts";
import { Toggle } from "./Toggle.tsx";
import { cn } from "./cn.ts";

/**
 * 注入状态简标：显示「Bare（0 注入）」或「注 N」
 * 供总设置页、bot 设置页弹窗头部等位置复用
 */
export function UnitContextBadge({ unit }: { unit: WorkUnit }): ReactElement {
  const m = normalizeContextManifest(unit.contextManifest);
  const items = [
    m.soul === true && "SOUL.md",
    m.user === true && "USER.md",
    m.memorySemantic === true && "MEMORY.md",
    m.memoryDaily === true && "当日精炼",
    m.memoryStanding === true && "STANDING.md",
    m.skills === true && "技能目录",
  ].filter((x): x is string => x !== false);
  const agentsOn = m.agentsMd === "on";
  const bare = items.length === 0 && !agentsOn;
  const total = items.length + (agentsOn ? 1 : 0);

  const firstTurnOff = m.firstTurnInject === false;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-chip px-1.5 py-0.5 text-[10px] font-medium transition",
        bare || firstTurnOff ? "bg-line-soft text-ash" : "bg-teal-tint text-teal font-semibold",
      )}
      title={
        firstTurnOff
          ? `首轮默认关闭注入（已配置 ${total} 项备选，可在聊天输入框按需开启）`
          : bare
            ? `Bare：未注入任何上下文（AGENTS.md ${m.agentsMd === "auto" ? "auto——由执行器原生读取" : "已关闭"}）`
            : `首轮注入 ${total} 项：${[...items, ...(agentsOn ? ["AGENTS.md（强制）"] : [])].join("、")}${m.agentsMd === "auto" ? "；AGENTS.md auto（执行器原生读取）" : ""}`
      }
    >
      {firstTurnOff ? (bare ? "首轮关 (0注)" : `首轮关 (配${total})`) : bare ? "Bare（0 注入）" : `注 ${total}`}
    </span>
  );
}

/**
 * 每 bot 上下文的集中编辑器（ADR 0014 / 用户 2026-10-22 三点反馈）——
 * 注入矩阵 + SOUL / AGENTS / MEMORY / STANDING / USER 五个文件的内容编辑，
 * 一处全办。三个消费面共用这一个组件：
 * - 设置页「上下文清单」分区（带 bot 选择器）
 * - bot 设置对话框的「上下文与文件」区（编辑模式）
 * - 右栏 Context 面板
 *
 * 写路径各归其位：SOUL/AGENTS 走 bot.put（文件即数据库 + 三锁乐观锁），
 * MEMORY/STANDING 走各自 RPC（备份 + 上限硬校验），USER 走全局 RPC（跨 bot 共享）。
 * 用户在 VS Code 里直改也永远成立——编辑器只是同一条写路径的另一个入口。
 */
export function UnitContextEditor({ unitId }: { unitId: string }): ReactElement | null {
  const unit = useWorkbench((s) => s.units.find((u) => String(u.id) === String(unitId)));
  const patchUnitContext = useWorkbench((s) => s.patchUnitContext);
  const putUnitFields = useWorkbench((s) => s.putUnitFields);
  const updateUnit = useWorkbench((s) => s.updateUnit);

  const [adapters, setAdapters] = useState<readonly DaemonExecutorInfo[]>([]);
  useEffect(() => {
    let alive = true;
    listDaemonExecutors()
      .then((list) => {
        if (alive) setAdapters(list);
      })
      .catch(() => {
        /* daemon 没起：AGENTS.md 的 auto 徽标按「未标注」显示（= 工作台兜底注入） */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (unit === undefined) {
    return <p className="p-3 text-caption text-ash">这个 bot 已经不在了（目录或定义被移除）。</p>;
  }

  const manifest = normalizeContextManifest(unit.contextManifest);

  // 主绑定执行器（与 askBot.primaryBinding 同口径）：auto 判定与徽标都看它
  const primary = unit.bindings.find((b) => b.primary === true) ?? unit.bindings[0];
  const primaryRuntime = primary?.runtimeId !== undefined ? String(primary.runtimeId).replace(/^daemon:/, "") : "";
  const nativeReadsAgents =
    adapters.find((a) => a.id === primaryRuntime)?.nativeContextFiles?.some((f) => f.toUpperCase() === "AGENTS.MD") === true;

  const onCount =
    (manifest.soul === true ? 1 : 0) +
    (manifest.user === true ? 1 : 0) +
    (manifest.memorySemantic === true ? 1 : 0) +
    (manifest.memoryDaily === true ? 1 : 0) +
    (manifest.memoryStanding === true ? 1 : 0) +
    (manifest.skills === true ? 1 : 0) +
    (resolveAgentsMdInjection(manifest.agentsMd ?? "auto", nativeReadsAgents) ? 1 : 0);

  /**
   * 开关改动后的预设同步（2026-10-23 四次定稿，指针模型——不再做内容比对跳转）：
   * - 选中了具名预设（自定义N）→ 就地更新该预设本体，选中态不变（改到与默认一致
   *   也仍是自定义N，不跳回默认）；
   * - 未选中 / 选中的是「默认」/「自动保存」→ 改动进「自动保存」草稿槽并选中它
   *   （没有预设时第一次开关即建槽）。增强件：失败静默（putUnitFields silent）。
   */
  const syncPresetOnEdit = async (): Promise<void> => {
    const fresh = useWorkbench.getState().units.find((x) => String(x.id) === String(unitId));
    if (fresh === undefined) return;
    const m = normalizeContextManifest(fresh.contextManifest);
    const presets = fresh.contextPresets ?? [];
    const active = fresh.contextPresetActive ?? "";
    const named = presets.find((c) => c.name === active && c.name !== AUTO_PRESET_NAME);
    const nextPresets = named !== undefined
      ? presets.map((c) => (c.name === named.name ? { ...c, manifest: m } : c))
      : [...presets.filter((c) => c.name !== AUTO_PRESET_NAME), { name: AUTO_PRESET_NAME, manifest: m }];
    const nextActive = named !== undefined ? named.name : AUTO_PRESET_NAME;
    if (nextActive === active && sameContextManifest(normalizeContextManifest(presets.find((c) => c.name === nextActive)?.manifest ?? DEFAULT_CONTEXT_MANIFEST), m)) return;
    await putUnitFields(unit.id, { contextPresets: nextPresets, contextPresetActive: nextActive }, { silent: true }).catch(() => {
      /* 预设同步失败不打断主流程（清单本身已写入） */
    });
  };

  const patch = (p: Partial<ContextManifest>): void => {
    void patchUnitContext(unit.id, p)
      .then(() => void syncPresetOnEdit())
      .catch(() => {});
  };

  return (
    <div className="space-y-3">
      {/* 状态摘要：默认全关（裸跑）是常态而非错误，但要显式可见 */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-card border px-3 py-2",
          onCount === 0 ? "border-line bg-canvas" : "border-teal/40 bg-teal-tint/40",
        )}
      >
        {onCount === 0 ? <Circle size={13} className="shrink-0 text-ash" /> : <CheckCircle2 size={13} className="shrink-0 text-teal" />}
        <p className="text-caption leading-relaxed text-graphite">
          {onCount === 0 ? (
            <>
              <span className="font-medium text-ink">Bare</span> —— 未注入任何上下文文件（默认状态）。
            </>
          ) : (
            <>
              注入 <span className="tnum font-medium text-ink">{onCount}</span> 项上下文。
            </>
          )}
          变更只影响下一个新会话（冻结快照，续聊不重复）。
        </p>
      </div>

      {/* 预设（2026-10-23 四次定稿，指针模型）：胶囊气泡直接选中；选中具名预设后
          开关改动就地更新该预设；未选中改动进「自动保存」草稿槽；不因内容一致跳默认 */}
      <PresetRow unit={unit} manifest={manifest} />

      {/* 工作区生命周期与 Init 补齐栏 */}
      {/* 工作区生命周期栏已移至 bot 设置「身份」分区（2026-10-23 用户裁定：
          注销 Bot / 补充工作区配置是大设置，不该混在上下文注入里造成误会） */}

      {/* ---- 注入矩阵 ---- */}
      <div className="overflow-hidden rounded-card border border-line bg-canvas">
        <div className="px-3 pb-1 pt-2.5">
          <p
            className="text-caption font-medium text-ink"
            title="写入 bot.json（contextManifest 节）——工作台、渠道、定时会话同一份"
          >
            注入清单 · {unit.name}
          </p>
        </div>
        <div className="divide-y divide-line-soft">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-canvas/40">
            <div className="min-w-0">
              <p
                className="text-caption font-semibold text-ink flex items-center gap-1.5"
                title="开启时，新开对话首轮自动按下方清单注入；关闭后开局默认 Bare，由用户在聊天输入框按需勾选。"
              >
                <span>新会话首轮自动注入</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-mono",
                    manifest.firstTurnInject !== false ? "bg-teal-tint text-teal font-medium" : "bg-line-soft text-ash",
                  )}
                >
                  {manifest.firstTurnInject !== false ? "默认开启" : "默认关闭"}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => patch({ firstTurnInject: !(manifest.firstTurnInject !== false) })}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium border transition shrink-0",
                manifest.firstTurnInject !== false
                  ? "border-teal/40 bg-teal text-canvas"
                  : "border-line text-graphite hover:text-ink bg-line-soft/40",
              )}
            >
              {manifest.firstTurnInject !== false ? "已启用" : "已关闭"}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p
                className="text-caption font-medium text-ink flex items-center gap-1.5 flex-wrap"
                title={
                  nativeReadsAgents
                    ? `当前执行器${primaryRuntime !== "" ? `（${primaryRuntime}）` : ""}原生读取 —— auto 不重复注入（防双注）`
                    : `当前执行器${primaryRuntime !== "" ? `（${primaryRuntime}）` : ""}未声明原生读取 —— auto 由工作台注入兜底`
                }
              >
                <span>岗位说明书 · AGENTS.md</span>
                {!hasSubstantiveContent(unit.agentsMd) && (
                  <span className="rounded px-1.5 py-0.5 bg-line-soft text-ash text-[10px] font-normal leading-none">
                    空内容 · 自动跳过
                  </span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 rounded-btn border border-line p-0.5">
              {(["auto", "on", "off"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => patch({ agentsMd: mode })}
                  className={cn(
                    "rounded px-2 py-0.5 text-[11px] font-medium transition",
                    (manifest.agentsMd ?? "auto") === mode ? "bg-teal text-canvas" : "text-graphite hover:text-ink",
                  )}
                >
                  {mode === "auto" ? "auto" : mode === "on" ? "强制注入" : "关闭"}
                </button>
              ))}
            </div>
          </div>
          <ManifestRow
            title="人设 · SOUL.md"
            desc="这个 bot 的人格与主动行为提示词（用户维护，只读注入）"
            on={manifest.soul === true}
            empty={!hasSubstantiveContent(unit.soulMd)}
            onToggle={() => patch({ soul: !(manifest.soul === true) })}
          />
          <ManifestRow
            title="关于用户 · USER.md（全局层）"
            desc="作息、偏好、环境等用户级事实，所有 bot 共享一份；对外渠道 bot 建议关闭"
            on={manifest.user === true}
            onToggle={() => patch({ user: !(manifest.user === true) })}
          />
          <ManifestRow
            title="长期事实 · MEMORY.md"
            desc="项目级关键事实（上限 2200 字符，bot 遵照上限自维护）"
            on={manifest.memorySemantic === true}
            onToggle={() => patch({ memorySemantic: !(manifest.memorySemantic === true) })}
          />
          <ManifestRow
            title="当日精炼 · memory/daily/"
            desc="当天会话的关键结论与踩坑（只读参考）"
            on={manifest.memoryDaily === true}
            onToggle={() => patch({ memoryDaily: !(manifest.memoryDaily === true) })}
          />
          <ManifestRow
            title="红线禁令 · STANDING.md"
            desc="不可打破的常驻指令与安全约束（关闭前请确认后果）"
            on={manifest.memoryStanding === true}
            onToggle={() => patch({ memoryStanding: !(manifest.memoryStanding === true) })}
          />
        </div>
        <div className="border-t border-line-soft">
          <SkillsBindingSection unit={unit} manifestSkills={manifest.skills === true} onToggle={() => patch({ skills: !(manifest.skills === true) })} />
        </div>
      </div>

      {/* ---- 自定义提示词 (Custom Prompt) ---- */}
      <CustomPromptEditor unit={unit} updateUnit={updateUnit} />

      {/* ---- 文件编辑 ---- */}
      <div className="flex items-center justify-between px-0.5 pt-1">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-graphite">
          <FileText size={12} className="text-teal" />
          具体文件内容（可折叠展开编辑保存；VS Code 与 agent 工具均可自改）
        </p>
      </div>

      <SoulFileEditor unit={unit} updateUnit={updateUnit} manifest={manifest} />
      <AgentsFileEditor unit={unit} updateUnit={updateUnit} manifest={manifest} nativeReadsAgents={nativeReadsAgents} />
      <RpcFileEditor
        title="MEMORY.md · 长期事实"
        desc="项目级关键事实与教训。上限 2200 字符——上限本身是最强的整理压力，满了先整合再写"
        icon={Brain}
        injectedLabel={manifest.memorySemantic === true ? "已注入" : "未注入"}
        isInjected={manifest.memorySemantic === true}
        loadKey={unit.rootPath}
        load={() => readProjectMemory(unit.rootPath)}
        save={(content) => writeProjectMemory(unit.rootPath, content).then(() => undefined)}
        template={FILE_TEMPLATES.memory}
      />
      <RpcFileEditor
        title="STANDING.md · 红线禁令"
        desc="不可打破的常驻指令与安全约束（上限 1000 字符，只读禁令注入）"
        icon={ShieldAlert}
        injectedLabel={manifest.memoryStanding === true ? "已注入" : "未注入"}
        isInjected={manifest.memoryStanding === true}
        loadKey={unit.rootPath}
        load={() => readStandingMemory(unit.rootPath)}
        save={(content) => writeStandingMemory(unit.rootPath, content).then(() => undefined)}
        template={FILE_TEMPLATES.standing}
      />
      <UserFileEditor manifest={manifest} />
    </div>
  );
}

/* ------------------------------------------------------------- 小件 */

/* 默认清单 / 自动保存槽名 / 清单比对已上移 core/units.ts（预设行与输入框胶囊共用） */

/**
 * 预设行（2026-10-23 四次定稿，指针模型）——胶囊气泡样式（对齐技能/执行器选择）：
 * - 点击胶囊 = 选中该预设并应用其清单；选中态是**显式指针**（bot.json
 *   contextPresetActive），不做内容比对跳转——自定义1 改到与默认完全一致也仍是
 *   自定义1；
 * - 选中具名预设后的开关改动**就地更新该预设本体**（不跳自动保存）；
 * - 未选中 / 选中的是「默认」时，开关改动进「自动保存」草稿槽并选中它；
 * - 「存为自定义预设」从当前清单建 自定义N 并**选中**它（随后的开关改动即编辑它）；
 * - 「取消选中」回到未选中态：之后的开关改动进自动保存草稿，不再改动选中预设。
 */
function PresetRow({
  unit,
  manifest,
}: {
  unit: WorkUnit;
  manifest: ContextManifest;
}): ReactElement {
  const putUnitFields = useWorkbench((s) => s.putUnitFields);
  const [busy, setBusy] = useState(false);
  const presets = unit.contextPresets ?? [];
  const active = unit.contextPresetActive ?? "";
  const customs = presets.filter((c) => c.name !== AUTO_PRESET_NAME);
  const autoPreset = presets.find((c) => c.name === AUTO_PRESET_NAME);

  /** 一笔写：预设名单 / 选中指针 / 清单本体任一组合——走 store 的自愈写通道
   *  （putUnitFields：锁基线过期时自动拉盘上真值重试，不会「点了又弹回」） */
  const writeFields = async (fields: {
    contextPresets?: readonly { name: string; manifest: ContextManifest }[];
    contextPresetActive?: string;
    contextManifest?: ContextManifest;
  }): Promise<void> => {
    setBusy(true);
    try {
      await putUnitFields(unit.id, fields as Partial<WorkUnit>);
      await useWorkbench.getState().reloadUnit(unit.id);
    } catch {
      /* putUnitFields 已弹通知 */
    } finally {
      setBusy(false);
    }
  };

  /** 选中预设：应用其清单 + 指针一笔写（选中即进入「编辑该预设」状态） */
  const selectPreset = (name: string, m: ContextManifest): void => {
    if (active === name) return;
    void writeFields({ contextManifest: m, contextPresetActive: name });
  };

  /** 自动命名：自定义1、自定义2……取第一个空缺号，不与现存重名 */
  const nextPresetName = (): string => {
    const used = new Set(presets.map((c) => c.name));
    for (let i = 1; i <= 99; i++) {
      const candidate = `自定义${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `自定义${Date.now() % 1000}`;
  };

  /** 存为自定义预设：建 自定义N 并选中（之后的开关改动就地更新它） */
  const saveCustom = (): void => {
    const name = nextPresetName();
    void writeFields({ contextPresets: [...presets, { name, manifest }], contextPresetActive: name });
  };

  /** 删除预设：删的是选中项时，选中态回未选中 */
  const deletePreset = (name: string): void => {
    void writeFields({
      contextPresets: presets.filter((c) => c.name !== name),
      ...(active === name ? { contextPresetActive: "" } : {}),
    });
  };

  const pillCls = (on: boolean): string =>
    cn(
      "flex items-center gap-1 rounded-full border px-3 py-1 text-caption transition select-none",
      on
        ? "border-teal bg-teal-tint font-medium text-teal"
        : "border-line bg-canvas text-graphite hover:border-teal/40 hover:text-ink",
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption font-medium text-ink">预设</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => selectPreset("default", DEFAULT_CONTEXT_MANIFEST)}
        title="选中默认预设（Bare 全关）并应用——之后再改动会转入自动保存草稿"
        className={pillCls(active === "default")}
      >
        {active === "default" ? <CheckCircle2 size={12} /> : <Circle size={12} className="text-ash/50" />}
        默认
      </button>
      {autoPreset !== undefined && (
        <button
          type="button"
          disabled={busy}
          onClick={() => selectPreset(AUTO_PRESET_NAME, autoPreset.manifest)}
          title="自动保存草稿——未选中具名预设时的开关改动都暂存在这里"
          className={pillCls(active === AUTO_PRESET_NAME)}
        >
          {active === AUTO_PRESET_NAME ? <CheckCircle2 size={12} /> : <Circle size={12} className="text-ash/50" />}
          {AUTO_PRESET_NAME}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              deletePreset(AUTO_PRESET_NAME);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                deletePreset(AUTO_PRESET_NAME);
              }
            }}
            className="ml-0.5 text-ash/60 hover:text-loss"
            aria-label="删除自动保存草稿"
          >
            ×
          </span>
        </button>
      )}
      {customs.map((c) => (
        <span
          key={c.name}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full border px-3 py-1 text-caption transition select-none",
            active === c.name
              ? "border-teal bg-teal-tint font-medium text-teal"
              : "border-line bg-canvas text-graphite hover:border-teal/40 hover:text-ink",
          )}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => selectPreset(c.name, c.manifest)}
            title={`选中「${c.name}」并应用——之后的开关改动就地更新这个预设`}
            className="flex items-center gap-1"
          >
            {active === c.name ? <CheckCircle2 size={12} /> : <Circle size={12} className="text-ash/50" />}
            {c.name}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => deletePreset(c.name)}
            title={`删除「${c.name}」`}
            className="text-ash/60 hover:text-loss"
            aria-label={`删除预设 ${c.name}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={saveCustom}
        className="rounded-full border border-dashed border-line px-3 py-1 text-caption text-graphite transition hover:border-teal/50 hover:text-ink disabled:opacity-40"
        title="把当前注入清单保存为新的自定义预设并选中（随后可继续用开关编辑它）"
      >
        ＋ 存为自定义预设
      </button>
      {active !== "" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void writeFields({ contextPresetActive: "" })}
          className="rounded-btn px-2 py-0.5 text-[11px] text-ash transition hover:text-ink"
          title="取消选中：之后的开关改动转入自动保存草稿，不再改动当前选中的预设（清单不变）"
        >
          取消选中
        </button>
      )}
    </div>
  );
}

function ManifestRow({
  title,
  desc,
  on,
  onToggle,
  empty,
}: {
  title: string;
  desc: string;
  on: boolean;
  onToggle: () => void;
  empty?: boolean;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-caption font-medium text-ink flex items-center gap-1.5 flex-wrap" title={desc}>
          <span>{title}</span>
          {empty === true && (
            <span className="rounded px-1.5 py-0.5 bg-line-soft text-ash text-[10px] font-normal leading-none">
              空内容 · 自动跳过
            </span>
          )}
        </p>
      </div>
      <Toggle on={on} onChange={onToggle} ariaLabel={title} />
    </div>
  );
}

/**
 * 技能绑定区（ADR 0014 D8）。两层语义分清楚：
 * - 开关 = manifest.skills（这个 bot 注不注技能目录）；
 * - 名单 = bot.json 的 skills 节（"all" / dirName 数组），只过滤**这个 bot 的注入**，
 *   不动文件系统——全局停用（搬 .disabled/）仍在设置页技能分区。
 */
function SkillsBindingSection({
  unit,
  manifestSkills,
  onToggle,
}: {
  unit: WorkUnit;
  manifestSkills: boolean;
  onToggle: () => void;
}): ReactElement {
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const pushNotice = useWorkbench((s) => s.pushNotice);
  const binding = normalizeSkillBinding(unit.skills);
  const [catalog, setCatalog] = useState<readonly { dirName: string; name: string }[] | null>(null);

  useEffect(() => {
    if (!manifestSkills || catalog !== null) return;
    let alive = true;
    fetchSkillsInventory(unit.rootPath)
      .then((inv) => {
        if (!alive) return;
        const seen = new Set<string>();
        const entries: { dirName: string; name: string }[] = [];
        for (const g of inv.groups) {
          for (const s of g.skills) {
            if (s.disabled || seen.has(s.dirName)) continue;
            seen.add(s.dirName);
            entries.push({ dirName: s.dirName, name: s.name });
          }
        }
        setCatalog(entries);
      })
      .catch(() => {
        if (alive) setCatalog([]);
      });
    return () => {
      alive = false;
    };
  }, [manifestSkills, catalog, unit.rootPath]);

  const isAll = binding.enabled === "all";
  const list = isAll ? [] : binding.enabled;
  const saveBinding = (enabled: "all" | readonly string[]): void => {
    // 三锁全带（guardsOf 同款）：saveBinding 展开整个 unit（含 store 缓存的
    // agentsMd/soulMd 正文），只锁 revision 会让 VS Code 里的并发修改被静默覆盖
    void updateUnit(
      { ...unit, skills: { enabled } },
      { ifRevision: unit.revision, ifAgentsMdHash: unit.agentsMdMeta?.hash, ifSoulMdHash: unit.soulMdMeta?.hash },
    ).catch(() => {
      pushNotice("技能名单未写入", "bot.json 或 AGENTS.md / SOUL.md 已被外部修改，重新打开后再试", { level: "warn" });
    });
  };
  const toggleSkill = (dirName: string): void => {
    const next = list.includes(dirName) ? list.filter((x) => x !== dirName) : [...list, dirName];
    saveBinding(next); // 空名单是合法状态（manifest 开着但一个都不注），不自动翻回 all
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p
            className="text-caption font-medium text-ink"
            title="⚠ 防双注：执行器原生就会发现自己的技能目录（.agents/skills 等）——多数情况下保持关闭即可；此开关是给不列技能的执行器补一份目录索引（name + 路径，不注 SKILL.md 全文）。名单只过滤这个 bot 的注入"
          >
            技能目录 · skills
          </p>
        </div>
        <Toggle on={manifestSkills} onChange={onToggle} ariaLabel="技能目录注入" />
      </div>
      {manifestSkills && (
        <div className="mt-2 border-t border-line-soft pt-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-graphite">
              注入范围：
              {isAll
                ? `全部启用中的技能${catalog !== null ? `（当前发现 ${catalog.length} 个）` : ""}`
                : list.length === 0
                  ? "空名单（不注入任何技能）"
                  : `名单制（${list.length} 个）`}
            </p>
            <div className="flex shrink-0 rounded-btn border border-line p-0.5">
              <button
                type="button"
                onClick={() => saveBinding("all")}
                className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition", isAll ? "bg-teal text-canvas" : "text-graphite hover:text-ink")}
              >
                全部
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isAll) saveBinding([]);
                }}
                className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition", !isAll ? "bg-teal text-canvas" : "text-graphite hover:text-ink")}
              >
                名单
              </button>
            </div>
          </div>
          {!isAll && (
            <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
              {catalog === null && <p className="text-[11px] text-ash">加载清单中…</p>}
              {catalog?.length === 0 && (
                <p className="text-[11px] text-ash">没有发现启用中的技能（各执行器技能源都没有 SKILL.md 文件夹）。</p>
              )}
              {catalog?.map((s) => (
                <label
                  key={s.dirName}
                  className="flex cursor-pointer items-center gap-2 rounded-btn px-1.5 py-1 text-[11px] text-graphite transition hover:bg-line-soft"
                >
                  <input
                    type="checkbox"
                    checked={list.includes(s.dirName)}
                    onChange={() => toggleSkill(s.dirName)}
                    className="h-3 w-3 accent-teal"
                  />
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ash">{s.dirName}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 工作区生命周期与注销栏（2026-10-23 移至 bot 设置「身份」分区渲染） */
export function WorkspaceInitAndUnregisterBar({
  unit,
}: {
  unit: WorkUnit;
}): ReactElement {
  const [initBusy, setInitBusy] = useState(false);
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [unregBusy, setUnregBusy] = useState(false);
  const initWorkspace = useWorkbench((s) => s.initWorkspace);
  const unregisterUnit = useWorkbench((s) => s.unregisterUnit);
  const pushNotice = useWorkbench((s) => s.pushNotice);

  const handleInit = async () => {
    setInitBusy(true);
    try {
      const res = await initWorkspace(unit.rootPath);
      await useWorkbench.getState().reloadUnit(unit.id);
      pushNotice(
        "工作区初始化完成",
        `已补齐 ${res.created.length} 项（memory 目录与官方基础技能），${res.existed.length} 项既有内容已完好保留。MD 正文不落骨架——写内容时才创建。`,
        { level: "info" },
      );
    } catch (e: unknown) {
      pushNotice("初始化失败", e instanceof Error ? e.message : String(e), { level: "warn" });
    } finally {
      setInitBusy(false);
    }
  };

  const handleUnregister = async () => {
    setUnregBusy(true);
    try {
      await unregisterUnit(unit.id);
      pushNotice(
        "Bot 已从工作台注销",
        `「${unit.name}」已从列表移除。本地项目目录（${unit.rootPath}）完全保留，重新导入即可恢复。`,
        { level: "info" },
      );
    } catch (e: unknown) {
      pushNotice("注销失败", e instanceof Error ? e.message : String(e), { level: "warn" });
      setUnregBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-card border border-line bg-rail/40 px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <FolderSync size={13} className="shrink-0 text-teal" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-ink truncate">工作区工具与生命周期</p>
          <p className="text-[10px] text-ash truncate">补齐标准记忆与检索技能，或安全注销</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => void handleInit()}
          disabled={initBusy}
          className="rounded px-2.5 py-1 text-[11px] font-medium border border-line text-graphite hover:text-ink hover:bg-canvas transition disabled:opacity-40"
          title="幂等补齐 memory/daily 目录与官方基础技能 ×2（版本标记升级，绝不覆盖用户自建）；MD 正文不落骨架"
        >
          {initBusy ? "补齐中…" : "补充工作区配置 (Init)"}
        </button>
        {confirmUnregister ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-loss">不删物理文件，仅从列表移除？</span>
            <button
              type="button"
              onClick={() => void handleUnregister()}
              disabled={unregBusy}
              className="rounded bg-loss text-canvas px-2 py-0.5 text-[10px] font-medium hover:bg-loss/90 transition"
            >
              {unregBusy ? "注销中…" : "确认注销"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmUnregister(false)}
              className="rounded px-1.5 py-0.5 text-[10px] text-ash hover:text-ink transition"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmUnregister(true)}
            className="rounded px-2 py-1 text-[11px] text-ash hover:text-loss border border-transparent hover:border-loss/30 transition flex items-center gap-1"
            title="从工作台注销该 Bot（不删除本地磁盘项目文件与代码）"
          >
            <Trash2 size={11} />
            <span>注销 Bot</span>
          </button>
        )}
      </div>
    </div>
  );
}

function CustomPromptEditor({
  unit,
  updateUnit,
}: {
  unit: WorkUnit;
  updateUnit: UpdateUnitFn;
}): ReactElement {
  const baseline = unit.customPrompt ?? "";
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = draft !== baseline;
  const isSubstantive = hasSubstantiveContent(draft);

  useEffect(() => {
    setDraft(unit.customPrompt ?? "");
  }, [unit.id, unit.customPrompt]);

  const DEFAULT_TEMPLATE = `你当前运行在当前项目的专属工作台环境中。
1. 请保持高效严谨的回答风格；
2. 若遇到不确定的项目背景、历史技术决策或日常备忘，请通过 skills 目录中的 \`workbench-context\` 工具按需查阅 \`MEMORY.md\` 或 \`memory/daily/\`；
3. 未经用户明确许可，严禁执行不可逆的危险系统命令与破坏性写操作。`;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await updateUnit(
        { ...unit, customPrompt: draft.trim() } as WorkUnit,
        { ifRevision: unit.revision, ifAgentsMdHash: unit.agentsMdMeta?.hash, ifSoulMdHash: unit.soulMdMeta?.hash },
      );
      await useWorkbench.getState().reloadUnit(unit.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-canvas">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-canvas/40 border-b border-line-soft">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquareQuote size={13} className="shrink-0 text-teal" />
          <p className="text-caption font-medium text-ink">工作区自定义提示词 · Custom Prompt</p>
          <span
            className={cn(
              "rounded-chip px-1.5 py-0.5 text-[10px] font-medium leading-none",
              isSubstantive ? "bg-teal-tint text-teal font-semibold" : "bg-line-soft text-ash",
            )}
          >
            {isSubstantive ? `已配置 · 首轮注入 (${draft.trim().length}字)` : "留空（0 注入）"}
          </span>
          {dirty && (
            <span className="rounded-chip bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium leading-none">
              未保存
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setDraft(DEFAULT_TEMPLATE)}
            className="rounded px-2 py-0.5 text-[11px] font-medium border border-line text-graphite hover:text-ink hover:bg-rail transition"
            title="一键填入包含通用指引与记忆技能调用的推荐模板"
          >
            使用推荐代写模板
          </button>
          {draft !== "" && (
            <button
              type="button"
              onClick={() => setDraft("")}
              className="rounded px-1.5 py-0.5 text-[11px] text-ash hover:text-loss transition"
            >
              清空
            </button>
          )}
        </div>
      </div>
      <div className="p-3 space-y-2">
        <p className="text-[11px] leading-snug text-ash">
          在执行器已有系统提示词之外，为本工作区注入自定义前置指引。留空时不注入任何 Token；想让 Bot 记住特定工作习惯、业务规则或引导其调用检索 Skill 时推荐使用。
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={4}
          placeholder="留空则不注入……（可点击右上角「使用推荐代写模板」一键填入标准范式）"
          className="w-full resize-y rounded-btn border border-line bg-rail px-2.5 py-2 font-mono text-caption leading-relaxed text-ink outline-none placeholder:text-ash focus:border-teal/60"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="tnum text-[10px] text-ash">
            {draft.length.toLocaleString("zh-CN")} 字 {!dirty && !busy && draft !== "" ? " · 已保存" : ""}
          </p>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="shrink-0 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas transition disabled:opacity-40"
          >
            {busy ? "保存中…" : "保存提示词"}
          </button>
        </div>
        {err !== null && (
          <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 文件编辑器 */

/**
 * 推荐代写模板（2026-10-23）：与自定义提示词的模板同款口径——空文件一键填入，
 * 已有内容仅展示不覆盖。模板只是起手式不是规范，用户改掉即个性化。
 */
const FILE_TEMPLATES = {
  soul: `# 人设\n\n你是……（一句话角色定位）\n\n## 语气与风格\n- 例：克制、直接，不堆客套\n\n## 主动行为\n- 例：发现风险先说风险，再给方案`,
  agents: `# 岗位说明书\n\n## 职责\n- ……\n\n## 决策依据\n- 遇到 X 优先考虑 Y\n\n## 输出契约\n- 结论先行；改动带文件路径\n\n## 红线\n- 未经确认不做不可逆操作`,
  memory: `# 项目记忆\n\n## 关键事实\n- ……\n\n## 技术选型与共识\n- ……\n\n## 踩过的坑\n- ……`,
  standing: `# 常驻红线\n\n- 严禁未经确认执行不可逆操作（删除 / 强推 / 格式化）\n- 严禁把密钥、token 写进日志或提交\n- ……`,
  user: `# 关于我\n\n## 作息与环境\n- ……\n\n## 偏好\n- 例：中文简短答复，结论先行\n\n## 常用环境\n- 例：Windows + Git Bash`,
} as const;

/** 编辑器外壳：标题 + 展开/折叠 + 路径 + 计数 + 保存；内容与保存动作由调用方注入 */
function EditorShell({
  title,
  desc,
  icon: Icon,
  injectedLabel,
  isInjected,
  path,
  draft,
  setDraft,
  baseline,
  limit,
  busy,
  err,
  onSave,
  placeholder,
  extra,
  defaultCollapsed = false,
  missing = false,
  template,
}: {
  title: string;
  desc: string;
  icon?: LucideIcon;
  injectedLabel?: string;
  isInjected?: boolean;
  path: string;
  draft: string;
  setDraft: (v: string) => void;
  baseline: string;
  limit: number | null;
  busy: boolean;
  err: string | null;
  onSave: () => void;
  placeholder: string;
  extra?: string;
  defaultCollapsed?: boolean;
  /** 文件未创建（未经编辑不落盘）——标题挂浅色「未创建」标，路径行淡化 */
  missing?: boolean;
  /** 推荐代写模板：草稿为空时一键填入；已有内容时仅展示预览，绝不覆盖 */
  template?: string;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [showTemplate, setShowTemplate] = useState(false);
  const dirty = draft !== baseline;
  const over = limit !== null && draft.length > limit;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-canvas transition-colors">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
        className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 transition hover:bg-rail/50 select-none"
      >
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon size={13} className={cn("shrink-0", missing ? "text-ash/50" : "text-teal")} />}
          <p className={cn("text-caption font-medium", missing ? "text-ash" : "text-ink")}>{title}</p>
          {missing && (
            <span
              className="rounded bg-line-soft/60 px-1.5 py-0.5 text-[10px] font-normal leading-none text-ash/80"
              title="未经编辑不落盘——工作区里没有这个文件，注入为 0；写第一行内容并保存时才创建"
            >
              未创建 · 0 注入
            </span>
          )}
          {injectedLabel && (
            <span
              className={cn(
                "rounded-chip px-1.5 py-0.5 text-[10px] font-medium leading-none",
                isInjected ? "bg-teal-tint text-teal font-semibold" : "bg-line-soft text-ash",
              )}
            >
              {injectedLabel}
            </span>
          )}
          {dirty && (
            <span className="rounded-chip bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium leading-none">
              未保存
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("hidden sm:inline max-w-[240px] truncate text-[10px]", missing ? "text-ash/50" : "text-ash")} title={path}>
            {path}
          </span>
          <ChevronDown
            size={13}
            className={cn("text-ash transition-transform duration-150", collapsed && "-rotate-90")}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="border-t border-line-soft">
          <p className={cn("px-3 pt-2 text-[11px] leading-snug", missing ? "text-ash/70" : "text-ash")}>{desc}</p>
          {template !== undefined && (
            <div className="px-3 pt-1.5">
              {draft.trim() === "" ? (
                <button
                  type="button"
                  onClick={() => setDraft(template)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium border border-line text-graphite hover:text-ink hover:bg-rail transition"
                  title="一键填入推荐代写模板"
                >
                  使用推荐代写模板
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowTemplate(!showTemplate)}
                  className="rounded px-2 py-0.5 text-[11px] border border-line text-ash hover:text-ink hover:bg-rail transition"
                  title="查看推荐代写模板（已有内容，仅展示不覆盖）"
                >
                  {showTemplate ? "收起模板" : "查看推荐模板（不覆盖）"}
                </button>
              )}
              {showTemplate && draft.trim() !== "" && (
                <div className="mt-1.5">
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-btn border border-line-soft bg-rail/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ash">
                    {template}
                  </pre>
                  <p className="mt-1 text-[10px] text-ash/70">模板仅作展示——已有内容不会被覆盖；想用模板请先清空正文再点「使用推荐代写模板」。</p>
                </div>
              )}
            </div>
          )}
          <div className="space-y-2 px-3 pb-3 pt-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={5}
              placeholder={placeholder}
              className="w-full resize-y rounded-btn border border-line bg-rail px-2.5 py-2 font-mono text-caption leading-relaxed text-ink outline-none placeholder:text-ash focus:border-teal/60"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="tnum text-[10px] text-ash">
                {draft.length.toLocaleString("zh-CN")}
                {limit !== null ? `/${limit.toLocaleString("zh-CN")}` : ""} 字
                {over ? " · 超限，保存会被拒绝" : ""}
                {extra !== undefined ? ` · ${extra}` : ""}
                {!dirty && !busy ? " · 已保存" : ""}
              </p>
              <button
                type="button"
                onClick={onSave}
                disabled={busy || !dirty || over}
                className="shrink-0 rounded-btn bg-ink px-3 py-1.5 text-caption font-medium text-canvas transition disabled:opacity-40"
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
            {err !== null && (
              <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** bot.put 通道的文件编辑器（SOUL/AGENTS）：三锁乐观锁 + 保存后 reload 刷新 hash 基线 */
function BotPutFileEditor({
  label,
  desc,
  icon,
  injectedLabel,
  isInjected,
  field,
  metaPath,
  placeholder,
  unit,
  updateUnit,
  template,
}: {
  label: string;
  desc: string;
  icon?: LucideIcon;
  injectedLabel?: string;
  isInjected?: boolean;
  field: "soulMd" | "agentsMd";
  metaPath: string;
  placeholder: string;
  unit: WorkUnit;
  updateUnit: (u: WorkUnit, guards?: { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string }) => Promise<void>;
  template?: string;
}): ReactElement {
  const baseline = unit[field] ?? "";
  const missing = baseline.trim() === "" && unit[field === "soulMd" ? "soulMdMeta" : "agentsMdMeta"] === undefined;
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prevBaselineRef = useRef(baseline);
  const prevUnitIdRef = useRef(unit.id);

  // unit 切换或外部变更时对齐草稿基线
  useEffect(() => {
    if (unit.id !== prevUnitIdRef.current) {
      prevUnitIdRef.current = unit.id;
      prevBaselineRef.current = baseline;
      setDraft(baseline);
      setErr(null);
      return;
    }
    if (baseline !== prevBaselineRef.current) {
      setDraft((cur) => (cur === prevBaselineRef.current ? baseline : cur));
      prevBaselineRef.current = baseline;
    }
  }, [unit.id, baseline]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await updateUnit(
        { ...unit, [field]: draft } as WorkUnit,
        // 三锁全带：payload 带着另一份文件的缓存正文，只锁单边会让并发修改被静默覆盖
        { ifRevision: unit.revision, ifAgentsMdHash: unit.agentsMdMeta?.hash, ifSoulMdHash: unit.soulMdMeta?.hash },
      );
      await useWorkbench.getState().reloadUnit(unit.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(
        msg.includes("conflict")
          ? "盘上已被外部修改（VS Code / 另一窗口）——重新进入这个页面加载新内容后再试"
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditorShell
      title={label}
      desc={desc}
      icon={icon}
      injectedLabel={injectedLabel}
      isInjected={isInjected}
      path={metaPath}
      draft={draft}
      setDraft={setDraft}
      baseline={baseline}
      limit={null}
      busy={busy}
      err={err}
      onSave={() => void save()}
      placeholder={placeholder}
      template={template}
      missing={missing}
    />
  );
}

function SoulFileEditor({
  unit,
  updateUnit,
  manifest,
}: {
  unit: WorkUnit;
  updateUnit: UpdateUnitFn;
  manifest: ContextManifest;
}): ReactElement {
  return (
    <BotPutFileEditor
      label="SOUL.md · 人设"
      desc="这个 bot 是谁、怎么说话、主动做什么——一段写给模型看的人设（注入上限 2000，超限部分注入时截断）"
      icon={Sparkles}
      injectedLabel={manifest.soul === true ? "已注入" : "未注入"}
      isInjected={manifest.soul === true}
      field="soulMd"
      metaPath={unit.soulMdMeta?.path ?? `${unit.rootPath}/SOUL.md（保存时创建）`}
      placeholder={"你是……（语气、原则、主动行为）"}
      unit={unit}
      updateUnit={updateUnit}
      template={FILE_TEMPLATES.soul}
    />
  );
}

function AgentsFileEditor({
  unit,
  updateUnit,
  manifest,
  nativeReadsAgents,
}: {
  unit: WorkUnit;
  updateUnit: UpdateUnitFn;
  manifest: ContextManifest;
  nativeReadsAgents: boolean;
}): ReactElement {
  const agentsInjected = resolveAgentsMdInjection(manifest.agentsMd ?? "auto", nativeReadsAgents);
  const injectedLabel =
    manifest.agentsMd === "on"
      ? "强制注入"
      : manifest.agentsMd === "off"
        ? "已关闭"
        : nativeReadsAgents
          ? "auto: 原生读取"
          : "auto: 工作台注入";

  return (
    <BotPutFileEditor
      label="AGENTS.md · 岗位说明书"
      desc="规矩文件：这个 bot 要遵守什么。多数执行器原生读取（auto 时不重复注入），内容对一切执行器可见"
      icon={ScrollText}
      injectedLabel={injectedLabel}
      isInjected={agentsInjected}
      field="agentsMd"
      metaPath={unit.agentsMdMeta?.path ?? `${unit.rootPath}/AGENTS.md`}
      placeholder={"# 岗位说明书\n\n- ……"}
      unit={unit}
      updateUnit={updateUnit}
      template={FILE_TEMPLATES.agents}
    />
  );
}

interface MemoryLikeFile {
  readonly content: string;
  readonly chars: number;
  readonly limit: number;
  readonly exists: boolean;
  readonly path?: string;
}

/** RPC 通道的文件编辑器（MEMORY/STANDING）：load/save 都走 daemon，上限硬校验在 daemon 侧 */
function RpcFileEditor({
  title,
  desc,
  icon,
  injectedLabel,
  isInjected,
  loadKey,
  load,
  save,
  template,
}: {
  title: string;
  desc: string;
  icon?: LucideIcon;
  injectedLabel?: string;
  isInjected?: boolean;
  loadKey: string;
  load: () => Promise<MemoryLikeFile>;
  save: (content: string) => Promise<void>;
  template?: string;
}): ReactElement {
  const [file, setFile] = useState<MemoryLikeFile | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    load()
      .then((f) => {
        setFile(f);
        setDraft(f.content);
        setErr(null);
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load 闭包随 loadKey 变化
  }, [loadKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doSave = async () => {
    setBusy(true);
    setErr(null);
    try {
      await save(draft);
      refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditorShell
      title={title}
      desc={desc}
      icon={icon}
      injectedLabel={injectedLabel}
      isInjected={isInjected}
      path={file?.path ?? `${loadKey}（保存时创建）`}
      draft={draft}
      setDraft={setDraft}
      baseline={file?.content ?? ""}
      limit={file?.limit && Number.isFinite(file.limit) ? file.limit : null}
      busy={busy}
      err={err}
      onSave={() => void doSave()}
      placeholder={"- （每行一条）"}
      template={template}
      missing={file !== null && file.exists === false}
    />
  );
}

/** USER.md：全局层——不属于任何 bot，这里编辑的是所有 bot 共享的那一份 */
function UserFileEditor({ manifest }: { manifest: ContextManifest }): ReactElement {
  const [file, setFile] = useState<UserContextFile | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readUserContext()
      .then((f) => {
        if (!alive) return;
        setFile(f);
        setDraft(f.content);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await writeUserContext(draft);
      const f = await readUserContext();
      setFile(f);
      setDraft(f.content);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditorShell
      title="USER.md · 关于我（全局层，所有 bot 共享）"
      desc="希望每个 bot 都知道的用户级事实：作息、偏好、说话风格、常用环境。住在工作台集中存储家，改动自动备份；是否注入由每个 bot 的清单决定"
      icon={UserCheck}
      injectedLabel={manifest.user === true ? "已注入" : "未注入"}
      isInjected={manifest.user === true}
      path={file?.path ?? "USER.md（全局，保存时创建）"}
      draft={draft}
      setDraft={setDraft}
      baseline={file?.content ?? ""}
      limit={file?.limit ?? 2000}
      busy={busy}
      err={err}
      onSave={() => void save()}
      placeholder={"- （把希望每个 bot 都知道的用户级事实写在这里。每行一条。）"}
      template={FILE_TEMPLATES.user}
      missing={file !== null && file.exists === false}
    />
  );
}

/** updateUnit 的签名（三锁乐观锁 guards）——各文件编辑器共用 */
type UpdateUnitFn = (
  u: WorkUnit,
  guards?: { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string },
) => Promise<void>;
