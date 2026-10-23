/**
 * bot 设置的「工作区技能」管理页（2026-10-23 用户需求）。
 *
 * 与设置页「技能」分区（全技能源的全局停用面）的分工：
 * - 这里**只管当前 bot 工作目录内的技能源**（.agents/skills/ 与 skills/ 项目级源）；
 * - 置顶（pin）：置顶名单存 bot.json（pinnedSkills），缺省 = 两个官方基础技能
 *   （agent-workbench / workbench-context）置顶——init 播种的基础能力永远排最前；
 * - 停用/恢复与全局页同一条路：搬 .disabled/ 文件夹，对读取该源的一切执行器生效。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Pin, PinOff } from "lucide-react";
import type { SkillEntryInfo, SkillSourceGroupInfo, SkillsInventory } from "../core/skills.ts";
import { fetchSkillsInventory, setSkillDisabledRpc } from "../adapters/daemon/client.ts";
import { useNativeCommands } from "../store/useNativeCommands.ts";
import { useWorkbench } from "../store/useWorkbench.ts";
import type { WorkUnit } from "../core/units.ts";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

/** 置顶缺省：两个官方基础技能（bot init 播种的基础能力） */
export const DEFAULT_PINNED_SKILLS: readonly string[] = ["agent-workbench", "workbench-context"];

export function WorkspaceSkillsEditor({ unit }: { unit: WorkUnit }): ReactElement {
  const updateUnit = useWorkbench((s) => s.updateUnit);
  const pushNotice = useWorkbench((s) => s.pushNotice);

  const [groups, setGroups] = useState<readonly SkillSourceGroupInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const reqSeq = useRef(0);

  const pinned = unit.pinnedSkills ?? DEFAULT_PINNED_SKILLS;

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const inv: SkillsInventory = await fetchSkillsInventory(unit.rootPath);
      if (seq !== reqSeq.current) return;
      // 只看这个工作目录内的源（scope=project 的目录都在 rootPath 下，双条件防串）
      setGroups(inv.groups.filter((g) => g.scope === "project" && (g.dir.startsWith(unit.rootPath) || unit.rootPath.startsWith(g.dir))));
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [unit.rootPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const markPending = (key: string, on: boolean): void =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /** 停用/恢复：与全局技能页同一条路（搬 .disabled/，文件系统即真相） */
  const toggleDisabled = (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean): void => {
    const key = `${group.id}|${entry.dirName}`;
    markPending(key, true);
    void (async () => {
      try {
        await setSkillDisabledRpc(group.dir, entry.dirName, disabled, unit.rootPath);
        useNativeCommands.getState().invalidateAll();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        markPending(key, false);
        await load();
      }
    })();
  };

  /** 置顶/取消置顶：写 bot.json（三锁防覆盖并发修改） */
  const togglePin = (dirName: string): void => {
    const next = pinned.includes(dirName) ? pinned.filter((x) => x !== dirName) : [...pinned, dirName];
    void updateUnit(
      { ...unit, pinnedSkills: next } as WorkUnit,
      { ifRevision: unit.revision, ifAgentsMdHash: unit.agentsMdMeta?.hash, ifSoulMdHash: unit.soulMdMeta?.hash },
    ).catch((e: unknown) => {
      pushNotice("置顶未写入", e instanceof Error ? e.message : String(e), { level: "warn" });
    });
  };

  // 展平行：组内去重（跨源同名在本页按目录名各自成行——工作区源少，直白优先）
  const rows: { group: SkillSourceGroupInfo; entry: SkillEntryInfo }[] = [];
  for (const g of groups ?? []) {
    for (const s of g.skills) rows.push({ group: g, entry: s });
  }
  // 置顶名单内的排最前（按名单序），其余按名称
  rows.sort((a, b) => {
    const pa = pinned.indexOf(a.entry.dirName);
    const pb = pinned.indexOf(b.entry.dirName);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return a.entry.name.localeCompare(b.entry.name);
  });

  return (
    <div className="space-y-3">
      <p
        className="-mt-1 text-[11px] text-ash"
        title="只管理这个 bot 工作目录内的技能（.agents/skills/ 与 skills/）。置顶只影响此页排序（存 bot.json）；停用 = 搬进源内 .disabled/，对读取该源的一切执行器生效。两个官方基础技能（agent-workbench / workbench-context）默认置顶——它们是 init 播种的基础能力。"
      >
        只管理本工作目录内的技能；置顶影响排序，停用搬入 .disabled/（悬停看全部语义）。
      </p>

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">
          {err}
          <button onClick={() => void load()} className="ml-2 text-graphite underline underline-offset-2 hover:text-ink">重试</button>
        </p>
      )}

      {groups === null && err === null && <p className="text-caption text-ash">正在扫描工作区技能源…</p>}

      {groups !== null && rows.length === 0 && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          工作目录里还没有技能。放一个含 <span className="font-mono">SKILL.md</span> 的文件夹进
          <span className="font-mono"> .agents/skills/</span>；「补充工作区配置 (Init)」会播种两个官方基础技能。
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line bg-card">
          <ul className="divide-y divide-line-soft">
            {rows.map(({ group, entry }) => {
              const key = `${group.id}|${entry.dirName}`;
              const isPinned = pinned.includes(entry.dirName);
              const busy = pending.has(key);
              return (
                <li key={key} className={cn("flex items-center gap-3 px-3 py-2.5", entry.disabled && "opacity-60")}>
                  <button
                    type="button"
                    onClick={() => togglePin(entry.dirName)}
                    title={isPinned ? "取消置顶" : "置顶（只影响此页排序）"}
                    className={cn(
                      "shrink-0 rounded p-1 transition",
                      isPinned ? "text-teal hover:bg-teal-tint" : "text-ash/60 hover:text-ink hover:bg-line-soft",
                    )}
                    aria-label={isPinned ? `取消置顶 ${entry.name}` : `置顶 ${entry.name}`}
                  >
                    {isPinned ? <Pin size={13} /> : <PinOff size={13} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={cn("truncate text-body-sm", entry.disabled ? "text-graphite" : "text-ink")}>{entry.name}</span>
                      {entry.dirName !== entry.name && (
                        <span className="truncate font-mono text-[10px] text-ash" title={entry.dirName}>{entry.dirName}</span>
                      )}
                      {DEFAULT_PINNED_SKILLS.includes(entry.dirName) && (
                        <span className="shrink-0 rounded bg-teal-tint px-1.5 py-0.5 text-[9px] font-medium leading-none text-teal">基础</span>
                      )}
                    </div>
                    {entry.description !== undefined && (
                      <p className="truncate text-caption text-ash" title={entry.description}>{entry.description}</p>
                    )}
                    <p className="truncate font-mono text-[10px] text-ash/70" title={group.dir}>{group.dir}</p>
                  </div>
                  {group.readOnly || entry.singleForm === true ? (
                    <span className="shrink-0 text-caption text-ash">{group.readOnly ? "只读" : "单技能形态"}</span>
                  ) : (
                    <Toggle on={!entry.disabled} onChange={(v) => toggleDisabled(group, entry, !v)} ariaLabel={`${entry.name} 启用`} />
                  )}
                  {busy && <span className="shrink-0 text-caption text-ash">…</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
