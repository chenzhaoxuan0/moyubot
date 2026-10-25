import type { ImgHTMLAttributes } from "react";
import { useAppearance } from "../store/useAppearance.ts";

/**
 * 品牌图标 —— 三个来源，优先级从高到低：
 *  1. 用户自定义 logo（外观设置里选的图，appearance.json 的 logo.mode === "custom"）；
 *  2. 内置品牌标的亮主题白底版（moyu-logo-light.png）；
 *  3. 内置品牌标的暗主题黑底版（moyu-logo-dark.png）。
 * PNG 都从设计导出的原图逐级减半缩放而来 —— 不用 SVG：浏览器栅格化 SVG 在小尺寸
 * 下图形外会出灰边（实测）。跟着 resolvedAppearance 走，与 <html data-theme> 同一
 * 真相源；浏览器直开（无 Electron）同样生效。
 */
export function BrandLogo({ alt = "MoyuBot", ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const resolved = useAppearance((s) => s.resolvedAppearance);
  const logo = useAppearance((s) => s.logo);
  const custom = logo.mode === "custom" && logo.source ? logo.source : null;
  return (
    <img
      src={custom ?? (resolved === "dark" ? "/moyu-logo-dark.png" : "/moyu-logo-light.png")}
      alt={alt}
      draggable={false}
      {...rest}
    />
  );
}
