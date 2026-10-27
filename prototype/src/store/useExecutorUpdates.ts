/**
 * 执行器新版本检测（docs/27）的前端状态面。
 *
 * 数据流：useWorkbench.runtimes（启动一次性探测的注册表）收出「裸执行器 id →
 * 当前版本」→ adapter.updates RPC → daemon 查 npm/PyPI latest（缓存 1h）比对 →
 * 报告落本 store。三个消费位：
 * - 侧栏设置入口红点（`hasUnseenUpdates(report, dismissed)` 为真时亮）
 * - 设置页「执行器与模型」顶部 banner（N 个执行器有新版本 + 重新检查）
 * - 执行器卡片「有新版本 vX.Y.Z」徽标与升级按钮高亮
 *
 * 消隐（dismiss）是纯呈现态：按「落后集合指纹」记 localStorage + store，新版本
 * 出现（指纹变化）红点自动再亮——与 T3 的 per-version dismissal 同思路。
 */

import { create } from "zustand";
import { fetchExecutorUpdates, type ExecutorUpdatesReport } from "../adapters/daemon/client.ts";
import { useWorkbench } from "./useWorkbench.ts";

const DISMISS_STORAGE_KEY = "awb-executor-updates-dismissed";

/** 落后集合指纹：`runtimeId@latest` 排序拼接 —— 任一家升到新版本指纹即变 */
export function behindFingerprint(report: ExecutorUpdatesReport | null): string {
  if (report === null) return "";
  return report.items
    .filter((i) => i.state === "behind")
    .map((i) => `${i.runtimeId}@${i.latest ?? "?"}`)
    .sort()
    .join(",");
}

/** 红点判据：有落后项且用户尚未消隐这一批（指纹未变过） */
export function hasUnseenUpdates(report: ExecutorUpdatesReport | null, dismissed: string): boolean {
  if (report === null || !report.hasUpdates) return false;
  const fp = behindFingerprint(report);
  return fp !== "" && dismissed !== fp;
}

function loadDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface ExecutorUpdatesStore {
  report: ExecutorUpdatesReport | null;
  checking: boolean;
  /** 当前已消隐的落后集合指纹（镜像 localStorage，保持组件可订阅） */
  dismissed: string;
  /** 幂等刷新：ready 执行器的当前版本从 useWorkbench.runtimes 收集后送 daemon 比对 */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  /** 用户点开设置（看到 banner）即消隐当前这批；新版本出现指纹变化自动再亮 */
  dismissCurrent: () => void;
}

export const useExecutorUpdates = create<ExecutorUpdatesStore>((set, get) => ({
  report: null,
  checking: false,
  dismissed: loadDismissed(),
  refresh: async (opts) => {
    // 只送 ready 且有版本号的：not_installed/unprobed 送去也只能得到 unknown 噪音
    const current: Record<string, string> = {};
    for (const r of useWorkbench.getState().runtimes) {
      if (r.state.status === "ready" && r.state.version !== undefined && r.state.version !== "") {
        current[r.id.replace(/^daemon:/, "").toLowerCase()] = r.state.version;
      }
    }
    if (Object.keys(current).length === 0) {
      set({ report: null });
      return;
    }
    if (get().checking) return;
    set({ checking: true });
    try {
      const report = await fetchExecutorUpdates(current, opts?.force === true);
      set({ report });
    } catch {
      // 检测是增强不是功能路径：失败静默（下次打开设置页/手动刷新重试）
    } finally {
      set({ checking: false });
    }
  },
  dismissCurrent: () => {
    const fp = behindFingerprint(get().report);
    if (fp === "") return;
    set({ dismissed: fp });
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, fp);
    } catch {
      /* 隐私模式等存储不可用：本会话内红点消隐仍生效 */
    }
  },
}));

// 启动一次性检测（延迟到启动探测大体收敛之后；红点据此点亮）。
// daemon 侧 latest 有 1h 缓存，这里即使每次启动都调，网络面也是按小时计的。
setTimeout(() => {
  void useExecutorUpdates.getState().refresh();
}, 12_000);
