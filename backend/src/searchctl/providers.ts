/**
 * 搜索提供商适配器注册表 —— 一家一个 def，daemon 侧统一执行（密钥不进桥、不进浏览器）。
 *
 * 接入依据（2026-10-24 逐家官方文档核实）：
 * - tavily：POST api.tavily.com/search（Bearer tvly-…；search_depth basic/fast/advanced）；
 *   余量 GET api.tavily.com/usage → key.{usage,limit}（免费层每月 1,000 credits，月 1 日重置）。
 * - deepseek：独立 Search API POST api.deepseek.com/v1/tools/search（Bearer sk-…；count 1–50）；
 *   余额 GET api.deepseek.com/user/balance（搜索无分项，只有账户总余额）；
 *   免费期至 2026-11-01（北京时间），之后 $0.75/千次。
 * - doubao（豆包搜索 Custom 版）：POST open.feedcoopapi.com/search_api/web_search
 *   （Bearer 搜索控制台 key，≠ 方舟 ARK key；字段 PascalCase：Query/SearchType/Count）；
 *   每火山账号每月 500 次免费，无公开余量 API（超额报 10406/10412）。
 * - yuanbao（元宝搜索 / 腾讯云联网搜索 API，wsa）：POST api.wsa.cloud.tencent.com/SearchPro
 *   （Bearer 服务 API KEY，sk- 开头；字段 PascalCase：Query/Cnt）。⚠ 响应的 Pages 是
 *   **JSON 字符串数组**，每个元素要二次 JSON.parse（官方文档明示的坑）。
 *   每账号每月 2000 次免费（活动期可提至 6000），超出极速版 14 元/千次；
 *   无公开余量 API（用量看控制台监控页）。另有官方 remote MCP（/Mcp，同 key）。
 *
 * 加新家 = 往 SEARCH_PROVIDERS 里加一个 def（core/search.ts 的 SearchProviderId 同步扩）。
 */
import type { SearchProviderId, SearchQuotaSnapshot } from "../../../prototype/src/core/search.ts";

/** 统一的搜索结果行（各家报文归一；text 是给模型的最终成品） */
export interface SearchExecution {
  readonly text: string;
  readonly resultCount: number;
  readonly provider: SearchProviderId;
}

export interface SearchArgs {
  readonly apiKey: string;
  readonly query: string;
  /** 1–10（桥侧已收窄） */
  readonly maxResults: number;
}

export type QuotaArgs = { readonly apiKey: string };

export interface SearchProviderDef {
  readonly id: SearchProviderId;
  readonly label: string;
  readonly keyHint: string;
  readonly docsUrl: string;
  readonly freeTierNote: string;
  /** 有余量/余额查询 API 才是 true（doubao 没有 → UI 只显本机计数） */
  readonly quotaSupported: boolean;
  search(args: SearchArgs): Promise<SearchExecution>;
  quota(args: QuotaArgs): Promise<SearchQuotaSnapshot>;
}

// ---- 公共件 ------------------------------------------------------------------------

const SEARCH_TIMEOUT_MS = 25_000;
const QUOTA_TIMEOUT_MS = 12_000;

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 非 2xx 时提取各家的错误说明（拿不到就给状态码） */
function apiError(provider: string, status: number, body: unknown): Error {
  const b = body as {
    message?: unknown;
    error?: unknown;
    ResponseMetadata?: { Error?: { Message?: unknown; Code?: unknown } };
  } | null;
  const errObj = b !== null && typeof b.error === "object" && b.error !== null
    ? (b.error as { message?: unknown })
    : undefined;
  const msg =
    (typeof b?.error === "string" ? b.error : undefined) ??
    (typeof errObj?.message === "string" ? errObj.message : undefined) ??
    (typeof b?.message === "string" ? b.message : undefined) ??
    (typeof b?.ResponseMetadata?.Error?.Message === "string"
      ? `${b.ResponseMetadata.Error.Message}（code=${String(b.ResponseMetadata.Error.Code ?? "?")}）`
      : undefined);
  return Object.assign(new Error(`${provider} API HTTP ${status}${msg !== undefined ? `：${msg}` : ""}`), {
    code: status === 401 || status === 403 ? "bad_key" : "provider_error",
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 下个月 1 日 00:00（本地时区）——「每月重置」口径的通用换算 */
function nextMonthlyReset(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
}

/** 摘要裁剪：保头去尾 + 省略号（各家的 snippet/summary 长度口径不一，统一成模型友好的一段） */
function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text.trim() : "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

interface NormalRow {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly date?: string | null;
  readonly site?: string | null;
}

/** 归一结果行 → 给模型的文本（标题/链接/摘要逐条列，日期与站点有则带） */
function formatRows(provider: string, rows: readonly NormalRow[], answer?: string | null): SearchExecution {
  const parts: string[] = [];
  if (answer !== undefined && answer !== null && answer.trim() !== "") {
    parts.push(`【直接答案】${answer.trim()}`);
    parts.push("");
  }
  if (rows.length === 0) {
    parts.push("（没有搜到结果——换个更具体的词，或去掉过窄的限定再试）");
    return { text: parts.join("\n"), resultCount: 0, provider: provider as SearchProviderId };
  }
  rows.forEach((r, i) => {
    const meta = [r.date ?? null, r.site ?? null].filter((x) => x !== null && x !== "").join(" · ");
    parts.push(`${i + 1}. ${r.title}`);
    parts.push(`   ${r.url}`);
    if (meta !== "") parts.push(`   ${meta}`);
    parts.push(`   ${r.snippet}`);
    parts.push("");
  });
  return { text: parts.join("\n").trimEnd(), resultCount: rows.length, provider: provider as SearchProviderId };
}

// ---- tavily ------------------------------------------------------------------------

const tavily: SearchProviderDef = {
  id: "tavily",
  label: "Tavily",
  keyHint: "tvly- 开头（tavily.com 控制台创建）",
  docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  freeTierNote: "免费层每月 1,000 credits（basic 1 credit/次、advanced 2；每月 1 日重置）",
  quotaSupported: true,
  async search({ apiKey, query, maxResults }) {
    const { status, body } = await fetchJson(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: Math.min(20, Math.max(1, maxResults)),
          include_answer: "basic",
        }),
      },
      SEARCH_TIMEOUT_MS,
    );
    if (status !== 200) throw apiError("Tavily", status, body);
    const b = body as { answer?: unknown; results?: unknown } | null;
    const rows: NormalRow[] = Array.isArray(b?.results)
      ? (b!.results as Record<string, unknown>[]).map((r) => ({
        title: str(r.title) ?? "(无标题)",
        url: str(r.url) ?? "",
        snippet: clip(r.content, 500),
        date: str(r.published_date),
      }))
      : [];
    return formatRows("tavily", rows, str(b?.answer));
  },
  async quota({ apiKey }) {
    const { status, body } = await fetchJson(
      "https://api.tavily.com/usage",
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      QUOTA_TIMEOUT_MS,
    );
    if (status !== 200) throw apiError("Tavily", status, body);
    const b = body as {
      key?: { usage?: unknown; limit?: unknown };
      account?: { current_plan?: unknown };
    } | null;
    const used = num(b?.key?.usage);
    const limit = num(b?.key?.limit); // null = 该 key 无上限
    return {
      provider: "tavily",
      ok: true,
      plan: str(b?.account?.current_plan),
      used,
      limit,
      remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null,
      balance: null,
      resetsAt: nextMonthlyReset(),
      note: null,
      fetchedAt: Date.now(),
    } satisfies SearchQuotaSnapshot;
  },
};

// ---- deepseek ----------------------------------------------------------------------

/** DeepSeek Search 的免费期终点（北京时间 2026-11-01 00:00）——之后 $0.75/千次 */
const DEEPSEEK_BILLING_START = Date.parse("2026-11-01T00:00:00+08:00");

const deepseek: SearchProviderDef = {
  id: "deepseek",
  label: "DeepSeek 搜索",
  keyHint: "sk- 开头（platform.deepseek.com 创建，与 chat API 同一把 key）",
  docsUrl: "https://api-docs.deepseek.com/guides/search",
  freeTierNote: "免费期至 2026-11-01，之后 $0.75/千次（仅成功请求计费）",
  quotaSupported: true,
  async search({ apiKey, query, maxResults }) {
    const { status, body } = await fetchJson(
      "https://api.deepseek.com/v1/tools/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        // query 上限 128 字符（官方口径：超长属于坏请求）
        body: JSON.stringify({ query: query.slice(0, 128), count: Math.min(50, Math.max(1, maxResults)) }),
      },
      SEARCH_TIMEOUT_MS,
    );
    if (status !== 200) throw apiError("DeepSeek", status, body);
    const b = body as { results?: unknown } | null;
    const rows: NormalRow[] = Array.isArray(b?.results)
      ? (b!.results as Record<string, unknown>[]).map((r) => ({
        title: str(r.title) ?? "(无标题)",
        url: str(r.url) ?? "",
        snippet: clip(r.summary ?? r.snippet, 600),
        date: str(r.date),
        site: str(r.site_name),
      }))
      : [];
    return formatRows("deepseek", rows);
  },
  async quota({ apiKey }) {
    // 搜索无分项余额：查的是账户总余额（CNY）。免费期内不扣费，金额只作参考。
    const { status, body } = await fetchJson(
      "https://api.deepseek.com/user/balance",
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      QUOTA_TIMEOUT_MS,
    );
    if (status !== 200) throw apiError("DeepSeek", status, body);
    const b = body as { is_available?: unknown; balance_infos?: unknown } | null;
    const info = Array.isArray(b?.balance_infos)
      ? (b!.balance_infos as Record<string, unknown>[]).find((x) => x.currency === "CNY") ??
        (b!.balance_infos as Record<string, unknown>[])[0]
      : undefined;
    const freeNow = Date.now() < DEEPSEEK_BILLING_START;
    return {
      provider: "deepseek",
      ok: true,
      plan: freeNow ? "免费期" : null,
      used: null,
      limit: null,
      remaining: null,
      balance: str(info?.total_balance),
      resetsAt: null,
      // 余额数字由 balance 字段承载（UI 单独成行），note 只说计费口径，不重复数字
      note: freeNow
        ? "免费期内不扣费；2026-11-01 起计费（$0.75/千次，仅成功请求）"
        : "按次计费 $0.75/千次；搜索与 chat 共用账户余额（无搜索分项）",
      fetchedAt: Date.now(),
    } satisfies SearchQuotaSnapshot;
  },
};

// ---- doubao（豆包搜索 Custom 版）----------------------------------------------------

const doubao: SearchProviderDef = {
  id: "doubao",
  label: "豆包搜索",
  keyHint: "豆包搜索控制台（console.volcengine.com/search-infinity）创建——不是方舟 ARK key",
  docsUrl: "https://www.volcengine.com/docs/87772/2272953",
  freeTierNote: "每火山账号每月 500 次免费（月 1 日重置），超出 0.02 元/次",
  quotaSupported: false, // 无公开余量 API，用量只在控制台看
  async search({ apiKey, query, maxResults }) {
    const { status, body } = await fetchJson(
      "https://open.feedcoopapi.com/search_api/web_search",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        // Custom 版字段 PascalCase；Query 超长官方口径是截断到 100
        body: JSON.stringify({
          Query: query.slice(0, 100),
          SearchType: "web",
          Count: Math.min(50, Math.max(1, maxResults)),
        }),
      },
      SEARCH_TIMEOUT_MS,
    );
    // 业务错误（含超额 10406/10412）走 200 + ResponseMetadata.Error，先验货再验码
    const b = body as { ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } }; Result?: { WebResults?: unknown } } | null;
    const err = b?.ResponseMetadata?.Error;
    if (err !== undefined && err !== null && String(err.Code ?? "") !== "") {
      throw Object.assign(
        new Error(`豆包搜索业务错误：${String(err.Message ?? "")}（code=${String(err.Code)}；10406/10412 = 免费额度用尽，去控制台看用量）`),
        { code: String(err.Code).startsWith("104") ? "quota_exhausted" : "provider_error" },
      );
    }
    if (status !== 200) throw apiError("豆包搜索", status, body);
    const rows: NormalRow[] = Array.isArray(b?.Result?.WebResults)
      ? ((b!.Result!.WebResults as Record<string, unknown>[]).map((r) => ({
        title: str(r.Title) ?? "(无标题)",
        url: str(r.Url) ?? "",
        snippet: clip(r.Summary ?? r.Snippet, 600),
        date: str(r.PublishTime),
        site: str(r.SiteName),
      })))
      : [];
    return formatRows("doubao", rows);
  },
  async quota() {
    // 无余量 API：这个分支不该被调到（service 侧按 quotaSupported 短路）
    throw Object.assign(new Error("豆包搜索没有余量查询 API（用量见控制台）"), { code: "unsupported" });
  },
};

// ---- yuanbao（元宝搜索 / 腾讯云联网搜索 API，wsa）----------------------------------

/**
 * Query 上限 1500 UTF-8 字节（官方口径）。按最坏 4 字节/字符保守裁到 370 字符
 * ——搜索词远短于此，精确字节裁剪不值得为它引入 Buffer 循环。
 */
const YUANBAO_QUERY_MAX_CHARS = 370;

const yuanbao: SearchProviderDef = {
  id: "yuanbao",
  label: "元宝搜索",
  keyHint: "sk- 开头（腾讯云控制台 → 元宝搜索/联网搜索API → 服务 API KEY，注意不是云 API 的 SecretId/SecretKey）",
  docsUrl: "https://cloud.tencent.com/document/product/1806",
  freeTierNote: "每账号每月 2000 次免费（活动期凭邀请码可提至 6000）；超出极速版 14 元/千次（标准 20 / 旗舰 26）",
  quotaSupported: false, // API 概览只有 SearchPro 一个接口，无 Describe 类；用量看控制台监控页
  async search({ apiKey, query, maxResults }) {
    const { status, body } = await fetchJson(
      "https://api.wsa.cloud.tencent.com/SearchPro",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8", authorization: `Bearer ${apiKey}` },
        // 不带 Cnt：极速版对条数参数支持有限，默认 5~10 条刚好落在我们的 1–10 区间
        body: JSON.stringify({ Query: query.slice(0, YUANBAO_QUERY_MAX_CHARS) }),
      },
      SEARCH_TIMEOUT_MS,
    );
    // 腾讯云系：业务错误在 200 的 Response.Error 里（UnauthorizedOperation=key 错、
    // ResourceNotFound=未开通、ResourceUnavailable=欠费、RequestLimitExceeded=超频）
    const resp = (body as { Response?: { Error?: { Code?: unknown; Message?: unknown } } } | null)?.Response;
    const err = resp?.Error;
    if (err !== undefined && err !== null && String(err.Code ?? "") !== "") {
      const code = String(err.Code);
      throw Object.assign(
        new Error(`元宝搜索业务错误：${String(err.Message ?? "")}（code=${code}；ResourceNotFound=服务未开通、UnauthorizedOperation=key 无效）`),
        { code: code === "UnauthorizedOperation" ? "bad_key" : "provider_error" },
      );
    }
    if (status !== 200) throw apiError("元宝搜索", status, body);
    // ⚠ Pages 是 JSON 字符串数组：每个元素要二次 parse（官方文档口径）
    const pages = (resp as { Pages?: unknown } | undefined)?.Pages;
    const rows: NormalRow[] = Array.isArray(pages)
      ? pages
          .flatMap((p) => {
            try {
              const r = JSON.parse(typeof p === "string" ? p : JSON.stringify(p)) as Record<string, unknown>;
              return [{
                title: str(r.title) ?? "(无标题)",
                url: str(r.url) ?? "",
                snippet: clip(r.passage ?? r.content, 600),
                date: str(r.date),
                site: str(r.site),
              }];
            } catch {
              return []; // 单条坏字符串不毒化整页结果
            }
          })
          .slice(0, maxResults)
      : [];
    return formatRows("yuanbao", rows);
  },
  async quota() {
    // 无余量 API：这个分支不该被调到（service 侧按 quotaSupported 短路）
    throw Object.assign(new Error("元宝搜索没有余量查询 API（用量见控制台监控页）"), { code: "unsupported" });
  },
};

// ---- 注册表 ------------------------------------------------------------------------

export const SEARCH_PROVIDERS: readonly SearchProviderDef[] = [tavily, deepseek, doubao, yuanbao];

export function findSearchProvider(id: string): SearchProviderDef | null {
  return SEARCH_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** UI 目录（core/search.ts 的 SearchProviderInfo 形状，剥掉函数面） */
export const SEARCH_PROVIDER_INFOS: readonly {
  id: SearchProviderId;
  label: string;
  keyHint: string;
  docsUrl: string;
  freeTierNote: string;
  quotaSupported: boolean;
}[] = SEARCH_PROVIDERS.map(({ id, label, keyHint, docsUrl, freeTierNote, quotaSupported }) => ({
  id,
  label,
  keyHint,
  docsUrl,
  freeTierNote,
  quotaSupported,
}));
