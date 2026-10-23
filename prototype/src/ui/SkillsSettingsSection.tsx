/**
 * 设置页「技能」分区 —— 按技能源分组的技能清单与停用开关。
 *
 * 领域语义（CONTEXT.md「技能与扩展」）：
 * - 停用 = 把技能文件夹搬进技能源内的 `.disabled/`，对读取该源的一切执行器生效；
 *   恢复即搬回。原生文件系统是唯一真相源，这里没有第二份状态。
 * - 影响范围 = 技能源的可见范围：分组头部的执行器徽标就是「停用会影响谁」。
 *   专属目录只影响一个执行器；公共目录（.agents）影响所有读取方 ——
 *   用户在开关的时候自己有这个意识，界面负责把范围摆在眼前。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillEntryInfo, SkillSourceGroupInfo, SkillsInventory } from "../core/skills.ts";
import { copySkillRpc, fetchSkillsInventory, setSkillDisabledRpc } from "../adapters/daemon/client.ts";
import { useNativeCommands } from "../store/useNativeCommands.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { Toggle } from "./SettingsPage.tsx";
import { cn } from "./cn.ts";

type LoadStatus = "loading" | "ready" | "error";

export function SkillsSettingsSection() {
  const activeUnit = useWorkbench(selectActiveUnit);
  const activeRoot = activeUnit?.rootPath ?? null;

  const [inv, setInv] = useState<SkillsInventory | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  /** 拉取错误（load 自管：成功清、失败设；有旧数据时不清屏只挂横幅） */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 操作错误（开关/批量）——与 loadErr 分离，清单重载不会把它冲掉 */
  const [err, setErr] = useState<string | null>(null);
  /** 在途开关动作（`${groupId}|${dirName}`），防重复点击与批量闪烁 */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  /** 选中的技能源（组 id）；null = 默认第一个源。切 bot 后项目源变化时自动回落 */
  const [selSource, setSelSource] = useState<string | null>(null);
  /** 分源查看 / 统合矩阵两种视图；矩阵 = 行=技能 × 列=技能源 的实时投影 */
  const [view, setView] = useState<"sources" | "matrix">("sources");
  /** 矩阵搜索词 + 矩阵在途格子（`${name}|${groupId}`） */
  const [search, setSearch] = useState("");
  const [cellPending, setCellPending] = useState<ReadonlySet<string>>(new Set());
  /** 请求序号：快速切 bot 连发 load 时只有最新一次允许写状态（旧响应后到不得覆盖新数据） */
  const reqSeq = useRef(0);

  const load = useCallback(async (root: string | null): Promise<void> => {
    const seq = ++reqSeq.current;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    try {
      const data = await fetchSkillsInventory(root ?? undefined);
      if (seq !== reqSeq.current) return;
      setInv(data);
      setStatus("ready");
      setLoadErr(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // 拉取失败保留旧清单（好过清屏），只在从没成功过时进 error 态
      setStatus((s) => (s === "ready" ? "ready" : "error"));
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(activeRoot);
  }, [activeRoot, load]);

  const markPending = (key: string, on: boolean): void => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** 单个开关：RPC 搬运 → 清命令缓存 → 重拉清单（盘上世界变了，重新看真相） */
  const toggle = useCallback(
    async (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean): Promise<{ msg: string; code?: string } | null> => {
      const key = `${group.id}|${entry.dirName}`;
      markPending(key, true);
      try {
        await setSkillDisabledRpc(group.dir, entry.dirName, disabled, activeRoot ?? undefined);
        // daemon 已失效自己的缓存；前端 10 分钟 TTL 缓存跟着作废
        useNativeCommands.getState().invalidateAll();
        return null;
      } catch (e) {
        return { msg: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code };
      } finally {
        markPending(key, false);
      }
    },
    [activeRoot],
  );

  const handleToggle = (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean): void => {
    void (async () => {
      const e = await toggle(group, entry, disabled);
      if (e !== null) setErr(e.msg);
      await load(activeRoot);
    })();
  };

  /**
   * 目录级批量：只动状态需要变的条目，逐个搬运；失败聚合报首错（本地 rename，毫秒级）。
   * daemon 断连/超时立即中止 —— 每个失败项都要吃满连接超时，20 项串行能拖两分钟。
   */
  const handleBatch = (group: SkillSourceGroupInfo, disabled: boolean): void => {
    void (async () => {
      const targets = group.skills.filter((s) => s.disabled !== disabled && s.singleForm !== true);
      let firstErr: string | null = null;
      for (const t of targets) {
        const e = await toggle(group, t, disabled);
        if (e !== null) {
          if (firstErr === null) firstErr = e.msg;
          if (e.code === "daemon_unreachable" || e.code === "daemon_rpc_timeout" || e.code === "daemon_disconnected") {
            firstErr = `daemon 连接不可用，批量操作中止（可恢复后重试）：${e.msg}`;
            break;
          }
        }
      }
      if (firstErr !== null) setErr(firstErr);
      await load(activeRoot);
    })();
  };

  // 技能源切换：主源（用户级/项目级）各占一个 tab；只读插件源聚合一个 tab
  //（zcode/agy 插件逐版本成源，单独列 tab 会把切换条挤爆）
  const PLUGIN_TAB = "__plugins__";
  const mainGroups = (inv?.groups ?? []).filter((g) => g.scope !== "plugin");
  const pluginGroups = (inv?.groups ?? []).filter((g) => g.scope === "plugin");
  const activeGroup = mainGroups.find((g) => g.id === selSource) ?? mainGroups[0];
  const pluginTabActive = selSource === PLUGIN_TAB || (selSource === null && mainGroups.length === 0 && pluginGroups.length > 0);

  /** 矩阵行：跨源同名聚合（cells 按 groupId 索引该源的条目） */
  const matrixRows: { name: string; cells: Map<string, SkillEntryInfo> }[] = [];
  {
    const byName = new Map<string, { name: string; cells: Map<string, SkillEntryInfo> }>();
    for (const g of mainGroups) {
      for (const s of g.skills) {
        const r = byName.get(s.name) ?? { name: s.name, cells: new Map<string, SkillEntryInfo>() };
        r.cells.set(g.id, s);
        byName.set(s.name, r);
      }
    }
    for (const r of byName.values()) matrixRows.push(r);
    matrixRows.sort((a, b) => a.name.localeCompare(b.name));
  }
  const q = search.trim().toLowerCase();
  const filteredRows = q === "" ? matrixRows : matrixRows.filter((r) => r.name.toLowerCase().includes(q));

  /** 矩阵格子：空 = 从行内任一源复制分发；✓ = 停用进 .disabled；◦ = 恢复 */
  const matrixCell = (row: { name: string; cells: Map<string, SkillEntryInfo> }, group: SkillSourceGroupInfo): void => {
    if (group.readOnly) return;
    const key = `${row.name}|${group.id}`;
    const markCellPending = (on: boolean): void =>
      setCellPending((prev) => {
        const n = new Set(prev);
        if (on) n.add(key);
        else n.delete(key);
        return n;
      });
    const cell = row.cells.get(group.id);
    markCellPending(true);
    void (async () => {
      try {
        if (cell === undefined) {
          // 分发：从行内任一源复制（源不动，目标多一份实体各自演化）
          // 优先选已启用的源，避免从停用目录复制；若全停用则兜底任一源
          const candidateGroupIds = [...row.cells.keys()];
          const activeGroupId = candidateGroupIds.find((gid) => {
            const entry = row.cells.get(gid);
            const g = mainGroups.find((x) => x.id === gid);
            return g !== undefined && !g.readOnly && entry !== undefined && !entry.disabled;
          }) ?? candidateGroupIds.find((gid) => {
            const g = mainGroups.find((x) => x.id === gid);
            return g !== undefined && !g.readOnly;
          });
          const srcGroupId = activeGroupId ?? candidateGroupIds[0];
          const srcGroup = mainGroups.find((g) => g.id === srcGroupId);
          const srcEntry = srcGroupId !== undefined ? row.cells.get(srcGroupId) : undefined;
          if (srcGroup === undefined || srcEntry === undefined) {
            setErr(`「${row.name}」在可复制的源里没有实体`);
            return;
          }
          await copySkillRpc(srcGroup.dir, srcEntry.dirName, group.dir, activeRoot ?? undefined);
          useNativeCommands.getState().invalidateAll();
        } else if (cell.disabled) {
          await setSkillDisabledRpc(group.dir, cell.dirName, false, activeRoot ?? undefined);
          useNativeCommands.getState().invalidateAll();
        } else {
          await setSkillDisabledRpc(group.dir, cell.dirName, true, activeRoot ?? undefined);
          useNativeCommands.getState().invalidateAll();
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        markCellPending(false);
        await load(activeRoot);
      }
    })();
  };

  return (
    <div className="space-y-4">
      {/* 视图切换：分源查看 / 统合矩阵 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["sources", "matrix"] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                setErr(null);
              }}
              className={cn(
                "rounded-chip border px-2.5 py-1 text-caption transition",
                view === v ? "border-teal bg-teal-tint font-medium text-ink" : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              {v === "sources" ? "分源查看" : "统合矩阵"}
            </button>
          ))}
        </div>
        {view === "matrix" && (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索技能名…"
              className="h-7 w-44 rounded-btn border border-line bg-canvas px-2.5 text-caption text-ink focus:border-teal focus:outline-none"
            />
            <span className="text-caption text-ash">
              {filteredRows.length} 项 · 打钩 = 复制到该源；取消 = 停用进 .disabled；◦ = 已停用可恢复
            </span>
          </>
        )}
      </div>

      {view === "matrix" ? (
        <SkillMatrix
          groups={mainGroups}
          rows={filteredRows}
          total={matrixRows.length}
          pending={cellPending}
          onCell={matrixCell}
          hasQuery={q !== ""}
        />
      ) : (
        <>


      {status === "loading" && <p className="text-body-sm text-ash">正在扫描技能源…</p>}
      {status === "error" && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">
          技能清单拉取失败：{loadErr ?? "daemon 未响应"}
        </p>
      )}

      {status === "ready" && loadErr !== null && (
        <p className="flex items-center gap-2 rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          <span className="min-w-0 flex-1">清单刷新失败（保留上次内容）：{loadErr}</span>
          <button
            onClick={() => void load(activeRoot)}
            className="shrink-0 rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
          >
            重试
          </button>
        </p>
      )}

      {err !== null && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-loss">{err}</p>
      )}

      {status === "ready" && inv !== null && inv.groups.length === 0 && (
        <p className="rounded-btn border border-line bg-card px-3 py-2 text-caption leading-relaxed text-ash">
          还没有发现任何技能。把一个含 <span className="font-mono">SKILL.md</span> 的文件夹放进任意技能源
          （如 <span className="font-mono">~/.agents/skills/&lt;name&gt;/</span>）即可被全部执行器发现。
        </p>
      )}

      {/* 技能源切换条（对齐 MCP 分区的执行器 tab 形态） */}
      {status === "ready" && (mainGroups.length > 0 || pluginGroups.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {mainGroups.map((g) => {
            const active = !pluginTabActive && activeGroup?.id === g.id;
            const enabled = g.skills.filter((s) => !s.disabled).length;
            return (
              <button
                key={g.id}
                onClick={() => setSelSource(g.id)}
                className={cn(
                  "rounded-chip border px-2.5 py-1 text-body-sm transition",
                  active
                    ? "border-teal bg-teal-tint font-medium text-ink"
                    : "border-line text-graphite hover:bg-line-soft hover:text-ink",
                )}
              >
                {g.label}
                <span className="ml-1 tnum text-caption">{enabled}</span>
              </button>
            );
          })}
          {pluginGroups.length > 0 && (
            <button
              onClick={() => setSelSource(PLUGIN_TAB)}
              className={cn(
                "rounded-chip border px-2.5 py-1 text-body-sm transition",
                pluginTabActive
                  ? "border-teal bg-teal-tint font-medium text-ink"
                  : "border-line text-graphite hover:bg-line-soft hover:text-ink",
              )}
            >
              插件源
              <span className="ml-1 tnum text-caption">{pluginGroups.length}</span>
            </button>
          )}
        </div>
      )}

      {status === "ready" && !pluginTabActive && activeGroup !== undefined && (
        <SkillGroupCard
          key={activeGroup.id}
          group={activeGroup}
          pending={pending}
          onToggle={handleToggle}
          onBatch={handleBatch}
        />
      )}

      {status === "ready" && pluginTabActive && pluginGroups.map((g) => (
        <SkillGroupCard
          key={g.id}
          group={g}
          pending={pending}
          onToggle={handleToggle}
          onBatch={handleBatch}
        />
      ))}
        </>
      )}

      {activeRoot !== null && (
        <p
          className="text-caption text-ash"
          title="项目级技能源按当前单元列出；切换侧栏单元后此处随之更新。"
        >
          项目级源跟随当前单元：{activeUnit?.name}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 技能统合矩阵 */

/** 行 = 技能（跨源同名聚合），列 = 可操作技能源。矩阵是文件系统实况的投影，不是账本 */
function SkillMatrix({
  groups,
  rows,
  total,
  pending,
  onCell,
  hasQuery,
}: {
  groups: readonly SkillSourceGroupInfo[];
  rows: readonly { name: string; cells: Map<string, SkillEntryInfo> }[];
  total: number;
  pending: ReadonlySet<string>;
  onCell: (row: { name: string; cells: Map<string, SkillEntryInfo> }, group: SkillSourceGroupInfo) => void;
  hasQuery: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="sticky left-0 z-[1] bg-card px-3 py-2 text-left text-caption font-medium text-graphite">
              技能{hasQuery && <span className="ml-1 text-ash">（{rows.length}/{total}）</span>}
            </th>
            {groups.map((g) => (
              <th key={g.id} className="min-w-[72px] px-1 py-2 text-center text-caption font-medium text-graphite" title={g.dir}>
                <span className="block truncate">{g.label}</span>
                <span className="tnum block text-[10px] text-ash">{g.skills.filter((s) => !s.disabled).length}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={groups.length + 1} className="px-4 py-3 text-caption text-ash">
                {hasQuery ? "没有匹配的技能。" : "还没有技能 —— 在「分源查看」里确认技能源存在。"}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const anyLive = [...row.cells.values()].some((s) => !s.disabled);
            return (
              <tr key={row.name} className="border-b border-line-soft last:border-b-0">
                <td className="sticky left-0 z-[1] max-w-[220px] bg-card px-3 py-1.5">
                  <span className={cn("block truncate text-body-sm", anyLive ? "text-ink" : "text-ash")} title={row.name}>{row.name}</span>
                </td>
                {groups.map((g) => {
                  const cell = row.cells.get(g.id);
                  const key = `${row.name}|${g.id}`;
                  const busy = pending.has(key);
                  const state = cell === undefined ? "none" : cell.disabled ? "vault" : "live";
                  const title = g.readOnly
                    ? "只读源"
                    : state === "live"
                      ? `${row.name} 在 ${g.label}（点击停用 → .disabled/）`
                      : state === "vault"
                        ? `${row.name} 已停用于 ${g.label}（点击恢复）`
                        : `复制到 ${g.label}（源实体不动，两处各自演化）`;
                  return (
                    <td key={g.id} className="px-1 py-1 text-center">
                      <button
                        onClick={() => onCell(row, g)}
                        disabled={busy || g.readOnly}
                        title={title}
                        className={cn(
                          "h-6 w-6 rounded-chip border text-caption leading-none transition",
                          state === "live" ? "border-teal bg-teal text-canvas"
                            : state === "vault" ? "border-line bg-line-soft text-graphite"
                              : "border-line bg-canvas text-ash hover:border-teal hover:text-teal",
                          g.readOnly && "opacity-30",
                        )}
                      >
                        {busy ? "…" : state === "live" ? "✓" : state === "vault" ? "◦" : "+"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SkillGroupCard({
  group,
  pending,
  onToggle,
  onBatch,
}: {
  group: SkillSourceGroupInfo;
  pending: ReadonlySet<string>;
  onToggle: (group: SkillSourceGroupInfo, entry: SkillEntryInfo, disabled: boolean) => void;
  onBatch: (group: SkillSourceGroupInfo, disabled: boolean) => void;
}) {
  const activeCount = group.skills.filter((s) => !s.disabled).length;
  const disabledCount = group.skills.length - activeCount;
  const canBatch = !group.readOnly && group.skills.length > 0;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-4 pb-2.5 pt-3">
        <div className="min-w-0">
          <span className="text-body-sm font-medium text-ink">{group.label}</span>
          <span className="ml-2 tnum text-caption text-ash">
            {activeCount} 启用{disabledCount > 0 ? ` · ${disabledCount} 停用` : ""}
          </span>
          <p className="truncate font-mono text-caption text-ash" title={group.dir}>{group.dir}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex max-w-[340px] flex-wrap items-center justify-end gap-1" title="停用该源内的技能会影响这些执行器">
            {group.readers.map((r) => (
              <span key={r.id} className="rounded-chip bg-line-soft px-1.5 py-0.5 text-caption text-graphite">
                {r.name}
              </span>
            ))}
          </span>
          {canBatch && (
            <span className="flex shrink-0 gap-1.5">
              <BatchButton label="全部停用" onClick={() => onBatch(group, true)} disabled={activeCount === 0} />
              <BatchButton label="全部恢复" onClick={() => onBatch(group, false)} disabled={disabledCount === 0} />
            </span>
          )}
        </div>
      </div>

      {group.readOnly && (
        <p className="border-b border-line-soft bg-rail/40 px-4 py-1.5 text-caption text-ash">
          只读源：由 {group.label.startsWith("agy") ? "Antigravity" : "所属工具"} 自身管理，只展示不提供开关。
        </p>
      )}

      <ul className="divide-y divide-line-soft">
        {group.skills.map((s) => {
          const key = `${group.id}|${s.dirName}`;
          const busy = pending.has(key);
          return (
            <li key={`${s.dirName}${s.disabled ? "|off" : ""}`} className={cn("flex items-center gap-3 px-4 py-2.5", s.disabled && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn("truncate text-body-sm", s.disabled ? "text-graphite" : "text-ink")}>{s.name}</span>
                  {s.dirName !== s.name && (
                    <span className="truncate font-mono text-caption text-ash" title={s.dirName}>{s.dirName}</span>
                  )}
                </div>
                {s.description !== undefined && (
                  <p className="truncate text-caption text-ash" title={s.description}>{s.description}</p>
                )}
              </div>
              {group.readOnly || s.singleForm === true ? (
                <span className="shrink-0 text-caption text-ash" title={s.singleForm === true ? "SKILL.md 直挂源目录，源目录即技能：无法搬进自己内部" : undefined}>
                  {s.singleForm === true ? "单技能形态" : "只读"}
                </span>
              ) : (
                <Toggle on={!s.disabled} onChange={(v) => onToggle(group, s, !v)} />
              )}
              {busy && <span className="shrink-0 text-caption text-ash">…</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BatchButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}
