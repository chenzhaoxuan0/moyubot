import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileCode,
  FileDiff,
  FolderOpen,
  GitBranch,
  Package,
  PencilLine,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import type { RuntimeEvent } from "../core/events.ts";
import { SESSION_SOURCE_LABEL } from "../core/units.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useShell } from "../store/useShell.ts";
import { openInEditor } from "../adapters/daemon/client.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { AttachmentsBar } from "./AttachmentsBar.tsx";
import type { ChatAttachment } from "../core/attachments.ts";
import { SessionReadinessBadge } from "./SessionReadinessBadge.tsx";
import { QuickContextMenu, quickMenuFromEvent, type QuickMenuState } from "./QuickContextMenu.tsx";
import { cn } from "./cn.ts";

/**
 * 时间线 —— Personal Agent 归一化事件流渲染层。
 *
 * 借鉴 GrokBot 与 Meta Muse：
 * - 思考过程折叠收纳（Thinking Accordion），展示耗时/字数摘要
 * - 工具调用卡片化（Tool Execution Pills），内联参数与输出预览
 * - 助手回复采用 Markdown 富文本排版与代码块复制
 * - 用户消息独立卡片排版
 */
/**
 * 吸底滚动：用户距底 <40px 视为「贴底」，此后内容变化（流式增量、新事件）
 * 自动滚到底；用户上滚即暂停，手动滚回底部恢复。渲染后同步执行（useLayoutEffect
 * 先于绘制），流式逐字不闪跳。openSession 历史重建时首帧即贴底。
 */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 无依赖数组：每次渲染后检查——流式每帧内容都变
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && stuck.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  return ref;
}

export function Timeline() {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const sessions = useWorkbench((s) => s.sessions);
  const runtimes = useWorkbench((s) => s.runtimes);
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const scrollRef = useStickToBottom();

  // sessionId → 执行器显示名（divider 合成用；Map 每次渲染重建，sessions 规模下可忽略）
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      const rt = runtimes.find((r) => r.id === s.runtimeId);
      map.set(String(s.id), rt?.presentation.displayName ?? String(s.runtimeId));
    }
    return (sid: string): string | undefined => map.get(sid);
  }, [sessions, runtimes]);

  // fork 血缘查询（fork.point 标记用）：sessions 行上带 forkOf/forkKind
  const sessionOf = useMemo(
    () => (sid: string): { forkOf?: string; forkKind?: "branch" | "revision" } | undefined =>
      sessions.find((s) => String(s.id) === sid),
    [sessions],
  );

  // 事件流归并处理：合并流式连续思考片段，配对工具调用
  const items = useMemo(() => groupTimelineEvents(timeline, nameOf, sessionOf), [timeline, nameOf, sessionOf]);

  // 非正文折叠（对齐 ZCode 的 turn history 手风琴）：连续的 思考/工具调用 归并成
  // 一个可折叠的工作组，回复正文不再被一串工具行往下拖 —— 见 buildWorkRuns
  const renderUnits = useMemo(() => buildWorkRuns(items), [items]);

  // 最后一条用户消息的 item id：编辑重发（revision）只对它开放（latestQueryEditOnly）
  const lastUserTurnId = useMemo(() => {
    let last: string | number | undefined;
    for (const it of items) if (it.kind === "user.message") last = it.id;
    return last;
  }, [items]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div
        style={{ maxWidth: chatColumnWidth }}
        className={cn(
          // 阅读列：mx-auto 居中 + 可设置的最大宽度（useShell.chatColumnWidth，默认
          // 900 ≈ ZCode 的 max-w-4xl）。输入框（Composer）用同一宽度 —— 两者永远对齐。
          // 空态主角（EmptyState）刻意不在这里渲染：此前它在本滚动区里
          // min-h-full 居中，居中参考是「输入区之上的剩余空间」，输入区高度随
          // 列宽变（工具栏换行/解除换行/图标缩档）时主角被推着上下跳 ——
          // 现由 WorkspaceShell 以绝对定位覆盖层居中（与输入区高度解耦）
          "mx-auto w-full px-4 py-6 @min-[560px]:px-6 @min-[720px]:px-8 @min-[720px]:py-8",
        )}
      >
        <div className="space-y-4">
          {renderUnits.map((u) =>
            u.kind === "item" ? (
              <TimelineItemRow key={u.key} item={u.item} busy={busy} lastUserTurnId={lastUserTurnId} />
            ) : (
              <WorkGroupRow key={u.key} entries={u.entries} running={u.running} busy={busy} lastUserTurnId={lastUserTurnId} />
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-body-sm text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" aria-hidden />
              <span>{unit?.name ?? "bot"} 正在思考与执行…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 事件归并 */

interface GroupedItem {
  id: string | number;
  kind:
    | "session.start"
    | "session.end"
    | "segment.divider"
    | "user.message"
    | "thinking"
    | "assistant.message"
    | "tool"
    | "permission"
    | "subagent.spawned"
    | "subagent.finished"
    | "file.diff"
    | "deliverable"
    | "usage"
    | "error"
    | "system.notice"
    | "fork.point";
  at: number;
  data: any;
}

/**
 * 段边界 divider（ADR 0012）：时间线是整条对话（谱系）的投影，sessionId 从一段
 * 换到另一段 = 执行器切换点。divider 是渲染层聚合产物，不进账本。
 * 只在两侧会话都「认识」（在 sessions 台账里）时插入 —— 本地合成的 sys notice
 * 等无主事件不产生边界。
 */
function groupTimelineEvents(
  events: readonly { id: number | string; event: RuntimeEvent; at: number }[],
  sessionNameOf?: (sessionId: string) => string | undefined,
  sessionOf?: (sessionId: string) => { forkOf?: string; forkKind?: "branch" | "revision" } | undefined,
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let prevSessionId: string | null = null;

  for (const entry of events) {
    const { id, event, at } = entry;

    // 段边界：已知段 → 另一已知段（渲染层合成，不入账本）。
    // 分叉拼接点优先于执行器 divider（ADR 0013）：新段是旧段的 fork 子段时，
    // 边界语义是「从此处分叉」，同执行器分叉也不会误显示成「已切换执行器」。
    if ("sessionId" in event && sessionNameOf !== undefined) {
      const sid = String(event.sessionId);
      if (prevSessionId !== null && sid !== prevSessionId && sessionNameOf(sid) !== undefined && sessionNameOf(prevSessionId) !== undefined) {
        const child = sessionOf?.(sid);
        if (child !== undefined && child.forkOf === prevSessionId) {
          result.push({
            id: `fork-${id}`,
            kind: "fork.point",
            at,
            data: {
              from: sessionNameOf(prevSessionId) ?? prevSessionId,
              to: sessionNameOf(sid) ?? sid,
              forkKind: child.forkKind ?? "branch",
              fromId: prevSessionId,
            },
          });
        } else {
          result.push({
            id: `divider-${id}`,
            kind: "segment.divider",
            at,
            data: { from: sessionNameOf(prevSessionId)!, to: sessionNameOf(sid)!, fromId: prevSessionId, toId: sid },
          });
        }
      }
      prevSessionId = sid;
    }

    switch (event.type) {
      case "session.started":
        result.push({ id, kind: "session.start", at, data: event });
        break;

      case "session.ended":
        result.push({ id, kind: "session.end", at, data: event });
        break;

      case "message.delta": {
        if (event.role === "user") {
          result.push({
            id,
            kind: "user.message",
            at,
            data: {
              text: event.text,
              attachments: event.attachments,
              // 消息来源标记（docs/23）：origin="automation" = 定时任务代发 —— 气泡
              // 「定时」徽标据此点亮，随事件进账本，回放同样生效
              origin: event.origin,
              // fork 锚点要素（ADR 0013）：messageId 用于账本定位轮边界，
              // sessionId 标明锚点属于哪个段（时间线跨段时消息不都在活跃段里）
              messageId: event.messageId,
              sessionId: String(event.sessionId),
            },
          });
          break;
        }
        if (event.role === "assistant") {
          // 助手流式增量：同（会话, messageId）的 delta 归并进同一个 streaming 块
          // （与 reasoning.delta 同款拼接模式；间隔 tool/thinking 不挪块，位置以首个 delta 为准）。
          // messageId 必须与 sessionId 一起匹配：适配器的 messageId 多为会话内计数
          // （msg_1/user-1），跨段回放（谱系拼接）时不同段会撞名。
          const existing = findAssistantBlock(result, event.messageId, String(event.sessionId));
          if (existing !== undefined && existing.data.streaming === true) {
            existing.data.text += event.text;
          } else {
            result.push({
              id,
              kind: "assistant.message",
              at,
              data: { text: event.text, messageId: event.messageId, sessionId: String(event.sessionId), streaming: true },
            });
          }
          break;
        }
        break;
      }

      case "reasoning.delta": {
        const last = result[result.length - 1];
        if (last && last.kind === "thinking") {
          last.data.text += event.text;
        } else {
          result.push({ id, kind: "thinking", at, data: { text: event.text } });
        }
        break;
      }

      case "message.completed": {
        // completed 带全文终态：找到同（会话, messageId）的流式块原位收口
        // （key 不变不重挂载），找不到（适配器只发 completed）则按原样入列；
        // 命中一个**已收口**的同名块说明是跨段撞名（见上），照常入列不丢弃
        const existing = findAssistantBlock(result, event.messageId, String(event.sessionId));
        if (existing !== undefined && existing.data.streaming === true) {
          existing.data.text = event.text;
          existing.data.streaming = false;
        } else {
          result.push({
            id,
            kind: "assistant.message",
            at,
            data: { text: event.text, messageId: event.messageId, sessionId: String(event.sessionId), streaming: false },
          });
        }
        break;
      }

      case "tool.started":
        result.push({
          id,
          kind: "tool",
          at,
          data: {
            callId: event.callId,
            toolName: event.toolName,
            title: event.title,
            input: event.input,
            completed: false,
          },
        });
        break;

      case "tool.completed": {
        // 回溯匹配同 callId 的 started 记录
        const target = result.find(
          (r) => r.kind === "tool" && r.data.callId === event.callId && !r.data.completed,
        );
        if (target) {
          target.data.completed = true;
          target.data.ok = event.ok;
          target.data.output = event.output;
        } else {
          result.push({
            id,
            kind: "tool",
            at,
            data: {
              callId: event.callId,
              toolName: "工具执行",
              title: "",
              completed: true,
              ok: event.ok,
              output: event.output,
            },
          });
        }
        break;
      }

      case "permission.requested":
        result.push({ id, kind: "permission", at, data: event });
        break;

      case "subagent.spawned":
        result.push({ id, kind: "subagent.spawned", at, data: event });
        break;

      case "subagent.finished":
        result.push({ id, kind: "subagent.finished", at, data: event });
        break;

      case "file.diff":
        result.push({ id, kind: "file.diff", at, data: event });
        break;

      case "deliverable":
        result.push({ id, kind: "deliverable", at, data: event });
        break;

      case "usage": {
        // 用量并入同会话最近一条助手消息的底部 meta 行（右侧模型/token 信息，
        // 不再独立成行也不显示计费）。找不到可挂靠的助手块时保留独立行兜底。
        const target = findLastAssistantOf(result, String(event.sessionId));
        if (target !== undefined) {
          target.data.usage = {
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
        } else {
          result.push({ id, kind: "usage", at, data: event });
        }
        break;
      }

      case "error":
        result.push({ id, kind: "error", at, data: event });
        break;

      case "system.notice":
        result.push({ id, kind: "system.notice", at, data: event });
        break;

      default:
        break;
    }
  }

  return result;
}

/** 倒序找同（会话, messageId）的助手消息块（流式收口 / 增量归并用） */
function findAssistantBlock(
  result: GroupedItem[],
  messageId: string,
  sessionId: string,
): GroupedItem | undefined {
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i]!;
    if (
      r.kind === "assistant.message" &&
      r.data.messageId === messageId &&
      r.data.sessionId === sessionId
    ) {
      return r;
    }
  }
  return undefined;
}

/** 倒序找同会话最近一条助手消息块（usage 并入挂靠用） */
function findLastAssistantOf(result: GroupedItem[], sessionId: string): GroupedItem | undefined {
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i]!;
    if (r.kind === "assistant.message" && r.data.sessionId === sessionId) return r;
  }
  return undefined;
}

/**
 * 分叉拼接点行（ADR 0013）：父段只读前缀 → fork 出的新段，与执行器切换 divider 区分。
 * 带「回看原分支」入口（ZCode forkNotice 的 onNavigate 模式）—— 点击在聊天页
 * 打开父段自己的视图；本轮进行中会被 openSession 的 idle 门禁拦下（诚实提示）。
 */
function ForkPointRow({
  data,
}: {
  data: { from: string; to: string; forkKind: "branch" | "revision"; fromId?: string };
}) {
  const isRevision = data.forkKind === "revision";
  const openSession = useWorkbench((s) => s.openSession);
  const parent = useWorkbench((s) => (data.fromId !== undefined ? s.sessions.find((x) => String(x.id) === data.fromId) : undefined));

  const openParent = () => {
    if (parent === undefined || data.fromId === undefined) return;
    void openSession({
      sessionId: parent.id,
      unitId: parent.unitId,
      runtimeId: String(parent.runtimeId).replace(/^daemon:/, ""),
    });
  };
  const canOpenParent = parent !== undefined;

  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label={isRevision ? "已编辑重发" : "已从此处分叉"}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-caption text-graphite shadow-xs">
        <GitBranch size={11} className="text-teal" />
        {isRevision ? (
          <>
            已编辑重发 ·
            <span className="font-medium text-ink">{data.from}</span>
            <span className="text-ash">· 之前对话以只读前缀带入</span>
          </>
        ) : (
          <>
            已从此处分叉 ·
            <span className="font-medium text-ink">
              {data.from === data.to ? data.from : `${data.from} → ${data.to}`}
            </span>
            <span className="text-ash">· 上文以只读前缀带入</span>
          </>
        )}
        {canOpenParent && (
          <button
            onClick={openParent}
            title={`回看原分支（${data.from} 的完整对话；本轮进行中需先落定）`}
            className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            回看原分支
          </button>
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/* ------------------------------------------------------------- 非正文工作组 */

/**
 * 连续的 思考/工具调用 归并成一个可折叠「工作组」（对齐 ZCode turn 的
 * AssistantHistory 手风琴：完成后收起，只留一行摘要；正文始终是主角）。
 * permission / file.diff / deliverable 等需要用户看见的行不进组，原样穿插。
 */
type RenderUnit =
  | { kind: "item"; key: string; item: GroupedItem }
  | { kind: "work"; key: string; entries: GroupedItem[]; running: boolean };

function buildWorkRuns(items: readonly GroupedItem[]): RenderUnit[] {
  const out: RenderUnit[] = [];
  let buf: GroupedItem[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    out.push({
      kind: "work",
      key: `work-${buf[0]!.id}`,
      entries: buf,
      running: buf.some((e) => e.kind === "tool" && e.data?.completed !== true),
    });
    buf = [];
  };
  for (const it of items) {
    if (it.kind === "thinking" || it.kind === "tool") buf.push(it);
    else {
      flush();
      out.push({ kind: "item", key: String(it.id), item: it });
    }
  }
  flush();
  return out;
}

/** 工作组手风琴：跑动中自动展开、完成即收起（可手动展开回看每一步） */
function WorkGroupRow({
  entries,
  running,
  busy,
  lastUserTurnId,
}: {
  entries: GroupedItem[];
  running: boolean;
  busy: boolean;
  lastUserTurnId: string | number | undefined;
}) {
  const [open, setOpen] = useState(running);
  useEffect(() => {
    // 跑动 → 展开；收口 → 收起（ZCode 的 autoCollapseOnComplete 同款：
    // 完成的工作不值得占屏，摘要行足够）。手动展开已完成组不受影响 ——
    // running 翻转只发生在收口那一刻
    if (running) setOpen(true);
    else setOpen(false);
  }, [running]);

  const toolCount = entries.filter((e) => e.kind === "tool").length;
  const thinkCount = entries.filter((e) => e.kind === "thinking").length;
  const failed = entries.some((e) => e.kind === "tool" && e.data?.ok === false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-btn border-b border-line/50 pb-1.5 text-left text-caption transition",
          running ? "text-graphite" : "text-ash hover:text-graphite",
        )}
      >
        <Sparkles size={11} className={cn("shrink-0", running ? "animate-pulse text-teal" : failed ? "text-loss" : "text-ash")} />
        <span className={cn("shrink-0 font-medium", running && "text-teal")}>{running ? "工作中" : "已工作"}</span>
        <span className="min-w-0 truncate">
          {toolCount > 0 && `· ${toolCount} 次工具调用`}
          {thinkCount > 0 && ` · 思考 ${thinkCount} 段`}
          {failed && " · 有失败"}
        </span>
        <ChevronRight
          size={12}
          className={cn("ml-auto shrink-0 transition-transform", open ? "rotate-90" : "rotate-0")}
        />
      </button>
      {open && (
        <div className="ml-2 mt-2 space-y-2 border-l border-line pl-3">
          {entries.map((e) => (
            <TimelineItemRow key={e.id} item={e} busy={busy} lastUserTurnId={lastUserTurnId} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 行渲染 */

/** 段边界 divider 行：执行器切换点 + 上一段 readiness（从 sessions 台账读） */
function SegmentDividerRow({
  data,
}: {
  data: { from: string; to: string; fromId: string; toId: string };
}) {
  const fromSession = useWorkbench((s) => s.sessions.find((x) => String(x.id) === data.fromId));
  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label={`已切换执行器：${data.from} → ${data.to}`}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-caption text-graphite shadow-xs">
        已切换执行器 · {data.from} → <span className="font-medium text-ink">{data.to}</span>
        <span className="text-ash">· 上一段保留在上方</span>
        <SessionReadinessBadge live={fromSession?.live} resumable={fromSession?.resumable} />
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function parseSlashCommand(text: string): { isCommand: boolean; name: string; args: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\n")) {
    return { isCommand: false, name: "", args: "" };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { isCommand: true, name: trimmed.slice(1), args: "" };
  }
  return {
    isCommand: true,
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/**
 * 用户消息（编辑重发参考 ZCode UserInputRowView 的就地编辑）：
 * 末轮用户消息 hover 出铅笔入口 → 原位把气泡替换为编辑器（Enter 重发 /
 * Shift+Enter 换行 / Esc 取消）→ 重发 = revision 分叉（新段替换这一轮，
 * 原分支保留可回看）。不再提供「从此处分叉」——分叉入口在助手消息底部。
 */
function UserMessageBubble({
  text,
  attachments,
  messageId,
  sessionId,
  origin,
  isLatestUserTurn,
  busy,
}: {
  text: string;
  attachments?: readonly ChatAttachment[];
  /** daemon 侧真实 messageId（echo 回填后的 user-N；本地假 id 时编辑入口禁用） */
  messageId: string;
  /** 这条消息所属的段 —— revision 的 ofSessionId */
  sessionId: string;
  /** 消息来源（docs/23）："automation" = 定时任务到点代发 —— 气泡上方亮「定时」徽标 */
  origin?: string;
  /** 时间线最后一条用户消息：编辑重发只对它开放（latestQueryEditOnly） */
  isLatestUserTurn: boolean;
  busy: boolean;
}) {
  const parsed = parseSlashCommand(text);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(text);
  const editAndResend = useWorkbench((s) => s.editAndResend);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);

  const blocked =
    busy ||
    sourceStatus === "running" ||
    sourceStatus === "awaiting_permission" ||
    sourceStatus === "awaiting_input";
  // 本地合成气泡的假 messageId（u${seq}，echo 尚未回填）不能做账本锚点
  const anchorReady = /^user-\d+$/.test(messageId);
  const canEdit = isLatestUserTurn && !blocked && anchorReady;
  const disabledTitle = blocked ? "先让这一轮落定" : "锚点还没落进账本，稍等一下再试";

  const openEdit = () => {
    setEditDraft(text);
    setEditing(true);
  };

  const submitEdit = () => {
    const v = editDraft.trim();
    if (v === "") return;
    setEditing(false);
    void editAndResend({ ofSessionId: sessionId as never, anchorMessageId: messageId, text: v });
  };

  // ---- 编辑态：气泡原位替换为编辑器 ----
  if (editing) {
    return (
      <div className="flex w-full flex-col items-end">
        <div className="w-full max-w-full rounded-[16px] rounded-tr-[4px] border border-teal/40 bg-card px-3.5 py-2.5 shadow-xs focus-within:border-teal/60">
          <textarea
            autoFocus
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            rows={Math.min(10, Math.max(2, editDraft.split("\n").length))}
            className="w-full resize-none bg-transparent text-body leading-relaxed text-ink outline-none"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-caption text-ash">
              重发将在新分支替换这一轮（原分支保留可回看，附件与文件改动不回滚）
            </span>
            <button
              onClick={() => setEditing(false)}
              title="取消编辑（Esc）"
              className="flex shrink-0 cursor-pointer items-center rounded-btn border border-line p-1.5 text-graphite transition hover:bg-line-soft hover:text-ink"
            >
              <X size={12} />
            </button>
            <button
              onClick={submitEdit}
              disabled={editDraft.trim() === ""}
              title="重发（Enter）"
              className="flex shrink-0 cursor-pointer items-center rounded-btn bg-teal p-1.5 text-canvas transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const editEntry = isLatestUserTurn ? (
    <button
      onClick={openEdit}
      disabled={!canEdit}
      aria-label="编辑重发"
      title={canEdit ? "编辑这条消息并重新发送：在新分支里替换这一轮（原位编辑，不进输入框）" : disabledTitle}
      className="flex shrink-0 cursor-pointer items-center rounded-btn p-1 text-ash opacity-60 transition hover:bg-line-soft hover:text-ink group-hover/user:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PencilLine size={12} />
    </button>
  ) : null;

  if (parsed.isCommand) {
    return (
      <div className="group/user flex items-end justify-end gap-1.5">
        {editEntry}
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          {attachments && attachments.length > 0 && (
            <AttachmentsBar attachments={[...attachments]} readOnly />
          )}
          <div className="max-w-full rounded-[16px] rounded-tr-[4px] border border-line bg-card px-3.5 py-2.5 shadow-xs flex items-center gap-2.5">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[11px] font-bold leading-none">
              /
            </div>
            <span className="font-mono text-body font-bold text-ink">
              /{parsed.name}
            </span>
            {parsed.args ? (
              <span className="font-mono text-body-sm text-graphite rounded-md bg-line-soft/80 px-2 py-0.5 border border-line-soft max-w-[420px] truncate">
                {parsed.args}
              </span>
            ) : null}
            <span className="ml-1 font-mono text-[10px] text-graphite/70 border border-line-soft rounded px-1.5 py-px shrink-0">
              斜杠指令
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/user flex items-end justify-end gap-1.5">
      {editEntry}
      <div className="flex min-w-0 flex-col items-end gap-1.5">
        {/* 定时代发徽标（docs/23）：气泡上方一枚小 pill —— 这条不是用户亲手
            发的，是定时任务到点投进来的；字段随事件进账本，回放同样可见 */}
        {origin === "automation" && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-teal-tint px-1.5 py-px text-[9px] font-medium text-teal"
            title="定时任务到点代发（非用户手动发送）"
          >
            <CalendarClock size={9} />
            定时
          </span>
        )}
        {attachments && attachments.length > 0 && (
          <AttachmentsBar attachments={[...attachments]} readOnly />
        )}
        {text.trim() && (
          <div className="max-w-full rounded-[16px] rounded-tr-[4px] border border-line bg-card px-4 py-3 shadow-xs">
            <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{text}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 文件改动 chip —— 右键：复制路径 / 复制完整路径 / 资源管理器定位（父目录，
 * ZCode「文件→打开所在目录」语义，避免 explorer 直接用默认应用打开文件）/
 * 用 VS Code 打开。path 是执行器口径（多为相对 bot 根），相对时拼 rootPath。
 */
function FileDiffRow({ data }: { data: { path: string; additions: number; deletions: number } }) {
  const unit = useWorkbench(selectActiveUnit);
  const [menu, setMenu] = useState<QuickMenuState | null>(null);
  const rootPath = unit?.rootPath ?? "";
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(data.path) || data.path.startsWith("\\\\") || data.path.startsWith("/");
  const absPath =
    isAbsolute || !rootPath
      ? data.path
      : `${rootPath.replace(/[\\/]+$/, "")}/${data.path.replace(/^[\\/]+/, "")}`;
  const parentDir = absPath.replace(/[\\/][^\\/]*$/, "") || absPath;
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div
      onContextMenu={(e) =>
        setMenu(
          quickMenuFromEvent(e, [
            { label: "复制路径", icon: Copy, onSelect: () => copy(data.path) },
            ...(isAbsolute
              ? []
              : [{ label: "复制完整路径", icon: Copy, onSelect: () => copy(absPath) }]),
            { separator: true },
            {
              label: "在资源管理器中打开",
              icon: FolderOpen,
              onSelect: () => void openInEditor({ path: parentDir, editorId: "explorer" }),
            },
            {
              label: "用 VS Code 打开",
              icon: Code2,
              onSelect: () => void openInEditor({ path: absPath, editorId: "vscode" }),
            },
          ]),
        )
      }
      className="rounded-card bg-card px-4 py-3 shadow-subtle flex items-center gap-2 border border-line/60"
    >
      <FileDiff size={14} className="shrink-0 text-graphite" />
      <span className="truncate font-mono text-body-sm text-ink">{data.path}</span>
      <span className="tnum ml-auto shrink-0 font-mono text-caption">
        <span className="text-gain">+{data.additions}</span>{" "}
        <span className="text-loss">−{data.deletions}</span>
      </span>
      <QuickContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function TimelineItemRow({
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
      return (
        <div className="my-6 flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <span className="tnum shrink-0 text-caption text-ash">会话结束 · {item.data.reason}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );

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
        />
      );

    case "thinking":
      return <ThinkingBlock text={item.data.text} busy={busy} />;

    case "tool":
      return <ToolCallBlock data={item.data} />;

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
        <div className="rounded-card border-l-2 border-l-teal bg-card px-4 py-3 shadow-subtle flex items-center gap-2">
          <Package size={14} className="shrink-0 text-teal" />
          <p className="text-body-sm text-graphite">
            派生子代理 · 角色 <span className="font-medium text-ink">{item.data.role}</span> · 经由 {item.data.runtimeId}
          </p>
        </div>
      );

    case "subagent.finished":
      return (
        <div className="flex items-center gap-2 pl-1 text-body-sm text-graphite">
          <Check size={14} className="shrink-0 text-gain" />
          <span>子代理完成{item.data.summary ? ` · ${item.data.summary}` : ""}</span>
        </div>
      );

    case "file.diff":
      return <FileDiffRow data={item.data} />;

    case "deliverable":
      return (
        <div className="rounded-card bg-card px-4 py-3 shadow-subtle flex items-center gap-2 border border-teal/30">
          <Package size={14} className="shrink-0 text-teal" />
          <span className="text-body-sm font-medium text-ink">{item.data.title}</span>
          {item.data.path && (
            <span className="ml-auto shrink-0 font-mono text-caption text-ash">{item.data.path}</span>
          )}
        </div>
      );

    case "usage":
      // 兜底行：usage 通常已并入助手消息底部 meta；找不到挂靠点时才独立渲染
      //（不显示计费与 token 上下行 —— 用户明确不要，↑↓ 语义无人能读）
      return (
        <div className="flex items-center gap-2 pl-1 text-caption text-ash">
          <Wallet size={12} />
          <span className="font-mono">{item.data.model}</span>
        </div>
      );

    case "error":
      return (
        <div className="rounded-card border border-loss/30 bg-loss/5 px-4 py-3 text-body-sm text-loss">
          {item.data.message}
        </div>
      );

    case "system.notice":
      return <SystemNoticeRow event={item.data} at={item.at} />;

    default:
      return null;
  }
}

/* ------------------------------------------------------------- 系统通知卡片 */

function SystemNoticeRow({
  event,
  at,
}: {
  event: {
    title: string;
    text: string;
    level?: "info" | "success" | "warn";
    meta?: Readonly<Record<string, string>>;
  };
  at: number;
}) {
  const isSuccess = event.level === "success";
  const isWarn = event.level === "warn";

  return (
    <div
      className={cn(
        "rounded-card border p-3.5 shadow-xs transition animate-in fade-in slide-in-from-bottom-1 duration-150",
        isSuccess
          ? "border-teal/30 bg-teal-tint/20 text-ink"
          : isWarn
            ? "border-amber-500/30 bg-amber-500/10 text-ink"
            : "border-line bg-line-soft/80 text-ink",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold",
            isSuccess ? "bg-teal text-canvas" : isWarn ? "bg-amber-600 text-white" : "bg-ink text-canvas",
          )}
        >
          ⚡
        </div>
        <span className="font-semibold text-body-sm text-ink">{event.title}</span>
        <span className="ml-auto font-mono text-[10px] text-ash">
          {new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>

      <div className="mt-2 text-body-sm text-graphite whitespace-pre-wrap leading-relaxed font-normal">
        {event.text}
      </div>

      {event.meta && Object.keys(event.meta).length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-2 border-t border-line-soft">
          {Object.entries(event.meta).map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-0.5 text-[11px] font-mono text-graphite border border-line-soft"
            >
              <span className="text-ash">{k}:</span>
              <span className="font-medium text-ink">{v}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 思考过程折叠块 */

function ThinkingBlock({ text, busy }: { text: string; busy: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex items-center gap-2 rounded-btn px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
      >
        <Sparkles size={13} className={cn("text-teal", busy && "animate-pulse")} />
        <span className="font-medium">{busy ? "思考中…" : "深度思考"}</span>
        <span className="font-mono text-ash text-[11px]">({text.length} 字)</span>
        {expanded ? (
          <ChevronDown size={12} className="text-ash transition group-hover:text-ink" />
        ) : (
          <ChevronRight size={12} className="text-ash transition group-hover:text-ink" />
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 max-h-96 overflow-y-auto rounded-card border border-line-soft bg-rail/60 p-3.5 font-mono text-body-sm italic leading-relaxed text-graphite whitespace-pre-wrap shadow-inner">
          {text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 工具调用卡片 */

function ToolCallBlock({
  data,
}: {
  data: {
    callId: string;
    toolName: string;
    title?: string;
    input?: unknown;
    completed: boolean;
    ok?: boolean;
    output?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);

  const ToolIcon = getToolIcon(data.toolName);
  const brief = data.title || formatInputBrief(data.input);

  return (
    <div className="overflow-hidden rounded-input border border-line bg-card shadow-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-line-soft/50"
      >
        <ToolIcon size={13} className="shrink-0 text-teal" />
        <span className="font-mono text-body-sm font-medium text-ink">{data.toolName}</span>
        {brief && <span className="min-w-0 flex-1 truncate font-mono text-caption text-ash">{brief}</span>}

        <div className="ml-auto flex items-center gap-2">
          {data.completed ? (
            data.ok ? (
              <span className="flex items-center gap-1 text-[11px] text-gain">
                <Check size={12} />
                <span>完成</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-loss">
                <AlertTriangle size={12} />
                <span>失败</span>
              </span>
            )
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-teal">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
              <span>执行中</span>
            </span>
          )}

          {expanded ? <ChevronDown size={12} className="text-ash" /> : <ChevronRight size={12} className="text-ash" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line/60 bg-rail/40 px-3 py-2.5 text-caption font-mono space-y-2">
          {data.input !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1">输入参数</p>
              <pre className="max-h-40 overflow-auto rounded bg-card p-2 text-ink border border-line/50 leading-relaxed">
                <code>{typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2)}</code>
              </pre>
            </div>
          )}

          {data.output !== undefined && (
            <div>
              <p className="text-ash text-[10px] mb-1">执行输出</p>
              <pre className="max-h-60 overflow-auto rounded bg-card p-2 text-graphite border border-line/50 leading-relaxed whitespace-pre-wrap">
                <code>{data.output}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getToolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("terminal") || n.includes("bash") || n.includes("exec") || n.includes("command")) return Terminal;
  if (n.includes("file") || n.includes("read") || n.includes("write") || n.includes("edit")) return FileCode;
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return Search;
  return Wrench;
}

function formatInputBrief(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const target = obj.path ?? obj.CommandLine ?? obj.command ?? obj.Query ?? obj.TargetFile ?? obj.url;
    if (typeof target === "string") return target;
  }
  return "";
}

/* ------------------------------------------------------------- 助手回复消息块 */

/**
 * 助手消息块（布局参考 ZCode ConversationAssistantTextActions）：
 * 不带头像与名字 —— 「当前在跟谁说话」由页面语境与执行器切换 divider 交代，
 * 每条回复重复一遍只是噪音；流式脉冲点移到 meta 行时间旁。
 * 正文 markdown；**底部 meta 行**——
 * 左 = 时间 + 「从此处分叉」+ 复制全文（分叉锚点挂在这条回复上，branch=through 含本轮），
 * 右 = 执行器模型名（usage 并入；token 上下行已删 —— ↑↓ 语义无人能读，且不显示计费）。
 */
function AssistantMessageBlock({
  text,
  at,
  messageId,
  sessionId,
  streaming = false,
  usage,
  busy,
}: {
  text: string;
  at: number;
  /** daemon 侧的助手消息 id —— 分叉锚点（resolveForkAtSeq 按它定位轮边界） */
  messageId: string;
  sessionId: string;
  streaming?: boolean;
  /** 本轮用量（groupTimelineEvents 把 usage 事件并入这里；缺省不渲染右侧 meta） */
  usage?: { model: string; inputTokens: number; outputTokens: number };
  busy: boolean;
}) {
  const startFork = useWorkbench((s) => s.startFork);
  const sourceStatus = useWorkbench((s) => s.sessions.find((x) => String(x.id) === sessionId)?.status);
  const [copied, setCopied] = useState(false);

  // idle 门禁（ADR 0013 不变量 6）：本轮流式中 / 源段 running/awaiting_* 时禁止分叉
  const blocked =
    busy ||
    sourceStatus === "running" ||
    sourceStatus === "awaiting_permission" ||
    sourceStatus === "awaiting_input";
  const canFork = !streaming && !blocked && messageId !== "";

  const copyReply = (): void => {
    const finish = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(text).then(finish, () => {});
    } else {
      // 非安全上下文（http 源）兜底：execCommand 已废弃但仍是唯一通路
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      finish();
    }
  };

  return (
    <div className="group/msg py-1">
      {/* 正文 Markdown 渲染（流式态容错未闭合围栏、跳过高亮） */}
      <div>
        <MarkdownContent content={text} streaming={streaming} />

        {/* 底部 meta 行：左 = 流式点 + 时间 + 分叉 + 复制；右 = 执行器模型名 */}
        <div className="mt-2 flex items-center gap-2.5 text-caption text-ash">
          {streaming && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal" aria-label="生成中" />}
          <span className="tnum shrink-0">{clock(at)}</span>
          <button
            onClick={() => startFork({ ofSessionId: sessionId as never, anchorMessageId: messageId, kind: "branch" })}
            disabled={!canFork}
            aria-label="从此处分叉"
            title={
              streaming
                ? "这一轮还在生成，落定后可分叉"
                : blocked
                  ? "先让这一轮落定"
                  : messageId === ""
                    ? "这条回复没有可定位的锚点（老账本记录），无法分叉"
                    : "从此回复之后开启分叉：新段携带此前对话的只读前缀，当前分支保留可回看"
            }
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GitBranch size={12} />
          </button>
          <button
            onClick={copyReply}
            aria-label="复制这条回复"
            title={copied ? "已复制" : "复制这条回复全文"}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-btn p-1 text-ash transition hover:bg-line-soft hover:text-ink"
          >
            {copied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
          </button>
          {usage !== undefined && (
            <span className="ml-auto flex min-w-0 shrink-0 items-center font-mono" title={`本轮由 ${usage.model} 执行`}>
              <span className="truncate">{usage.model}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 辅助组件 */

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function SessionStartRow({
  event,
  at,
}: {
  event: Extract<RuntimeEvent, { type: "session.started" }>;
  at: number;
}) {
  const source = event.source ?? "workbench";
  const fromWorkbench = source === "workbench";
  return (
    <div className="my-6 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="h-px flex-1 bg-line" />
      <span className="tnum shrink-0 text-caption text-ash">会话开始 · {clock(at)}</span>
      {!fromWorkbench && (
        <span
          className="shrink-0 rounded-btn bg-teal-tint px-1.5 py-0.5 text-[10px] text-teal"
          title="这个会话是从这个渠道发起的，和工作台里的是同一段对话"
        >
          来自{SESSION_SOURCE_LABEL[source]}
        </span>
      )}
      {event.modelActual !== undefined && (
        <span className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 font-mono text-[10px] text-graphite" title="实际生效的模型">
          {event.modelActual}
        </span>
      )}
      {event.modelHintDropped !== undefined && (
        <span
          className="shrink-0 rounded-btn bg-line-soft px-1.5 py-0.5 text-[10px] text-graphite"
          title={`你配的默认模型 ${event.modelHintDropped} 这家执行器不接，已回落到执行器默认`}
        >
          配的 {event.modelHintDropped} 不可用，已回落
        </span>
      )}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function PermissionRow({
  requestId,
  detail,
  risk,
}: {
  requestId: string;
  detail: string;
  risk: "low" | "medium" | "high";
}) {
  const decision = useWorkbench((s) => s.permissionDecisions[requestId]);

  return (
    <div className="mb-2 flex items-center gap-2 rounded-btn bg-line-soft px-3 py-2 text-body-sm">
      {decision ? (
        decision === "deny" ? (
          <X size={12} className="shrink-0 text-loss" />
        ) : (
          <Check size={12} className="shrink-0 text-gain" />
        )
      ) : (
        <ShieldCheck size={12} className="shrink-0 animate-pulse text-teal" />
      )}
      <span className="min-w-0 flex-1 truncate text-graphite">{detail}</span>
      {risk === "high" && <span className="shrink-0 text-caption text-loss">高风险</span>}
      <span className={cn("shrink-0 text-caption", decision ? "text-ash" : "text-teal")}>
        {decision ? (DECISION_LABEL[decision] ?? decision) : "待裁决"}
      </span>
    </div>
  );
}

const DECISION_LABEL: Record<string, string> = {
  allow: "已允许一次",
  always: "已始终允许",
  deny: "已拒绝",
};

/* ------------------------------------------------------------- 空态 */

/**
 * 对话空态主角（头像 + 问候 + 交代任务提示）。由 WorkspaceShell 渲染为对话列
 * 上的绝对定位覆盖层（固定预留居中，与输入区高度解耦）—— 不再挂在 Timeline
 * 滚动区里，列宽变化导致的输入区换行/缩档不会再推着它跳。
 */
export function EmptyState() {
  const unit = useWorkbench(selectActiveUnit);
  const avatarFrame = useAppearance((s) => s.avatarFrame);

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? "夜深了" : hour < 9 ? "早上好" : hour < 12 ? "上午好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  const avatar = unit ? botAvatarStyle(unit.name, avatarFrame) : null;

  return (
    <div className="flex flex-col items-center">
      {unit && (
        /* 头像与 bot 设置里同一份：自定义头像优先，缺省回落设置页同款「浅底 + 首字」，
           外框形态跟随外观设置的「bot 头像框形态」 */
        unit.avatar ? (
          <img
            src={unit.avatar}
            alt=""
            className={cn("mb-3 h-14 w-14 object-cover shadow-subtle", avatar?.shape)}
          />
        ) : (
          <div
            className={cn(
              "mb-3 flex h-14 w-14 items-center justify-center bg-line-soft text-body-lg font-medium text-graphite shadow-subtle",
              avatar?.shape,
            )}
          >
            {unit.name.slice(0, 1)}
          </div>
        )
      )}
      <p className="text-caption text-ash">{greeting}</p>
      <p className="mt-1 text-body-lg font-medium text-ink">
        {!unit ? "选一个 bot 开始" : `向「${unit.name}」交代任务`}
      </p>
      <p className="mt-1 text-body-sm text-graphite">
        {!unit
          ? "新建一个 bot —— 指向已有文件夹即为认领（原地注册）"
          : unit.identity?.role
            ? `已装载岗位：${unit.identity.role} · 读 AGENTS.md`
            : "从对话或快捷任务开始"}
      </p>
    </div>
  );
}
