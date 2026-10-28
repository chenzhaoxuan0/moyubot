import type { RuntimeEvent } from "../../core/events.ts";

export type GroupedItemKind =
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
  | "fork.point"
  | "context.injection";

export interface GroupedItem {
  readonly id: string | number;
  readonly kind: GroupedItemKind;
  readonly at: number;
  readonly data: any;
}

export type RenderUnit =
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: GroupedItem;
      /** true = 未落定轮的中间正文：按过程语境渲染（无 meta 行，Codex 逻辑） */
      readonly itemIsProcess?: boolean;
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly entries: readonly GroupedItem[];
      readonly running: boolean;
    };

export interface ToolExecutionData {
  readonly callId: string;
  readonly toolName: string;
  readonly title?: string;
  readonly input?: unknown;
  readonly completed: boolean;
  readonly ok?: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly cwd?: string;
}

export interface TurnNavAnchor {
  readonly turnIndex: number;
  readonly userMessageId: string;
  readonly queryPreview: string;
  /** 用户提问完整文本（供悬停大纲多行卡片展示） */
  readonly queryText?: string;
  /** 该轮助手的回复摘要或工具执行总结（供悬停大纲预览） */
  readonly assistantSummary?: string;
  /** 该轮调用的工具总数 */
  readonly toolCount?: number;
  readonly at: number;
  readonly itemIndex?: number;
}
