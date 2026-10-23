import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  CircleDot,
  History,
  MessageSquare,
  RotateCcw,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  dispatchTerminal,
  fetchUnitHistory,
  type UnitHistoryEntry,
} from "../adapters/daemon/client.ts";
import { asSessionId, asUnitId, isResidentUnit } from "../core/units.ts";
import { AUTO_ARCHIVE_DAY_OPTIONS, useHistoryPrefs } from "../store/useHistoryPrefs.ts";
import { useShell } from "../store/useShell.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { collectLeafIds, useTerminalStore } from "../store/useTerminalStore.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { resumeArgsFor } from "./HistoryPane.tsx";
import { executorIconSrc } from "./executorIcon.ts";
import { Toggle } from "./Toggle.tsx";
import { cn } from "./cn.ts";

function formatTimestamp(ts: number | null): string {
  if (ts === null || ts <= 0) return "-";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${hm}`;
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays < 7) return `${diffDays}天前 ${hm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

function formatDuration(entry: UnitHistoryEntry): string | null {
  if (entry.endedAt === null) return null;
  const s = Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
}

function statusBadge(status: string): { icon: typeof CircleCheck; cls: string; label: string } {
  if (status === "done" || status === "completed" || status === "idle") {
    return { icon: CircleCheck, cls: "text-gain bg-gain/10", label: "已完成" };
  }
  if (status === "failed") {
    return { icon: CircleAlert, cls: "text-loss bg-loss/10", label: "失败" };
  }
  if (status === "running") {
    return { icon: CircleDot, cls: "text-blue-500 bg-blue-500/10", label: "运行中" };
  }
  if (status === "skipped") {
    return { icon: CircleAlert, cls: "text-ash bg-line-soft", label: "跳过" };
  }
  return { icon: CircleDot, cls: "text-graphite bg-line-soft", label: status };
}

const KIND_LABEL: Record<UnitHistoryEntry["kind"], { label: string; cls: string }> = {
  automation: { label: "定时", cls: "bg-teal-tint text-teal" },
  backlog: { label: "待办", cls: "bg-amber-500/10 text-amber-600" },
  manual: { label: "手动", cls: "bg-violet-500/10 text-violet-500" },
  session: { label: "会话", cls: "bg-line-soft text-graphite" },
};

export function ArchivedTasksSettingsSection(): ReactElement {
  const units = useWorkbench((s) => s.units);
  const historyPrefs = useHistoryPrefs((s) => s.prefs);
  const setPrefs = useHistoryPrefs((s) => s.setPrefs);
  const runAutoArchive = useHistoryPrefs((s) => s.runAutoArchive);
  const archivedKeys = historyPrefs.archivedKeys;
  const archivedEntries = historyPrefs.archivedEntries;
  const unarchiveKey = useHistoryPrefs((s) => s.unarchiveKey);
  const unarchiveAll = useHistoryPrefs((s) => s.unarchiveAll);
  const updateArchivedEntries = useHistoryPrefs((s) => s.updateArchivedEntries);

  const [search, setSearch] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState<string>("all");
  const [selectedKind, setSelectedKind] = useState<string>("all");
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [justRestoredKey, setJustRestoredKey] = useState<string | null>(null);

  // 打开设置页时后台拉取一次历史，补充或刷新已归档条目的最新详情，并执行自动归档检查
  useEffect(() => {
    let alive = true;
    void fetchUnitHistory(undefined, 500)
      .then((list) => {
        if (alive && list && list.length > 0) {
          updateArchivedEntries(list);
          runAutoArchive(list);
        }
      })
      .catch((err: unknown) => {
        console.warn("[ArchivedTasksSettingsSection] 刷新历史记录失败:", err);
      });
    return () => {
      alive = false;
    };
  }, [updateArchivedEntries, runAutoArchive]);

  // 全部归档任务列表（archivedKeys 驱动）
  const allArchivedList = useMemo(() => {
    const list: UnitHistoryEntry[] = [];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    for (const key of archivedKeys) {
      const cached = archivedEntries[key];
      if (cached) {
        // 如果所属 unitName 缺失，尝试从当前 units 里补充
        const u = cached.unitId ? unitMap.get(cached.unitId as any) : undefined;
        list.push({
          ...cached,
          unitName: cached.unitName || u?.name || cached.unitId || "未知 Bot",
        });
      } else {
        // 只有 key 没有快照时提供保底占位
        list.push({
          key,
          kind: "session",
          title: `已归档会话 (${key})`,
          subtitle: null,
          runtimeId: "unknown",
          launchMode: "headless",
          status: "done",
          trigger: null,
          startedAt: 0,
          endedAt: null,
          detail: null,
          sessionId: key.startsWith("session-") ? key.replace(/^session-/, "") : key,
          resumeRef: null,
        });
      }
    }

    // 按结束时间或开始时间倒序
    return list.sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
  }, [archivedKeys, archivedEntries, units]);

  // 过滤后的列表
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allArchivedList.filter((item) => {
      if (selectedUnitId !== "all" && item.unitId !== selectedUnitId) {
        return false;
      }
      if (selectedKind !== "all" && item.kind !== selectedKind) {
        return false;
      }
      if (q === "") return true;
      return (
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        (item.unitName && item.unitName.toLowerCase().includes(q)) ||
        (item.runtimeId && item.runtimeId.toLowerCase().includes(q)) ||
        item.key.toLowerCase().includes(q)
      );
    });
  }, [allArchivedList, search, selectedUnitId, selectedKind]);

  // 处理在聊天页打开
  const handleOpenInChat = (entry: UnitHistoryEntry): void => {
    if (!entry.sessionId) return;
    const ownerUnitId = entry.unitId || (units[0]?.id ?? "");
    void useWorkbench
      .getState()
      .openSession({
        sessionId: asSessionId(entry.sessionId),
        unitId: asUnitId(ownerUnitId),
        runtimeId: entry.runtimeId,
      })
      .then(() => {
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("chat");
        sh.closeSettings();
      });
  };

  // 处理在 TUI 中重现
  const handleOpenInTui = (entry: UnitHistoryEntry): void => {
    const st = useTerminalStore.getState();
    if (entry.terminalId) {
      const live = st.instances.find((i) => i.id === entry.terminalId);
      if (live) {
        const group = st.groups.find((g) => collectLeafIds(g.rootLayout).includes(live.id));
        if (group) st.setActiveGroup(group.id);
        st.setActiveInstance(live.id);
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        sh.closeSettings();
        return;
      }
    }

    const args = resumeArgsFor(entry.runtimeId, entry.resumeRef);
    if (!args) return;
    const unit = units.find((u) => u.id === entry.unitId) ?? units[0];
    if (!unit) return;

    useTerminalStore.getState().notePendingUnitDispatch(unit.id);
    void dispatchTerminal({
      unitId: unit.id,
      unitName: unit.name,
      rootPath: unit.rootPath,
      runtimeId: entry.runtimeId,
      args,
      resumeRef: entry.resumeRef,
    })
      .then(() => {
        const sh = useShell.getState();
        sh.setMainView("chat");
        sh.setConversationView("terminal");
        sh.closeSettings();
      })
      .catch((err: unknown) => {
        console.error("[ArchivedTasksSettingsSection] TUI 恢复失败:", err);
      });
  };

  // 处理查看详情（开右侧栏）
  const handleOpenDetail = (entry: UnitHistoryEntry): void => {
    const unit = units.find((u) => u.id === entry.unitId) ?? units[0];
    if (!unit) return;
    useShell.getState().closeSettings();
    useSidePane.getState().openTab({
      unitId: unit.id,
      unitName: unit.name,
      focusKey: entry.key,
    });
  };

  // 恢复单条任务
  const handleRestore = (key: string): void => {
    unarchiveKey(key);
    setJustRestoredKey(key);
    setTimeout(() => {
      setJustRestoredKey((curr) => (curr === key ? null : curr));
    }, 2500);
  };

  return (
    <div className="space-y-6">
      {/* 头部标题与说明 */}
      <div>
        <div className="flex items-center gap-2">
          <Archive size={18} className="text-teal" />
          <h3
            className="text-body font-semibold text-ink"
            title="已归档的任务放进此「已完成抽屉」，内容和完整历史均永久保留，只是不再显示在左侧栏占用日常工作空间。在此您可以随时按条件检索、查看回顾、在聊天页或 TUI 中重新打开、或取消归档恢复回左侧栏。"
          >
            归档任务抽屉
          </h3>
          <span className="rounded-full bg-teal-tint px-2 py-0.5 text-caption font-medium text-teal">
            共 {allArchivedList.length} 条已归档
          </span>
        </div>
      </div>

      {/* 自动归档配置（对齐 ZCode taskAutoArchive 设置） */}
      <div className="rounded-card border border-line bg-card/60 p-4 shadow-xs space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="text-body-sm font-semibold text-ink"
                title="自动将超过指定天数且已结束的旧任务移入此抽屉，保持左侧栏整洁。置顶任务和进行中的任务不会被自动归档。"
              >
                自动归档旧任务
              </span>
              {historyPrefs.autoArchiveEnabled && (
                <span className="rounded-full bg-teal-tint px-2 py-0.5 text-[10px] font-medium text-teal">
                  已开启 · 超出 {historyPrefs.autoArchiveOlderThanDays} 天自动归档
                </span>
              )}
            </div>
          </div>
          <Toggle
            on={historyPrefs.autoArchiveEnabled}
            onChange={(v) => {
              setPrefs({ autoArchiveEnabled: v });
            }}
            ariaLabel="自动归档旧任务"
          />
        </div>

        {historyPrefs.autoArchiveEnabled && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
            <div>
              <p
                className="text-caption font-medium text-graphite"
                title="任务最后完成或更新时间早于该时长后，才会自动进入归档"
              >
                归档保留时长
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setPrefs({ autoArchiveOlderThanDays: days })}
                  className={cn(
                    "rounded-btn px-2.5 py-1 text-caption font-medium transition cursor-pointer",
                    historyPrefs.autoArchiveOlderThanDays === days
                      ? "bg-teal text-white shadow-xs"
                      : "border border-line bg-canvas text-graphite hover:bg-line-soft hover:text-ink",
                  )}
                >
                  {days} 天后归档
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 筛选与批量控制栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-btn border border-line bg-card/60 p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* 搜索输入框 */}
          <div className="relative flex items-center">
            <Search size={14} className="absolute left-2.5 text-ash" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索任务名称、Bot、执行器..."
              className="h-8 w-60 rounded-btn border border-line bg-canvas pl-8 pr-3 text-caption text-ink placeholder:text-ash/70 focus:border-teal/60 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 text-caption text-ash hover:text-ink cursor-pointer"
              >
                ×
              </button>
            )}
          </div>

          {/* Bot 单元筛选 */}
          <select
            value={selectedUnitId}
            onChange={(e) => setSelectedUnitId(e.target.value)}
            className="h-8 rounded-btn border border-line bg-canvas px-2.5 text-caption text-ink focus:border-teal/60 focus:outline-none"
          >
            <option value="all">全部 Bot ({units.length})</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {isResidentUnit(u) ? "（常驻）" : ""}
              </option>
            ))}
          </select>

          {/* 任务类型筛选 */}
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
            className="h-8 rounded-btn border border-line bg-canvas px-2.5 text-caption text-ink focus:border-teal/60 focus:outline-none"
          >
            <option value="all">全部任务类型</option>
            <option value="session">会话</option>
            <option value="automation">定时任务</option>
            <option value="backlog">待办任务</option>
            <option value="manual">手动任务</option>
          </select>
        </div>

        {/* 批量操作 */}
        <div className="flex items-center gap-2">
          {allArchivedList.length > 0 && !confirmClearAll && (
            <button
              type="button"
              onClick={() => setConfirmClearAll(true)}
              className="flex h-8 items-center gap-1.5 rounded-btn border border-line bg-canvas px-2.5 text-caption text-graphite transition hover:border-loss/40 hover:bg-loss/5 hover:text-loss"
            >
              <ArchiveRestore size={13} />
              <span>全部取消归档</span>
            </button>
          )}

          {confirmClearAll && (
            <div className="flex items-center gap-1.5 rounded-btn bg-loss/10 p-1 text-caption text-loss">
              <span>确认恢复全部 {allArchivedList.length} 条任务到左侧栏？</span>
              <button
                type="button"
                onClick={() => {
                  unarchiveAll();
                  setConfirmClearAll(false);
                }}
                className="rounded-btn bg-loss px-2 py-0.5 text-white hover:bg-loss/90 font-medium"
              >
                确认
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearAll(false)}
                className="rounded-btn bg-canvas px-2 py-0.5 text-graphite hover:text-ink"
              >
                取消
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 恢复提示横幅 */}
      {justRestoredKey && (
        <div className="flex items-center justify-between rounded-btn bg-gain/10 px-3 py-2 text-caption text-gain border border-gain/20 animate-in fade-in duration-200">
          <span>✓ 已成功取消归档，该任务已重新显示在左侧栏对应的 Bot 列表中。</span>
          <button
            type="button"
            onClick={() => useShell.getState().closeSettings()}
            className="font-medium underline hover:opacity-80"
          >
            返回左侧栏查看 →
          </button>
        </div>
      )}

      {/* 归档列表 */}
      {filteredList.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-btn border border-dashed border-line bg-card/30 px-6 py-16 text-center">
          <Archive size={36} className="text-ash/60 mb-3" />
          <h4 className="text-body-sm font-medium text-graphite">
            {allArchivedList.length === 0 ? "抽屉里还没有已归档的任务" : "没有匹配条件的归档任务"}
          </h4>
          <p className="mt-1.5 max-w-md text-caption text-ash leading-relaxed">
            {allArchivedList.length === 0 ? (
              <>
                当左侧栏中某些任务已顺利完成、不再频繁交互时，可在该任务上点击右键选择
                <b className="text-graphite font-semibold">「归档任务」</b>
                或点击悬浮归档图标，即可将其收纳进本抽屉，既不丢失历史，又能释放左侧栏空间。
              </>
            ) : (
              "尝试更换筛选条件或清除搜索框文字"
            )}
          </p>
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setSelectedUnitId("all");
                setSelectedKind("all");
              }}
              className="mt-4 rounded-btn bg-teal-tint px-3 py-1 text-caption text-teal hover:bg-teal/15 font-medium"
            >
              清空筛选条件
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredList.map((entry) => {
            const st = statusBadge(entry.status);
            const SIcon = st.icon;
            const kindInfo = KIND_LABEL[entry.kind] ?? KIND_LABEL.session;
            const iconSrc = executorIconSrc(entry.runtimeId);
            const canChat = entry.sessionId !== null;
            const canTui = resumeArgsFor(entry.runtimeId, entry.resumeRef) !== null;
            const duration = formatDuration(entry);

            return (
              <div
                key={entry.key}
                className="group flex flex-col gap-2 rounded-btn border border-line bg-card p-3 shadow-xs transition hover:border-teal/30 hover:shadow-sm"
              >
                {/* 顶栏：Bot 名称、类型、执行器、状态、时间 */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5 flex-wrap">
                    {/* Bot 标牌 */}
                    <span className="flex shrink-0 items-center gap-1 rounded-btn bg-line-soft/80 px-2 py-0.5 text-caption font-medium text-ink">
                      <span>{entry.unitName || "Bot"}</span>
                    </span>

                    {/* 类型 */}
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.2 text-[10px] font-medium", kindInfo.cls)}>
                      {kindInfo.label}
                    </span>

                    {/* 执行器 */}
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-mono text-ash">
                      {iconSrc && <img src={iconSrc} alt="" className="h-3 w-3 object-contain" />}
                      <span>{entry.runtimeId.replace(/^daemon:/, "")}</span>
                    </span>

                    {/* 运行模式 */}
                    <span className="shrink-0 text-[10px] text-ash/80">
                      ({entry.launchMode === "terminal" ? "TUI" : "后台对话"})
                    </span>
                  </div>

                  {/* 状态与时间 */}
                  <div className="flex shrink-0 items-center gap-2 text-caption">
                    <span className={cn("flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[10px]", st.cls)}>
                      <SIcon size={10} />
                      <span>{st.label}</span>
                    </span>
                    {duration && <span className="text-ash">{duration}</span>}
                    <span className="text-ash/80">{formatTimestamp(entry.startedAt)}</span>
                  </div>
                </div>

                {/* 任务主标题与副标题 */}
                <div className="min-w-0">
                  <h4 className="text-body-sm font-medium text-ink break-words">{entry.title}</h4>
                  {entry.subtitle && (
                    <p className="mt-0.5 text-caption text-ash line-clamp-2 leading-relaxed">
                      {entry.subtitle}
                    </p>
                  )}
                  {entry.detail && (
                    <p className="mt-0.5 text-caption text-ash/70 line-clamp-1 italic">
                      {entry.detail}
                    </p>
                  )}
                </div>

                {/* 底部动作工具栏 */}
                <div className="flex items-center justify-between border-t border-line/50 pt-2 mt-1">
                  <div className="flex items-center gap-1.5">
                    {canChat && (
                      <button
                        type="button"
                        onClick={() => handleOpenInChat(entry)}
                        className="flex h-7 items-center gap-1 rounded-btn bg-teal-tint px-2 text-caption text-teal transition hover:bg-teal/20"
                      >
                        <MessageSquare size={11} />
                        <span>在聊天页查看</span>
                      </button>
                    )}

                    {canTui && (
                      <button
                        type="button"
                        onClick={() => handleOpenInTui(entry)}
                        className="flex h-7 items-center gap-1 rounded-btn bg-violet-500/10 px-2 text-caption text-violet-500 transition hover:bg-violet-500/20"
                      >
                        <SquareTerminal size={11} />
                        <span>在 TUI 中重现</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleOpenDetail(entry)}
                      className="flex h-7 items-center gap-1 rounded-btn px-2 text-caption text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <History size={11} />
                      <span>详情记录</span>
                    </button>
                  </div>

                  {/* 取消归档（恢复）按钮 */}
                  <button
                    type="button"
                    onClick={() => handleRestore(entry.key)}
                    title="取消归档：恢复到左侧栏的 Bot 列表中"
                    className="flex h-7 items-center gap-1 rounded-btn border border-line bg-canvas px-2.5 text-caption font-medium text-graphite transition hover:border-teal hover:bg-teal-tint hover:text-teal"
                  >
                    <ArchiveRestore size={12} className="text-teal" />
                    <span>取消归档（恢复至侧栏）</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
