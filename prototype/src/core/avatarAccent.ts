/**
 * 头像主题色提取（2026-10-28，per-bot 对话强调色）。
 *
 * 要解决的问题：bot 头像的大面积色通常是底色（黑/白/灰），真正的「签名色」
 * 是面积不大但饱和鲜明的那个颜色。所以这里**不做**主色统计，而是：
 *   1. 先把无彩色像素（低饱和 / 极亮 / 极暗）整批剔除——黑底白底直接出局；
 *   2. 剩下的彩色像素按「色相 × 明暗」分桶，桶权重 = 像素数 × 饱和度，
 *      越鲜艳的色块越像签名色，同时仍需一定面积才压得过噪点；
 *   3. 相邻色相桶合并成簇（色相环首尾相接），按权重取前几个互不相似的簇，
 *      各自算加权平均色；
 *   4. 归一化成可用的强调色：饱和度夹到 [0.55, 0.92]、明度夹到 [0.46, 0.66]，
 *      保证深蓝发黑、亮黄发白这类头像色提出来后在亮/暗两套主题下都读得清。
 *      色相永远不改——签名色的身份就是色相。
 *
 * 输出按推荐度排序的 hex 候选（至多 4 个）；整个头像无彩色时返回空数组
 * （调用方回退到手动取色 / 跟随全局）。
 */

interface Hsl {
  readonly h: number; // 0..360
  readonly s: number; // 0..1
  readonly l: number; // 0..1
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToHex(h: number, s: number, l: number): string {
  const hex = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  if (s === 0) {
    const v = hex(l);
    return `#${v}${v}${v}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h / 360 + 1 / 3);
  const g = hueToRgb(p, q, h / 360);
  const b = hueToRgb(p, q, h / 360 - 1 / 3);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** 色相环上的最短角距（0..180），首尾相接 */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 候选数量上限：再多就成调色板了，失去「签名色」的意味 */
const MAX_CANDIDATES = 4;
/** 色相分桶数（15° 一桶） */
const HUE_BUCKETS = 24;
/** 两个候选至少差这么远才算「不同的颜色」 */
const CANDIDATE_HUE_GAP = 30;
/** 归一化目标域：饱和度与明度的可用区间（见文件头第 4 条） */
const SAT_RANGE = [0.55, 0.92] as const;
const LIGHT_RANGE = [0.46, 0.66] as const;
/** 无彩色剔除阈值：低于此饱和度 / 超出此明度区间的像素视为底色或噪点 */
const ACHROMATIC_SAT = 0.28;
const LIGHT_FLOOR = 0.14;
const LIGHT_CEIL = 0.93;
/** 半透明像素的参与门槛（圆角 / PNG 透明区不参与统计） */
const ALPHA_THRESHOLD = 128;

const clampRange = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface Bucket {
  readonly hueIdx: number;
  readonly bright: boolean; // 明暗半区（l >= 0.5）
  weight: number; // Σ 饱和度（每像素计 1 × s）
  rSum: number;
  gSum: number;
  bSum: number; // 原始 rgb 的加权和
}

/**
 * 提取核心：纯函数，吃 ImageData（头像已缩到 ≤96×96，无需再降采样）。
 * 上传路径里画布现成，直接同步调用；data URL 路径走 extractAvatarAccents。
 */
export function accentCandidatesFromImageData(data: ImageData): string[] {
  const { data: px } = data;
  const buckets = new Map<string, Bucket>();

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < ALPHA_THRESHOLD) continue; // 透明区（圆角/PNG）不参与
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const { h, s, l } = rgbToHsl(r, g, b);
    // 无彩色整批剔除：黑底/白底/灰阶都不是签名色
    if (s < ACHROMATIC_SAT || l < LIGHT_FLOOR || l > LIGHT_CEIL) continue;
    const hueIdx = Math.floor(h / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
    const bright = l >= 0.5;
    const key = `${hueIdx}:${bright ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        hueIdx,
        bright,
        weight: s,
        rSum: r * s,
        gSum: g * s,
        bSum: b * s,
      });
    } else {
      bucket.weight += s;
      bucket.rSum += r * s;
      bucket.gSum += g * s;
      bucket.bSum += b * s;
    }
  }

  if (buckets.size === 0) return [];

  // 相邻色相桶（同明暗半区）合并成簇：签名色常横跨两三个桶，不合并会被自己稀释
  const ordered = [...buckets.values()].sort((a, b) => b.weight - a.weight);
  const claimed = new Set<Bucket>();
  const clusters: {
    weight: number;
    rSum: number;
    gSum: number;
    bSum: number;
    sinSum: number;
    cosSum: number;
  }[] = [];
  for (const seed of ordered) {
    if (claimed.has(seed)) continue;
    claimed.add(seed);
    let { weight, rSum, gSum, bSum } = seed;
    // 簇色相用环上的加权圆均值（sin/cos 分量和）：色相环首尾相接，线性平均会让
    // 跨 0° 的红簇算出 ~180° 的假青色，去重时误杀自己
    let sinSum = 0;
    let cosSum = 0;
    const addBucket = (b: Bucket): void => {
      const rad = (((b.hueIdx + 0.5) * (360 / HUE_BUCKETS)) * Math.PI) / 180;
      sinSum += Math.sin(rad) * b.weight;
      cosSum += Math.cos(rad) * b.weight;
    };
    addBucket(seed);
    for (const other of ordered) {
      if (claimed.has(other) || other.bright !== seed.bright) continue;
      // 色相环距离 ≤ 1 桶即并入（含 0↔23 的首尾相接）
      const d = Math.abs(other.hueIdx - seed.hueIdx);
      if (d <= 1 || d === HUE_BUCKETS - 1) {
        claimed.add(other);
        weight += other.weight;
        rSum += other.rSum;
        gSum += other.gSum;
        bSum += other.bSum;
        addBucket(other);
      }
    }
    clusters.push({ weight, rSum, gSum, bSum, sinSum, cosSum });
  }
  clusters.sort((a, b) => b.weight - a.weight);

  // 逐簇归一化输出；与已入选候选色相过近（含明暗镜像）的跳过
  const picked: { hex: string; hueDeg: number }[] = [];
  for (const c of clusters) {
    if (picked.length >= MAX_CANDIDATES) break;
    const hueDeg = ((Math.atan2(c.sinSum, c.cosSum) * 180) / Math.PI + 360) % 360;
    if (picked.some((p) => hueDistance(p.hueDeg, hueDeg) < CANDIDATE_HUE_GAP)) continue;
    const avg = rgbToHsl(c.rSum / c.weight, c.gSum / c.weight, c.bSum / c.weight);
    picked.push({
      hueDeg,
      hex: hslToHex(
        avg.h,
        clampRange(avg.s, SAT_RANGE[0], SAT_RANGE[1]),
        clampRange(avg.l, LIGHT_RANGE[0], LIGHT_RANGE[1]),
      ),
    });
  }
  return picked.map((p) => p.hex);
}

/**
 * 便捷入口：加载 data URL 头像 → 画布取像素 → 候选色。
 * data URL 同源无污染，getImageData 不会被 canvas taint 拦。
 */
export function extractAvatarAccents(dataUrl: string, maxSide = 64): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.max(1, Math.min(maxSide, Math.min(img.naturalWidth, img.naturalHeight)));
      const canvas = document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve([]);
        return;
      }
      ctx.drawImage(img, 0, 0, side, side);
      resolve(accentCandidatesFromImageData(ctx.getImageData(0, 0, side, side)));
    };
    img.onerror = () => reject(new Error("头像加载失败，无法提取主题色"));
    img.src = dataUrl;
  });
}
