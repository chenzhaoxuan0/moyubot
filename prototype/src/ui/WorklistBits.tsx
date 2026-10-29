import type { ReactElement } from "react";
import { CircleAlert, type LucideIcon } from "lucide-react";
import { cn } from "./cn.ts";

/**
 * 清单页（单页两栏：左清单右待办）的公共小件 —— 原 InboxPage / BacklogPage
 * 各持一份的 HeaderBtn / MenuRow / notice 横幅 / 输入框底色收拢于此。
 */

export function HeaderBtn({ icon: Icon, label, onClick, active }: { icon: LucideIcon; label: string; onClick: () => void; active?: boolean }): ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-btn transition",
        active ? "bg-teal-tint text-teal" : "text-graphite hover:bg-line-soft hover:text-ink",
      )}
    >
      <Icon size={13} />
    </button>
  );
}

export function MenuRow({ icon, label, onClick, danger }: { icon?: React.ReactNode; label: string; onClick: () => void; danger?: boolean }): ReactElement {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-btn px-2 py-1.5 text-left text-caption transition hover:bg-line-soft",
        danger === true ? "text-loss hover:text-loss" : "text-graphite hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** 页面级通知横幅（操作成败的一行实话），5 秒自动消失由调用方处理 */
export function NoticeBanner({
  kind,
  text,
  onClose,
  className,
}: {
  kind: "error" | "info" | "success";
  text: string;
  onClose: () => void;
  className?: string;
}): ReactElement {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-btn px-3 py-2 text-body-sm",
        kind === "error" ? "bg-loss/10 text-loss" : kind === "success" ? "bg-gain/10 text-gain" : "bg-teal-tint text-teal",
        className,
      )}
    >
      <CircleAlert size={13} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
      <button onClick={onClose} className="ml-auto shrink-0 opacity-60 hover:opacity-100" aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}

/** bg-card 弹窗上的输入框底色（衬出输入位） */
export const inputCls =
  "w-full rounded-input border border-transparent bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";

/** bg-rail 分组块内的输入框底色 */
export const railInputCls =
  "w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal";
