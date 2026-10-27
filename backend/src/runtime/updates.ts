/**
 * 执行器新版本检测（docs/27）——「轻量增强」版的新版本感知层。
 *
 * 升级动作本身不动（设置页「升级」按钮仍把升级命令派发到内置终端可见执行，
 * PROVIDER_INSTALL_GUIDES 是命令事实源），这里只补缺失的一半：**知道有新版本了**。
 *
 * 设计口径（对齐 T3 Code 的 maintenanceResolver 思路，按本项目哲学裁剪）：
 * - **当前版本由前端传入**（params.current）：探测状态活在前端 runtimeRegistry
 *   （启动一次性探测），daemon 侧没有缓存、也**不做启动探测**（index.ts 刻意
 *   不做启动预热的同一决策）——无 spawn、按需付费。
 * - **daemon 只拥有网络面**：npm registry / PyPI 查 latest，内存 + 磁盘缓存
 *   （<homeDir>/updates-cache.json）TTL 1 小时，force 直查。
 * - 检测源表是白名单：没登记的执行器（zcode/agy/…）不检测、不产生噪音。
 *
 * 比对是启发式 semver：CLI 版本串五花八门（"2.0.1 (Claude Code)" / "v1.2.3"），
 * 取第一段 \d+.\d+.\d+ 数值比；解析不出就诚实报 unknown，不猜。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";

export type ExecutorUpdateSource =
  /** npm registry（registry.npmjs.org/<pkg>/latest） */
  | { readonly kind: "npm"; readonly pkg: string }
  /** PyPI JSON API（pypi.org/pypi/<pkg>/json） */
  | { readonly kind: "pypi"; readonly pkg: string };

/** 检测源白名单：键为裸执行器 id（小写）。没登记 = 不检测。 */
export const EXECUTOR_UPDATE_SOURCES: Readonly<Record<string, ExecutorUpdateSource>> = {
  claude: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
  codex: { kind: "npm", pkg: "@openai/codex" },
  cursor: { kind: "npm", pkg: "cursor-agent" },
  "cursor-agent": { kind: "npm", pkg: "cursor-agent" },
  openclaw: { kind: "npm", pkg: "openclaw" },
  opencode: { kind: "npm", pkg: "opencode-ai" },
  pi: { kind: "npm", pkg: "@earendil-works/pi-coding-agent" },
  mcode: { kind: "npm", pkg: "@minimax/mcode" },
  kimi: { kind: "npm", pkg: "@moonshot-ai/kimi-code" },
  dsh: { kind: "npm", pkg: "@deepseek-ai/dsh" },
  grok: { kind: "npm", pkg: "@xai-official/grok" },
  hermes: { kind: "pypi", pkg: "hermes-agent" },
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export type ExecutorUpdateState = "current" | "behind" | "unknown";

export interface ExecutorUpdateItem {
  readonly runtimeId: string;
  readonly current: string;
  readonly latest: string | null;
  readonly state: ExecutorUpdateState;
  /** 检测源描述（"npm @openai/codex"），徽标悬停/排查用 */
  readonly source: string;
}

export interface ExecutorUpdatesReport {
  readonly checkedAt: number;
  readonly items: readonly ExecutorUpdateItem[];
  readonly hasUpdates: boolean;
}

/** 第一段 semver（major.minor.patch，容忍前缀 v 与后缀文字） */
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/;

export function extractSemver(version: string): [number, number, number, number] | null {
  const m = SEMVER_RE.exec(version);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
}

/** a < b 返回 -1，a > b 返回 1，相等 0。任一侧解析不出返回 null（不敢比） */
export function compareVersions(a: string, b: string): number | null {
  const va = extractSemver(a);
  const vb = extractSemver(b);
  if (va === null || vb === null) return null;
  for (let i = 0; i < 4; i++) {
    if (va[i]! < vb[i]!) return -1;
    if (va[i]! > vb[i]!) return 1;
  }
  return 0;
}

interface LatestCacheEntry {
  readonly latest: string | null;
  readonly checkedAt: number;
}

interface LatestCacheFile {
  readonly entries?: Record<string, LatestCacheEntry>;
}

export class ExecutorUpdatesChecker {
  private readonly cache = new Map<string, LatestCacheEntry>();
  private readonly inflight = new Map<string, Promise<LatestCacheEntry>>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly homeDir: string) {
    void this.loadDisk();
  }

  private async loadDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.homeDir, "updates-cache.json"), "utf8")) as LatestCacheFile;
      if (parsed !== null && typeof parsed === "object" && parsed.entries !== null && typeof parsed.entries === "object") {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v !== null && typeof v === "object" && typeof v.latest !== "undefined" && typeof v.checkedAt === "number") {
            this.cache.set(k, v as LatestCacheEntry);
          }
        }
      }
    } catch {
      /* 无文件/坏文件：从零开始 */
    }
  }

  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const entries: Record<string, LatestCacheEntry> = {};
      for (const [k, v] of this.cache) entries[k] = v;
      void mkdir(this.homeDir, { recursive: true })
        .then(() => writeFile(path.join(this.homeDir, "updates-cache.json"), JSON.stringify({ entries }), "utf8"))
        .catch(() => undefined);
    }, 500);
  }

  private async fetchLatest(src: ExecutorUpdateSource): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      if (src.kind === "npm") {
        const res = await fetch(`https://registry.npmjs.org/${src.pkg}/latest`, { signal: controller.signal });
        if (!res.ok) return null;
        const body = (await res.json()) as { version?: unknown };
        return typeof body.version === "string" ? body.version : null;
      }
      const res = await fetch(`https://pypi.org/pypi/${src.pkg}/json`, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { info?: { version?: unknown } };
      return typeof body.info?.version === "string" ? body.info.version : null;
    } catch {
      return null; // 超时/网络不通/JSON 坏：报 unknown，不炸 RPC
    } finally {
      clearTimeout(timer);
    }
  }

  /** 单家 latest：缓存命中（TTL 内）直取，否则单飞网络查（并发去重） */
  private async latestOf(runtimeId: string, src: ExecutorUpdateSource, force: boolean): Promise<LatestCacheEntry> {
    const cached = this.cache.get(runtimeId);
    const now = Date.now();
    if (!force && cached !== undefined && now - cached.checkedAt < CACHE_TTL_MS) return cached;
    const running = this.inflight.get(runtimeId);
    if (running !== undefined) return running;
    const p = this.fetchLatest(src)
      .then((latest) => {
        const entry: LatestCacheEntry = { latest, checkedAt: Date.now() };
        this.cache.set(runtimeId, entry);
        this.persist();
        return entry;
      })
      .finally(() => {
        if (this.inflight.get(runtimeId) === p) this.inflight.delete(runtimeId);
      });
    this.inflight.set(runtimeId, p);
    return p;
  }

  /**
   * 检测：current 是前端传来的「裸执行器 id → 当前版本串」清单（只放 ready 的）。
   * 没在检测源白名单里的 id 直接忽略（不产生 unknown 噪音项）。
   */
  async check(current: Readonly<Record<string, string>>, force: boolean): Promise<ExecutorUpdatesReport> {
    const ids = Object.keys(current).filter((id) => EXECUTOR_UPDATE_SOURCES[id] !== undefined);
    const items = await Promise.all(
      ids.map(async (id): Promise<ExecutorUpdateItem> => {
        const src = EXECUTOR_UPDATE_SOURCES[id]!;
        const cur = current[id] ?? "";
        const { latest } = await this.latestOf(id, src, force);
        const cmp = latest === null ? null : compareVersions(cur, latest);
        const state: ExecutorUpdateState = cmp === null ? "unknown" : cmp < 0 ? "behind" : "current";
        return {
          runtimeId: id,
          current: cur,
          latest,
          state,
          source: src.kind === "npm" ? `npm ${src.pkg}` : `pypi ${src.pkg}`,
        };
      }),
    );
    if (force && items.length > 0) {
      log.debug("[executor-updates] 已强制刷新检测", { count: items.length });
    }
    return { checkedAt: Date.now(), items, hasUpdates: items.some((i) => i.state === "behind") };
  }
}
