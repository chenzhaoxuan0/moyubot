import type { ImgHTMLAttributes } from "react";
import { useAppearance } from "../store/useAppearance.ts";

/**
 * 品牌图标 —— 三个来源，优先级从高到低：
 *  1. 用户自定义 logo（外观设置里选的图，appearance.json 的 logo.mode === "custom"）；
 *  2. 内置品牌标的亮主题白底版；
 *  3. 内置品牌标的暗主题黑底版。
 * PNG 按使用场景出尺寸（64/128 两档，srcSet 让浏览器按倍率挑）：小位 20px 用 64，
 * 设置页预览 44px 高倍率用 128 —— 都是设计原图逐级减半缩放而来，不走 SVG 栅格化
 * （SVG 小尺寸下图形外会出灰边）。跟着 resolvedAppearance 走，与 <html data-theme>
 * 同一真相源；浏览器直开（无 Electron）同样生效。
 */
export function BrandLogo({ alt = "MoyuBot", ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const resolved = useAppearance((s) => s.resolvedAppearance);
  const logo = useAppearance((s) => s.logo);
  const custom = logo.mode === "custom" && logo.source ? logo.source : null;
  const base = resolved === "dark" ? "/moyu-logo-dark" : "/moyu-logo-light";
  return (
    <img
      src={custom ?? `${base}-64.png`}
      srcSet={custom ? undefined : `${base}-64.png 1x, ${base}-128.png 2x`}
      alt={alt}
      draggable={false}
      {...rest}
    />
  );
}
