import { useMemo, useState, type ReactElement } from "react";
import { ChevronDown, Inbox as InboxIcon, Loader2 } from "lucide-react";
import type { InboxHints } from "../core/inbox.ts";
import { useInbox } from "../store/useInbox.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { inputCls } from "./WorklistBits.tsx";
import { cn } from "./cn.ts";

/**
 * 清单输入框 —— 个人 context 的唯一捕获入口，合页后仍在页面顶部。
 * Enter 收进清单（Shift+Enter 换行）；「可选项」预置 routing 必须尊重的字段。
 */

export function InboxComposer(): ReactElement {
  const add = useInbox((s) => s.add);
  const classifier = useInbox((s) => s.classifier);
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);

  const [text, setText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [hints, setHints] = useState<InboxHints>({});
  const [submitting, setSubmitting] = useState(false);

  const runtimeIds = useMemo(() => runtimes.map((r) => r.id.replace(/^daemon:/, "")), [runtimes]);
  const hintsFilled = Object.values(hints).some((v) => v !== undefined && v !== null && v !== "");

  const submit = (): void => {
    const t = text.trim();
    if (t === "" || submitting) return;
    // daemon 往返期间再按 Enter / 点按钮会重复提交同一段文字 —— 占位挡住
    setSubmitting(true);
    void add({ text: t, hints: hintsFilled ? hints : undefined })
      .then((ok) => {
        if (ok) {
          setText("");
          setHints({});
        }
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="rounded-card border border-line bg-card px-4 py-3 focus-within:border-teal">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter 直接收进清单（Shift+Enter 换行）；IME 组合中（拼音候选）不拦截
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="写下任何东西：想法、近期目标、要做的杂事、留存的资料……"
        className="w-full resize-none bg-transparent text-body-sm leading-relaxed text-ink outline-none placeholder:text-ash"
      />
      <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
        <button
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-1 rounded-btn px-1.5 py-1 text-caption text-ash hover:bg-line-soft hover:text-ink"
          aria-expanded={advanced}
        >
          可选项（指定 bot / 文件夹 / 执行器 / 模型 / 会话）
          <ChevronDown size={12} className={cn("transition-transform", advanced && "rotate-180")} />
        </button>
        {hintsFilled && <span className="rounded-chip bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal">已预置 {Object.keys(hints).length} 项</span>}
        <span className="ml-auto text-caption text-ash">Enter 收进清单 · Shift+Enter 换行</span>
        <button
          onClick={submit}
          disabled={text.trim() === "" || submitting}
          className="flex shrink-0 items-center gap-1.5 rounded-btn bg-ink px-3 py-1.5 text-body-sm text-canvas hover:opacity-90 active:scale-95 transition disabled:opacity-40"
        >
          {classifier?.classifying === true ? <Loader2 size={12} className="animate-spin" /> : <InboxIcon size={12} />}
          收进清单
        </button>
      </div>
      {advanced && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-btn bg-rail px-3 py-3">
          <HintField label="指定 bot（归属工作单元）">
            <select
              value={hints.unitId ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, unitId: e.target.value === "" ? undefined : e.target.value }))}
              className={inputCls}
            >
              <option value="">（由 routing 建议）</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </HintField>
          <HintField label="指定文件夹（覆盖工作目录）">
            <input
              value={hints.rootPath ?? ""}
              placeholder="（由 routing 决定）"
              onChange={(e) => setHints((h) => ({ ...h, rootPath: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={cn(inputCls, "font-mono")}
            />
          </HintField>
          <HintField label="指定执行器">
            <select
              value={hints.runtimeId ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, runtimeId: e.target.value === "" ? undefined : e.target.value }))}
              className={inputCls}
            >
              <option value="">（由 routing 建议）</option>
              {runtimeIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </HintField>
          <HintField label="指定模型">
            <input
              value={hints.model ?? ""}
              placeholder="（缺省跟随执行器）"
              onChange={(e) => setHints((h) => ({ ...h, model: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={inputCls}
            />
          </HintField>
          <HintField label="执行方式">
            <select
              value={hints.launchMode ?? ""}
              onChange={(e) => setHints((h) => ({ ...h, launchMode: e.target.value === "" ? undefined : (e.target.value as "terminal" | "chat" | "headless") }))}
              className={inputCls}
            >
              <option value="">headless（自动执行缺省）</option>
              <option value="chat">对话页前台</option>
              <option value="terminal">执行器 TUI</option>
              <option value="headless">纯后台</option>
            </select>
          </HintField>
          <HintField label="在某个已有会话里执行">
            <input
              value={hints.targetSessionId ?? ""}
              placeholder="（留空 = 新开会话）"
              onChange={(e) => setHints((h) => ({ ...h, targetSessionId: e.target.value.trim() === "" ? undefined : e.target.value.trim() }))}
              className={cn(inputCls, "font-mono")}
            />
          </HintField>
          <p className="col-span-2 text-[10px] leading-relaxed text-ash">
            预置了就照你的来，routing 不改写；空着的由 routing 分类时建议。这些字段沉淀成任务后都能在右栏待办里再改。
          </p>
        </div>
      )}
    </div>
  );
}

function HintField({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="space-y-1">
      <span className="block text-caption text-graphite">{label}</span>
      {children}
    </div>
  );
}
