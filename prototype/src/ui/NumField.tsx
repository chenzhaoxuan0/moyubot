import { useEffect, useState, type ReactElement } from "react";
import { cn } from "./cn.ts";

/**
 * 带标签的数字输入框 —— 「label + 数字 + 钳制范围 + 失焦保存」的共享形状。
 * 设置页心跳分区与待办页弹层共用一份：钳制语义只此一处，改范围不会两处漂移。
 *
 * 行为：草稿是字符串（清空、输入中的中间态不跳变）；失焦或回车提交 —— 非
 * 整数回退原值，越界钳到 [min, max]（daemon 侧同款钳制，这里拦的是明显手滑），
 * 与当前值相同只复位草稿不触发保存。
 */

const defaultInputCls =
  "w-full rounded-input border border-line bg-canvas px-2.5 py-1.5 text-body-sm text-ink outline-none focus:border-teal";

export function NumField({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  inputClassName,
  onSave,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  /** 输入框样式覆盖（默认是设置页的描边变体，待办页弹层传自己的） */
  inputClassName?: string;
  onSave: (n: number) => void;
}): ReactElement {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (!Number.isFinite(n) || Math.round(n) !== n) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped === value) {
      setDraft(String(value));
      return;
    }
    onSave(clamped);
  };
  return (
    <label className="block space-y-1">
      {/* text-body-sm text-ink：与设置页 SettingsRow 的行标签同级（视觉同层同字号） */}
      <span className="block text-body-sm text-ink" title={hint}>
        {label}
      </span>
      <input
        value={draft}
        disabled={disabled}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={cn(defaultInputCls, inputClassName)}
      />
    </label>
  );
}
