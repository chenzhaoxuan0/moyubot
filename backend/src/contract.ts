/**
 * 契约类型引入 —— 唯一事实源是 prototype/src/core/，这里只 re-export，绝不复制。
 *
 * import type 编译后完全消失：daemon 运行时不依赖前端目录，
 * 但 typecheck 会跟着前端源码走 —— events.ts 改了而 daemon 没跟上，
 * 这里的类型位立刻红（`docs/06` 契约变更纪律的机械保障）。
 *
 * Phase 1 需要adapter 侧类型（StartSessionRequest / RuntimeAdapter…）时
 * 从 ../../prototype/src/core/adapter.ts 照同样口径追加。
 */

export type {
  PlanStep,
  PlanStepStatus,
  RuntimeEvent,
  RuntimeEventType,
  TraceRecord,
} from "../../prototype/src/core/events.ts";

export type {
  ConnectionState,
  NativeCommandInfo,
  ProbeResult,
  RuntimeCapabilities,
  TransportDescriptor,
  TransportKind,
} from "../../prototype/src/core/adapter.ts";
export { FULL_CAPABILITIES } from "../../prototype/src/core/adapter.ts";

export type {
  ContextManifest,
  ModelId,
  RuntimeId,
  Session,
  SessionId,
  SessionStatus,
  SkillBinding,
  TurnContextConfig,
  TurnContextOverrideMode,
  UnitId,
  WorkUnit,
} from "../../prototype/src/core/units.ts";
export {
  asModelId,
  asSessionId,
  asUnitId,
  LEGACY_CONTEXT_MANIFEST,
  normalizeContextManifest,
  normalizeSkillBinding,
  resolveAgentsMdInjection,
  resolveEffectiveTurnManifest,
} from "../../prototype/src/core/units.ts";

export type {
  SkillEntryInfo,
  SkillReaderRef,
  SkillSourceGroupInfo,
  SkillsInventory,
} from "../../prototype/src/core/skills.ts";

export type {
  McpCopyOutcome,
  McpFileStatus,
  McpInventory,
  McpMutationResult,
  McpServerEntry,
  McpServerInstance,
  McpServerRow,
  McpTransport,
  McpUnsupportedExecutor,
} from "../../prototype/src/core/mcp.ts";

export type {
  AcpMcpServer,
  BrowserChannel,
  BrowserControlConfig,
  BrowserControlMode,
  BrowserControlState,
  ComputerControlConfig,
  ComputerControlState,
  ComputerLeaseInfo,
  ControlActionEntry,
  ControlFanoutOutcome,
  SharedChromeStatus,
} from "../../prototype/src/core/control.ts";

export type {
  SearchBotStatus,
  SearchOverview,
  SearchProviderId,
  SearchProviderInfo,
  SearchQuotaSnapshot,
} from "../../prototype/src/core/search.ts";

export type {
  GitBranchInfo,
  GitBranchesResult,
  GitChangeEntry,
  GitChangesResult,
  GitCommitResult,
  GitDiffResult,
  GitGraphCommit,
  GitGraphRef,
  GitGraphResult,
  GitIdentity,
  GitPushResult,
  GitStatus,
  GitStatusResult,
  GitWorktree,
} from "../../prototype/src/core/git.ts";

/** git.* 的稳定错误码词表（ADR 0008）：daemon 产生、前端按码走确认流 */
export { GIT_ERROR_CODES } from "../../prototype/src/core/git.ts";

export type {
  ActiveMention,
  WorkspacePathKind,
  WorkspacePathSuggestion,
  WorkspacePathsResult,
} from "../../prototype/src/core/workspacePaths.ts";

import { isShellTool as coreIsShellTool } from "../../prototype/src/core/events.ts";

/**
 * bash-output 归一化判定 —— 契约约定 daemon 侧分类用同一口径（`docs/06` §五），
 * 直接引 core 的实现，不复制第二份白名单。
 */
export const isShellTool = coreIsShellTool;
