import { MessageSquarePlus, Plus, Zap } from "lucide-react";
import { useChatPanes } from "../store/useChatPanes.ts";
import { useTerminalStore, SUPPORTED_TERMINAL_PROFILES } from "../store/useTerminalStore.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { openNewTuiForUnit } from "../store/sessionOpen.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { ShellOrAgentIcon } from "./TerminalPaneSlot.tsx";
import { cn } from "./cn.ts";

/**
 * 新建会话页（docs/31 §三）—— 画布空态的主角：选 bot × 选形态
 * （对话 / Agent TUI），外加免选 bot 的系统终端。替代旧「当前没有打开的
 * 终端实例」空态；对话窗格拆分出的内嵌 bot 选择器（ChatPaneSlot）是它的
 * 精简版。
 */
export function NewSessionPage() {
  const units = useWorkbench((s) => s.units);
  const runtimes = useWorkbench((s) => s.runtimes);
  const activeUnitId = useWorkbench((s) => s.activeUnitId);
  const defaultProfileId = useTerminalStore((s) => s.defaultProfileId);
  const avatarFrame = useAppearance((s) => s.avatarFrame);

  const bots = units.filter((u) => u.kind !== "project" || u.bindings.length > 0);
  const executors = runtimes.filter((r) => !r.testOnly);

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[720px] flex-col gap-6">
        <div className="flex flex-col items-center gap-1 select-none">
          <h2 className="text-body-lg font-medium text-ink">新建会话</h2>
          <p className="text-body-sm text-ash">选择一个 bot 与形态开始 —— 对话与终端可在画布中并排</p>
        </div>

        {/* 分组 1：对话（docs/31：画布的第一等窗格） */}
        <section>
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase">
            <MessageSquarePlus size={12} />
            <span>对话</span>
            <span className="ml-auto text-[9px] normal-case tracking-normal text-ash/50">结构化时间线 · 可与终端并排</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5">
            {bots.map((u) => (
              <button
                key={u.id}
                onClick={() => useChatPanes.getState().openUnitChatPane(u.id)}
                className="flex items-center gap-2.5 rounded-panel border border-line/60 bg-card px-3 py-2.5 text-left transition hover:border-teal/40 hover:bg-teal-tint/40"
              >
                {u.avatar ? (
                  <img src={u.avatar} alt="" className={cn("h-7 w-7 shrink-0 object-cover", botAvatarStyle(u.name, avatarFrame)?.shape)} />
                ) : (
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center bg-line-soft text-body-sm font-medium text-graphite",
                      botAvatarStyle(u.name, avatarFrame)?.shape,
                    )}
                  >
                    {u.name.slice(0, 1)}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-ink">{u.name}</span>
                  <span className="block truncate text-caption text-ash">{u.identity?.role || "bot"}</span>
                </span>
                {String(u.id) === String(activeUnitId) && (
                  <span className="shrink-0 rounded bg-teal/15 px-1 py-0.2 text-[9px] font-sans text-teal">当前</span>
                )}
              </button>
            ))}
            {bots.length === 0 && (
              <p className="col-span-full px-1 text-caption text-ash">还没有 bot —— 先在左侧栏新建一个。</p>
            )}
          </div>
        </section>

        {/* 分组 2：Agent TUI（派发 · 记入历史） */}
        <section>
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-teal/80 tracking-wide uppercase">
            <Zap size={12} />
            <span>Agent CLI (TUI · 派发)</span>
            <span className="ml-auto text-[9px] normal-case tracking-normal text-ash/50">记入历史</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bots.map((u) => (
              <button
                key={u.id}
                onClick={() => openNewTuiForUnit(u)}
                className="flex items-center gap-2 rounded-btn border border-line/60 bg-card px-2.5 py-1.5 text-caption font-mono transition hover:border-teal/40 hover:bg-teal-tint hover:text-teal"
                title={`在 ${u.name} 的工作空间派发它的绑定执行器 TUI`}
              >
                {u.name}
                <span className="text-ash/60">· TUI</span>
              </button>
            ))}
          </div>
          {executors.length === 0 && bots.length > 0 && (
            <p className="px-1 text-caption text-ash">执行器还没注册 —— 对话形态不受影响。</p>
          )}
        </section>

        {/* 分组 3：原生系统终端（免选 bot） */}
        <section>
          <div className="mb-2 px-1 text-[11px] font-semibold text-ash/70 tracking-wide uppercase">原生系统终端</div>
          <div className="flex flex-wrap gap-1.5">
            {SUPPORTED_TERMINAL_PROFILES.map((profile) => (
              <button
                key={profile.id}
                onClick={() => {
                  const unit = useWorkbench.getState().units.find((u) => u.id === useWorkbench.getState().activeUnitId);
                  useTerminalStore.getState().createTab({ profileId: profile.id, cwd: unit?.rootPath });
                }}
                className="flex items-center gap-2 rounded-btn border border-line/60 bg-card px-2.5 py-1.5 text-caption font-mono text-ink transition hover:border-teal/40 hover:bg-teal-tint hover:text-teal"
              >
                <ShellOrAgentIcon icon={profile.icon} />
                {profile.name}
                {profile.id === defaultProfileId && (
                  <span className="text-[9px] text-teal/80 bg-teal/10 px-1 py-0.2 rounded font-sans">默认</span>
                )}
              </button>
            ))}
          </div>
        </section>

        <p className="flex items-center justify-center gap-1 text-caption text-ash/60 select-none">
          <Plus size={11} />
          标签栏「＋」下拉随时可加：对话 / Agent TUI / 系统终端；窗格可自由左右/上下拆分
        </p>
      </div>
    </div>
  );
}
