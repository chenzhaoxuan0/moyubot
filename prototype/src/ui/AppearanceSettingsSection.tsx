import { useRef, useState } from "react";
import {
  Palette,
  Check,
  Sun,
  Moon,
  Monitor,
  Image as ImageIcon,
  Sparkles,
  Frame,
  Wand2,
  FileJson,
  RefreshCw,
  RotateCcw,
  Upload,
  Download,
  Trash2,
  Smartphone,
  Laptop,
  PanelBottom,
  Bot,
  Sticker,
} from "lucide-react";
import { useAppearance } from "../store/useAppearance.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { Toggle } from "./Toggle.tsx";
import { useLayoutStore } from "./mobile/useIsMobile.ts";
import { useShell as useShellState } from "../store/useShell.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import {
  APPEARANCE_PRESETS,
  contrastRatio,
  DEFAULT_TRANSPARENCY,
  WALLPAPER_DEFAULT_TRANSPARENCY,
  resolveFocusX,
  resolveFocusY,
  toHex,
  type DensityScale,
  type FontChoice,
  type MotionLevel,
  type PaletteKey,
  type SafeArea,
  type ShadowLevel,
  type TaskMode,
} from "../core/appearance.ts";
import { cn } from "./cn.ts";

/* ========================================================================== 小组件 */

function SectionCard({
  icon,
  title,
  desc,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-teal">{icon}</span>
          <h2 className="text-body font-medium text-ink" title={desc}>
            {title}
          </h2>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/** 颜色输入：色块 + 十六进制文本框。色块走原生 picker，文本框可精确粘贴。 */
function ColorField({
  label,
  value,
  onChange,
  onReset,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onReset?: () => void;
  hint?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const hex = toHex(value, "#000000");

  return (
    <div className="flex items-center gap-2">
      <label className="relative h-7 w-7 shrink-0 overflow-hidden rounded-btn border border-line">
        <span className="absolute inset-0" style={{ backgroundColor: hex }} />
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} 颜色`}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <div className="min-w-0 flex-1">
        <span className="block text-caption text-ink" title={hint}>
          {label}
        </span>
      </div>
      <input
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            onChange(draft);
            setDraft(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        spellCheck={false}
        aria-label={`${label} 色值`}
        className="w-24 shrink-0 rounded-btn border border-line bg-canvas px-2 py-1 text-caption font-mono text-ink outline-none focus:border-teal"
      />
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          title="恢复该色默认值"
          aria-label={`恢复 ${label} 默认值`}
          className="h-7 w-7 shrink-0 rounded-btn text-ash hover:bg-surface-hover hover:text-ink"
        >
          <RotateCcw size={12} className="mx-auto" />
        </button>
      )}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format: (v: number) => string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn(disabled && "pointer-events-none opacity-40")}>
      <div className="flex items-center justify-between">
        <span className="text-body-sm text-ink" title={hint}>
          {label}
        </span>
        <span className="rounded-chip bg-surface-hover px-2 py-0.5 text-caption font-mono text-graphite">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="mt-2 w-full accent-teal"
      />
    </div>
  );
}

function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  hint?: string;
}) {
  return (
    <div>
      <span className="block text-body-sm text-ink" title={hint}>
        {label}
      </span>
      <div className="mt-2 inline-flex rounded-input border border-line bg-canvas p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-btn px-3 py-1 text-body-sm transition",
              value === option.value
                ? "bg-teal text-canvas"
                : "text-graphite hover:bg-surface-hover hover:text-ink",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ========================================================================== 主组件 */

const PALETTE_FIELDS: readonly { key: PaletteKey; label: string; hint: string }[] = [
  { key: "background", label: "画布 background", hint: "全局底色" },
  { key: "panel", label: "面板 panel", hint: "卡片与浮层" },
  { key: "panelAlt", label: "次面板 panelAlt", hint: "侧栏与次级面" },
  { key: "accent", label: "强调 accent", hint: "主按钮与激活态" },
  { key: "accentAlt", label: "强调次色 accentAlt", hint: "强调色悬停态" },
  { key: "secondary", label: "次要 secondary", hint: "终端蓝系" },
  { key: "highlight", label: "高亮 highlight", hint: "终端品红系" },
  { key: "text", label: "正文 text", hint: "主文字" },
  { key: "muted", label: "弱化 muted", hint: "次级文字" },
  { key: "line", label: "线条 line", hint: "发丝线与边框" },
];

export function AppearanceSettingsSection() {
  const store = useAppearance();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const logoFileRef = useRef<HTMLInputElement | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  const layoutPref = useLayoutStore((s) => s.preference);
  const setLayoutPref = useLayoutStore((s) => s.setPreference);
  const windowIsMobile = useLayoutStore((s) => s.windowIsMobile);

  const statusBarHeight = useShellState((s) => s.statusBarHeight);
  const statusBarLocked = useShellState((s) => s.statusBarLocked);
  const setStatusBarLocked = useShellState((s) => s.setStatusBarLocked);

  const chatColumnWidth = useShellState((s) => s.chatColumnWidth);
  const setChatColumnWidth = useShellState((s) => s.setChatColumnWidth);

  const { mode, resolvedAppearance, activeProfile, art, wallpaper, logo, presetId } = store;
  const followsTheme = activeProfile.transparency === null;
  // 跟随默认的显示值按有无壁纸分档：无壁纸 0%（不透明），有壁纸 30%（否则壁纸被盖住）
  const wallpaperOn = store.wallpaper.enabled && Boolean(store.wallpaper.source);
  const transparency =
    activeProfile.transparency ?? (wallpaperOn ? WALLPAPER_DEFAULT_TRANSPARENCY : DEFAULT_TRANSPARENCY);
  const hasWallpaper = wallpaper.enabled && Boolean(wallpaper.source);

  /**
   * 壁纸导入：交给 daemon 落盘到 <homeDir>/wallpapers/，appearance.json 里只留一个路径。
   * 图不再进 localStorage，5MB 配额这回事就不存在了；agent 也能直接把图丢进那个目录再改路径。
   */
  const handleWallpaperFile = async (file: File) => {
    setImportError(null);
    if (!file.type.startsWith("image/")) {
      setImportError("请选择图片文件");
      return;
    }
    try {
      await store.importWallpaper(file);
    } catch (error) {
      setImportError(
        error instanceof Error ? `保存失败：${error.message}` : "保存失败，请确认后台 daemon 在运行",
      );
    }
  };

  const textContrast = contrastRatio(activeProfile.palette.text, activeProfile.palette.background);
  const mutedContrast = contrastRatio(activeProfile.palette.muted, activeProfile.palette.background);

  /**
   * 自选 logo 导入：与壁纸同一套链路 —— daemon 落盘到 <homeDir>/logos/，
   * appearance.json 只记路径。导入成功当场启用（本地 File 直接转 data URL 上屏）。
   */
  const handleLogoFile = async (file: File) => {
    setLogoError(null);
    if (!file.type.startsWith("image/")) {
      setLogoError("请选择图片文件");
      return;
    }
    try {
      await store.importLogo(file);
    } catch (error) {
      setLogoError(
        error instanceof Error ? `保存失败：${error.message}` : "保存失败，请确认后台 daemon 在运行",
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------- 预设主题 */}
      <SectionCard
        icon={<Palette size={16} />}
        title="预设主题"
        desc="一键换十组配色。透明度、表面、壁纸等你的自定义设置在切换时原样保留；之后再微调会变成「自定义」。"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {APPEARANCE_PRESETS.map((preset) => {
            const active = preset.id === presetId;
            // 预览用「该预设自己会切过去的档案」，不是当前正在编辑的档案。
            // 否则 DS 那两个深色预设（哥特/暮色）在浅色模式下会借用浅色档案，
            // 四张卡片看上去一模一样 —— 选哪张都看不出区别。
            const swatchProfile = preset.mode === "auto" ? preset.light : preset[preset.mode];
            const swatches = swatchProfile.palette;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => store.applyPreset(preset)}
                className={cn(
                  "group relative rounded-card border p-3 text-left transition",
                  active
                    ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                    : "border-line bg-canvas hover:border-line-soft hover:bg-surface-hover",
                )}
              >
                <div className="mb-2.5 flex h-9 gap-1 overflow-hidden rounded-btn border border-line">
                  {[swatches.background, swatches.panel, swatches.panelAlt, swatches.accent].map(
                    (color, index) => (
                      <span key={index} className="flex-1" style={{ backgroundColor: color }} />
                    ),
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-body-sm font-medium text-ink" title={preset.desc}>
                    {preset.name}
                  </span>
                  {active && (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-canvas">
                      <Check size={11} strokeWidth={3} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 外观模式 */}
      <SectionCard
        icon={<Sun size={16} />}
        title="外观模式"
        desc="决定用哪一套配色档案。对应 DS 的 appearance 字段。"
      >
        <div
          className="grid grid-cols-3 gap-3"
          title={`正在编辑「${resolvedAppearance === "dark" ? "深色" : "浅色"}」档案。切换模式会切到另一套档案，两套的改动各自独立保存。`}
        >
          {(
            [
              { value: "light", label: "浅色", icon: Sun },
              { value: "dark", label: "深色", icon: Moon },
              { value: "auto", label: "跟随系统", icon: Monitor },
            ] as const
          ).map((option) => {
            const Icon = option.icon;
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => store.setMode(option.value)}
                className={cn(
                  "flex items-center gap-2 rounded-card border p-3 transition",
                  active
                    ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                    : "border-line bg-canvas hover:bg-surface-hover",
                )}
              >
                <Icon size={14} className={active ? "text-teal" : "text-graphite"} />
                <span className="text-body-sm font-medium text-ink">{option.label}</span>
                {active && (
                  <span className="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-teal text-canvas">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 显示视图模式 */}
      <SectionCard
        icon={<Smartphone size={16} />}
        title="显示视图模式"
        desc="选择工作台使用桌面端完整布局还是手机移动端布局。随时可在抽屉或顶部栏中切换。"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(
            [
              { value: "auto" as const, label: "自动检测", icon: Monitor, hint: "跟随屏幕宽度与触屏" },
              { value: "mobile" as const, label: "手机视图", icon: Smartphone, hint: "底部输入框 + 抽屉导航" },
              { value: "desktop" as const, label: "电脑视图", icon: Laptop, hint: "多栏侧栏与全功能桌面" },
            ]
          ).map((option) => {
            const Icon = option.icon;
            const active = layoutPref === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setLayoutPref(option.value)}
                className={cn(
                  "flex items-start gap-2.5 rounded-card border p-3 text-left transition",
                  active
                    ? "border-teal bg-teal-tint/20 ring-1 ring-teal"
                    : "border-line bg-canvas hover:bg-surface-hover",
                )}
              >
                <Icon size={16} className={cn("mt-0.5 shrink-0", active ? "text-teal" : "text-graphite")} />
                <div className="min-w-0 flex-1">
                  <span className="block text-body-sm font-medium text-ink" title={option.hint}>
                    {option.label}
                  </span>
                </div>
                {active && (
                  <span className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal text-canvas">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 底栏（任务栏） */}
      <SectionCard
        icon={<PanelBottom size={16} />}
        title="底栏（任务栏）"
        desc="折叠对话停靠的地方。高度可锁（任务栏锁定语义）：锁定时固定不可拖拽，默认锁定在最薄一档 28px。"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p
              className="text-body-sm font-medium text-ink"
              title={
                statusBarLocked
                  ? `已锁定在当前高度（${statusBarHeight}px）。解锁后可拖动底栏上缘调整。`
                  : "未锁定：拖动底栏上缘可在 28–44px 间调整（拉高显示任务详情行），双击手柄复位最薄档。"
              }
            >
              锁定底栏高度
            </p>
          </div>
          <Toggle on={statusBarLocked} onChange={setStatusBarLocked} ariaLabel="锁定底栏高度" />
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 配色 */}
      <SectionCard
        icon={<Sparkles size={16} />}
        title="配色"
        desc="十组颜色，键名与 DS 的 theme.json.colors 完全一致，方便日后与 DS 主题包互通。"
        action={
          <button
            type="button"
            onClick={() => store.resetPalette()}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
          >
            <RotateCcw size={12} />
            全部重置
          </button>
        }
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {PALETTE_FIELDS.map((field) => (
            <ColorField
              key={field.key}
              label={field.label}
              hint={field.hint}
              value={activeProfile.palette[field.key]}
              onChange={(next) => store.setPaletteColor(field.key, next)}
              onReset={() => store.resetPaletteColor(field.key)}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
          <span className={cn(textContrast < 4.5 ? "text-loss" : "text-ash")}>
            正文对比度 {textContrast.toFixed(2)}:1 {textContrast < 4.5 ? "· 低于 WCAG AA 4.5" : "· 达标"}
          </span>
          <span className={cn(mutedContrast < 3 ? "text-loss" : "text-ash")}>
            弱化文字对比度 {mutedContrast.toFixed(2)}:1
          </span>
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 透明度 */}
      <SectionCard
        icon={<Frame size={16} />}
        title="面板透明度"
        desc="只改背景底色的通透度，文字与图标始终完全不透明 —— 这条与 DS 的行为一致，并有测试钉死。"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span
              className="text-body-sm text-ink"
              title="0% 为完全不透明，100% 为完全透明（方向与 CSS 的 alpha 相反，DS 也是这个约定）。拖动后点「跟随主题」可清除自定义值、退回默认：无壁纸 0%（不透明）；开着壁纸时 30% —— 壁纸垫在最底层，底色不半透它就永远看不见。"
            >
              背景透明度
            </span>
            <div className="flex items-center gap-2">
              {followsTheme && (
                <span className="rounded-chip bg-teal-tint px-2 py-0.5 text-caption text-teal">
                  跟随主题
                </span>
              )}
              <span className="rounded-chip bg-surface-hover px-2 py-0.5 text-caption font-mono text-graphite">
                {transparency}% {transparency === 0 ? "不透明" : transparency === 100 ? "全透" : ""}
              </span>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={transparency}
            onChange={(e) => store.setTransparency(Number(e.target.value))}
            aria-label="背景透明度"
            className="w-full accent-teal"
          />
          {!followsTheme && (
            <button
              type="button"
              onClick={() => store.setTransparency(null)}
              className="rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
            >
              跟随主题（清除覆盖）
            </button>
          )}

          <div className="space-y-3 border-t border-line-soft pt-4">
            <div className="flex items-center justify-between">
              <span
                className="text-body-sm text-ink"
                title="只作用于设置页整页底色，与上面的背景透明度相互独立。默认 0% 完全不透明，叠在主界面上时不透出下层文字；调高后壁纸会透进设置页，但下层内容也会跟着显形。"
              >
                设置页透明度
              </span>
              <span className="rounded-chip bg-surface-hover px-2 py-0.5 text-caption font-mono text-graphite">
                {activeProfile.overlayTransparency}%
                {activeProfile.overlayTransparency === 0 ? "不透明" : activeProfile.overlayTransparency === 100 ? "全透" : ""}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={activeProfile.overlayTransparency}
              onChange={(e) => store.setOverlayTransparency(Number(e.target.value))}
              aria-label="设置页透明度"
              className="w-full accent-teal"
            />
          </div>

          <div className="space-y-3 border-t border-line-soft pt-4">
            <div className="flex items-center justify-between">
              <span
                className="text-body-sm text-ink"
                title="只作用于终端画布的底色，终端文字永远不透明。开着壁纸时建议 60% 以上才能明显透出壁纸（终端后面还垫着一层全局底色）。改完需刷新页面（F5）重建终端才生效 —— xterm 的透明开关只在创建时读取。"
              >
                终端透明度
              </span>
              <span className="rounded-chip bg-surface-hover px-2 py-0.5 text-caption font-mono text-graphite">
                {activeProfile.terminalTransparency}%
                {activeProfile.terminalTransparency === 0 ? "不透明" : activeProfile.terminalTransparency === 100 ? "全透" : ""}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={activeProfile.terminalTransparency}
              onChange={(e) => store.setTerminalTransparency(Number(e.target.value))}
              aria-label="终端透明度"
              className="w-full accent-teal"
            />
          </div>
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 壁纸 */}
      <SectionCard
        icon={<ImageIcon size={16} />}
        title="背景壁纸"
        desc="一张图铺满整窗。焦点与安全区决定压暗往哪边让，内容才不会被壁纸吃掉。"
        action={
          <button
            type="button"
            onClick={() => store.resetWallpaper()}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
          >
            <RotateCcw size={12} />
            清除
          </button>
        }
      >
        <div className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleWallpaperFile(file);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="选中的图由后台 daemon 落盘到工作目录的 wallpapers/ 下，appearance.json 里只记一个路径——图片本身不进配置文件。"
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-surface-hover"
            >
              <Upload size={13} />
              选择图片
            </button>
            {wallpaper.source && (
              <button
                type="button"
                onClick={() => store.setWallpaper("enabled", !wallpaper.enabled)}
                className={cn(
                  "flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-body-sm transition",
                  wallpaper.enabled
                    ? "bg-teal text-canvas"
                    : "border border-line text-graphite hover:bg-surface-hover",
                )}
              >
                {wallpaper.enabled ? "已启用" : "已停用"}
              </button>
            )}
          </div>
          {importError && <p className="text-caption text-loss">{importError}</p>}
          {wallpaper.path && (
            <p className="rounded-btn border border-line/60 bg-line-soft/30 px-2.5 py-1.5 text-caption text-graphite">
              壁纸文件：<span className="font-mono text-ink">{wallpaper.path}</span>
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SliderField
              label="缩放"
              value={wallpaper.zoom}
              min={1}
              max={2}
              step={0.05}
              onChange={(v) => store.setWallpaper("zoom", v)}
              format={(v) => `${v.toFixed(2)}×`}
              disabled={!hasWallpaper}
            />
            <SliderField
              label="压暗"
              value={wallpaper.dim}
              min={0}
              max={0.8}
              step={0.05}
              onChange={(v) => store.setWallpaper("dim", v)}
              format={(v) => `${Math.round(v * 100)}%`}
              disabled={!hasWallpaper}
            />
            <SliderField
              label="内容沉底强度"
              value={wallpaper.taskIntensity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => store.setWallpaper("taskIntensity", v)}
              format={(v) => `${Math.round(v * 100)}%`}
              disabled={!hasWallpaper}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SegmentedField<SafeArea>
              label="安全区 safeArea"
              value={art.safeArea}
              onChange={(v) => store.setArt("safeArea", v)}
              options={[
                { value: "auto", label: "自动" },
                { value: "left", label: "左" },
                { value: "right", label: "右" },
                { value: "center", label: "中" },
                { value: "none", label: "无" },
              ]}
              hint="决定压暗从哪一侧扩散，把对比度让给内容区"
            />
            <SegmentedField<TaskMode>
              label="任务模式 taskMode"
              value={art.taskMode}
              onChange={(v) => store.setArt("taskMode", v)}
              options={[
                { value: "auto", label: "自动" },
                { value: "ambient", label: "氛围" },
                { value: "banner", label: "横幅" },
                { value: "full", label: "铺满" },
                { value: "off", label: "关闭" },
              ]}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SliderField
              label="焦点 X"
              value={resolveFocusX(art)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => store.setArt("focusX", v)}
              format={(v) => `${Math.round(v * 100)}%`}
              hint={`安全区默认 ${Math.round(resolveFocusX({ ...art, focusX: null }) * 100)}%`}
              disabled={!hasWallpaper}
            />
            <SliderField
              label="焦点 Y"
              value={resolveFocusY(art)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => store.setArt("focusY", v)}
              format={(v) => `${Math.round(v * 100)}%`}
              disabled={!hasWallpaper}
            />
          </div>

          {hasWallpaper && (
            <button
              type="button"
              onClick={() => store.resetArt()}
              className="rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
            >
              重置焦点与安全区
            </button>
          )}
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 应用 Logo */}
      <SectionCard
        icon={<Sticker size={16} />}
        title="应用 Logo"
        desc="换成你自己的图 —— 侧栏、浏览器标签页、Electron 窗口与托盘图标全部跟着换。内置品牌标自带亮白底/暗黑底双版。"
        action={
          logo.mode === "custom" ? (
            <button
              type="button"
              onClick={() => store.resetLogo()}
              className="flex shrink-0 items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
            >
              <RotateCcw size={12} />
              恢复品牌标
            </button>
          ) : undefined
        }
      >
        <div className="space-y-4">
          <input
            ref={logoFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleLogoFile(file);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-4">
            {/* 预览：就是当前真实生效的图标（自定义图或随主题的品牌标） */}
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-card border border-line bg-canvas">
              <BrandLogo className="h-11 w-11 rounded-btn object-cover" />
            </div>
            <div className="min-w-48 flex-1">
              <SegmentedField<"brand" | "custom">
                label="图标来源"
                value={logo.mode}
                onChange={(v) => {
                  // 还没有自定义图就切「自定义」= 直接打开选图；选完导入会自动启用
                  if (v === "custom" && !logo.source) {
                    logoFileRef.current?.click();
                    return;
                  }
                  store.setLogo("mode", v);
                }}
                options={[
                  { value: "brand", label: "品牌标" },
                  { value: "custom", label: "自定义" },
                ]}
              />
            </div>
          </div>
          {logoError && <p className="text-caption text-loss">{logoError}</p>}
          {logo.mode === "custom" && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => logoFileRef.current?.click()}
                  title="选中的图由后台 daemon 落盘到工作目录的 logos/ 下，appearance.json 里只记一个路径。"
                  className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-surface-hover"
                >
                  <Upload size={13} />
                  更换图片
                </button>
              </div>
              {logo.path && (
                <p className="rounded-btn border border-line/60 bg-line-soft/30 px-2.5 py-1.5 text-caption text-graphite">
                  logo 文件：<span className="font-mono text-ink">{logo.path}</span>
                </p>
              )}
            </div>
          )}
          <p className="text-caption text-graphite">
            自定义图会居中裁方，同一张用在明暗两套主题；窗口 / 托盘图标在桌面端实时同步。
            agent 也可以直接改 appearance.json 的 logo.path（图放 logos/ 目录）。
          </p>
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 表面 */}
      <SectionCard
        icon={<Wand2 size={16} />}
        title="表面与排版"
        desc="对应 DS safe-css 策略里允许的表面变量。每一项的取值域都照抄 DS 校验器的上下限。"
        action={
          <button
            type="button"
            onClick={() => store.resetSurface()}
            className="flex shrink-0 items-center gap-1.5 rounded-btn border border-line px-2.5 py-1 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
          >
            <RotateCcw size={12} />
            重置
          </button>
        }
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
          <SliderField
            label="圆角 radius"
            value={activeProfile.surface.radius}
            min={0}
            max={28}
            step={1}
            onChange={(v) => store.setSurface("radius", v)}
            format={(v) => `${v}px`}
            hint="按原比例联动四档圆角（按钮/输入/卡片/胶囊）"
          />
          <div className="sm:col-span-2">
            {/* 与同网格的 SliderField 标签同级（text-body-sm text-ink）：
                视觉同层就得同字号，此前 text-caption text-ash 小了一级 */}
            <p className="mb-2 text-body-sm text-ink" title="作用于侧栏的 bot 头像框。">
              bot 头像框形态
            </p>
            <div className="flex gap-2">
              {([
                { id: "rounded", label: "圆角" },
                { id: "square", label: "方形（无圆角）" },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => store.setAvatarFrame(opt.id)}
                  aria-pressed={store.avatarFrame === opt.id}
                  className={cn(
                    "rounded-btn border px-3 py-1 text-body-sm transition",
                    store.avatarFrame === opt.id
                      ? "border-teal-edge bg-teal-tint font-medium text-teal"
                      : "border-line text-graphite hover:bg-surface-hover hover:text-ink",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {/* mt-2：上一行底部是按钮（实心顶到行底），滑杆行底部是 range 元素盒
              （轨道细、盒内自带空隙）——补 8px 让视觉空白与滑杆行之间一致 */}
          <div className="mt-2 sm:col-span-2">
            <p
              className="mb-2 text-body-sm text-ink"
              title="时间线阅读列与输入框共用的最大宽度（默认 900 ≈ ZCode）。用户气泡最宽跟列同宽，调宽即变宽。"
            >
              对话列宽
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={640}
                max={1440}
                step={40}
                value={chatColumnWidth}
                onChange={(e) => setChatColumnWidth(Number(e.target.value))}
                className="flex-1 accent-teal"
                aria-label="对话列宽（像素）"
              />
              <span className="tnum w-14 shrink-0 text-right text-caption text-graphite">{chatColumnWidth}px</span>
              <button
                type="button"
                onClick={() => setChatColumnWidth(900)}
                className="shrink-0 rounded-btn border border-line px-2 py-0.5 text-caption text-graphite hover:bg-surface-hover hover:text-ink"
              >
                默认
              </button>
            </div>
          </div>
          <SliderField
            label="表面不透明度 opacity"
            value={activeProfile.surface.opacity}
            min={0.65}
            max={1}
            step={0.01}
            onChange={(v) => store.setSurface("opacity", v)}
            format={(v) => `${Math.round(v * 100)}%`}
            hint="有壁纸时会在正文下垫一层画布色"
          />
          <SliderField
            label="背景模糊 blur"
            value={activeProfile.surface.blur}
            min={0}
            max={30}
            step={1}
            onChange={(v) => store.setSurface("blur", v)}
            format={(v) => `${v}px`}
          />
          <SliderField
            label="边框强度 borderAlpha"
            value={activeProfile.surface.borderAlpha}
            min={0}
            max={1}
            step={0.02}
            onChange={(v) => store.setSurface("borderAlpha", v)}
            format={(v) => v.toFixed(2)}
          />
          <SliderField
            label="字号缩放 fontScale"
            value={activeProfile.surface.fontScale}
            min={0.85}
            max={1.3}
            step={0.01}
            onChange={(v) => store.setSurface("fontScale", v)}
            format={(v) => `${v.toFixed(2)}×`}
            hint={`当前正文 ${Math.round(14 * activeProfile.surface.fontScale)}px`}
          />
          <SegmentedField<ShadowLevel>
            label="投影 shadow"
            value={activeProfile.surface.shadow}
            onChange={(v) => store.setSurface("shadow", v)}
            options={[
              { value: "none", label: "无" },
              { value: "soft", label: "轻" },
              { value: "strong", label: "重" },
            ]}
          />
          <SegmentedField<FontChoice>
            label="字体 fontFamily"
            value={activeProfile.surface.fontFamily}
            onChange={(v) => store.setSurface("fontFamily", v)}
            options={[
              { value: "system", label: "系统" },
              { value: "grotesk", label: "无衬线" },
              { value: "serif", label: "衬线" },
              { value: "mono", label: "等宽" },
            ]}
          />
          <SegmentedField<DensityScale>
            label="密度 density"
            value={activeProfile.surface.density}
            onChange={(v) => store.setSurface("density", v)}
            options={[
              { value: "compact", label: "紧凑" },
              { value: "standard", label: "标准" },
              { value: "comfortable", label: "宽松" },
            ]}
          />
          <SegmentedField<MotionLevel>
            label="动效 motion"
            value={activeProfile.surface.motion}
            onChange={(v) => store.setSurface("motion", v)}
            options={[
              { value: "off", label: "关闭" },
              { value: "reduced", label: "减弱" },
              { value: "standard", label: "标准" },
            ]}
            hint="只影响颜色过渡的时长，不引入位移或缩放"
          />
        </div>
      </SectionCard>

      {/* ---------------------------------------------------- 外观文件 */}
      <SectionCard
        icon={<FileJson size={16} />}
        title="外观文件"
        desc="整套外观就是这一个 JSON 文件。直接让 agent 改它，应用几秒内自己跟进 —— 不用重启，也不用在这个页面里点。终端配色也随主题实时同步，无需重启后台 Shell。"
      >
        <div className="space-y-4">
          <div className="rounded-btn border border-line bg-canvas p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="text-caption text-graphite">当前外观文件</span>
              <span
                className={cn(
                  "shrink-0 rounded-chip px-2 py-0.5 text-caption",
                  store.source === "file"
                    ? "bg-teal-tint text-teal"
                    : "bg-surface-hover text-graphite",
                )}
              >
                {store.source === "file"
                  ? "文件已连接"
                  : store.source === "fallback"
                    ? "临时兜底（daemon 未运行）"
                    : "内置默认"}
              </span>
            </div>
            <p className="mt-1.5 select-all break-all font-mono text-body-sm text-ink">
              {store.filePath ?? "~/.agent-workbench/appearance.json"}
            </p>
            {store.source !== "file" && (
              <p className="mt-1.5 text-caption text-loss">
                后台 daemon 没连上，改动只存在浏览器里，重开会丢。启动 daemon（pnpm dev:daemon）后自动接管。
              </p>
            )}
          </div>

          {store.lastError && (
            <p className="rounded-btn border border-loss/40 bg-loss/10 px-3 py-2 text-caption text-loss">
              上次写入失败：{store.lastError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void store.reload()}
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-surface-hover"
            >
              <RefreshCw size={13} />
              重新读取文件
            </button>
            {/* 一个按钮胜过一串 schema 说明：跳到对话页（总管优先，否则第一个
                bot），预填一条带文件路径与取值域指引的提示词，待发送 */}
            <button
              type="button"
              onClick={() => {
                const wb = useWorkbench.getState();
                const target = wb.units.find((u) => u.id === "steward") ?? wb.units.find((u) => u.rootPath !== "") ?? null;
                if (target === null) {
                  wb.pushNotice("还没有可用的 bot", "先在左侧栏新建一个 bot，再回来点「让 agent 改外观」。", { level: "warn" });
                  return;
                }
                const path = store.filePath ?? "~/.agent-workbench/appearance.json";
                wb.selectUnit(target.id);
                wb.setDraft(
                  `帮我调整工作台外观。外观的唯一真相是 ${path}：先读这个文件，各字段（mode、profiles.light|dark 的 palette / transparency / overlayTransparency / surface、art、wallpaper、logo）的取值域见 prototype/src/core/appearance.ts。改完保存即可——应用每 4 秒核对一次文件，变了就自动换新外观，无需重启。我的要求：`,
                );
                useShellState.getState().closeSettings();
              }}
              className="flex items-center gap-1.5 rounded-btn bg-teal-tint px-3 py-1.5 text-body-sm font-medium text-teal transition hover:bg-teal/15"
            >
              <Bot size={13} />
              让 agent 改外观
            </button>
            <button
              type="button"
              onClick={() => {
                const theme = store.exportDreamSkinTheme();
                const blob = new Blob([JSON.stringify(theme, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "theme.json";
                anchor.click();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-ink hover:bg-surface-hover"
            >
              <Download size={13} />
              导出 theme.json
            </button>
            <button
              type="button"
              onClick={() => store.resetAll()}
              className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
            >
              <Trash2 size={13} />
              恢复全部默认
            </button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}