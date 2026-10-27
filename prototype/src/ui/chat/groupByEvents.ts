import type { RuntimeEvent } from "../../core/events.ts";
import type { GroupedItem, RenderUnit, ToolExecutionData } from "./types.ts";

/**
 * 倒序找同（会话, messageId）的助手消息块（流式收口 / 增量归并用）
 */
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
 * 事件流归并处理：合并流式连续思考片段，配对工具调用，合成段边界与分叉点
 */
export function groupTimelineEvents(
  events: readonly { id: number | string; event: RuntimeEvent; at: number }[],
  sessionNameOf?: (sessionId: string) => string | undefined,
  sessionOf?: (sessionId: string) => { forkOf?: string; forkKind?: "branch" | "revision" } | undefined,
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let prevSessionId: string | null = null;
  let currentTurnStartedAt: number | undefined;

  for (const entry of events) {
    const { id, event, at } = entry;

    // 段边界：已知段 → 另一已知段（渲染层合成，不入账本）。
    // 分叉拼接点优先于执行器 divider（ADR 0013）：新段是旧段的 fork 子段时，
    // 边界语义是「从此处分叉」，同执行器分叉也不会误显示成「已切换执行器」。
    if ("sessionId" in event && sessionNameOf !== undefined) {
      const sid = String(event.sessionId);
      if (
        prevSessionId !== null &&
        sid !== prevSessionId &&
        sessionNameOf(sid) !== undefined &&
        sessionNameOf(prevSessionId) !== undefined
      ) {
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
            data: {
              from: sessionNameOf(prevSessionId)!,
              to: sessionNameOf(sid)!,
              fromId: prevSessionId,
              toId: sid,
            },
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
          currentTurnStartedAt = at;
          result.push({
            id,
            kind: "user.message",
            at,
            data: {
              text: event.text,
              attachments: event.attachments,
              origin: event.origin,
              messageId: event.messageId,
              sessionId: String(event.sessionId),
            },
          });
          break;
        }
        if (event.role === "assistant") {
          const existing = findAssistantBlock(result, event.messageId, String(event.sessionId));
          if (existing !== undefined && existing.data.streaming === true) {
            existing.data.text += event.text;
          } else {
            result.push({
              id,
              kind: "assistant.message",
              at,
              data: {
                text: event.text,
                messageId: event.messageId,
                sessionId: String(event.sessionId),
                streaming: true,
                turnStartedAt: currentTurnStartedAt,
              },
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

      case "turn.started": {
        currentTurnStartedAt = at;
        break;
      }

      case "message.completed": {
        if ((event as any).role === "user") {
          break;
        }
        const existing = findAssistantBlock(result, event.messageId, String(event.sessionId));
        if (existing !== undefined && existing.data.streaming === true) {
          existing.data.text = event.text;
          existing.data.streaming = false;
          existing.data.completedAt = at;
          if (existing.data.turnStartedAt && at >= existing.data.turnStartedAt) {
            const diff = at - existing.data.turnStartedAt;
            if (diff > 0) {
              existing.data.durationMs = diff;
            }
          }
        } else {
          let durationMs: number | undefined = undefined;
          if (currentTurnStartedAt && at >= currentTurnStartedAt) {
            const diff = at - currentTurnStartedAt;
            if (diff > 0) {
              durationMs = diff;
            }
          }
          result.push({
            id,
            kind: "assistant.message",
            at,
            data: {
              text: event.text,
              messageId: event.messageId,
              sessionId: String(event.sessionId),
              streaming: false,
              turnStartedAt: currentTurnStartedAt,
              completedAt: at,
              durationMs,
            },
          });
        }
        // 这一轮已结束，重置开始时间，防止下一轮或历史消息误用几小时前的时间戳
        currentTurnStartedAt = undefined;
        break;
      }

      case "tool.started": {
        const toolData: ToolExecutionData = {
          callId: event.callId,
          toolName: event.toolName,
          title: event.title,
          input: event.input,
          completed: false,
          startedAt: at,
        };
        result.push({
          id,
          kind: "tool",
          at,
          data: toolData,
        });
        break;
      }

      case "tool.completed": {
        const target = result.find(
          (r) => r.kind === "tool" && r.data.callId === event.callId && !r.data.completed,
        );
        if (target) {
          const startedAt = target.data.startedAt;
          target.data.completed = true;
          target.data.ok = event.ok;
          target.data.output = event.output;
          target.data.error = event.ok === false ? event.output : undefined;
          if (startedAt) {
            target.data.durationMs = Math.max(0, at - startedAt);
          }
        } else {
          const toolData: ToolExecutionData = {
            callId: event.callId,
            toolName: "工具执行",
            title: "",
            completed: true,
            ok: event.ok,
            output: event.output,
            error: event.ok === false ? event.output : undefined,
          };
          result.push({
            id,
            kind: "tool",
            at,
            data: toolData,
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

      default: {
        // 支持 ADR 0014 上下文注入事件
        const anyEvt = event as any;
        if (anyEvt.type === "context.injected" || anyEvt.type === "context.injection") {
          result.push({ id, kind: "context.injection", at, data: anyEvt });
        }
        break;
      }
    }
  }

  // 会话已终结时收口仍挂着 streaming 的历史助手消息块，
  // 彻底阻断历史会话回放时因 streaming=true 导致按 Date.now() 跑出几万秒/几百分钟的失真 Bug
  const endedSessionIds = new Set<string>();
  for (const entry of events) {
    if (entry.event.type === "session.ended" && "sessionId" in entry.event) {
      endedSessionIds.add(String(entry.event.sessionId));
    }
  }
  if (endedSessionIds.size > 0) {
    for (const r of result) {
      if (r.kind === "assistant.message" && r.data.streaming === true && endedSessionIds.has(r.data.sessionId)) {
        r.data.streaming = false;
      }
    }
  }

  return result;
}

/** 可收进折叠组的「过程」条目：思考、工具、中间正文、子代理、文件产物 */
const FOLDABLE_KINDS = new Set([
  "thinking",
  "tool",
  "assistant.message",
  "file.diff",
  "deliverable",
  "subagent.spawned",
  "subagent.finished",
]);

/**
 * 轮级「过程」归并（借鉴 ZCode AssistantHistory 的折叠设计）：
 * 一轮 = 用户消息 → …过程… → 最终正文。最终正文 = 轮内最后一条已完成的
 * assistant 消息（usage 已并入它）；它之前的所有过程条目（含中间正文）收进
 * 一个默认折叠的工作组，最终正文独立渲染在折叠组之下 —— 用户一眼看到清晰
 * 回复，按需展开执行过程。
 *
 * 未落定的轮（末条是运行中工具或流式正文）不折叠中间正文：正被阅读的文本
 * 不该在流式过程中突然缩进组里，轮落定后的下一次重建再收口（ZCode 的
 * auto-collapse-on-settle 同款语义，只是 ours 无动画、直接收）。
 * 权限裁决 / 错误 / 系统通知 / 段边界永远留在折叠组外——待决与失败不可藏。
 */
export function buildWorkRuns(items: readonly GroupedItem[]): RenderUnit[] {
  const out: RenderUnit[] = [];
  let buf: GroupedItem[] = [];

  const flush = (): void => {
    if (buf.length === 0) return;
    out.push({
      kind: "work",
      key: `work-${buf[0]!.id}`,
      entries: [...buf],
      running: buf.some((e) => e.kind === "tool" && e.data?.completed !== true),
    });
    buf = [];
  };
  const emitItem = (it: GroupedItem): void => {
    flush();
    out.push({ kind: "item", key: String(it.id), item: it });
  };
  const emitFoldable = (it: GroupedItem): void => {
    if (FOLDABLE_KINDS.has(it.kind)) buf.push(it);
    else emitItem(it);
  };
  /** 未落定轮 / 轮外前缀的保守口径：只折叠思考与工具链（旧语义），
   * 中间正文保持可见——正被阅读的文本不进折叠组 */
  const emitChainFoldable = (it: GroupedItem): void => {
    if (it.kind === "thinking" || it.kind === "tool") buf.push(it);
    else emitItem(it);
  };

  // 轮缓冲：用户消息开启，段/会话边界关闭；null = 轮外（无轮上下文）
  let turn: GroupedItem[] | null = null;

  const flushTurn = (): void => {
    if (turn === null) return;
    const last = turn[turn.length - 1];
    const settled = last !== undefined && last.kind === "assistant.message" && last.data.streaming !== true;
    if (settled) {
      // 轮末正是完成态正文：它之前的全部过程（含中间正文）折叠，正文独立在下
      let lastAssistant = 0;
      for (let i = turn.length - 1; i >= 0; i--) {
        if (turn[i]!.kind === "assistant.message") {
          lastAssistant = i;
          break;
        }
      }
      for (const e of turn.slice(0, lastAssistant)) emitFoldable(e);
      flush();
      for (const e of turn.slice(lastAssistant)) emitItem(e);
    } else {
      // 轮还在跑（或没有正文收口）：中间正文保持可见，只折叠思考/工具链，
      // 轮落定后的下一次重建再整体收口
      for (const e of turn) emitChainFoldable(e);
      flush();
    }
    turn = null;
  };

  for (const it of items) {
    if (it.kind === "user.message") {
      flushTurn();
      emitItem(it);
      turn = [];
      continue;
    }
    if (it.kind === "segment.divider" || it.kind === "fork.point" || it.kind === "session.start" || it.kind === "session.end") {
      flushTurn();
      emitItem(it);
      continue;
    }
    if (turn === null) {
      // 轮外前缀（谱系段从中段回放、无用户消息开头）：退回链式折叠语义，
      // 思考/工具链照样归组，不能因为缺轮锚点就整段平铺
      emitChainFoldable(it);
      continue;
    }
    turn.push(it);
  }
  flushTurn();
  flush();
  return out;
}
