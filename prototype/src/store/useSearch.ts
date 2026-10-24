/**
 * 搜索的数据层 —— bot 设置「搜索」分区与全局设置「搜索」分区的唯一 RPC 封装处。
 *
 * 口径沿用 useControl：DaemonClient 单例 + rpc<T>，UI 本地 state + 按需拉取，
 * 不进全局 zustand（数据只在分区打开时有用）。密钥只在 configure 的请求里出现，
 * 响应侧永远是掩码——浏览器不持有明文。
 */
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";
import type {
  SearchBotStatus,
  SearchOverview,
  SearchProviderId,
  SearchProviderInfo,
  SearchQuotaSnapshot,
} from "../core/search.ts";

function rpc<T>(method: string, params: unknown = null, timeoutMs = 60_000): Promise<T> {
  return DaemonClient.get(defaultDaemonEndpoint()).rpc<T>(method, params, timeoutMs);
}

export function fetchSearchProviders(): Promise<SearchProviderInfo[]> {
  return rpc<SearchProviderInfo[]>("search.providers");
}

export function fetchSearchOverview(): Promise<SearchOverview> {
  return rpc<SearchOverview>("search.overview");
}

export function fetchSearchStatus(botId: string): Promise<SearchBotStatus> {
  return rpc<SearchBotStatus>("search.status", { botId });
}

/**
 * 配置一个 bot 的搜索。apiKey 语义与 daemon 一致：undefined = 不动已存密钥、
 * "" = 清除、非空 = 替换（支持 env:NAME 引用）。
 */
export function configureSearch(
  botId: string,
  provider: SearchProviderId | "none",
  apiKey?: string,
): Promise<SearchBotStatus> {
  return rpc<SearchBotStatus>("search.configure", {
    botId,
    provider,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
}

/** 已存密钥的余量快照（daemon 侧 60s 缓存；force 绕过——Tavily usage 有限速，别高频刷） */
export function fetchSearchQuota(botId: string, force = false): Promise<SearchQuotaSnapshot> {
  return rpc<SearchQuotaSnapshot>("search.quota", { botId, ...(force ? { force: true } : {}) }, 30_000);
}

/** 草稿密钥预检（保存前用：直接按 provider+key 问，不动 bot 配置） */
export function probeSearchQuota(
  provider: SearchProviderId,
  apiKey: string,
): Promise<SearchQuotaSnapshot> {
  return rpc<SearchQuotaSnapshot>("search.quota", { provider, apiKey }, 30_000);
}
