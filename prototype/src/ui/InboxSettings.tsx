import { useState, type ReactElement } from "react";
import { Settings2, Trash2 } from "lucide-react";
import type { InboxCategoryDef } from "../core/inbox.ts";
import { useInbox } from "../store/useInbox.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { inputCls } from "./WorklistBits.tsx";

/**
 * 清单设置弹窗（原 InboxPage 内嵌弹窗独立成文件）。
 * 自动分类总开关在左栏清单栏头（与「立即分类」同排），这里只留分类会话
 * 执行器/模型与自定义分类。
 */

export function InboxSettings({ onClose }: { onClose: () => void }): ReactElement {
  const config = useInbox((s) => s.config);
  const saveConfig = useInbox((s) => s.saveConfig);
  const runtimes = useWorkbench((s) => s.runtimes);

  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newActionable, setNewActionable] = useState(false);

  if (config === null) {
    return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />;
  }

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    await saveConfig(patch);
    setBusy(false);
  };

  // Enter 与「添加」按钮共用的提交口：busy 守卫收在这里，两条路径都不会并发写
  const submitNewCategory = (): void => {
    const label = newLabel.trim();
    if (label === "" || busy) return;
    void save({ categories: [...config.categories, { id: label, label, actionable: newActionable }] });
    setNewLabel("");
  };

  const hbRuntimes = ["", ...runtimes.map((r) => r.id.replace(/^daemon:/, ""))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="清单设置"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-card border border-line bg-card shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Settings2 size={14} className="text-graphite" />
          <p className="flex-1 text-body-sm font-medium text-ink">清单设置</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-ink">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-body-sm">
          {/* routing 分类 */}
          <section className="space-y-2.5">
            <h3 className="text-body-sm font-medium text-ink">routing 分类</h3>
            <p className="text-[10px] leading-relaxed text-ash">
              「自动分类」总开关在左栏清单头部 —— 关闭时新内容停在「待分类」，可手动「立即分类」触发。
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">分类会话的执行器</span>
                <select
                  value={config.classifier.runtimeId}
                  disabled={busy}
                  onChange={(e) => void save({ classifier: { ...config.classifier, runtimeId: e.target.value } })}
                  className={inputCls}
                >
                  {hbRuntimes.map((id) => (
                    <option key={id} value={id}>
                      {id === "" ? "（跟随 routing bot 的主绑定）" : id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <span className="block text-body-sm text-ink">模型（缺省跟随执行器）</span>
                <input
                  value={config.classifier.model ?? ""}
                  placeholder="（缺省跟随执行器）"
                  disabled={busy}
                  onChange={(e) => void save({ classifier: { ...config.classifier, model: e.target.value.trim() === "" ? null : e.target.value.trim() } })}
                  className={inputCls}
                />
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-ash">
              routing 是常驻 bot（侧栏「Routing」），它的主绑定在 bot 设置页改 —— 这里显式指定时优先。
            </p>
          </section>

          {/* 自定义分类 */}
          <section className="space-y-2">
            <h3 className="text-body-sm font-medium text-ink">自定义分类</h3>
            <p className="text-[10px] leading-relaxed text-ash">
              内置五个通用分类（目标 / 待办 / 想法 / 资料 / 以后再说）；这里追加你自己的。勾「沉淀任务」的分类会像目标/待办一样生成任务。
            </p>
            <div className="space-y-1.5">
              {config.categories.length === 0 && <p className="text-caption text-ash">还没有自定义分类</p>}
              {config.categories.map((c: InboxCategoryDef) => (
                <div key={c.id} className="flex items-center gap-2 rounded-btn bg-rail px-2.5 py-2">
                  <span className="flex-1 text-caption text-ink">{c.label}</span>
                  <label className="flex cursor-pointer items-center gap-1 text-caption text-graphite">
                    <input
                      type="checkbox"
                      checked={c.actionable}
                      disabled={busy}
                      onChange={(e) =>
                        void save({ categories: config.categories.map((x) => (x.id === c.id ? { ...x, actionable: e.target.checked } : x)) })
                      }
                      className="accent-teal"
                    />
                    沉淀任务
                  </label>
                  <button
                    onClick={() => void save({ categories: config.categories.filter((x) => x.id !== c.id) })}
                    className="rounded-btn p-1 text-ash hover:bg-line-soft hover:text-loss"
                    aria-label={`删除分类 ${c.label}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newLabel}
                placeholder="新分类名（如「读书清单」）"
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submitNewCategory();
                }}
                className={inputCls}
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-caption text-graphite">
                <input type="checkbox" checked={newActionable} onChange={(e) => setNewActionable(e.target.checked)} className="accent-teal" />
                沉淀任务
              </label>
              <button onClick={submitNewCategory} disabled={newLabel.trim() === "" || busy} className="shrink-0 rounded-btn bg-ink px-2.5 py-1.5 text-caption text-canvas hover:opacity-90 disabled:opacity-40">
                添加
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
