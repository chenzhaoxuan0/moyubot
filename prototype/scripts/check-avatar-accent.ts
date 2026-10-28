/**
 * 头像签名色提取 + 单 bot 对话列强调色派生的回归检查（2026-10-28）。
 * 零依赖约定：node --experimental-strip-types 直跑（同 check-models / check-sidepane）。
 *
 * 覆盖两类契约：
 *   1. accentCandidatesFromImageData —— 负路径（无彩色/全透明）、归一化锚点、
 *      色相环接缝（跨 0° 红簇的加权圆均值回归位）、明暗镜像去重、候选上限、
 *      「鲜艳签名色压过大面积低饱和色」的权重语义；
 *   2. deriveChatAccentVariables —— 变量表完整性、亮暗两套的可读性护栏
 *      （亮主题压亮、暗主题抬暗，色相不动）、hover 加深方向、调用方守卫契约
 *      （isValidColor 拦非法值 → 组件侧回退跟随全局）。
 */
import { accentCandidatesFromImageData } from "../src/core/avatarAccent.ts";
import {
  deriveChatAccentVariables,
  isValidColor,
  parseColor,
  relativeLuminance,
} from "../src/core/appearance.ts";

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}`);
  }
};

// Node 无 ImageData：函数只读 .data，鸭子类型即可（scripts/ 不在 tsc -b 范围）
const img = (
  ...px: Array<[number, number, number] | [number, number, number, number]>
): ImageData =>
  ({
    data: new Uint8ClampedArray(px.flatMap((p) => [p[0], p[1], p[2], p[3] ?? 255])),
  }) as unknown as ImageData;

/** hex → 色相（0..360）；灰阶返回 0 */
const hueOf = (hex: string): number => {
  const c = parseColor(hex);
  if (c === null) return -1;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  if (max === r) return ((g - b) / d + (g < b ? 6 : 0)) * 60;
  if (max === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
};

console.log("accentCandidatesFromImageData:");
// 负路径：无彩色 / 全透明 → 空候选（调用方回退手动取色 / 跟随全局）
check("无彩色头像 → []", accentCandidatesFromImageData(img([0, 0, 0], [255, 255, 255], [128, 128, 128])).length === 0);
check("全透明头像 → []", accentCandidatesFromImageData(img([255, 0, 0, 0])).length === 0);
// 归一化锚点：纯红 s 夹到 0.92、l 落 0.5、色相 0 不动
check("纯红锚点 #f50a0a", accentCandidatesFromImageData(img([255, 0, 0]))[0] === "#f50a0a");
// 深藏青：明度被抬进 [0.46,0.66]，色相保持 240
const navy = accentCandidatesFromImageData(img([0, 0, 139]))[0] ?? "";
check("深藏青提亮且色相保持", navy !== "" && Math.abs(hueOf(navy) - 240) < 5);
// 透明门槛：alpha 128 计入 / 127 剔除；s<0.28 剔除
check("alpha=128 计入", accentCandidatesFromImageData(img([255, 0, 0, 128])).length === 1);
check("alpha=127 剔除", accentCandidatesFromImageData(img([255, 0, 0, 127])).length === 0);
check("s<0.28 剔除", accentCandidatesFromImageData(img([91, 91, 96])).length === 0);
// 色相环接缝：跨 0° 的红簇（0° + 356°）合并为一个候选
check("跨 0° 红簇合并为 1", accentCandidatesFromImageData(img([255, 0, 0], [255, 0, 15])).length === 1);
// 回归位：环均值修复前，跨 0° 红簇的线性平均色相 ≈180° 被当成青色，红候选被误杀
check(
  "跨 0° 红簇不被青色误杀（回归位）",
  accentCandidatesFromImageData(img([0, 255, 255], [0, 255, 255], [0, 255, 255], [255, 0, 0], [255, 0, 15])).length === 2,
);
// 明暗镜像：同色相一明一暗 → 去重为 1
check("明暗镜像去重为 1", accentCandidatesFromImageData(img([255, 0, 0], [120, 0, 0])).length === 1);
// 候选上限 4
check(
  "六色头像上限 4 个候选",
  accentCandidatesFromImageData(img([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255])).length === 4,
);
// 权重语义：300 个全饱和橙 vs 1000 个低饱和蓝 → 橙排第一（签名色 > 面积）
const signatureFirst = accentCandidatesFromImageData(
  img(
    ...Array.from({ length: 300 }, () => [255, 128, 0] as [number, number, number]),
    ...Array.from({ length: 1000 }, () => [91, 91, 164] as [number, number, number]),
  ),
)[0];
check("鲜艳签名色压过大面积低饱和色", signatureFirst !== undefined && Math.abs(hueOf(signatureFirst) - 30) < 10);

console.log("deriveChatAccentVariables:");
const lightVars = deriveChatAccentVariables("#f67729", false);
const darkVars = deriveChatAccentVariables("#f67729", true);
const expectedKeys = [
  "--color-teal",
  "--color-teal-hover",
  "--color-teal-tint",
  "--color-teal-edge",
  "--color-on-accent",
  "--color-selection",
  "--ds-theme-color-accent",
  "--ds-theme-color-accent-alt",
];
check(
  "变量表完整（8 键）",
  expectedKeys.every((k) => lightVars[k] !== undefined) && Object.keys(lightVars).length === expectedKeys.length,
);
// #f67729 亮度 0.33：暗主题过护栏不动，亮主题压进 ≤0.28
check("暗主题保持原值", darkVars["--color-teal"] === "#f67729");
check("亮主题压进可读亮度", relativeLuminance(lightVars["--color-teal"]!) <= 0.28);
// hover 与全局预设同向：比本体更深
check("亮主题 hover 加深", relativeLuminance(lightVars["--color-teal-hover"]!) < relativeLuminance(lightVars["--color-teal"]!));
check("暗主题 hover 加深", relativeLuminance(darkVars["--color-teal-hover"]!) < relativeLuminance(darkVars["--color-teal"]!));
// 可读性护栏：亮黄在亮主题被压暗、色相不动；深藏青在暗主题被抬亮
const yellowLight = deriveChatAccentVariables("#f8f85a", false)["--color-teal"]!;
check("亮黄→亮主题压暗且色相保持", relativeLuminance(yellowLight) <= 0.28 && Math.abs(hueOf(yellowLight) - 60) < 8);
const navyDark = deriveChatAccentVariables("#00008b", true)["--color-teal"]!;
check("深藏青→暗主题抬亮且色相保持", relativeLuminance(navyDark) >= 0.18 && Math.abs(hueOf(navyDark) - 240) < 8);
// on-accent 永远是黑或白（WCAG 判读）
check("on-accent 为黑/白", ["#000000", "#ffffff"].includes(darkVars["--color-on-accent"]!));
// 调用方守卫契约：非法值被 isValidColor 拦下 → 组件侧不注入（跟随全局）；
// bot.json 手改成非字符串（数字/对象）也不能把渲染面炸到 ErrorBoundary
check("isValidColor 拦非法值", !isValidColor("not-a-color") && isValidColor("#f67729"));
check(
  "isValidColor 拦非字符串（手改 bot.json 场景）",
  !isValidColor(123 as unknown as string) && !isValidColor({} as unknown as string),
);

if (failures > 0) {
  console.error(`check-avatar-accent: ${failures} FAILED`);
  process.exit(1);
}
console.log("check-avatar-accent: all checks passed");
