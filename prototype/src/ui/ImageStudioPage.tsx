import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  FolderOpen,
  ImagePlus,
  Loader2,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  FORMAT_OPTIONS,
  initImageStudio,
  qualityOptionsFor,
  sizeOptionsFor,
  useImageStudio,
  type ImageTask,
} from "../store/useImageStudio.ts";
import { useShell } from "../store/useShell.ts";
import { ensureSavePermission } from "../core/imageSave.ts";
import { cn } from "./cn.ts";

/**
 * 出图工作台 —— 主视图（侧栏顶部动作区第三入口，与新建任务/搜索/自动化同级）。
 *
 * 生成逻辑移植自 gpt_image_playground（OpenAI 兼容 images / responses 双模式）：
 * - 纯文本 prompt → /v1/images/generations；附参考图 → /v1/images/edits（FormData）；
 * - 流式开启时 partial image 实时显示在 pending 任务卡；
 * - 尺寸/质量/压缩/审核选项随模型族切换；
 * - 供应商 profile 的完整编辑面在设置页「出图」分区，这里只放只读摘要 + 跳转。
 */

export function ImageStudioPage() {
  const restoreSaveDir = useImageStudio((s) => s.restoreSaveDir);
  // 恢复保存文件夹的权限态（句柄在 IndexedDB；granted / prompt）
  useEffect(() => {
    void restoreSaveDir();
  }, [restoreSaveDir]);
  // profile 从 daemon 同步（含旧密钥一次性上缴迁移）——幂等，设置页挂载也会调
  useEffect(() => {
    void initImageStudio();
  }, []);
  return (
    /* 头在滚动容器之外（固定 48px + 下方 flex-1 滚动）：滚动条不再越过 HEAD */
    <div className="flex h-full min-h-0 flex-col">
      {/* 面包屑顶带 —— 统一在侧边栏返回工作台。titlebar-drag 挂整宽外层条；
          no-drag 占位绝对锚定行右缘（落在窗口按钮带正下方） */}
      <div className="titlebar-drag relative h-12 shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-8">
          <span className="text-body-sm font-medium text-ink">出图工作台</span>
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">OpenAI 兼容 images / responses</span>
        </div>
        <div
          aria-hidden
          className="titlebar-no-drag absolute right-0 top-0 h-full"
          style={{ width: "var(--wco-w, 0px)" }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-5">
          <Composer />
          <Gallery />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 输入区 */

function Composer() {
  const prompt = useImageStudio((s) => s.prompt);
  const setPrompt = useImageStudio((s) => s.setPrompt);
  const params = useImageStudio((s) => s.params);
  const setParams = useImageStudio((s) => s.setParams);
  const profile = useImageStudio((s) => s.activeProfile());
  const refImages = useImageStudio((s) => s.refImages);
  const addRefImages = useImageStudio((s) => s.addRefImages);
  const removeRefImage = useImageStudio((s) => s.removeRefImage);
  const generate = useImageStudio((s) => s.generate);
  const busy = useImageStudio((s) => s.busy);
  const openSettings = useShell((s) => s.openSettings);
  const saveDirName = useImageStudio((s) => s.saveDirName);
  const savePermission = useImageStudio((s) => s.savePermission);
  const setSavePermission = useImageStudio((s) => s.setSavePermission);
  const autoSave = useImageStudio((s) => s.autoSave);

  const fileRef = useRef<HTMLInputElement>(null);

  // 密钥在 daemon（hasKey 是脱敏布尔）——没配就是「缺密钥」
  const missing = profile.hasKey !== true;
  const isGptImage = profile.model.toLowerCase().includes("gpt-image");
  const canGenerate = !busy && prompt.trim().length > 0 && !missing;

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const dataUrls = await Promise.all(
      [...files].slice(0, 4).filter((f) => f.type.startsWith("image/")).map(fileToDataUrl),
    );
    addRefImages(dataUrls);
  };

  const sizes = sizeOptionsFor(profile.model);
  const qualities = qualityOptionsFor(profile.model);

  return (
    <section className="mb-6 rounded-card border border-line bg-card p-4">
      {/* 当前供应商摘要（只读）→ 完整编辑在设置页「出图」分区 */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-input border border-line-soft bg-rail px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-teal" aria-hidden />
        <span className="text-caption font-medium text-ink">{profile.name}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">
          {profile.apiMode === "responses" ? "responses" : "images"}
        </span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{profile.model}</span>
        {profile.codexCli && <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite">codex 中转</span>}
        {profile.streamImages && (
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">流式 ×{profile.streamPartialImages ?? 0}</span>
        )}
        {/* 保存位置：未设置走浏览器下载目录；prompt 权限 = 刷新后需重新授权 */}
        {saveDirName ? (
          savePermission === "prompt" ? (
            <button
              onClick={() => {
                void ensureSavePermission().then((ok) => setSavePermission(ok ? "granted" : "denied"));
              }}
              title={`自动保存目标：${saveDirName}${autoSave ? "（自动保存开）" : ""}`}
              className="flex shrink-0 items-center gap-1 rounded-chip bg-loss/10 px-2 py-0.5 text-[10px] text-loss hover:bg-loss/20"
            >
              <FolderOpen size={10} />
              重新授权 {saveDirName}
            </button>
          ) : (
            <span
              title={`保存文件夹：${saveDirName}${autoSave ? "（自动保存开）" : "（下载按钮写入此文件夹）"}`}
              className="flex shrink-0 items-center gap-1 rounded-chip bg-teal-tint px-2 py-0.5 font-mono text-[10px] text-teal"
            >
              <FolderOpen size={10} />
              {saveDirName}
              {autoSave && " · 自动保存"}
            </span>
          )
        ) : (
          <span className="shrink-0 rounded-chip bg-line-soft px-2 py-0.5 text-[10px] text-ash">保存位置未设置</span>
        )}
        <button
          onClick={() => openSettings("image")}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          <Settings2 size={11} />
          供应商设置
        </button>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canGenerate) void generate();
        }}
        placeholder="描述要生成的图片…（⌘Enter 生成）"
        rows={3}
        className="w-full resize-none rounded-input border border-line bg-rail px-3 py-2.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal-edge"
      />

      {refImages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {refImages.map((src, i) => (
            <div key={`${i}-${src.slice(-16)}`} className="group relative">
              <img src={src} alt={`参考图 ${i + 1}`} className="h-16 w-16 rounded-btn border border-line object-cover" />
              <button
                onClick={() => removeRefImage(i)}
                aria-label={`移除参考图 ${i + 1}`}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-canvas text-graphite shadow-subtle hover:text-loss"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 参数组：随模型族切换（gpt-image 全量；dall-e 尺寸/质量族不同；codex 中转忽略 size/quality） */}
        {!profile.codexCli && (
          <>
            <SelectChip label="尺寸" value={params.size} options={[...sizes]} onChange={(size) => setParams({ size })} />
            <SelectChip label="质量" value={params.quality} options={[...qualities]} onChange={(quality) => setParams({ quality })} />
          </>
        )}
        {isGptImage && !profile.codexCli && (
          <>
            <SelectChip
              label="格式"
              value={params.output_format}
              options={[...FORMAT_OPTIONS]}
              labels={{ png: "PNG", jpeg: "JPEG", webp: "WebP" }}
              onChange={(v) => setParams({ output_format: v as (typeof FORMAT_OPTIONS)[number] })}
            />
            {params.output_format !== "png" && (
              <SelectChip
                label="压缩"
                value={params.output_compression == null ? "默认" : String(params.output_compression)}
                options={["默认", "60", "80", "95"]}
                onChange={(v) => setParams({ output_compression: v === "默认" ? null : Number(v) })}
              />
            )}
            <SelectChip
              label="审核"
              value={params.moderation}
              options={["auto", "low"]}
              onChange={(v) => setParams({ moderation: v as "auto" | "low" })}
            />
            <button
              onClick={() => setParams({ transparent_output: !params.transparent_output })}
              aria-pressed={params.transparent_output}
              title="gpt-image 原生 background=transparent"
              className={cn(
                "shrink-0 rounded-btn border px-2.5 py-1.5 text-caption",
                params.transparent_output
                  ? "border-teal-edge bg-teal-tint text-ink"
                  : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              透明
            </button>
          </>
        )}
        <StepperChip value={params.n} min={1} max={4} onChange={(n) => setParams({ n })} />

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
        >
          <ImagePlus size={12} />
          参考图
        </button>

        <button
          onClick={() => void generate()}
          disabled={!canGenerate}
          title={missing ? "先在设置页「出图」里填 API Key" : undefined}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-4 py-1.5 text-caption font-medium text-canvas",
            canGenerate ? "hover:bg-graphite" : "cursor-not-allowed opacity-50",
          )}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {busy ? "生成中…" : "生成"}
        </button>
      </div>
      {missing && (
        <p className="mt-2 text-[10px] text-loss">当前供应商「{profile.name}」还没有填 API Key —— 到 设置 → 出图 里配置。</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- 结果画廊 */

function Gallery() {
  const history = useImageStudio((s) => s.history);
  const removeTask = useImageStudio((s) => s.removeTask);
  const clearHistory = useImageStudio((s) => s.clearHistory);

  if (history.length === 0) {
    return (
      <p className="py-14 text-center text-body-sm text-ash">
        还没有生成记录。在 设置 → 出图 配好供应商，写一段描述，生成第一张图。
      </p>
    );
  }
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="text-caption text-ash">
          生成记录 · {history.length} 条（本地留存，配额满时丢最旧任务的图）
        </p>
        <button
          onClick={clearHistory}
          className="ml-auto flex items-center gap-1 rounded-btn px-2 py-1 text-caption text-graphite hover:bg-line-soft hover:text-loss"
        >
          <Trash2 size={11} />
          清空
        </button>
      </div>
      <div className="space-y-3">
        {history.map((t) => (
          <TaskCard key={t.id} t={t} onRemove={() => removeTask(t.id)} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ t, onRemove }: { t: ImageTask; onRemove: () => void }) {
  const saveDirName = useImageStudio((s) => s.saveDirName);
  const time = useMemo(
    () => new Date(t.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    [t.ts],
  );
  return (
    <div className="rounded-card border border-line bg-card px-4 py-3">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 truncate text-body-sm text-ink">{t.prompt}</p>
        <span className="tnum shrink-0 text-[10px] text-ash">{time}</span>
        <button
          onClick={onRemove}
          aria-label="删除该条记录"
          className="shrink-0 rounded-btn p-1 text-ash hover:bg-line-soft hover:text-loss"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {t.profileName && (
          <span className="rounded-chip bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite">{t.profileName}</span>
        )}
        {t.model && <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.model}</span>}
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.params.size}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">{t.params.quality}</span>
        <span className="rounded-chip bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite">×{t.params.n}</span>
        {t.params.transparent_output && (
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">透明</span>
        )}
        {t.refImages && (
          <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">参考图 ×{t.refImages.length}</span>
        )}
      </div>

      {t.pending && (
        <div className="mt-3">
          {t.partialImage ? (
            <figure className="relative w-fit overflow-hidden rounded-input border border-line">
              <img src={t.partialImage} alt="流式过渡图" className="block max-h-64 bg-line-soft object-contain" />
              <figcaption className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-chip bg-canvas/90 px-2 py-0.5 text-[10px] text-graphite">
                <Loader2 size={10} className="animate-spin text-teal" />
                流式生成中…
              </figcaption>
            </figure>
          ) : (
            <p className="flex items-center gap-2 text-caption text-graphite">
              <Loader2 size={12} className="animate-spin text-teal" />
              生成中…（gpt-image 一张约 20–60s）
            </p>
          )}
        </div>
      )}
      {t.error && (
        <p className="mt-3 whitespace-pre-wrap break-all rounded-btn bg-loss/5 px-2.5 py-2 text-caption leading-relaxed text-loss">{t.error}</p>
      )}
      {t.images.length > 0 && (
        <>
          {t.revisedPrompt && (
            <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-ash" title={t.revisedPrompt}>
              revised: {t.revisedPrompt}
            </p>
          )}
          {(t.savedCount ?? 0) > 0 && (
            <p className="mt-2 text-[10px] text-teal">已保存 {t.savedCount} 张到「{saveDirName}」</p>
          )}
          {t.saveError && <p className="mt-2 text-[10px] text-loss">落盘失败：{t.saveError}</p>}
          <div className={cn("mt-2 grid gap-2", t.images.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {t.images.map((src, i) => (
              <figure key={`${t.id}-${i}`} className="group relative overflow-hidden rounded-input border border-line">
                <img src={src} alt={`${t.prompt} 结果 ${i + 1}`} className="block w-full bg-line-soft object-contain" />
                <SaveButton task={t} index={i} src={src} />
              </figure>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 小件 */

/** 下载按钮：已授权保存文件夹时直接落盘，否则回退浏览器默认下载目录 */
function SaveButton({ task, index, src }: { task: ImageTask; index: number; src: string }) {
  const saveDirName = useImageStudio((s) => s.saveDirName);
  const savePermission = useImageStudio((s) => s.savePermission);
  const saveOne = useImageStudio((s) => s.saveOne);
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");
  const canWrite = Boolean(saveDirName) && savePermission === "granted";

  if (!canWrite) {
    return (
      <a
        href={src}
        download={`img-${task.id}-${index + 1}.${task.params.output_format}`}
        className="absolute bottom-2 right-2 flex items-center gap-1 rounded-btn bg-canvas/90 px-2 py-1 text-[10px] text-ink opacity-0 shadow-subtle transition group-hover:opacity-100"
      >
        <Download size={10} />
        下载
      </a>
    );
  }
  return (
    <button
      onClick={() => {
        void saveOne(task.id, index).then((ok) => setState(ok ? "saved" : "failed"));
      }}
      className={cn(
        "absolute bottom-2 right-2 flex items-center gap-1 rounded-btn px-2 py-1 text-[10px] opacity-0 shadow-subtle transition group-hover:opacity-100",
        state === "idle" && "bg-canvas/90 text-ink",
        state === "saved" && "bg-gain/15 text-gain",
        state === "failed" && "bg-loss/10 text-loss",
      )}
    >
      <Download size={10} />
      {state === "saved" ? "已保存" : state === "failed" ? "保存失败" : "保存到文件夹"}
    </button>
  );
}

function SelectChip({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite hover:bg-line-soft hover:text-ink"
      >
        <span className="text-ash">{label}</span>
        {labels?.[value] ?? value}
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-20 mt-1 min-w-[120px] overflow-hidden rounded-btn border border-line bg-canvas py-0.5 shadow-subtle">
            {options.map((o) => (
              <button
                key={o}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full whitespace-nowrap px-3 py-1.5 text-left font-mono text-caption",
                  o === value ? "bg-teal-tint font-medium text-ink" : "text-graphite hover:bg-line-soft",
                )}
              >
                {labels?.[o] ?? o}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StepperChip({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center rounded-btn border border-line">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="减少张数"
        className="px-2 py-1.5 text-caption text-graphite hover:text-ink"
      >
        −
      </button>
      <span className="tnum min-w-8 text-center text-caption text-ink">{value} 张</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="增加张数"
        className="px-2 py-1.5 text-caption text-graphite hover:text-ink"
      >
        +
      </button>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
