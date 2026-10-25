import type { ImgHTMLAttributes } from "react";
import { useAppearance } from "../store/useAppearance.ts";

/**
 * 品牌图标 —— 三个来源，优先级从高到低：
 *  1. 用户自定义 logo（外观设置里选的图，appearance.json 的 logo.mode === "custom"）；
 *  2. 内置品牌标的亮主题白底版（moyu-logo-light.svg）；
 *  3. 内置品牌标的暗主题黑底版（moyu-logo-dark.svg）。
 * 两版内置 SVG 是整幅底色不同的满版构图，钉死任何一版都会在另一主题里变成色块，
 * 所以跟着 resolvedAppearance 走 —— 与 <html data-theme> 同一真相源。浏览器直开
 * （无 Electron）同样生效。
 */
export function BrandLogo({ alt = "MoyuBot", ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const resolved = useAppearance((s) => s.resolvedAppearance);
  const logo = useAppearance((s) => s.logo);
  const custom = logo.mode === "custom" && logo.source ? logo.source : null;
  return (
    <img
      src={custom ?? (resolved === "dark" ? "/moyu-logo-dark.svg" : "/moyu-logo-light.svg")}
      alt={alt}
      draggable={false}
      {...rest}
    />
  );
}
