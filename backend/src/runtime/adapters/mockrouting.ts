/**
 * mockrouting 适配器 —— 清单分类成功链路的真实试金石。
 *
 * 冒烟把分类器指到不存在的执行器只能验收「优雅失败」；成功路径（决策落库、
 * 沉淀任务、链接回填、hints 优先、无效分类/bot 回落）此前零覆盖。本适配器
 * 吃分类 prompt（含 `#id:N 原文` 行），按关键词脚本化地产出 JSON 决策数组 ——
 * 不烧任何真实额度，行为对冒烟完全确定：
 *
 * - 文本含「想法」 → idea 归档（无 task）
 * - 文本含「坏分类」 → 故意给无效分类 id + task（验收回落 todo + 理由注明）
 * - 文本含「坏bot」 → task 建议 nonexistent-bot（验收未知 bot 回落）
 * - 其余 → todo + task（hints 优先由 applyDecision 强制，mock 不掺和）
 */

import { randomUUID } from "node:crypto";
import {
  type AdapterSession,
  type AdapterSink,
  type ExecutorAdapter,
  type ExecutorModelInfo,
  type StartRequest,
} from "./types.ts";
import type { ModelId, ProbeResult, RuntimeCapabilities, SessionId } from "../../contract.ts";

interface MockSession {
  readonly sessionId: SessionId;
  sink: AdapterSink | null;
  turnCount: number;
}

export class MockRoutingAdapter implements ExecutorAdapter {
  readonly id = "mockrouting";
  readonly displayName = "MockRouting";
  readonly glyph = "R";
  /** 不是真执行器。界面照实标出来，别让人以为是个没听说过的厂商 CLI。 */
  readonly testOnly = true;
  readonly models: readonly ExecutorModelInfo[] = [{ id: "mock-1" as ModelId, displayName: "Mock-1" }];
  readonly capabilities: RuntimeCapabilities = {
    resumeSession: false,
    fileDiff: false,
    terminal: false,
    permissions: false,
    subagents: false,
    worktrees: false,
    sandbox: false,
    mcp: false,
    usage: true,
    multimodal: false,
    streaming: "realtime",
    steering: "turn-end",
  };

  private readonly sessions = new Map<string, MockSession>();

  async probe(): Promise<ProbeResult> {
    return { state: { status: "ready", version: "mock-1" }, capabilities: this.capabilities, elapsedMs: 0 };
  }

  async start(req: StartRequest, sink: AdapterSink): Promise<AdapterSession> {
    const state: MockSession = { sessionId: `sess_${randomUUID()}` as SessionId, sink, turnCount: 0 };
    this.sessions.set(state.sessionId, state);
    return this.makeSession(state);
  }

  reattach(sessionId: SessionId, _ref: string, _rootPath: string, sink: AdapterSink): AdapterSession {
    const state: MockSession = { sessionId, sink, turnCount: 0 };
    this.sessions.set(state.sessionId, state);
    return this.makeSession(state);
  }

  async disconnect(): Promise<void> {
    this.sessions.clear();
  }

  private makeSession(state: MockSession): AdapterSession {
    return {
      id: state.sessionId,
      send: async (text: string) => {
        await this.runTurn(state, text);
      },
      cancel: async () => {},
      // capabilities.permissions=false：本适配器不产生权限请求，占位满足接口
      resolvePermission: async () => {},
      externalRef: () => `mockrouting:${state.sessionId}`,
    };
  }

  /** 一轮 = 解析条目行 → 脚本化决策 → JSON 消息 → 用量 → 结束（一次性语义） */
  private async runTurn(state: MockSession, text: string): Promise<void> {
    const sink = state.sink;
    if (sink === null) return;
    state.turnCount += 1;
    const sessionId = state.sessionId;
    const decisions: Array<Record<string, unknown>> = [];
    const re = /^#id:(\d+)\s+(.+)$/gm;
    for (const m of text.matchAll(re)) {
      const id = Number(m[1]);
      const t = m[2]!.trim();
      if (t.includes("想法")) {
        decisions.push({ id, category: "idea", title: "想法条目", reason: "mockrouting：想法归档" });
      } else if (t.includes("坏分类")) {
        decisions.push({
          id, category: "bogus-category", title: "坏分类", reason: "mockrouting：故意给无效分类",
          task: { goal: "坏分类条目的目标", prompt: "", title: "", unitId: "", runtimeId: "", model: null },
        });
      } else if (t.includes("坏bot")) {
        decisions.push({
          id, category: "todo", title: "坏bot", reason: "mockrouting：故意建议不存在的bot",
          task: { goal: "坏bot条目的目标", prompt: "", title: "", unitId: "nonexistent-bot", runtimeId: "", model: null },
        });
      } else {
        const brief = t.slice(0, 20);
        decisions.push({
          id, category: "todo", title: "默认待办", reason: "mockrouting：默认沉淀任务",
          task: { goal: `目标：${brief}`, prompt: `执行：${brief}`, title: "", unitId: "", runtimeId: "", model: null },
        });
      }
    }
    sink({ type: "message.completed", sessionId, messageId: `msg_${state.turnCount}`, text: JSON.stringify(decisions) });
    sink({
      type: "usage",
      sessionId,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      model: "mock-1",
      requestId: `mockrouting:${sessionId}:p${process.pid}:${state.turnCount}`,
    });
    sink({ type: "session.ended", sessionId, reason: "completed" });
  }
}
