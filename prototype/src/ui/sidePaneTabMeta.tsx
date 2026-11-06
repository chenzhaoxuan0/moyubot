import type { ReactElement } from "react";
import { Bell, FileDiff, FolderGit2, GitGraph, History, Layers, ListChecks, Plus, Radio, type LucideIcon } from "lucide-react";
import type { SidePaneTab } from "../core/sidePaneTabs.ts";
import type { UnitId } from "../core/units.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import { HistoryPane } from "./HistoryPane.tsx";
import { LiveSessionPane } from "./LiveSessionPane.tsx";
import { PlanPane } from "./PlanPane.tsx";
import { DiffPane } from "./DiffPane.tsx";
import { NotificationsPane } from "./NotificationsPane.tsx";
import { BotSettingsPane } from "./BotSettingsPane.tsx";
import { NewBotPane, GitGraphPane } from "./SidePaneExtraPanes.tsx";
import { SourceControlPage } from "./SourceControlPage.tsx";

/**
 * 侧栏 tab 的 UI 注册表 —— 图标 / 标题 / 内容渲染 / 功能主页入口的唯一登记处。
 *
 * 契约（类型、id 规则、开关节奏域语义）在 core/sidePaneTabs.ts，保持不碰
 * React；本文件是「加一种 tab 要改的 UI 面」的收敛点：此前图标、标题、渲染
 * 分散在 SidePanePanel 的三处 switch，新增类型要改两处文件四处代码，注册表
 * 化之后一处登记、容器无感。容器仍保留自己的职责（tab 条交互、保活挂载、
 * 开合），这里只提供「长什么样、叫什么、渲染什么」。
 */

export interface SidePaneTabRenderCtx {
  /** 面板可见且本 tab 激活（保活协议的开关） */
  readonly shown: boolean;
  readonly closeTab: (tabId: string) => void;
  /** 关闭回调的稳定包装（memo 组件防击穿用） */
  readonly onFinished: () => void;
}

export interface SidePaneTabMetaEntry {
  readonly type: SidePaneTab["type"];
  readonly icon: LucideIcon;
  readonly title: (tab: SidePaneTab) => string;
  readonly render: (tab: SidePaneTab, ctx: SidePaneTabRenderCtx) => ReactElement | null;
}

const entries: readonly SidePaneTabMetaEntry[] = [
  {
    type: "history",
    icon: History,
    title: (tab) => (tab.type === "history" ? `${tab.unitName} · 历史` : ""),
    render: (tab, ctx) =>
      tab.type === "history" ? (
        <HistoryPane
          unitId={String(tab.ownerUnitId)}
          unitName={tab.unitName}
          focusKey={tab.focusKey}
          isActive={ctx.shown}
          onFinished={ctx.onFinished}
        />
      ) : null,
  },
  {
    type: "live",
    icon: Radio,
    title: (tab) => (tab.type === "live" && tab.title !== "" ? tab.title : "会话监控"),
    render: (tab, ctx) =>
      tab.type === "live" ? (
        <LiveSessionPane sessionId={tab.sessionId} runtimeId={tab.runtimeId} title={tab.title} shown={ctx.shown} />
      ) : null,
  },
  {
    type: "plan",
    icon: ListChecks,
    title: (tab) => (tab.type === "plan" ? `${tab.unitName} · 计划` : ""),
    render: (tab, ctx) => (tab.type === "plan" ? <PlanPane unitId={tab.ownerUnitId} shown={ctx.shown} /> : null),
  },
  {
    type: "diff",
    icon: FileDiff,
    title: (tab) => (tab.type === "diff" ? `${tab.unitName} · 变更` : ""),
    render: (tab, ctx) => (tab.type === "diff" ? <DiffTabBody unitId={tab.ownerUnitId} shown={ctx.shown} /> : null),
  },
  {
    type: "context",
    icon: Layers,
    // 设置面归拢（2026-10-23）：原「Context 面板」升级为「bot 设置」——身份/上下文/
    // 技能/渠道/导入的完整设置都在这（AddBotDialog embedded 形态），tab id 仍是
    // context:*，原有入口（徽标/右键/胶囊「编辑各文件」）全部自然落进来
    title: (tab) => (tab.type === "context" ? `${tab.unitName} · 设置` : ""),
    render: (tab) => (tab.type === "context" ? <BotSettingsPane unitId={tab.ownerUnitId} /> : null),
  },
  {
    // 新建 bot（2026-10-23 归拢自弹窗）：workspace 级单例，创建成功切新 bot 并关签
    type: "newbot",
    icon: Plus,
    title: () => "新建 bot",
    render: () => <NewBotPane />,
  },
  {
    // git 提交图（2026-10-23 归拢自 GitGraphDialog 弹窗）：按 bot 一个
    type: "gitgraph",
    icon: GitGraph,
    title: (tab) => (tab.type === "gitgraph" ? `${tab.unitName} · 提交图` : ""),
    render: (tab) =>
      tab.type === "gitgraph" ? <GitGraphPane unitId={tab.ownerUnitId} rootPath={tab.rootPath} branchName={tab.branchName} /> : null,
  },  {
    type: "notify",
    icon: Bell,
    title: () => "通知",
    render: (_tab, ctx) => <NotificationsPane shown={ctx.shown} />,
  },
  {
    // 源代码管理（2026-11-06 归拢自主视图）：workspace 级单例，内容跟随激活单元
    type: "scm",
    icon: FolderGit2,
    title: () => "源代码管理",
    render: (_tab, ctx) => <SourceControlPage shown={ctx.shown} />,
  },
];

export const SIDE_PANE_TAB_META: Readonly<Record<SidePaneTab["type"], SidePaneTabMetaEntry>> = Object.fromEntries(
  entries.map((e) => [e.type, e]),
) as Readonly<Record<SidePaneTab["type"], SidePaneTabMetaEntry>>;

/** diff tab 的宿主：rootPath 从 units 现查（bot 改目录后 tab 跟着走），
 *  bot 被注销时给出空态而不是白屏 */
function DiffTabBody({ unitId, shown }: { unitId: UnitId; shown: boolean }): ReactElement {
  const rootPath = useWorkbench((s) => s.units.find((u) => String(u.id) === String(unitId))?.rootPath);
  if (rootPath === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-caption text-ash">
        这个 bot 已经不在了（目录或定义被移除），变更审查无从挂载
      </div>
    );
  }
  return <DiffPane rootPath={rootPath} unitId={unitId} shown={shown} />;
}

/* --------------------------------------------------------- 功能主页入口清单 */

/** 实时监控的默认目标（SidePaneHome 解析后传入） */
export interface SidePaneLiveTarget {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly title: string;
  readonly running: boolean;
}

export interface SidePaneHomeEntryDef {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly icon: LucideIcon;
  /** 伴随视角跟 bot（无激活 bot 不渲染）；工作区入口不跟 */
  readonly group: "companion" | "workspace";
  /** 监控入口：无目标时禁用（目标解析在 SidePaneHome，这里只消费） */
  readonly requiresLiveTarget?: boolean;
  readonly open: (args: {
    unitId: UnitId | null;
    unitName: string;
    liveTarget: SidePaneLiveTarget | null;
  }) => void;
}

export const SIDE_PANE_HOME_ENTRIES: readonly SidePaneHomeEntryDef[] = [
  {
    key: "live",
    label: "会话实时监控",
    desc: "跟随一个在跑（或最近）的后台会话看它正在干什么",
    icon: Radio,
    group: "companion",
    requiresLiveTarget: true,
    open: ({ unitId, liveTarget }) => {
      if (unitId === null || liveTarget === null) return;
      useSidePane.getState().openLiveSession({
        unitId,
        sessionId: liveTarget.sessionId,
        runtimeId: liveTarget.runtimeId,
        title: liveTarget.title,
      });
    },
  },
  {
    key: "plan",
    label: "计划 / 任务进度",
    desc: "活跃会话的步骤清单，边干活边看进度",
    icon: ListChecks,
    group: "companion",
    open: ({ unitId, unitName }) => {
      if (unitId === null) return;
      useSidePane.getState().openPlan({ unitId, unitName });
    },
  },
  {
    key: "diff",
    label: "变更审查",
    desc: "工作目录的改动与 diff，对话在左、改动在右",
    icon: FileDiff,
    group: "companion",
    open: ({ unitId, unitName }) => {
      if (unitId === null) return;
      useSidePane.getState().openDiff({ unitId, unitName });
    },
  },
  {
    key: "context",
    label: "bot 设置",
    desc: "身份 / 上下文注入 / 工作区技能 / 渠道——bot 的完整设置（归拢自原上下文清单与 bot 设置弹窗）",
    icon: Layers,
    group: "companion",
    open: ({ unitId, unitName }) => {
      if (unitId === null) return;
      useSidePane.getState().openContext({ unitId, unitName });
    },
  },
  {
    key: "gitgraph",
    label: "git 提交图",
    desc: "分支 · 标签 · 远端的可见历史图（归拢自原提交图弹窗）",
    icon: GitGraph,
    group: "companion",
    open: ({ unitId, unitName }) => {
      if (unitId === null) return;
      const u = useWorkbench.getState().units.find((x) => String(x.id) === String(unitId));
      if (u === undefined) return;
      useSidePane.getState().openGitGraph({ unitId, unitName, rootPath: u.rootPath, branchName: null });
    },
  },
  {
    key: "newbot",
    label: "新建 bot",
    desc: "指一个文件夹认领/新建一个 bot（归拢自原弹窗，创建成功即上岗）",
    icon: Plus,
    group: "workspace",
    open: () => useSidePane.getState().openNewBot(),
  },
  {
    key: "scm",
    label: "源代码管理",
    desc: "激活单元仓库的分支 / 工作树 / 改动总管（归拢自左侧栏主视图入口）",
    icon: FolderGit2,
    group: "workspace",
    open: () => useSidePane.getState().openSourceControl(),
  },
  {
    key: "notify",
    label: "通知中心",
    desc: "后台会话终态、审批请求、系统通知与仓库变更",
    icon: Bell,
    group: "workspace",
    open: () => useSidePane.getState().openNotifications(),
  },
];
