import { create } from "zustand";
import type { InboxConfig, InboxEntry, InboxSignal } from "../core/inbox.ts";
import {
  addInboxEntry,
  deleteInboxEntry,
  fetchInbox,
  reclassifyInboxEntry,
  runInboxClassify,
  setInboxConfigRpc,
  updateInboxEntry,
} from "../adapters/daemon/client.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";

/**
 * 清单（inbox）store —— 权威数据全在 daemon（state.db），这里是运行态视图 +
 * 信号路由。信号帧（entries/state/notice）由本 store 统一接，清单页从这里读，
 * 不重复订阅。与 useBacklog 同一套口径。
 */

interface InboxState {
  entries: readonly InboxEntry[];
  config: InboxConfig | null;
  /** 分类器状态：分类中（routing 会话跑着）/ 最近一轮结果 */
  classifier: { readonly classifying: boolean; readonly lastOutcome: string | null } | null;
  /** 页面级通知（操作成败的一行实话），5 秒自动消失由页面处理 */
  notice: { readonly kind: "error" | "info" | "success"; readonly text: string } | null;
  setNotice: (n: { readonly kind: "error" | "info" | "success"; readonly text: string } | null) => void;
  /** 从 daemon 重拉全量（启动、信号 entries、每次写操作后） */
  refresh: () => Promise<void>;
  /** 信号帧入口（main.tsx 里绑定到 DaemonClient.onInboxSignal） */
  handleSignal: (s: InboxSignal) => void;

  add: (input: { text: string; category?: string | null; hints?: import("../core/inbox.ts").InboxHints }) => Promise<boolean>;
  updateText: (id: number, text: string) => Promise<boolean>;
  setCategory: (id: number, category: string | null) => Promise<boolean>;
  saveHints: (id: number, hints: import("../core/inbox.ts").InboxHints | null) => Promise<boolean>;
  remove: (id: number) => Promise<void>;
  classifyNow: () => Promise<void>;
  reclassify: (id: number) => Promise<void>;
  saveConfig: (patch: Record<string, unknown>) => Promise<boolean>;
}

export const useInbox = create<InboxState>((set, get) => ({
  entries: [],
  config: null,
  classifier: null,
  notice: null,

  setNotice: (notice) => set({ notice }),

  refresh: async () => {
    try {
      const r = await fetchInbox(defaultDaemonEndpoint());
      set({ entries: r.entries, config: r.config, classifier: r.classifier });
    } catch (err: unknown) {
      // daemon 没起是正常态（与 useBacklog.refresh 同口径）：留痕不打断
      console.info("[inbox] 清单拉取失败", err instanceof Error ? err.message : err);
    }
  },

  handleSignal: (s) => {
    switch (s.kind) {
      case "entries":
        void get().refresh();
        break;
      case "state":
        set({ classifier: { classifying: s.classifying, lastOutcome: s.lastOutcome } });
        if (s.classifying) void get().refresh();
        break;
      case "notice":
        set({ notice: { kind: s.level === "warn" ? "error" : s.level, text: s.text } });
        break;
    }
  },

  add: async (input) => {
    try {
      await addInboxEntry(input, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `写入失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  updateText: async (id, text) => {
    try {
      await updateInboxEntry(id, { text }, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `保存失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  setCategory: async (id, category) => {
    try {
      await updateInboxEntry(id, { category }, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `改分类失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  saveHints: async (id, hints) => {
    try {
      await updateInboxEntry(id, { hints: hints ?? undefined }, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `保存预置字段失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  remove: async (id) => {
    try {
      await deleteInboxEntry(id, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `删除失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  classifyNow: async () => {
    try {
      await runInboxClassify(defaultDaemonEndpoint());
      set({ notice: { kind: "info", text: "已交给 routing 分类（会话要跑几十秒，完成自动刷新）" } });
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `触发失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  reclassify: async (id) => {
    try {
      await reclassifyInboxEntry(id, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `重新分类失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  saveConfig: async (patch) => {
    try {
      const r = await setInboxConfigRpc(patch, defaultDaemonEndpoint());
      set({ config: r.config });
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `配置保存失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },
}));

/** 把 inbox 信号帧接进 daemon 客户端（main.tsx 挂载时调用一次） */
export function bindInboxSignals(): () => void {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  const off = client.onInboxSignal((s) => useInbox.getState().handleSignal(s));
  // 启动拉一次全量
  void useInbox.getState().refresh();
  return off;
}
