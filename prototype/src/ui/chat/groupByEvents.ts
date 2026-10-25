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

      case "message.completed": {
        const existing = findAssistantBlock(result, event.messageId, String(event.sessionId));
        if (existing !== undefined && existing.data.streaming === true) {
          existing.data.text = event.text;
          existing.data.streaming = false;
        } else {
          result.push({
            id,
            kind: "assistant.message",
            at,
            data: {
              text: event.text,
              messageId: event.messageId,
              sessionId: String(event.sessionId),
              streaming: false,
            },
          });
        }
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

  return result;
}

/**
 * 连续的 思考/工具调用 归并成一个可折叠「工作组」（对齐 ZCode AssistantHistory）
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

  for (const it of items) {
    if (it.kind === "thinking" || it.kind === "tool") {
      buf.push(it);
    } else {
      flush();
      out.push({ kind: "item", key: String(it.id), item: it });
    }
  }
  flush();
  return out;
}
