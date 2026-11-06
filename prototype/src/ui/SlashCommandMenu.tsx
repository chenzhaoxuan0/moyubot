import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Sparkles, SquareSlash } from "lucide-react";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { CanvasVisibleContext } from "./canvasVisibility.ts";
import { cn } from "./cn.ts";

/**
 * 执行器原生斜杠面板 —— 数据全部来自当前执行器自己的声明面
 * （zcode readPresentation + skills/referenceCatalog / claude supportedCommands
 * 或 ~/.claude 三段 / codex prompts 目录 / opencode GET /command+/agent）。
 * 按 ZCode 斜杠面板的节奏分三组：命令 / 技能 / 子智能体。
 * 选中只把 "/name " 放进草稿，Enter 后原样透传给执行器分发 ——
 * 面板是「发现 + 提示」，不是「执行器」。
 */

/** 条目种类 → 分组定义（顺序即渲染顺序） */
const GROUPS = [
  {
    kind: "command" as const,
    label: "命令",
    icon: SquareSlash,
    /** 徽标文案 */
    badge: (c: NativeCommandInfo) => (c.builtin ? "内置" : c.source === "project" ? "项目" : c.source === "plugin" ? "插件" : "自定义"),
  },
  {
    kind: "skill" as const,
    label: "技能",
    icon: Sparkles,
    badge: (c: NativeCommandInfo) => (c.source === "project" ? "项目" : c.source === "plugin" ? "插件" : "用户"),
  },
  {
    kind: "agent" as const,
    label: "子智能体",
    icon: Bot,
    badge: (c: NativeCommandInfo) => (c.source === "project" ? "项目" : "用户"),
  },
];

/**
 * 过滤谓词（导出给 Composer 复用）：Composer 需要在菜单无可选项时放行 Enter
 * 直接发送（避免「菜单开着但没匹配项，Enter 按不动」）。
 */
export function filterNativeCommands(
  commands: readonly NativeCommandInfo[],
  query: string,
): readonly NativeCommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const filtered = commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false) ||
      (c.description?.toLowerCase().includes(q) ?? false),
  );
  return filtered.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aExact = aName === q ? 0 : 1;
    const bExact = bName === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const aStarts = aName.startsWith(q) ? 0 : 1;
    const bStarts = bName.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;

    const aAliasStarts = a.aliases?.some((al) => al.toLowerCase().startsWith(q)) ? 0 : 1;
    const bAliasStarts = b.aliases?.some((al) => al.toLowerCase().startsWith(q)) ? 0 : 1;
    if (aAliasStarts !== bAliasStarts) return aAliasStarts - bAliasStarts;

    return 0;
  });
}

/**
 * 描述清洗：执行器给的 description 常是整段 markdown（"## Usage" 起头），
 * 面板只要一行人话 —— 取首个非标题行，剥掉反引号/井号/YAML 引号，截断到 96 字符。
 * 清洗后只剩 "Usage" 这类章节标题残渣（zcode 会把正文首行当 description 抽出来）
 * 视为没有描述 —— 显示一行无意义词比不显示更糟。
 */
function cleanDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("---"));
  const text = (firstLine ?? raw.trim()).replace(/`+/g, "").replace(/^#+\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (text === "" || /^usage$/i.test(text)) return undefined;
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

interface SlashCommandMenuProps {
  filter: string;
  onSelect: (cmd: NativeCommandInfo) => void;
  onClose: () => void;
  /** 当前执行器的原生命令面（清单 + 拉取状态），由 Composer 注入 */
  readonly native: {
    readonly commands: readonly NativeCommandInfo[];
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly executorName: string;
    readonly error?: string;
  };
}

export function SlashCommandMenu({ filter, onSelect, onClose, native }: SlashCommandMenuProps) {
  const matched = useMemo(() => filterNativeCommands(native.commands, filter), [native.commands, filter]);

  // 分组（只渲染非空组；扁平后的顺序即 ↑↓ 遍历顺序）
  const sections = useMemo(() => {
    const out: Array<{ group: (typeof GROUPS)[number]; items: readonly NativeCommandInfo[] }> = [];
    for (const group of GROUPS) {
      const items = matched.filter((c) => (c.kind ?? "command") === group.kind);
      if (items.length > 0) out.push({ group, items });
    }
    return out;
  }, [matched]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // 菜单开着时切到别的主视图：画布只是隐藏（mount-once latch），不挂监听 ——
  // 别吞那些页的 Enter/Tab/方向键（见 CanvasVisibleContext）
  const canvasVisible = useContext(CanvasVisibleContext);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter, flat.length]);

  useEffect(() => {
    if (!canvasVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // 这个 effect 挂在早退 return 之前（hooks 顺序不能变），「菜单没内容」
      // 必须在处理函数里自己挡掉：否则输入框里的 ↑↓ 会被 preventDefault 吞掉。
      if (flat.length === 0) return;
      // 输入法组字中的 Enter 是「选词」，不是「执行这条指令」
      if (e.isComposing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % flat.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + flat.length) % flat.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (flat[activeIndex]) {
          e.preventDefault();
          onSelect(flat[activeIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flat, activeIndex, onSelect, onClose, canvasVisible]);

  // 点击外部收起菜单
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (listRef.current?.closest(".slash-command-menu")?.contains(target)) return;
      if (target.closest("textarea[aria-label='任务输入']")) return;
      onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  // 滚动跟随：键盘选中项滚进可视区
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showMenu = flat.length > 0 || native.status === "loading" || native.status === "error" || (native.status === "ready" && native.commands.length === 0);
  if (!showMenu) return null;

  let runningIndex = -1; // 扁平下标（键盘导航与渲染行一一对应）

  return (
    <div className="slash-command-menu absolute bottom-full -left-px -right-px mb-2.5 rounded-2xl border border-line bg-card/95 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95 duration-100 overflow-hidden flex flex-col">
      {/* 头部栏：对标 T3code 命令面板设计 */}
      <div className="px-4 py-2.5 border-b border-line-soft flex items-center justify-between bg-canvas/70 select-none">
        <div className="flex items-center gap-2">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold leading-none">
            /
          </span>
          <span className="text-xs font-semibold text-ink">{native.executorName}</span>
          <span className="text-[11px] text-graphite font-normal">命令面板</span>
          {flat.length > 0 && (
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-full bg-line-soft text-graphite font-medium">
              {flat.length}
            </span>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[10px] text-graphite/80 font-sans">
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">↑</kbd>
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">↓</kbd>
            <span className="ml-0.5">导航</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-line-soft border border-line text-graphite">↵</kbd>
            <span>选定</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-[9px] px-1 py-0.5 rounded bg-line-soft border border-line text-graphite">esc</kbd>
            <span>关闭</span>
          </span>
        </div>
      </div>

      {/* 列表区：T3code 风格向上列表展示 */}
      <div ref={listRef} className="max-h-[340px] overflow-y-auto px-2 py-1.5 space-y-2">
        {sections.map(({ group, items }) => {
          const Icon = group.icon;
          return (
            <div key={group.kind} className="space-y-0.5">
              {/* 分组头 */}
              <div className="px-2.5 pt-1.5 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-graphite/70 select-none">
                <Icon size={12} className="text-graphite/60" />
                <span>{group.label}</span>
                <span className="font-mono text-[10px] text-graphite/50 font-normal">({items.length})</span>
              </div>
              {/* 列表行：单行横向排布，充分利用输入框宽度 */}
              {items.map((cmd) => {
                runningIndex += 1;
                const idx = runningIndex;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={`${cmd.kind ?? "command"}:${cmd.name}`}
                    data-idx={idx}
                    type="button"
                    onClick={() => onSelect(cmd)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      "group w-full flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors select-none",
                      isActive
                        ? "bg-line-soft text-ink font-medium shadow-xs"
                        : "text-graphite hover:bg-line-soft/60 hover:text-ink",
                    )}
                  >
                    {/* 左侧图标 */}
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs transition-colors",
                        isActive
                          ? "border-line bg-canvas text-teal shadow-xs"
                          : "border-transparent bg-canvas/70 text-graphite/70 group-hover:text-ink",
                      )}
                    >
                      <Icon size={13} />
                    </div>

                    {/* 命令 / 技能名称 + 参数提示 */}
                    <div className="flex items-center gap-1.5 shrink-0 max-w-[280px]">
                      <span
                        className={cn(
                          "font-mono text-xs font-semibold truncate",
                          isActive ? "text-ink" : "text-ink/90",
                        )}
                      >
                        /{cmd.name}
                      </span>
                      {cmd.argumentHint ? (
                        <span
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-teal-tint/60 text-teal truncate max-w-[130px] font-medium"
                          title={cmd.argumentHint}
                        >
                          {cmd.argumentHint}
                        </span>
                      ) : null}
                    </div>

                    {/* 中间描述：单行弹性截断 */}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-xs text-left",
                        isActive ? "text-graphite" : "text-graphite/80",
                      )}
                    >
                      {cleanDescription(cmd.description) ?? "—"}
                    </span>

                    {/* 右侧来源徽标（对标 T3code SkillSourceBadge） */}
                    <span
                      className={cn(
                        "ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border leading-tight transition-colors",
                        isActive
                          ? "bg-canvas border-line text-ink"
                          : "bg-line-soft/40 border-line-soft text-graphite/80",
                      )}
                    >
                      {group.badge(cmd)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}

        {native.status === "loading" && native.commands.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-graphite">
            <Loader2 size={14} className="animate-spin text-teal" />
            <span>正在从 {native.executorName} 拉取原生命令与技能…</span>
          </div>
        )}
        {native.status === "ready" && native.commands.length === 0 && flat.length === 0 && (
          <div className="py-8 text-center text-xs text-graphite leading-relaxed">
            {native.executorName} 没有原生命令面 —— "/" 开头的文本会原样发给执行器，直接输入任务即可。
          </div>
        )}
        {native.status === "error" && native.commands.length === 0 && (
          <div className="py-8 text-center text-xs text-graphite leading-relaxed">
            命令面板拉取失败（{native.error ?? "daemon 不可达"}）。"/" 文本仍会原样发给执行器。
          </div>
        )}
        {flat.length === 0 && native.status !== "loading" && native.commands.length > 0 && (
          <div className="py-8 text-center text-xs text-graphite">
            未找到与 "{filter}" 匹配的命令或技能
          </div>
        )}
      </div>
    </div>
  );
}
