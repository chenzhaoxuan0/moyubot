import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { SearchOverview, SearchQuotaSnapshot } from "../core/search.ts";
import { fetchSearchOverview } from "../store/useSearch.ts";
import { ActionLogCard, FanoutCard } from "./BrowserControlSection.tsx";
import { GroupCard, SettingsRow } from "./SettingsPage.tsx";

/**
 * 全局设置「搜索」分区 —— bot 级搜索的总览面（配置本身在各 bot 的设置里）。
 *
 * 这里回答三个问题：哪些 bot 配了搜索（用哪家、余量多少）、桥条目装没装进
 * 执行器原生配置、最近发生过什么。密钥明文永不出现——余量数字来自各家
 * 官方接口（daemon 侧 60s 缓存），豆包没有接口就如实显示本机计数。
 */
export function SearchSettingsSection() {
  const [state, setState] = useState<SearchOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    (silent = false) => {
      if (!silent) setBusy(true);
      fetchSearchOverview()
        .then((s) => {
          setState(s);
          setErr(null);
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [],
  );

  useEffect(() => {
    refresh(true);
    const t = setInterval(() => refresh(true), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const configured = state?.bots.filter((b) => b.configured) ?? [];

  return (
    <div className="space-y-6">
      <p className="-mt-2 text-body-sm leading-relaxed text-graphite">
        每个 bot 独立配置联网搜索（bot 设置 → 搜索）：密钥存 daemon 侧按 bot 分槽，
        执行器侧只有一条与 bot 无关的 <span className="font-mono text-ink">workbench-search</span> 桥——
        按会话目录决定给不给 <span className="font-mono text-ink">web_search</span> 工具。
        任一 bot 配置即自动把桥条目扇出进全部执行器；全部关闭则条目入停用库。
      </p>

      <GroupCard>
        <div className="px-4 pb-2.5 pt-3">
          <p
            className="text-caption font-medium text-graphite"
            title="余量快照来自各家官方接口（daemon 60s 缓存）；本机计数只统计经工作台桥的调用。"
          >
            各 bot 的搜索状态
          </p>
        </div>
        {state === null && <p className="px-4 pb-3 text-caption text-ash">加载中…</p>}
        {state !== null && state.bots.length === 0 && (
          <p className="px-4 pb-3 text-caption text-ash">还没有任何 bot——先在侧栏添加。</p>
        )}
        {state !== null &&
          state.bots.map((b) => (
            <SettingsRow
              key={b.botId}
              label={b.botName}
              description={b.rootPath}
              control={
                b.configured ? (
                  <span className="text-caption text-ink">
                    {providerLabel(state, b.provider)}
                    {b.apiKeyMasked !== null && <span className="text-ash"> · {b.apiKeyMasked}</span>}
                  </span>
                ) : (
                  <span className="text-caption text-ash">未配置</span>
                )
              }
              detail={
                b.configured ? (
                  <OverviewQuota quota={b.quota} localUsage={b.localUsageMonth} />
                ) : undefined
              }
            />
          ))}
        {configured.length === 0 && state !== null && state.bots.length > 0 && (
          <p className="border-t border-line px-4 py-3 text-caption text-ash">
            还没有 bot 配置搜索——到某个 bot 的设置 → 搜索里选提供商、填密钥。
          </p>
        )}
      </GroupCard>

      {state !== null && (
        <GroupCard>
          <SettingsRow
            label="桥条目（workbench-search）"
            description={`条目命令指向 ${state.bridgePath}；有任一 bot 配置搜索即保持写入，全部关闭则入停用库。`}
            control={
              <span className={`text-caption ${state.entryInstalled ? "text-gain" : "text-ash"}`}>
                {state.entryInstalled ? "已写入执行器配置" : "未写入（无 bot 使用搜索）"}
              </span>
            }
          />
        </GroupCard>
      )}

      {state !== null && (
        <GroupCard>
          <div className="px-4 pb-2.5 pt-3">
            <p className="text-caption font-medium text-graphite" title="新增提供商 = 后端注册表加一个 def（backend/src/searchctl/providers.ts）。">
              提供商目录
            </p>
          </div>
          <div className="space-y-2 px-4 pb-3">
            {state.providers.map((p) => (
              <div key={p.id} className="border-t border-line-soft pt-2 first:border-t-0 first:pt-0">
                <p className="flex items-center gap-1.5 text-caption font-medium text-ink">
                  {p.label}
                  <span className="font-normal text-ash">· {p.keyHint}</span>
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-0.5 text-teal hover:underline"
                  >
                    文档 <ExternalLink size={10} />
                  </a>
                </p>
                <p className="mt-0.5 text-caption leading-relaxed text-ash">{p.freeTierNote}</p>
              </div>
            ))}
          </div>
        </GroupCard>
      )}

      <FanoutCard state={state} />
      <ActionLogCard actions={state?.actions ?? []} />

      <div className="flex items-center gap-2">
        <button
          onClick={() => refresh()}
          disabled={busy}
          className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : undefined} />
          刷新
        </button>
        {err !== null && <span className="text-caption text-loss">{err}</span>}
      </div>
    </div>
  );
}

function providerLabel(state: SearchOverview, id: string | null): string {
  if (id === null) return "—";
  return state.providers.find((p) => p.id === id)?.label ?? id;
}

/** 总览行的余量一句话（bot 设置分区里的 SearchSection 有更全的展示，这里从简） */
function OverviewQuota({ quota, localUsage }: { quota: SearchQuotaSnapshot | null; localUsage: number }) {
  if (quota === null) {
    return (
      <p className="text-caption leading-relaxed text-ash">
        本机本月调用 {localUsage} 次（这家没有余量查询接口，或快照还没拉到——去 bot 设置里刷新）。
      </p>
    );
  }
  if (!quota.ok) {
    return <p className="text-caption leading-relaxed text-loss">余量查询失败：{quota.error ?? "未知"}</p>;
  }
  const parts: string[] = [];
  if (quota.used != null && quota.limit != null) {
    parts.push(`已用 ${quota.used} / ${quota.limit}${quota.remaining != null ? `，剩余 ${quota.remaining}` : ""}`);
  } else if (quota.balance != null) {
    parts.push(`账户余额 ${quota.balance} 元`);
  }
  if (quota.plan != null) parts.push(quota.plan);
  if (quota.note != null) parts.push(quota.note);
  parts.push(`本机本月 ${localUsage} 次`);
  return <p className="text-caption leading-relaxed text-graphite">{parts.join(" · ")}</p>;
}
