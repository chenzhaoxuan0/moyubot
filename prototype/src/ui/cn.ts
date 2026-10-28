import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * twMerge 必须认识我们的自定义字号 token（styles.css @theme 的
 * text-caption / text-body-sm / text-body / text-body-lg / text-thread）。
 *
 * 默认配置不认识它们，会把 `text-caption` 归进「text-color」冲突组——
 * 于是 `cn("text-caption", "text-ink")` 会把字号类静默丢掉，组件回落到
 * 继承的 14px。这正是「同类组件字号不一致」的根因：丢与不丢取决于
 * className 里有没有后置的颜色类，纯看运气。
 *
 * 注册为 font-size 组后：字号只与字号冲突（保留最后一个），
 * 与 text-ink 等颜色类各归各组、互不吞并。
 *
 * ⚠ text-thread（对话正文档，带行高伴生 token）当年漏登记——
 * `cn("text-thread text-ink")` 把字号+行高整体吞掉，agent 回复正文行距
 * 自上线起一直回落 body 的 1.43 而非档位值（2026-10-28 探针实测发现）。
 * 给 @theme 加新 text-* 档位时必须同步登记到这里。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-caption",
        "text-body-sm",
        "text-body",
        "text-body-lg",
        "text-thread",
      ],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
