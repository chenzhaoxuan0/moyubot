import { useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  Brain,
  Check,
  CheckSquare,
  ExternalLink,
  FileCode,
  FileText,
  ShieldAlert,
  Sparkles,
  Square,
  User,
  Wrench,
} from "lucide-react";
import { useWorkbench, selectActiveUnit, MANIFEST_ALL_OFF } from "../store/useWorkbench.ts";
import {
  ensureContextPresets,
  normalizeContextManifest,
  resolveActivePresetName,
  resolveEffectiveTurnManifest,
  type ContextManifest,
  type TurnContextConfig,
} from "../core/units.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { cn } from "./cn.ts";

/**
 * 输入框底栏的「上下文注入」状态胶囊与快捷勾选面板。
 *
 * 核心设计哲学：
 * 1. 默认行为极度丝滑：首轮默认跟随 Bot 预设，续聊默认不重复注入；
 * 2. 极致的自由度与自主权：用户可在任意一轮随时开启/关闭注入，自主勾选要注入的文件；
 * 3. 与 bot 设置同一套预设模型（2026-10-26 指针模型 v2）：预设名单是唯一事实源，
 *    「默认」是名单里真实可编辑的一条；这里点胶囊/勾文件与设置页走同一条写路
 *    （store 统一写层），勾选改动直接写进当前选中的预设（自动保存，无草稿槽）；
 *    仅「清空」是本轮临时覆盖（mode:"off"，不动预设）；
 * 4. 默认「单轮生效」防污染：发送后自动复位为后续默认，亦可勾选「本会话保持」。
 */
export function ComposerContextPicker({ compact }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const unit = useWorkbench(selectActiveUnit);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const sessions = useWorkbench((s) => s.sessions);
  const turnContextConfig = useWorkbench((s) => s.turnContextConfig);
  const setTurnContextConfig = useWorkbench((s) => s.setTurnContextConfig);
  const openContext = useSidePane((s) => s.openContext);

  const activeSession = activeSessionId !== null ? sessions.find((s) => s.id === activeSessionId) : undefined;
  const isFirstTurn =
    activeSession === undefined ||
    activeSession.live === false ||
    activeSession.status === "done" ||
    activeSession.status === "failed";

  const botManifest = normalizeContextManifest(unit?.contextManifest);
  const effectiveManifest = resolveEffectiveTurnManifest(turnContextConfig, unit?.contextManifest, isFirstTurn);

  // 点击外部自动关闭气泡
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [open]);

  // 统计当前生效的项数与名称
  const activeItemLabels: string[] = [];
  if (effectiveManifest !== null) {
    if (effectiveManifest.memoryStanding) activeItemLabels.push("常驻红线 (STANDING.md)");
    if (effectiveManifest.soul) activeItemLabels.push("人设 (SOUL.md)");
    if (effectiveManifest.user) activeItemLabels.push("关于用户 (USER.md)");
    if (effectiveManifest.memorySemantic) activeItemLabels.push("长期事实 (MEMORY.md)");
    if (effectiveManifest.agentsMd === "on" || (effectiveManifest.agentsMd === "auto" && isFirstTurn)) {
      activeItemLabels.push("岗位说明 (AGENTS.md)");
    }
    if (effectiveManifest.memoryDaily) activeItemLabels.push("当日精炼 (daily)");
    if (effectiveManifest.skills) activeItemLabels.push("技能目录 (skills)");
  }

  const isEnabled = effectiveManifest !== null && activeItemLabels.length > 0;
  const count = activeItemLabels.length;

  // 胶囊文本
  const buttonLabel = isFirstTurn
    ? isEnabled
      ? `首轮: ${count}项`
      : "首轮: 关"
    : isEnabled
      ? `本轮附加: ${count}项`
      : "附加上下文";

  // 单独切换某一项（兜底底板 = 全关常量，与 run 的分叉/新段覆盖同一份）
  // 开关改动 = 改当前选中的预设（2026-10-26 指针模型 v2，与 bot 设置同一写层）：
  // 在「默认」下勾选就是改默认预设（可保存），在自定义N下勾选就是改自定义N——
  // 不再是「仅本轮临时覆盖」（旧 custom 模式造成两处 UI 看似各管一套的根源）。
  const patchPresetManifest = useWorkbench((s) => s.patchContextPresetManifest);

  const toggleItem = (key: keyof ContextManifest) => {
    const base = effectiveManifest ?? { ...MANIFEST_ALL_OFF };
    const currentVal = base[key];
    const nextVal = key === "agentsMd" ? (currentVal === "off" ? "on" : "off") : !currentVal;

    if (unit === undefined) {
      // 没有可写的单元（未选 bot）：退化为仅本轮的临时清单，点了至少有反应
      setTurnContextConfig({
        mode: "custom",
        customManifest: { ...base, firstTurnInject: true, [key]: nextVal },
      });
      return;
    }
    // 本轮清空（mode off）下勾选：先回 bot_default，让这次编辑立即生效
    if (turnContextConfig.mode === "off") {
      setTurnContextConfig({ mode: "bot_default" });
    }
    void patchPresetManifest(unit.id, { [key]: nextVal } as Partial<ContextManifest>);
  };

  // 快捷预设（与 bot 设置同一份名单、同一写层）：名单即事实源，「默认」是名单里
  // 真实可编辑的一条；选中指针由 resolveActivePresetName 兜底（空串/旧 "default"
  // 指针/已删条目 → 名单第一条），高亮口径与设置页完全一致。
  const presets = ensureContextPresets(unit?.contextPresets);
  const activePreset = resolveActivePresetName(unit?.contextPresetActive, presets);
  const selectPresetAction = useWorkbench((s) => s.selectContextPreset);

  /**
   * 点预设胶囊：store 统一写层写指针 + 应用清单（与 bot 设置同一条路），并把
   * 本轮切回 bot_default（清空态下点预设 = 恢复注入）。注意不能
   * resetTurnContextConfig——它落回 DEFAULT_TURN_CONFIG（mode:"off"），点预设
   * 反而亮「清空」，这是 347c09f 后「预设点了没反应」的根因。
   */
  const selectPreset = (name: string): void => {
    if (unit === undefined) return;
    setTurnContextConfig({ mode: "bot_default", customManifest: undefined });
    void selectPresetAction(unit.id, name);
  };

  /** 高亮口径：mode 必须是 bot_default 且指针指向该条；custom/off 时预设行
   *  不高亮（高亮落在「清空」或清单本身） */
  const presetActive = (name: string): boolean => turnContextConfig.mode === "bot_default" && name === activePreset;

  const applyPreset = (preset: "bot_default" | "off") => {
    if (preset === "bot_default") {
      setTurnContextConfig({ mode: "bot_default" });
    } else {
      setTurnContextConfig({ mode: "off" });
    }
  };

  return (
    <div className="relative inline-block shrink-0 select-none" ref={containerRef}>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`上下文注入 (${buttonLabel}) · 点击自定义本轮发送注入哪些文件`}
          className={cn(
            "relative flex h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8 shrink-0 items-center justify-center rounded-lg border transition",
            isEnabled
              ? "border-teal/50 bg-teal-tint/80 text-teal shadow-xs font-semibold"
              : "border-line-soft bg-card/60 text-graphite hover:bg-line-soft hover:text-ink",
          )}
        >
          {/* 图标与右侧执行器/模型选择器的 Sparkles 区分：上下文注入用「翻开的
              书」—— 一眼读出「资料/记忆注入」，而不是又一个魔棒 */}
          <BookOpenText size={14} />
          {isEnabled && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-teal" />}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`当前上下文注入：\n${activeItemLabels.length > 0 ? activeItemLabels.join("\n") : "（无注入）"}\n\n点击自主选择本轮注入哪些文件`}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition border font-medium whitespace-nowrap",
            isEnabled
              ? "border-teal/40 bg-teal-tint text-teal hover:border-teal/60 shadow-xs"
              : "border-line-soft bg-card/40 text-graphite hover:text-ink hover:bg-line-soft/60",
          )}
        >
          <BookOpenText size={13} className={cn(isEnabled ? "text-teal" : "text-graphite")} />
          <span className="font-mono text-[11px] tracking-tight">{buttonLabel}</span>
        </button>
      )}

      {/* 弹出面板 */}
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-84 max-w-[calc(100vw-24px)] rounded-2xl border border-line bg-canvas p-3 shadow-2xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
          {/* 顶栏：标题与轮次状态 */}
          <div className="flex items-center justify-between pb-2.5 border-b border-line-soft">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-ink">上下文注入控制</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-mono",
                  isFirstTurn ? "bg-teal-tint text-teal font-medium" : "bg-line-soft text-ash",
                )}
              >
                {isFirstTurn ? "首轮对话" : "续聊轮次"}
              </span>
            </div>

            {/* 本轮总开关 */}
            <button
              type="button"
              onClick={() => {
                if (isEnabled) {
                  applyPreset("off");
                } else {
                  applyPreset("bot_default");
                }
              }}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                isEnabled
                  ? "bg-teal-tint text-teal hover:bg-teal-tint/80"
                  : "bg-line-soft text-graphite hover:text-ink",
              )}
            >
              {isEnabled ? "已启用" : "已关闭"}
            </button>
          </div>

          {/* 快捷预设（与 bot 设置同一份名单、同一写层）：名单里第一条即「默认」，
              真实可编辑；清空 = 仅本轮不注入（临时覆盖，不动预设） */}
          <div className="pt-2 pb-1.5">
            <div className="text-[10px] text-ash font-medium mb-1.5 flex items-center justify-between">
              <span>快捷预设</span>
              <span className="font-mono text-[9px] text-ash/80">与 bot 设置同步</span>
            </div>
            <div className="flex flex-wrap items-center gap-1 select-none">
              {presets.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => selectPreset(c.name)}
                  title={`选中「${c.name}」并应用——与 bot 设置同款，全局生效；此处的开关改动会写进这个预设`}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition truncate text-center cursor-pointer",
                    presetActive(c.name)
                      ? "border-teal/40 bg-teal-tint text-teal font-medium"
                      : "border-line-soft text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  {c.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => applyPreset("off")}
                title="清空本轮注入（仅本轮临时覆盖，不改预设）"
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition truncate text-center cursor-pointer",
                  turnContextConfig.mode === "off"
                    ? "border-teal/40 bg-teal-tint text-teal font-medium"
                    : "border-line-soft text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                清空
              </button>
            </div>
          </div>

          {/* 7 大文件细粒度清单：勾选 = 写入当前选中的预设（含默认），自动保存 */}
          <div className="py-2 border-t border-line-soft space-y-1">
            <div className="text-[10px] text-ash font-medium mb-1">
              {turnContextConfig.mode === "off"
                ? `本轮已清空 · 勾选任意项会改「${activePreset}」预设并恢复注入`
                : `注入清单 · 编辑「${activePreset}」预设（改动自动保存）`}
            </div>

            {/* 1. STANDING.md */}
            <ItemRow
              icon={<ShieldAlert size={13} className="text-amber-500" />}
              label="常驻指令 / 红线"
              file="STANDING.md"
              checked={effectiveManifest?.memoryStanding === true}
              onClick={() => toggleItem("memoryStanding")}
              desc="安全硬约束，压轴注入保证遵守"
            />

            {/* 2. SOUL.md */}
            <ItemRow
              icon={<Sparkles size={13} className="text-purple-500" />}
              label="人设与沟通偏好"
              file="SOUL.md"
              checked={effectiveManifest?.soul === true}
              onClick={() => toggleItem("soul")}
              desc="语气习惯、主动角色定位"
            />

            {/* 3. USER.md */}
            <ItemRow
              icon={<User size={13} className="text-blue-500" />}
              label="关于用户"
              file="USER.md"
              checked={effectiveManifest?.user === true}
              onClick={() => toggleItem("user")}
              desc="用户作息、硬件环境与习惯"
            />

            {/* 4. MEMORY.md */}
            <ItemRow
              icon={<Brain size={13} className="text-teal" />}
              label="长期事实记忆"
              file="MEMORY.md"
              checked={effectiveManifest?.memorySemantic === true}
              onClick={() => toggleItem("memorySemantic")}
              desc="历史事实与经验"
            />

            {/* 5. AGENTS.md */}
            <ItemRow
              icon={<FileCode size={13} className="text-emerald-500" />}
              label="岗位说明书"
              file="AGENTS.md"
              checked={effectiveManifest?.agentsMd === "on" || (effectiveManifest?.agentsMd === "auto" && isFirstTurn)}
              onClick={() => toggleItem("agentsMd")}
              desc="职责边界（执行器原生未读时兜底）"
            />

            {/* 6. daily/*.md */}
            <ItemRow
              icon={<FileText size={13} className="text-sky-500" />}
              label="当日精炼摘要"
              file="daily/*.md"
              checked={effectiveManifest?.memoryDaily === true}
              onClick={() => toggleItem("memoryDaily")}
              desc="当天提取的会话结论"
            />

            {/* 7. skills */}
            <ItemRow
              icon={<Wrench size={13} className="text-orange-500" />}
              label="技能目录"
              file="skills/"
              checked={effectiveManifest?.skills === true}
              onClick={() => toggleItem("skills")}
              desc="可用技能轻量索引"
            />
          </div>

          {/* 底部：生效范围与文件编辑入口 */}
          <div className="pt-2 border-t border-line-soft flex items-center justify-between text-[11px]">
            <label className="flex items-center gap-1.5 text-graphite hover:text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                checked={turnContextConfig.persistForSession === true}
                onChange={(e) => setTurnContextConfig({ persistForSession: e.target.checked })}
                className="rounded border-line text-teal focus:ring-teal/30 h-3 w-3"
              />
              <span>本会话保持此选择</span>
            </label>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (unit) openContext({ unitId: unit.id, unitName: unit.name });
              }}
              className="flex items-center gap-1 text-teal hover:underline font-medium"
            >
              <span>编辑各文件</span>
              <ExternalLink size={11} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemRow({
  icon,
  label,
  file,
  checked,
  onClick,
  desc,
}: {
  icon: React.ReactNode;
  label: string;
  file: string;
  checked: boolean;
  onClick: () => void;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition select-none",
        checked
          ? "bg-teal-tint/30 text-ink hover:bg-teal-tint/50"
          : "text-graphite hover:bg-line-soft/60 hover:text-ink opacity-70 hover:opacity-100",
      )}
    >
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{label}</span>
          <span className="font-mono text-[10px] text-ash/80 truncate">({file})</span>
        </div>
        <div className="text-[10px] text-ash truncate leading-tight">{desc}</div>
      </div>
      <div className="shrink-0 text-teal">
        {checked ? (
          <CheckSquare size={14} className="text-teal" />
        ) : (
          <Square size={14} className="text-ash/60" />
        )}
      </div>
    </button>
  );
}
