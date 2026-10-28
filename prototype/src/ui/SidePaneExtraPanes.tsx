/**
 * 右栏的「新建 bot」与「git 提交图」面板（2026-10-23 弹窗归拢）。
 * - NewBotPane：AddBotDialog 新建态的右栏宿主（编辑/设置早已由 BotSettingsPane 承载），
 *   创建成功即切到新 bot 并关页签；
 * - GitGraphPane：GitGraphDialog embedded 形态，自 BranchPicker 的弹窗归拢而来。
 */
import type { ReactElement } from "react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { NEW_BOT_TAB_ID, gitGraphTabId } from "../core/sidePaneTabs.ts";
import { asModelId, asRuntimeId, asUnitId, type UnitId } from "../core/units.ts";
import { configureSearch } from "../store/useSearch.ts";
import { AddBotDialog } from "./AddBotDialog.tsx";
import { GitGraphDialog } from "./gitGraph/GitGraphDialog.tsx";

export function NewBotPane(): ReactElement {
  const addUnit = useWorkbench((s) => s.addUnit);
  return (
    <AddBotDialog
      embedded
      open
      initial={null}
      onClose={() => useSidePane.getState().closeTab(NEW_BOT_TAB_ID)}
      onSubmit={async (draft) => {
        // 新建：等写盘结果再关页签（目录不存在 / daemon 没起都该让用户看见）。
        const id = asUnitId(`bot-${Date.now().toString(36)}`);
        await addUnit(
          {
            id,
            rootPath: draft.rootPath,
            name: draft.name,
            kind: "bot",
            resident: draft.resident ?? false,
            identity: {
              role: draft.role,
              sourcePath: "AGENTS.md",
              loadedAt: Date.now(),
            },
            // ADR 0014 D2：新建 bot 默认全关（Bare）——注入是显式决定
            contextManifest: { agentsMd: "auto" },
            soulMd: draft.persona || undefined,
            bindings: draft.runtimeId
              ? [
                  {
                    runtimeId: asRuntimeId(draft.runtimeId),
                    modelHint: draft.modelHint ? asModelId(draft.modelHint) : undefined,
                    primary: true,
                  },
                ]
              : [],
            assets: { agentFiles: ["AGENTS.md"], skillDirs: [] },
            agentsMd: draft.agentsMd,
            memory: draft.memory,
            channels: draft.channels,
            avatar: draft.avatar,
            themeAccent: draft.themeAccent,
            tags: ["新建"],
            lastActiveAt: Date.now(),
          },
          { createRoot: true },
        );
        // 搜索配置（bot 级、daemon 侧存储）：bot 落盘后写密钥槽。失败不回滚
        // bot 本体（它已经建好），错误由 AddBotDialog 的 catch 展示。
        if (draft.search !== undefined) {
          await configureSearch(
            id,
            draft.search.provider,
            draft.search.apiKey === "" ? undefined : draft.search.apiKey,
          );
        }
        // 建完即变身（2026-10-23 页面合并）：同一个右栏面板无缝切换成新 bot 的
        // 完整设置页——切 bot、关新建签、开它的 bot 设置签，一个连续流程
        useWorkbench.getState().selectUnit(id);
        useSidePane.getState().closeTab(NEW_BOT_TAB_ID);
        useSidePane.getState().openContext({ unitId: id, unitName: draft.name });
      }}
    />
  );
}

export function GitGraphPane({
  unitId,
  rootPath,
  branchName,
}: {
  unitId: UnitId;
  rootPath: string;
  branchName: string | null;
}): ReactElement {
  return (
    <GitGraphDialog
      embedded
      rootPath={rootPath}
      branchName={branchName}
      onClose={() => useSidePane.getState().closeTab(gitGraphTabId(unitId))}
    />
  );
}
