import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { cn } from "./cn.ts";

/**
 * logo 裁剪弹窗 —— 用户选图后先在这里定位方框再入库。
 *
 * 为什么必须有它：非方形图（半身照、横幅 logo）自动居中裁方经常把主体裁掉半张脸；
 * GitHub/Discord 头像裁剪的同款交互：方框固定、拖动平移图片、滑杆缩放，所见即所得。
 * 确认时按当前取景在原图上裁出正方形 PNG（输出 512，够所有显示位用），再走
 * importLogo 的既有落盘链路 —— 后续 squarePngDataUrl 对已是正方形的图是恒等变换。
 */

/** 裁剪框边长（显示像素）；预览按 64/S 比例线性缩放同一取景 */
const FRAME = 280;
/** 输出正方形边长：显示位最大 256（Electron 窗口图标），512 留一倍余量 */
const OUTPUT = 512;
/** SVG 无内在尺寸时的回退用户坐标系（与品牌标同规格） */
const FALLBACK_NATURAL = 1024;

interface Loaded {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export function LogoCropDialog({
  file,
  onCancel,
  onConfirm,
}: {
  file: File;
  onCancel: () => void;
  onConfirm: (cropped: File) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  /* 回调走 ref：父组件传的是内联箭头，每次重渲染都是新引用。若直接进 effect 依赖，
     一次无关重渲染就会 revoke 掉 loaded.url 还在用的 object URL 再重建重解码 ——
     窗口期内 <img> 闪断，此刻确认裁剪会对已 revoke 的 URL 解码而失败 */
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  /* 解码选中的图（file 在弹窗生命周期内不变，effect 只跑一次）；object URL 卸载即 revoke */
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setLoaded({
        url,
        width: img.naturalWidth || FALLBACK_NATURAL,
        height: img.naturalHeight || FALLBACK_NATURAL,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      onCancelRef.current();
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /* Esc 取消（弹窗惯例） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* 取景几何：cover 基准（zoom=1 恰好铺满方框）+ zoom 放大；offset 被钳在
     「图永远盖住方框」的范围内，四个方向都不会露出空底 */
  const coverScale = loaded ? FRAME / Math.min(loaded.width, loaded.height) : 1;
  const totalScale = coverScale * zoom;
  const dispW = loaded ? loaded.width * totalScale : FRAME;
  const dispH = loaded ? loaded.height * totalScale : FRAME;
  const clampOffset = useCallback(
    (x: number, y: number) => ({
      x: Math.max(-(dispW - FRAME) / 2, Math.min((dispW - FRAME) / 2, x)),
      y: Math.max(-(dispH - FRAME) / 2, Math.min((dispH - FRAME) / 2, y)),
    }),
    [dispW, dispH],
  );
  const clamped = clampOffset(offset.x, offset.y);

  /* 拖动平移：pointer capture 保证移出方框仍跟随；触屏同一条路径 */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loaded) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: clamped.x, baseY: clamped.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset(clampOffset(drag.baseX + (e.clientX - drag.startX), drag.baseY + (e.clientY - drag.startY)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const changeZoom = (next: number) => {
    setZoom(next);
    setOffset((o) => clampOffset(o.x, o.y));
  };
  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  /* 帧坐标 → 原图像素：u = (x − S/2 − ox)/st + nw/2，取景框左上角即得源矩形 */
  const confirmCrop = useCallback(async () => {
    if (!loaded || busy) return;
    setBusy(true);
    try {
      const st = totalScale;
      const side = Math.min(FRAME / st, loaded.width, loaded.height);
      const sx = Math.max(0, Math.min(loaded.width - side, loaded.width / 2 - (FRAME / 2 + clamped.x) / st));
      const sy = Math.max(0, Math.min(loaded.height - side, loaded.height / 2 - (FRAME / 2 + clamped.y) / st));

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("logo decode failed"));
        el.src = loaded.url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d unavailable");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUTPUT, OUTPUT);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("crop encode failed");
      const stem = file.name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 32) || "logo";
      onConfirm(new File([blob], `${stem}-crop.png`, { type: "image/png" }));
    } finally {
      setBusy(false);
    }
  }, [loaded, busy, totalScale, clamped, file.name, onConfirm]);

  /* 与 64px 预览共用的取景参数按比例 k 缩放 */
  const k = 64 / FRAME;
  const frameStyle = "relative overflow-hidden rounded-card border border-line bg-canvas select-none touch-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-xs"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="裁剪应用 logo"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[420px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        {/* 头部 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <p className="text-body-sm font-medium text-ink">裁剪 logo</p>
          <span className="truncate text-caption text-graphite">
            {loaded ? `${file.name} · ${loaded.width}×${loaded.height}` : file.name}
          </span>
          <div className="flex-1" />
          <button onClick={onCancel} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            <X size={13} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* 取景框：拖动图片定位 */}
          <div className="flex justify-center">
            <div
              className={cn(frameStyle, "h-[280px] w-[280px] cursor-grab active:cursor-grabbing")}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={reset}
              title="拖动调整位置，双击复位"
            >
              {loaded && (
                <img
                  src={loaded.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
                  style={{
                    width: dispW,
                    height: dispH,
                    transform: `translate(calc(-50% + ${clamped.x}px), calc(-50% + ${clamped.y}px))`,
                  }}
                />
              )}
              {!loaded && (
                <div className="flex h-full w-full items-center justify-center text-caption text-graphite">加载中…</div>
              )}
              {/* 九宫格参考线 */}
              <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }, (_, i) => (
                  <div key={i} className="border border-white/15" />
                ))}
              </div>
            </div>
          </div>

          {/* 缩放 + 预览 */}
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-ink">缩放</span>
                <span className="rounded-chip bg-surface-hover px-2 py-0.5 font-mono text-caption text-graphite">
                  {zoom.toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                disabled={!loaded}
                onChange={(e) => changeZoom(Number(e.target.value))}
                aria-label="缩放"
                className="mt-2 w-full accent-teal"
              />
            </div>
            <div className="shrink-0 text-center">
              <div className={cn(frameStyle, "h-16 w-16")}>
                {loaded && (
                  <img
                    src={loaded.url}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
                    style={{
                      width: dispW * k,
                      height: dispH * k,
                      transform: `translate(calc(-50% + ${clamped.x * k}px), calc(-50% + ${clamped.y * k}px))`,
                    }}
                  />
                )}
              </div>
              <p className="mt-1 text-caption text-graphite">预览</p>
            </div>
          </div>

          <p className="text-caption text-graphite">
            裁剪结果为正方形，应用在所有 logo 显示位（侧栏、标签页、窗口与托盘）。
          </p>
        </div>

        {/* 底部动作 */}
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={reset}
            disabled={!loaded}
            className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          >
            <RotateCcw size={13} />
            复位
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-btn border border-line px-3 py-1.5 text-body-sm text-graphite hover:bg-surface-hover hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void confirmCrop().catch(() => undefined)}
            disabled={!loaded || busy}
            className="flex items-center gap-1.5 rounded-btn bg-teal px-3 py-1.5 text-body-sm text-canvas disabled:opacity-40"
          >
            <Check size={13} />
            {busy ? "处理中…" : "使用这个"}
          </button>
        </div>
      </div>
    </div>
  );
}
