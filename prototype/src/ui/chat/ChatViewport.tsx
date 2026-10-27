import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RuntimeEvent } from "../../core/events.ts";
import type { useWorkbench, selectActiveUnit } from "../../store/useWorkbench.ts";
import { cn } from "../cn.ts";

type WorkbenchSnapshot = ReturnType<typeof useWorkbench.getState>;
export type SessionItem = WorkbenchSnapshot["sessions"][number];
export type RuntimeItem = WorkbenchSnapshot["runtimes"][number];
export type ActiveUnit = ReturnType<typeof selectActiveUnit>;

import type { GroupedItem, RenderUnit, ToolExecutionData, TurnNavAnchor } from "./types.ts";
import { groupTimelineEvents, buildWorkRuns } from "./groupByEvents.ts";
import { useChatScroll } from "./scroll/useChatScroll.ts";
import { BackToBottomFab } from "./scroll/BackToBottomFab.tsx";
import { TurnNavigator } from "./interaction/TurnNavigator.tsx";
import { InChatFindBar } from "./interaction/InChatFindBar.tsx";
import { SelectionTooltip } from "./interaction/SelectionTooltip.tsx";

import { UserMessageBubble } from "./items/UserMessageBubble.tsx";
import { AssistantMessageBlock } from "./items/AssistantMessageBlock.tsx";
import { ReasoningShimmerBlock } from "./items/ReasoningShimmerBlock.tsx";
import { ContextInjectionCard } from "./items/ContextInjectionCard.tsx";
import {
  SegmentDividerRow,
  ForkPointRow,
  SessionStartRow,
  SessionEndRow,
  PermissionRow,
  SystemNoticeRow,
  SubagentSpawnedRow,
  SubagentFinishedRow,
  UsageFallbackRow,
  ErrorRow,
} from "./items/SegmentRows.tsx";

import { ToolCardHost } from "./tools/ToolCardHost.tsx";
import { FileDiffToolCard } from "./tools/FileDiffToolCard.tsx";
import { DeliverablesSummaryCard } from "./tools/DeliverablesSummaryCard.tsx";

export interface ChatViewportProps {
  readonly timeline: readonly { id: number | string; event: RuntimeEvent; at: number }[];
  readonly busy: boolean;
  readonly unit?: ActiveUnit;
  readonly sessions: readonly SessionItem[];
  readonly runtimes: readonly RuntimeItem[];
  readonly chatColumnWidth: number;
}

/* --------------------------------------------------------- 轮次定位环形聚焦 */

/** 虚拟 / 非虚拟两个分支共用的 ring 聚焦类（加环 + 过渡，1.5s 后撤环） */
const TURN_RING_CLASSES = ["ring-2", "ring-teal/50", "transition-all", "duration-500"] as const;

function flashTurnRing(el: Element): void {
  el.classList.add(...TURN_RING_CLASSES);
  setTimeout(() => el.classList.remove("ring-2", "ring-teal/50"), 1500);
}

export function ChatViewport({
  timeline,
  busy,
  unit,
  sessions,
  runtimes,
  chatColumnWidth,
}: ChatViewportProps) {
  // sessionId → 执行器显示名（divider 合成用）
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      const rt = runtimes.find((r) => r.id === s.runtimeId);
      map.set(String(s.id), rt?.presentation.displayName ?? String(s.runtimeId));
    }
    return (sid: string): string | undefined => map.get(sid);
  }, [sessions, runtimes]);

  // fork 血缘查询
  const sessionOf = useMemo(
    () => (sid: string): { forkOf?: string; forkKind?: "branch" | "revision" } | undefined =>
      sessions.find((s) => String(s.id) === sid),
    [sessions],
  );

  // 1. 事件流归并
  const items = useMemo(
    () => groupTimelineEvents(timeline, nameOf, sessionOf),
    [timeline, nameOf, sessionOf],
  );

  // 2. 思考与工具折叠工作组聚合
  const renderUnits = useMemo(() => buildWorkRuns(items), [items]);

  // 3. 提取轮次锚点（供右侧大纲导览），关联在单元列表中的下标
  const turnAnchors = useMemo<TurnNavAnchor[]>(() => {
    const anchors: TurnNavAnchor[] = [];
    let turnCount = 0;
    renderUnits.forEach((u, unitIdx) => {
      if (u.kind === "item" && u.item.kind === "user.message") {
        turnCount += 1;
        anchors.push({
          turnIndex: turnCount,
          userMessageId: String(u.item.data.messageId || u.item.id),
          queryPreview: typeof u.item.data.text === "string" ? u.item.data.text.trim().slice(0, 36) : "",
          at: u.item.at,
          itemIndex: unitIdx,
        });
      }
    });
    return anchors;
  }, [renderUnits]);

  // 4. 最后一条用户消息 id（末轮编辑重发专属入口）
  const lastUserTurnId = useMemo(() => {
    let last: string | number | undefined;
    for (const it of items) if (it.kind === "user.message") last = it.id;
    return last;
  }, [items]);

  // 5. 意图感知吸底与滚动控制器
  // 当 timeline 长度或 busy 改变时触发信号
  const changeSignal = timeline.length > 0 ? `${timeline.length}-${timeline[timeline.length - 1]!.id}-${busy}` : busy;
  const { containerRef, showBackToBottom, scrollToBottom } = useChatScroll(changeSignal);

  // 6. 双段架构（Dual-Phase Architecture）：沉淀单元 vs 活跃 LiveTail
  const { settledUnits, liveTailUnit } = useMemo(() => {
    if (renderUnits.length === 0) {
      return { settledUnits: [], liveTailUnit: null };
    }
    const last = renderUnits[renderUnits.length - 1]!;
    // 如果处于 busy 忙态，且最后一个单元是正在运行的工作组或未闭合的助手流式块，将其置于 LiveTail 尾插槽
    const isLive =
      busy &&
      ((last.kind === "work" && last.running) ||
        (last.kind === "item" &&
          last.item.kind === "assistant.message" &&
          last.item.data?.streaming === true));

    if (isLive) {
      return {
        settledUnits: renderUnits.slice(0, -1),
        liveTailUnit: last,
      };
    }
    return {
      settledUnits: renderUnits,
      liveTailUnit: null,
    };
  }, [renderUnits, busy]);

  // 7. 虚拟滚动虚拟化（当沉淀单元 > 20 时启用虚拟滚动，避免 DOM 膨胀）
  const useVirtual = settledUnits.length > 20;
  const virtualizer = useVirtualizer({
    count: settledUnits.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 110,
    overscan: 6,
    enabled: useVirtual,
  });

  const handleScrollToTurn = useCallback(
    (anchor: TurnNavAnchor) => {
      if (useVirtual && anchor.itemIndex !== undefined) {
        virtualizer.scrollToIndex(anchor.itemIndex, { align: "start", behavior: "smooth" });
        // 虚拟滚动等首帧落位后再定位元素
        setTimeout(() => {
          const el = containerRef.current?.querySelector(`[data-turn-id="${anchor.userMessageId}"]`);
          if (el) flashTurnRing(el);
        }, 300);
      } else {
        const container = containerRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-turn-id="${anchor.userMessageId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          flashTurnRing(el);
        }
      }
    },
    [useVirtual, virtualizer, containerRef],
  );

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden selection:bg-teal-tint selection:text-ink"
    >
      {/* 顶部悬浮查找栏（Ctrl+F） */}
      <InChatFindBar containerRef={containerRef} />

      {/* 选中文本微型交互 Tooltip（引用追问、复制） */}
      <SelectionTooltip containerRef={containerRef} />

      {/* 轮次导航大纲条（右轨） */}
      <TurnNavigator
        anchors={turnAnchors}
        containerRef={containerRef}
        onNavigate={handleScrollToTurn}
      />

      {/* 居中正文阅读列 */}
      <div
        style={{ maxWidth: chatColumnWidth }}
        className={cn(
          "mx-auto w-full px-4 py-6 @min-[560px]:px-6 @min-[720px]:px-8 @min-[720px]:py-8",
        )}
      >
        {/* 沉淀单元区域 */}
        {useVirtual ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const u = settledUnits[virtualRow.index];
              if (!u) return null;
              return (
                <div
                  key={u.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="pb-4"
                >
                  <UnitRowRenderer
                    unit={u}
                    busy={busy}
                    lastUserTurnId={lastUserTurnId}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-4">
            {settledUnits.map((u) => (
              <UnitRowRenderer
                key={u.key}
                unit={u}
                busy={busy}
                lastUserTurnId={lastUserTurnId}
              />
            ))}
          </div>
        )}

        {/* LiveTail 独立尾插槽：非虚拟化渲染，流式极速响应与零闪烁 */}
        {liveTailUnit && (
          <div className="mt-4">
            <UnitRowRenderer
              unit={liveTailUnit}
              busy={busy}
              lastUserTurnId={lastUserTurnId}
            />
          </div>
        )}

        {/* 忙态底部指示 */}
        {busy && (
          <div className="mt-4 flex items-center gap-2 text-body-sm text-teal select-none">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" aria-hidden />
            <span>{unit?.name ?? "bot"} 正在思考与执行…</span>
          </div>
        )}
      </div>

      {/* 悬浮回到底部 FAB 按钮（带忙态未读流式脉冲指示） */}
      <BackToBottomFab
        visible={showBackToBottom}
        busy={busy}
        onClick={() => scrollToBottom(true)}
      />
    </div>
  );
}

/* ------------------------------------------------------------- 单元渲染路由器 */

function UnitRowRenderer({
  unit,
  busy,
  lastUserTurnId,
}: {
  unit: RenderUnit;
  busy: boolean;
  lastUserTurnId: string | number | undefined;
}) {
  if (unit.kind === "work") {
    return (
      <WorkGroupRow
        groupKey={unit.key}
        entries={unit.entries}
        running={unit.running}
        busy={busy}
        lastUserTurnId={lastUserTurnId}
      />
    );
  }
  return (
    <SingleItemRow
      item={unit.item}
      busy={busy}
      lastUserTurnId={lastUserTurnId}
    />
  );
}

/* ------------------------------------------------------------- 思考与工具工作组 */

/**
 * 工作组展开态的模块级记忆（借鉴 ZCode ToolLayout 的 toolLayoutOpenState）：
 * 虚拟滚动把行卸载重挂后恢复用户的选择，不强制回默认折叠。
 */
const workGroupOpenStates = new Map<string, boolean>();

function WorkGroupRow({
  groupKey,
  entries,
  running,
  busy,
  lastUserTurnId,
}: {
  groupKey: string;
  entries: readonly GroupedItem[];
  running: boolean;
  busy: boolean;
  lastUserTurnId: string | number | undefined;
}) {
  // 保持默认折叠状态，绝不随运行状态自动展开收起导致画面剧烈跳跃；
  // 用户展开过的组在虚拟卸载重挂后保持展开（记忆见 workGroupOpenStates）
  const [open, setOpen] = useState(() => workGroupOpenStates.get(groupKey) ?? false);
  const toggleOpen = (): void => {
    const next = !open;
    workGroupOpenStates.set(groupKey, next);
    setOpen(next);
  };

  const toolCount = entries.filter((e) => e.kind === "tool").length;
  const thinkCount = entries.filter((e) => e.kind === "thinking").length;
  // 中间正文（最终回复之前的过程文本段）：折叠摘要里如实计数，用户知道组里
  // 不止命令，还有被收起来的模型叙述
  const noteCount = entries.filter((e) => e.kind === "assistant.message").length;
  const failed = entries.some((e) => e.kind === "tool" && e.data?.ok === false);

  // 落定后的整段时长（首末条目时间差）：摘要行给「这轮花了多久」的直觉
  const durationLabel = useMemo(() => {
    if (running || entries.length < 2) return null;
    const ms = entries[entries.length - 1]!.at - entries[0]!.at;
    if (!(ms > 0)) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
  }, [entries, running]);

  // 提取当前正在进行的操作或思考摘要
  const activeLabel = useMemo(() => {
    if (!running) return null;
    const activeTool = entries.find((e) => e.kind === "tool" && e.data?.completed !== true);
    if (activeTool) {
      return `正在执行 ${activeTool.data?.title || activeTool.data?.toolName || "工具"}…`;
    }
    const isThinking = entries[entries.length - 1]?.kind === "thinking";
    if (isThinking) {
      return "正在深度思考…";
    }
    return "正在处理中…";
  }, [entries, running]);

  // 统计修改交付的文件
  const deliverableFiles = useMemo(() => {
    const files: { path: string }[] = [];
    for (const e of entries) {
      if (e.kind === "file.diff" && e.data?.path) {
        files.push({ path: e.data.path });
      } else if (e.kind === "deliverable" && e.data?.path) {
        files.push({ path: e.data.path });
      }
    }
    return files;
  }, [entries]);

  return (
    <div className="rounded-card border border-line/60 bg-rail/15 px-3 py-2 shadow-2xs transition">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 text-left text-caption transition select-none",
          running ? "text-graphite" : "text-ash hover:text-graphite",
        )}
      >
        <Sparkles
          size={12}
          className={cn(
            "shrink-0",
            running ? "animate-pulse text-teal" : failed ? "text-loss" : "text-ash",
          )}
        />
        <span className={cn("shrink-0 font-medium", running ? "text-teal" : "text-graphite")}>
          {running ? (activeLabel ?? "工作中…") : toolCount > 0 ? "执行过程" : "思考过程"}
        </span>
        <span className="min-w-0 truncate text-ash font-mono text-[11px]">
          {toolCount > 0 && ` · ${toolCount} 条命令`}
          {thinkCount > 0 && ` · 思考 ${thinkCount} 阶段`}
          {noteCount > 0 && ` · 过程文本 ${noteCount} 段`}
          {failed && " · 含有失败项"}
          {durationLabel !== null && ` · 用时 ${durationLabel}`}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-ash">
          <span className="hidden sm:inline">{open ? "收起明细" : "展开过程"}</span>
          <ChevronRight
            size={12}
            className={cn("shrink-0 transition-transform text-ash", open ? "rotate-90" : "rotate-0")}
          />
        </span>
      </button>

      {/* 展开的详细执行流。file.diff / deliverable 不逐条渲染——底部已聚合成
          一张交付摘要卡，逐条再画一遍是同一信息两份 */}
      {open && (
        <div className="mt-2.5 space-y-2 border-l border-line/70 pl-3">
          {entries
            .filter((e) => e.kind !== "file.diff" && e.kind !== "deliverable")
            .map((e) => (
              <SingleItemRow
                key={e.id}
                item={e}
                busy={busy}
                lastUserTurnId={lastUserTurnId}
              />
            ))}

          {/* 聚合文件交付卡 */}
          {deliverableFiles.length > 0 && (
            <div className="pt-1">
              <DeliverablesSummaryCard files={deliverableFiles} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 单个条目路由器 */

function SingleItemRow({
  item,
  busy,
  lastUserTurnId,
}: {
  item: GroupedItem;
  busy: boolean;
  lastUserTurnId: string | number | undefined;
}) {
  switch (item.kind) {
    case "session.start":
      return <SessionStartRow event={item.data} at={item.at} />;

    case "session.end":
      return <SessionEndRow reason={item.data?.reason ?? ""} />;

    case "segment.divider":
      return <SegmentDividerRow data={item.data} />;

    case "fork.point":
      return <ForkPointRow data={item.data} />;

    case "user.message":
      return (
        <UserMessageBubble
          text={item.data.text}
          attachments={item.data.attachments}
          messageId={typeof item.data.messageId === "string" ? item.data.messageId : ""}
          sessionId={typeof item.data.sessionId === "string" ? item.data.sessionId : ""}
          origin={typeof item.data.origin === "string" ? item.data.origin : undefined}
          isLatestUserTurn={item.id === lastUserTurnId}
          busy={busy}
          at={item.at}
        />
      );

    case "thinking":
      return <ReasoningShimmerBlock text={item.data.text} busy={busy} startedAt={item.at} />;

    case "tool":
      return <ToolCardHost data={item.data as ToolExecutionData} />;

    case "assistant.message":
      return (
        <AssistantMessageBlock
          text={item.data.text}
          at={item.at}
          messageId={typeof item.data.messageId === "string" ? item.data.messageId : ""}
          sessionId={typeof item.data.sessionId === "string" ? item.data.sessionId : ""}
          streaming={item.data.streaming === true}
          usage={item.data.usage}
          busy={busy}
          turnStartedAt={item.data.turnStartedAt}
          durationMs={item.data.durationMs}
        />
      );

    case "permission":
      return (
        <PermissionRow
          requestId={item.data.requestId}
          detail={item.data.detail}
          risk={item.data.risk}
        />
      );

    case "subagent.spawned":
      return (
        <SubagentSpawnedRow
          role={item.data.role}
          runtimeId={item.data.runtimeId}
        />
      );

    case "subagent.finished":
      return <SubagentFinishedRow summary={item.data.summary} />;

    case "file.diff":
      return <FileDiffToolCard data={{
        callId: String(item.id),
        toolName: "file_diff",
        completed: true,
        ok: true,
        output: JSON.stringify(item.data),
      }} />;

    case "deliverable":
      return (
        <DeliverablesSummaryCard
          files={[{ path: item.data.path || item.data.title || "deliverable" }]}
        />
      );

    case "context.injection":
      return (
        <ContextInjectionCard
          parts={item.data.parts ?? []}
          totalChars={item.data.totalChars}
        />
      );

    case "usage":
      return <UsageFallbackRow model={item.data.model} />;

    case "error":
      return <ErrorRow message={item.data.message} />;

    case "system.notice":
      return <SystemNoticeRow event={item.data} at={item.at} />;

    default:
      return null;
  }
}
