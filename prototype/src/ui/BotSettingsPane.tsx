/**
 * 右栏「bot 设置」面板（2026-10-23 设置面归拢）。
 *
 * 归拢后的格局：设置页「上下文清单」分区不动（随时可用的全局入口）；bot 设置
 * （原 AddBotDialog 编辑弹窗）、右栏原 Context 面板、胶囊的「编辑各文件」入口
 * 三者合并到这一个 tab——AddBotDialog 以 embedded 形态承载完整设置
 * （身份 / 上下文与文件 / 工作区技能 / 渠道 / 导入会话），保存后不关面板
 * （分区之间连续编辑）。
 */
import type { ReactElement } from "react";
import { useWorkbench } from "../store/useWorkbench.ts";
import { useSidePane } from "../store/useSidePane.ts";
import { contextTabId } from "../core/sidePaneTabs.ts";
import { asRuntimeId, asModelId, type UnitId, type WorkUnit } from "../core/units.ts";
import { configureSearch } from "../store/useSearch.ts";
import type { AddBotDraft } from "./AddBotDialog.tsx";
import { AddBotDialog } from "./AddBotDialog.tsx";

function guardsOf(u: WorkUnit): { ifRevision?: number; ifAgentsMdHash?: string; ifSoulMdHash?: string } {
  return { ifRevision: u.revision, ifAgentsMdHash: u.agentsMdMeta?.hash, ifSoulMdHash: u.soulMdMeta?.hash };
}

export function BotSettingsPane({ unitId }: { unitId: UnitId }): ReactElement | null {
  const unit = useWorkbench((s) => s.units.find((u) => String(u.id) === String(unitId)));

  if (unit === undefined) {
    return <p className="p-3 text-caption text-ash">这个 bot 已经不在了（目录或定义被移除），面板可关闭。</p>;
  }

  return (
    <AddBotDialog
      embedded
      open
      initial={unit}
      onClose={() => useSidePane.getState().closeTab(contextTabId(unitId))}
      onSubmit={async (draft: AddBotDraft, opts?: { overwrite?: boolean }) => {
        // 与原 Sidebar 编辑接线同款：读最新 store（避免「上下文与文件」里单独保存后
        // revision 过期或正文被旧草稿覆盖），只换用户能改的字段。
        const fresh = useWorkbench.getState().units.find((u) => String(u.id) === String(unitId)) ?? unit;
        await useWorkbench.getState().updateUnit(
          {
            ...fresh,
            name: draft.name,
            rootPath: draft.rootPath,
            kind: draft.kind,
            resident: draft.resident,
            autoCollect: draft.autoCollect,
            identity: {
              ...fresh.identity,
              role: draft.role,
              sourcePath: "AGENTS.md",
              loadedAt: fresh.identity?.loadedAt ?? Date.now(),
            },
            soulMd: fresh.soulMd,
            bindings: draft.runtimeId
              ? [
                  {
                    runtimeId: asRuntimeId(draft.runtimeId),
                    modelHint: draft.modelHint ? asModelId(draft.modelHint) : undefined,
                    primary: true,
                  },
                ]
              : [],
            agentsMd: fresh.agentsMd,
            memory: draft.memory,
            channels: draft.channels,
            avatar: draft.avatar,
          },
          opts?.overwrite === true ? {} : guardsOf(fresh),
        );
        // 搜索配置（bot 级、daemon 侧存储）：定义落盘成功后再写密钥槽，
        // 失败由 AddBotDialog 的 catch 展示（bot.json 已保存，不算回滚）。
        if (draft.search !== undefined) {
          await configureSearch(
            String(unitId),
            draft.search.provider,
            draft.search.apiKey === "" ? undefined : draft.search.apiKey,
          );
        }
        // 保存后不关面板：分区之间继续编辑；冲突走 AddBotDialog 内建的三选一
      }}
    />
  );
}
