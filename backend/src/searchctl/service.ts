/**
 * 搜索服务 —— bot 级联网搜索的编排核心（docs 口径对齐 ctrl 两兄弟，但作用域 per-bot）。
 *
 * 职责：
 * - 密钥存储：`<homeDir>/search-keys.json`，按 botId 分槽（明文与 image-profiles
 *   同级信任——daemon 家目录是本机私有领地；支持 `env:NAME` 引用，resolveSecret 统一解析）。
 *   **不进 bot.json**：工作区目录会被 git/push 带出去，密钥落那里在形态上就可能泄漏
 *   （渠道密钥「只填变量名」的同一条教训）。
 * - 身份解析：桥只带着会话 cwd 来（dsh 带 --root），daemon 按「rootPath == cwd 或其
 *   祖先、取最深匹配」定位 bot——全局一条 workbench-search 条目由此做到按 bot 开关。
 * - 条目协调：有任一存活 bot 配置了搜索 → 桥条目扇出进全部执行器原生配置；
 *   一个都没有 → 条目入停用库。boot 时对齐（桥脚本端口变了按 hash 重装）。
 * - 配额：有余量 API 的家 60s 缓存快照；没有的（豆包）显式 quotaSupported=false。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {
  SearchBotStatus,
  SearchOverview,
  SearchProviderId,
  SearchQuotaSnapshot,
} from "../../../prototype/src/core/search.ts";
import type { AcpMcpServer, ControlFanoutOutcome, McpServerEntry } from "../contract.ts";
import type { Store } from "../store/db.ts";
import type { BotDefinition } from "../bots/registry.ts";
import { log } from "../log.ts";
import { resolveSecret } from "../secrets.ts";
import { controlActions, daemonHttpPort, logControlAction } from "../ctrl/store.ts";
import { MCP_EXECUTORS, MCP_UNSUPPORTED_EXECUTORS, wrapCmd } from "../mcpadmin/executors.ts";
import { mcpRemove, mcpSave, type McpServiceDeps } from "../mcpadmin/service.ts";
import { SEARCH_PROVIDER_INFOS, findSearchProvider } from "./providers.ts";
import { ensureBridgeScript } from "./bridge.ts";

/** 写进各执行器原生配置的 MCP 条目名（与 playwright / workbench-computer 同一命名域） */
export const SEARCH_ENTRY_NAME = "workbench-search";

/** 配额快照缓存窗口：两家都是低频接口（Tavily usage 还有 10 次/10 分钟的限速实测） */
const QUOTA_CACHE_MS = 60_000;

interface BotSearchEntry {
  readonly provider: SearchProviderId;
  /** 字面量或 `env:NAME` 引用；解析在用的时候做（改 .env 立即生效） */
  readonly apiKey: string;
  readonly updatedAt: number;
}

type KeyStoreShape = { bots: Record<string, BotSearchEntry> };

/** 本机用量计数（kv）：<botId> → { "YYYY-MM": 次数 }；只数经桥的调用 */
type UsageShape = Record<string, Record<string, number>>;

export interface SearchServiceDeps extends McpServiceDeps {
  readonly store: Store;
  /** 注册表实时扫描（无缓存口径与 bot.list 一致） */
  readonly listBots: () => Promise<BotDefinition[]>;
}

/** 冒烟注入：覆写提供商解析（假 provider 打编排链路，不打真实 API） */
export interface CreateSearchServiceOpts {
  readonly providerOverride?: (id: string) => import("./providers.ts").SearchProviderDef | null;
}

export function createSearchService(deps: SearchServiceDeps, opts: CreateSearchServiceOpts = {}) {
  const lookupProvider = opts.providerOverride ?? findSearchProvider;
  // ---- 密钥存储 -----------------------------------------------------------------

  const keyStorePath = join(deps.stateHome, "search-keys.json");

  function readKeyStore(): KeyStoreShape {
    if (!existsSync(keyStorePath)) return { bots: {} };
    try {
      const parsed = JSON.parse(readFileSync(keyStorePath, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { bots: {} };
      const bots = (parsed as { bots?: unknown }).bots;
      if (bots === null || typeof bots !== "object" || Array.isArray(bots)) return { bots: {} };
      return { bots: bots as Record<string, BotSearchEntry> };
    } catch {
      // 坏文件 fail-open 回空表（显示层照常）；下次显式保存时覆写修复
      return { bots: {} };
    }
  }

  function writeKeyStore(shape: KeyStoreShape): void {
    mkdirSync(dirname(keyStorePath), { recursive: true });
    const tmp = `${keyStorePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape, null, 2) + "\n", "utf8");
    renameSync(tmp, keyStorePath);
  }

  // ---- 本机用量计数（kv）----------------------------------------------------------

  const USAGE_KEY = "search_usage_v1";

  function readUsage(): UsageShape {
    const raw = deps.store.kvGet(USAGE_KEY);
    if (raw === undefined) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as UsageShape)
        : {};
    } catch {
      return {};
    }
  }

  function monthKey(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function usageOf(botId: string): number {
    return readUsage()[botId]?.[monthKey()] ?? 0;
  }

  function countUsage(botId: string): void {
    const all = readUsage();
    const perBot = all[botId] ?? {};
    const mk = monthKey();
    perBot[mk] = (perBot[mk] ?? 0) + 1;
    all[botId] = perBot;
    // 只留当前月：计数是「这个月用了多少」的口径，历史月没有消费面
    const trimmed: UsageShape = {};
    for (const [id, months] of Object.entries(all)) {
      if (months[mk] !== undefined) trimmed[id] = { [mk]: months[mk]! };
    }
    deps.store.kvSet(USAGE_KEY, JSON.stringify(trimmed));
  }

  // ---- bot 定位与配置读取 -----------------------------------------------------------

  /** cwd → 注册 bot 的最深匹配（rootPath == cwd 或是其祖先）；找不到 null */
  async function resolveBotByPath(target: string): Promise<BotDefinition | null> {
    const abs = resolvePath(target);
    const bots = await deps.listBots();
    let best: BotDefinition | null = null;
    let bestLen = -1;
    for (const b of bots) {
      const root = typeof b.rootPath === "string" ? b.rootPath : "";
      if (root === "") continue;
      const r = resolvePath(root);
      if (abs !== r && !abs.startsWith(r + "\\") && !abs.startsWith(r + "/")) continue;
      // 深度按路径段数：嵌套注册时取最内层那个
      const len = r.split(/[\\/]/).filter((s) => s !== "").length;
      if (len > bestLen) {
        best = b;
        bestLen = len;
      }
    }
    return best;
  }

  async function botById(botId: string): Promise<BotDefinition> {
    const bots = await deps.listBots();
    const hit = bots.find((b) => b.id === botId);
    if (hit === undefined) {
      throw Object.assign(new Error(`bot "${botId}" 不存在`), { code: "not_found" });
    }
    return hit;
  }

  /** 已解析（env: 已展开）的可用密钥；未配置/解析为空 → null */
  function resolvedKeyOf(entry: BotSearchEntry | undefined): string | null {
    if (entry === undefined) return null;
    const key = resolveSecret(entry.apiKey).trim();
    return key === "" ? null : key;
  }

  function configuredEntry(botId: string): { entry: BotSearchEntry; key: string } | null {
    const entry = readKeyStore().bots[botId];
    const key = resolvedKeyOf(entry);
    if (entry === undefined || key === null) return null;
    return { entry, key };
  }

  /** 配了多少存活 bot（孤儿槽不算——bot 删了，它的搜索配置不再驱动条目扇出） */
  async function configuredBotIds(): Promise<string[]> {
    const store = readKeyStore();
    const bots = await deps.listBots();
    return bots.filter((b) => typeof b.id === "string" && configuredEntry(b.id) !== null).map((b) => String(b.id));
  }

  // ---- 配额（60s 缓存）--------------------------------------------------------------

  const quotaCache = new Map<string, SearchQuotaSnapshot>();

  function quotaCacheKey(provider: SearchProviderId, key: string): string {
    return `${provider}:${key.slice(0, 8)}…${key.slice(-4)}`;
  }

  async function fetchQuota(provider: SearchProviderId, key: string, force: boolean): Promise<SearchQuotaSnapshot> {
    const def = lookupProvider(provider);
    if (def === null) throw Object.assign(new Error(`未知搜索提供商：${provider}`), { code: "bad_params" });
    if (!def.quotaSupported) {
      throw Object.assign(new Error(`${def.label} 没有余量查询 API（用量见其控制台）`), { code: "unsupported" });
    }
    const ck = quotaCacheKey(provider, key);
    const cached = quotaCache.get(ck);
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < QUOTA_CACHE_MS) return cached;
    let snap: SearchQuotaSnapshot;
    try {
      snap = await def.quota({ apiKey: key });
    } catch (e) {
      // 快照也缓存失败（含错误文本）：60s 内重开页面不至于连环打限速接口
      snap = {
        provider,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        fetchedAt: Date.now(),
      };
    }
    quotaCache.set(ck, snap);
    return snap;
  }

  // ---- 状态组装 ---------------------------------------------------------------------

  function maskKey(key: string): string {
    if (key.length <= 8) return `${key.slice(0, 2)}••••`;
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }

  function statusOf(bot: BotDefinition): SearchBotStatus {
    const botId = String(bot.id ?? "");
    const hit = configuredEntry(botId);
    return {
      botId,
      botName: String(bot.name ?? botId),
      rootPath: typeof bot.rootPath === "string" ? bot.rootPath : "",
      configured: hit !== null,
      provider: hit?.entry.provider ?? null,
      apiKeySet: hit !== null,
      apiKeyMasked: hit !== null ? maskKey(hit.key) : null,
      localUsageMonth: usageOf(botId),
      // 配额不在这里现查（会让 status 变慢接口）；前端另调 search.quota 异步补
      quota: hit !== null && lookupProvider(hit.entry.provider)?.quotaSupported === true
        ? quotaCache.get(quotaCacheKey(hit.entry.provider, hit.key)) ?? null
        : null,
    };
  }

  // ---- 条目扇出 / 回收 ----------------------------------------------------------------

  let lastFanout: ControlFanoutOutcome[] = [];
  /** 最近一次对账的意图（装 or 收）——回收时 not_found 也记 ok，只看 outcomes 会误报「已写入」 */
  let lastInstallIntent = false;

  function bridgeEntry(): McpServerEntry {
    return {
      name: SEARCH_ENTRY_NAME,
      transport: "stdio",
      command: "node",
      args: [ensureBridgeScript(deps.stateHome, daemonHttpPort()).path],
    };
  }

  async function fanoutEntry(install: boolean): Promise<ControlFanoutOutcome[]> {
    const outcomes: ControlFanoutOutcome[] = [];
    const entry = bridgeEntry();
    for (const def of MCP_EXECUTORS) {
      try {
        if (install) await mcpSave(deps, def.id, entry);
        else await mcpRemove(deps, def.id, SEARCH_ENTRY_NAME, { toVault: true });
        outcomes.push({ executorId: def.id, ok: true });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!install && code === "not_found") outcomes.push({ executorId: def.id, ok: true });
        else outcomes.push({ executorId: def.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    logControlAction(
      "search",
      install ? "entry.write" : "entry.remove",
      `${SEARCH_ENTRY_NAME} 条目：${outcomes.filter((o) => o.ok).length}/${outcomes.length} 家${install ? "写入" : "移入停用库"}`,
    );
    return outcomes;
  }

  /** 对账：有配置的存活 bot ≥1 → 装；0 → 收。configure / boot 后调用。 */
  async function reconcile(): Promise<ControlFanoutOutcome[]> {
    const ids = await configuredBotIds();
    lastInstallIntent = ids.length > 0;
    lastFanout = await fanoutEntry(lastInstallIntent);
    return lastFanout;
  }

  // ---- 对外动作 -----------------------------------------------------------------------

  async function sessionTools(p: { cwd?: unknown; root?: unknown }): Promise<{ tools: string[] }> {
    const target = typeof p.root === "string" && p.root !== "" ? p.root : typeof p.cwd === "string" ? p.cwd : "";
    if (target === "") return { tools: [] };
    const bot = await resolveBotByPath(target);
    if (bot === null) return { tools: [] };
    return { tools: configuredEntry(String(bot.id ?? "")) !== null ? ["web_search"] : [] };
  }

  async function query(p: {
    cwd?: unknown;
    root?: unknown;
    query?: unknown;
    maxResults?: unknown;
  }): Promise<{ text: string; resultCount: number; provider: SearchProviderId }> {
    const q = typeof p.query === "string" ? p.query.trim() : "";
    if (q === "") throw Object.assign(new Error("query 必须是非空字符串"), { code: "bad_params" });
    const target = typeof p.root === "string" && p.root !== "" ? p.root : typeof p.cwd === "string" ? p.cwd : "";
    if (target === "") {
      throw Object.assign(new Error("缺 cwd / root：无法定位这是哪个工作区的搜索"), { code: "bad_params" });
    }
    const maxResults = typeof p.maxResults === "number" && p.maxResults >= 1 ? Math.min(10, Math.round(p.maxResults)) : 5;
    const bot = await resolveBotByPath(target);
    if (bot === null) {
      throw Object.assign(
        new Error("当前目录不属于任何注册 bot（搜索按 bot 配置，先在工作台把它注册为 bot 并配置搜索）"),
        { code: "search_not_configured" },
      );
    }
    const botId = String(bot.id ?? "");
    const hit = configuredEntry(botId);
    if (hit === null) {
      throw Object.assign(
        new Error(`bot「${String(bot.name ?? botId)}」未配置搜索：在工作台 → bot 设置 → 搜索里选择提供商并填入密钥`),
        { code: "search_not_configured" },
      );
    }
    const def = lookupProvider(hit.entry.provider);
    if (def === null) throw Object.assign(new Error(`未知提供商：${hit.entry.provider}`), { code: "bad_params" });
    const t0 = Date.now();
    try {
      const r = await def.search({ apiKey: hit.key, query: q, maxResults });
      countUsage(botId);
      logControlAction("search", "tool.web_search", `bot ${String(bot.name ?? botId)} · ${def.label} · 「${q.slice(0, 60)}」 · ${r.resultCount} 条 · ${Date.now() - t0}ms`);
      return { text: r.text, resultCount: r.resultCount, provider: r.provider };
    } catch (e) {
      logControlAction("search", "tool.web_search", `bot ${String(bot.name ?? botId)} · ${def.label} · 「${q.slice(0, 60)}」 · 失败：${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  async function status(p: { botId?: unknown }): Promise<SearchBotStatus> {
    if (typeof p.botId !== "string" || p.botId === "") {
      throw Object.assign(new Error("botId 必填"), { code: "bad_params" });
    }
    return statusOf(await botById(p.botId));
  }

  async function quota(p: { botId?: unknown; provider?: unknown; apiKey?: unknown; force?: unknown }): Promise<SearchQuotaSnapshot> {
    // 两种口径：{botId}（用已存密钥）或 {provider, apiKey}（草稿密钥，保存前预检）
    if (typeof p.botId === "string" && p.botId !== "") {
      const hit = configuredEntry((await botById(p.botId)).id ?? p.botId);
      if (hit === null) throw Object.assign(new Error("这个 bot 还没配置搜索密钥"), { code: "not_configured" });
      return fetchQuota(hit.entry.provider, hit.key, p.force === true);
    }
    const provider = typeof p.provider === "string" ? p.provider : "";
    const apiKeyRaw = typeof p.apiKey === "string" ? p.apiKey : "";
    if (provider === "" || apiKeyRaw === "") {
      throw Object.assign(new Error("quota 需要 {botId} 或 {provider, apiKey}"), { code: "bad_params" });
    }
    const key = resolveSecret(apiKeyRaw).trim();
    if (key === "") throw Object.assign(new Error("密钥是 env: 引用但没解析到值（.env / 环境变量里没有）"), { code: "bad_key" });
    return fetchQuota(provider as SearchProviderId, key, true);
  }

  async function configure(p: { botId?: unknown; provider?: unknown; apiKey?: unknown }): Promise<SearchBotStatus> {
    if (typeof p.botId !== "string" || p.botId === "") throw Object.assign(new Error("botId 必填"), { code: "bad_params" });
    const provider = typeof p.provider === "string" ? p.provider : "";
    if (provider !== "none" && lookupProvider(provider) === null) {
      throw Object.assign(new Error(`未知提供商：${provider}（可选：tavily / deepseek / doubao / yuanbao / none）`), { code: "bad_params" });
    }
    await botById(p.botId); // 不存在直接 not_found
    const shape = readKeyStore();
    const prev = shape.bots[p.botId];
    if (provider === "none") {
      delete shape.bots[p.botId];
      writeKeyStore(shape);
      logControlAction("search", "configure", `bot ${p.botId} 关闭搜索（密钥槽删除）`);
    } else {
      // 密钥语义：undefined = 不动；"" = 清除；非空 = 替换。
      // 换提供商且没显式给 key → 清掉旧 key（key 是按家发的，留着必错）
      const switched = prev !== undefined && prev.provider !== provider;
      const apiKey =
        typeof p.apiKey === "string"
          ? p.apiKey.trim()
          : switched
            ? ""
            : prev?.apiKey ?? "";
      shape.bots[p.botId] = { provider: provider as SearchProviderId, apiKey, updatedAt: Date.now() };
      writeKeyStore(shape);
      logControlAction(
        "search",
        "configure",
        `bot ${p.botId} → ${provider}${apiKey === "" ? "（未存密钥）" : ""}${switched && typeof p.apiKey !== "string" ? "，换家已清旧密钥" : ""}`,
      );
    }
    await reconcile();
    return statusOf(await botById(p.botId));
  }

  async function overview(): Promise<SearchOverview> {
    const bots = await deps.listBots();
    const { path: bridge } = ensureBridgeScript(deps.stateHome, daemonHttpPort());
    return {
      providers: SEARCH_PROVIDER_INFOS,
      bots: bots.map(statusOf),
      bridgePath: bridge,
      entryInstalled: lastInstallIntent && lastFanout.some((o) => o.ok),
      fanout: lastFanout,
      notes: [
        ...MCP_UNSUPPORTED_EXECUTORS.map((u) => ({
          executorId: u.id,
          note: u.id === "dsh" ? "MCP 随会话动态注入（按会话工作区带 --root）" : u.reason,
        })),
      ],
      actions: controlActions().filter((a) => a.domain === "search").slice(-50),
    };
  }

  /** dsh（ACP session/new）注入：这个 rootPath 的 bot 配了搜索才有条目 */
  function acpEntries(rootPath: string | undefined): AcpMcpServer[] {
    if (rootPath === undefined || rootPath === "") return [];
    // 同步判定（dsh 注入在会话建立的热路径上，不 await 磁盘扫描）：
    // 桥自己会再问一次 daemon（tools/list 按 cwd/root 精确收口），这里宁可宽松
    if (Object.keys(readKeyStore().bots).length === 0) return [];
    const entry = wrapCmd(bridgeEntry());
    // cmd /c 包装时 --root 追加在尾部也是 node 之后的脚本参数，两种形态等价
    return [{ name: entry.name, command: entry.command, args: [...(entry.args ?? []), "--root", rootPath] }];
  }

  async function boot(): Promise<void> {
    // 桥脚本对齐（端口烘焙进内容，hash 变了自动重装）+ 条目对账
    await reconcile();
    log.info("search service reconciled", { bridge: bridgePathOf() });
  }

  function bridgePathOf(): string {
    return join(deps.stateHome, "mcp", "search-bridge.mjs");
  }

  return {
    sessionTools,
    query,
    status,
    quota,
    configure,
    overview,
    acpEntries,
    boot,
    reconcile,
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
