import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type {
  SearchProviderId,
  SearchProviderInfo,
  SearchQuotaSnapshot,
  SearchBotStatus,
} from "../core/search.ts";
import {
  fetchSearchProviders,
  fetchSearchQuota,
  fetchSearchStatus,
  probeSearchQuota,
} from "../store/useSearch.ts";

/**
 * bot 设置 / 新建流的「搜索」分区 —— 每个 bot 独立的联网搜索。
 *
 * 机制（对齐浏览器/电脑控制的「工作台登记 + 扇出」心智，但按 bot 开关）：
 * 密钥存 daemon 侧（<homeDir>/search-keys.json，按 botId 分槽，支持 env: 引用），
 * 执行器侧只有一条与 bot 无关的 workbench-search 桥条目——桥拿会话目录问 daemon
 * 「这个工作区配没配搜索」，配了才暴露 web_search。所以这里的配置**随保存生效**，
 * 已开的会话要新开会话才拿到工具（与 MCP 条目写入的时效一致）。
 */

/** 表单草稿（挂在 AddBotDialog 上跨分区切换存活；touched = 与盘上不一致） */
export interface SearchDraftState {
  readonly provider: SearchProviderId | "none";
  /** "" = 不动已存密钥；非空 = 替换（保存时传给 search.configure） */
  readonly apiKey: string;
  readonly touched: boolean;
}

export const SEARCH_DRAFT_INIT: SearchDraftState = { provider: "none", apiKey: "", touched: false };

export function SearchSection({
  botId,
  draft,
  onDraftChange,
}: {
  /** 编辑模式的 bot id；null = 新建（无已存状态可显示，草稿创建后生效） */
  botId: string | null;
  draft: SearchDraftState;
  onDraftChange: (d: SearchDraftState) => void;
}) {
  const [providers, setProviders] = useState<readonly SearchProviderInfo[]>([]);
  const [status, setStatus] = useState<SearchBotStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [quota, setQuota] = useState<SearchQuotaSnapshot | null>(null);
  const [quotaBusy, setQuotaBusy] = useState(false);

  const providerDef = providers.find((p) => p.id === draft.provider) ?? null;

  const refreshStatus = useCallback(() => {
    if (botId === null) return;
    fetchSearchStatus(botId)
      .then((s) => {
        setStatus(s);
        setStatusErr(null);
        setQuota(s.quota);
      })
      .catch((e) => setStatusErr(e instanceof Error ? e.message : String(e)));
  }, [botId]);

  useEffect(() => {
    fetchSearchProviders().then(setProviders).catch(() => undefined);
  }, []);

  // 打开 / 切换 bot / 保存落定（touched 归零）时重拉已存状态；改草稿期间不打扰
  useEffect(() => {
    if (draft.touched) return;
    refreshStatus();
  }, [refreshStatus, draft.touched]);

  // 尚未被用户改动过 → 草稿的 provider 基线跟随盘上真值（key 永不回填浏览器）
  useEffect(() => {
    if (draft.touched || status === null || status.provider === null) return;
    if (draft.provider !== status.provider) {
      onDraftChange({ provider: status.provider, apiKey: "", touched: false });
    }
  }, [status, draft.provider, draft.touched, onDraftChange]);

  // ---- 配额动作 -----------------------------------------------------------------

  /** 用草稿密钥预检（新建模式，或编辑模式有未保存修改时）；否则查已存密钥 */
  const probingDraft = botId === null || draft.touched;
  const draftKeyReady = draft.provider !== "none" && draft.apiKey.trim() !== "";
  const useDraftKey = probingDraft && draftKeyReady;

  const refreshQuota = (): void => {
    if (quotaBusy) return;
    const p: Promise<SearchQuotaSnapshot> = useDraftKey
      ? probeSearchQuota(draft.provider as SearchProviderId, draft.apiKey.trim())
      : botId !== null
        ? fetchSearchQuota(botId, true)
        : Promise.reject(new Error("先填密钥"));
    setQuotaBusy(true);
    p.then(setQuota)
      .catch(() => undefined)
      .finally(() => setQuotaBusy(false));
  };

  const setProvider = (id: SearchProviderId | "none"): void => {
    onDraftChange({ ...draft, provider: id, touched: true });
    setQuota(null);
  };

  return (
    <div className="space-y-4">
      <p
        className="text-body-sm leading-relaxed text-graphite"
        title="密钥存 daemon 侧（~/.agent-workbench/search-keys.json），不进工作区文件、不回浏览器。workbench-search 桥按会话目录定位 bot：这里配了，这个 bot 的会话才有 web_search 工具。"
      >
        给这个 bot 配联网搜索：配置与密钥在 daemon 侧按 bot 分槽（支持{" "}
        <span className="font-mono text-ink">env:变量名</span> 引用），执行器经
        <span className="font-mono text-ink"> workbench-search </span>
        桥获得 <span className="font-mono text-ink">web_search</span> 工具——已开的会话需新开会话生效。
      </p>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="block text-caption font-medium text-graphite" title="换家会清掉旧密钥（key 是按家发的）。">
            搜索提供商
          </span>
          <select
            value={draft.provider}
            onChange={(e) => setProvider(e.target.value as SearchProviderId | "none")}
            className="w-full rounded-input border border-line bg-canvas px-3 py-2 text-body-sm text-ink outline-none focus:border-teal"
          >
            <option value="none">未配置（这个 bot 没有搜索工具）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {providers.length === 0 && draft.provider !== "none" && (
              <option value={draft.provider}>{draft.provider}（目录拉取失败）</option>
            )}
          </select>
        </label>

        {draft.provider !== "none" && (
          <>
            <label className="block space-y-1">
              <span
                className="block text-caption font-medium text-graphite"
                title={providerDef?.keyHint ?? "支持 env:变量名 引用（.env / 系统环境变量）"}
              >
                API Key{providerDef !== null ? ` · ${providerDef.keyHint}` : " · 支持 env:变量名 引用"}
              </span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => onDraftChange({ ...draft, apiKey: e.target.value, touched: true })}
                placeholder={
                  status?.apiKeySet === true && !draft.touched
                    ? `已存 ${status.apiKeyMasked}（留空保持）`
                    : "tvly-… / sk-…（DeepSeek、元宝）/ 豆包控制台 key，或 env:变量名"
                }
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-input border border-transparent bg-rail px-2.5 py-1.5 font-mono text-body-sm text-ink outline-none placeholder:text-ash focus:border-teal"
              />
            </label>
            {providerDef !== null && (
              <p className="-mt-1 flex items-center gap-1.5 text-caption leading-relaxed text-ash">
                <span>{providerDef.freeTierNote}</span>
                <a
                  href={providerDef.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-0.5 text-teal hover:underline"
                >
                  文档 <ExternalLink size={10} />
                </a>
              </p>
            )}
          </>
        )}
      </div>

      {/* 余量卡片：有余量 API 的家显示快照；豆包没有 → 只显示本机计数与说明 */}
      {draft.provider !== "none" && (
        <div className="space-y-1.5 rounded-card border border-line bg-rail/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-caption font-medium text-graphite" title="快照有 60s 缓存；Tavily 的用量接口有限速，别高频刷新。">
              免费额度余量
            </p>
            <button
              type="button"
              onClick={() => refreshQuota()}
              disabled={
                quotaBusy ||
                // 没有可查的口径时禁用：草稿没密钥（新建模式无已存密钥可言），
                // 或编辑模式既无已存配置也无缓存快照
                (!useDraftKey && (botId === null || (status?.configured !== true && quota === null)))
              }
              className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-caption text-graphite transition hover:bg-line-soft hover:text-ink disabled:opacity-40"
            >
              <RefreshCw size={11} className={quotaBusy ? "animate-spin" : undefined} />
              {useDraftKey ? "预检（草稿密钥）" : "刷新"}
            </button>
          </div>
          <QuotaBody
            quota={quota}
            providerId={draft.provider}
            providerDef={providerDef}
            localUsage={status?.localUsageMonth ?? 0}
            hasStored={status?.configured === true}
            isCreate={botId === null}
          />
        </div>
      )}

      {statusErr !== null && (
        <p className="text-caption leading-relaxed text-loss">读取已存配置失败：{statusErr}</p>
      )}
      {draft.touched && (
        <p className="text-caption text-ash">
          {botId === null ? "创建时随保存写入 daemon（密钥不落工作区文件）。" : "已修改——随「保存」生效。"}
        </p>
      )}
    </div>
  );
}

/** 余量正文：能查的显示数字，查不了的（豆包）如实说，别拿本机计数冒充官方余量 */
function QuotaBody({
  quota,
  providerId,
  providerDef,
  localUsage,
  hasStored,
  isCreate,
}: {
  quota: SearchQuotaSnapshot | null;
  providerId: SearchProviderId;
  providerDef: SearchProviderInfo | null;
  localUsage: number;
  hasStored: boolean;
  isCreate: boolean;
}) {
  if (providerDef !== null && !providerDef.quotaSupported) {
    return (
      <div className="space-y-1 text-caption leading-relaxed text-graphite">
        <p>
          {providerDef.label}没有余量查询 API（用量在其控制台看）：
          {providerDef.freeTierNote}。
        </p>
        {!isCreate && (
          <p className="text-ash">本机本月经这个工作台调用 {localUsage} 次（免费额度含其他渠道用量，以此为准会偏低）。</p>
        )}
      </div>
    );
  }
  if (quota === null) {
    return (
      <p className="text-caption leading-relaxed text-ash">
        {isCreate || !hasStored
          ? "填入密钥后可预检余量（不保存也能验 key 是否有效）。"
          : "点「刷新」拉取最新余量。"}
      </p>
    );
  }
  if (!quota.ok) {
    return (
      <p className="text-caption leading-relaxed text-loss">
        查询失败：{quota.error ?? "未知错误"}（401/403 = key 无效；其余多为网络或限速）
      </p>
    );
  }
  return (
    <div className="space-y-1 text-caption leading-relaxed text-graphite">
      {quota.used != null && quota.limit != null && (
        <p>
          已用 <span className="tnum text-ink">{quota.used}</span> /{" "}
          <span className="tnum text-ink">{quota.limit}</span>
          {quota.remaining != null && (
            <>
              {" "}· 剩余 <span className="tnum font-medium text-teal">{quota.remaining}</span>
            </>
          )}
          {quota.plan != null && <span className="text-ash">（{quota.plan}）</span>}
        </p>
      )}
      {quota.used == null && quota.limit == null && quota.balance != null && (
        <p>
          账户余额 <span className="tnum text-ink">{quota.balance}</span> 元
          {quota.plan != null && <span className="text-ash">（{quota.plan}）</span>}
        </p>
      )}
      {quota.note != null && <p className="text-ash">{quota.note}</p>}
      {quota.resetsAt != null && quota.resetsAt > Date.now() && (
        <p className="text-ash">额度 {new Date(quota.resetsAt).toLocaleString()} 重置。</p>
      )}
      {!isCreate && (
        <p className="text-ash">本机本月经这个工作台调用 {localUsage} 次（{providerId}）。</p>
      )}
    </div>
  );
}
