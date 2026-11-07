import { create } from "zustand";
import type {
  BacklogConfig,
  BacklogItem,
  BacklogProposal,
  BacklogStateSnapshot,
  QuotaHeadroom,
  QuotaResumeConfig,
} from "../core/backlog.ts";
import {
  answerBacklogItem,
  confirmBacklogProposal,
  createBacklogItem,
  deleteBacklogItem,
  fetchBacklog,
  fetchBacklogQuotas,
  forceHeartbeat,
  rejectBacklogProposal,
  reorderBacklog,
  reviewBacklogItem,
  runBacklogConsolidate,
  runBacklogNow,
  setBacklogConfigRpc,
  setForceBusy,
  sleepBacklogItem,
  updateBacklogItem,
  wakeBacklogItem,
  fetchQuotaResumeState,
  type BacklogWriteInput,
  type QuotaResumeStateRow,
} from "../adapters/daemon/client.ts";
import { DaemonClient, defaultDaemonEndpoint } from "../adapters/daemon/client.ts";

/**
 * 待办（GTD）store —— 权威数据全在 daemon（state.db），这里是运行态视图 +
 * 信号路由。信号帧（proposal/settled/state/items/notice）由本 store 统一接，
 * ProposalBanner / 状态点 / 清单页都从这里读，各自不重复订阅。
 */

interface BacklogState {
  items: readonly BacklogItem[];
  proposal: BacklogProposal | null;
  state: BacklogStateSnapshot | null;
  config: BacklogConfig | null;
  quotas: readonly QuotaHeadroom[];
  /**
   * 用量续跑的判定态（谁用尽了、排没排、为什么没排）。
   * null = 还没拉到 / 拉取失败 —— 界面据此不显示这一块，而不是显示「正常」。
   */
  quotaResume: { readonly enabled: boolean; readonly config: QuotaResumeConfig; readonly states: readonly QuotaResumeStateRow[] } | null;
  /** 页面级通知（操作成败的一行实话），5 秒自动消失由页面处理 */
  notice: { readonly kind: "error" | "info" | "success"; readonly text: string } | null;
  setNotice: (n: { readonly kind: "error" | "info" | "success"; readonly text: string } | null) => void;
  /** 从 daemon 重拉全量（启动、信号 items、每次写操作后） */
  refresh: () => Promise<void>;
  /** 信号帧入口（main.tsx 里绑定到 DaemonClient.onBacklogSignal） */
  handleSignal: (s: import("../core/backlog.ts").BacklogSignal) => void;

  createItem: (input: BacklogWriteInput) => Promise<boolean>;
  updateItem: (id: number, patch: BacklogWriteInput) => Promise<boolean>;
  deleteItem: (id: number) => Promise<void>;
  reorder: (ids: readonly number[]) => Promise<void>;
  wake: (id: number) => Promise<void>;
  sleep: (id: number) => Promise<void>;
  /** 确认提议（弹窗里可改选执行器） */
  confirmProposal: (params: { runtimeId?: string; model?: string | null }) => Promise<void>;
  rejectProposal: () => Promise<void>;
  review: (id: number, pass: boolean, note?: string) => Promise<void>;
  runNow: (id: number) => Promise<void>;
  /** 回答受阻任务（docs/33 §2）：答案暂存为追加，任务回就绪重新入列 */
  answer: (id: number, text: string) => Promise<void>;
  saveConfig: (patch: Record<string, unknown>) => Promise<boolean>;
  refreshQuotas: () => Promise<void>;
  setForceBusy: (on: boolean) => Promise<void>;
  forceBeat: () => Promise<void>;
  consolidate: () => Promise<void>;
}

export const useBacklog = create<BacklogState>((set, get) => ({
  items: [],
  proposal: null,
  state: null,
  config: null,
  quotas: [],
  quotaResume: null,
  notice: null,

  setNotice: (notice) => set({ notice }),

  refresh: async () => {
    try {
      const r = await fetchBacklog(defaultDaemonEndpoint());
      set({ items: r.items, proposal: r.proposal, state: r.state, config: r.config, quotas: r.quotas });
    } catch (err: unknown) {
      // daemon 没起是正常态（与 refreshAutomations 同口径）：留痕不打断
      console.info("[backlog] 列表拉取失败", err instanceof Error ? err.message : err);
    }
    // 续跑判定态单独拉：它是解释性信息，拿不到不该让整个待办视图降级
    try {
      set({ quotaResume: await fetchQuotaResumeState(defaultDaemonEndpoint()) });
    } catch (err: unknown) {
      console.info("[backlog] 续跑状态拉取失败", err instanceof Error ? err.message : err);
    }
  },

  handleSignal: (s) => {
    switch (s.kind) {
      case "proposal":
        set({ proposal: s.proposal });
        void get().refresh();
        break;
      case "settled":
        // 跨通道撤销：任一侧确认/拒绝/超时，弹窗立即收起
        set({ proposal: null });
        void get().refresh();
        break;
      case "state":
        set({ state: s.snapshot });
        break;
      case "items":
        void get().refresh();
        break;
      case "notice":
        set({ notice: { kind: s.level === "warn" ? "error" : s.level, text: s.text } });
        break;
    }
  },

  createItem: async (input) => {
    try {
      await createBacklogItem(input, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `创建失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  updateItem: async (id, patch) => {
    try {
      await updateBacklogItem(id, patch, defaultDaemonEndpoint());
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `保存失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  deleteItem: async (id) => {
    try {
      await deleteBacklogItem(id, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `删除失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  reorder: async (ids) => {
    try {
      await reorderBacklog(ids, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `排序失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  wake: async (id) => {
    try {
      await wakeBacklogItem(id, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `唤醒失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  sleep: async (id) => {
    try {
      await sleepBacklogItem(id, defaultDaemonEndpoint());
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `休眠失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  confirmProposal: async (params) => {
    try {
      await confirmBacklogProposal(params, defaultDaemonEndpoint());
      set({ proposal: null, notice: { kind: "success", text: "已确认，正在起执行会话" } });
      setTimeout(() => void get().refresh(), 1500);
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `确认失败：${err instanceof Error ? err.message : String(err)}` } });
      // 提议可能已被另一通道结算（先到先得）：重拉对齐
      void get().refresh();
    }
  },

  rejectProposal: async () => {
    try {
      await rejectBacklogProposal(defaultDaemonEndpoint());
      set({ proposal: null, notice: { kind: "info", text: "已拒绝 —— 这条待办进入休眠，可随时在清单唤醒" } });
      void get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `操作失败：${err instanceof Error ? err.message : String(err)}` } });
      void get().refresh();
    }
  },

  review: async (id, pass, note) => {
    try {
      await reviewBacklogItem({ id, pass, ...(note !== undefined ? { note } : {}) }, defaultDaemonEndpoint());
      set({
        notice: {
          kind: "success",
          text: pass ? "验收通过，待办已关闭" : "已打回 —— 待办回到就绪，下次心跳可再提议",
        },
      });
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `验收失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  runNow: async (id) => {
    try {
      await runBacklogNow({ id }, defaultDaemonEndpoint());
      set({ notice: { kind: "info", text: "已派发，正在起新会话" } });
      setTimeout(() => void get().refresh(), 1500);
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `立即执行失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  answer: async (id, text) => {
    try {
      await answerBacklogItem(id, text, defaultDaemonEndpoint());
      set({ notice: { kind: "success", text: "已回答 —— 任务带着答案回到就绪队列" } });
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `回答失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  saveConfig: async (patch) => {
    try {
      const r = await setBacklogConfigRpc(patch, defaultDaemonEndpoint());
      set({ config: r.config });
      await get().refresh();
      return true;
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `配置保存失败：${err instanceof Error ? err.message : String(err)}` } });
      return false;
    }
  },

  refreshQuotas: async () => {
    try {
      const r = await fetchBacklogQuotas(true, defaultDaemonEndpoint());
      set({ quotas: r.quotas });
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `余量刷新失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  setForceBusy: async (on) => {
    try {
      const r = await setForceBusy(on, defaultDaemonEndpoint());
      set({ state: r.snapshot });
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `切换失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  forceBeat: async () => {
    try {
      await forceHeartbeat(defaultDaemonEndpoint());
      set({ notice: { kind: "info", text: "已触发一跳（护栏照旧：强制忙碌/单飞会拦）" } });
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `触发失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },

  consolidate: async () => {
    try {
      const r = await runBacklogConsolidate(true, defaultDaemonEndpoint());
      set({
        notice: {
          kind: r.created > 0 ? "success" : "info",
          text: `统合完成：新收录 ${r.created} 条，合并重复 ${r.duplicates} 条（扫描 ${r.scanned} 个单元）`,
        },
      });
      await get().refresh();
    } catch (err: unknown) {
      set({ notice: { kind: "error", text: `统合失败：${err instanceof Error ? err.message : String(err)}` } });
    }
  },
}));

/** 把 backlog 信号帧接进 daemon 客户端（main.tsx 挂载时调用一次） */
export function bindBacklogSignals(): () => void {
  const client = DaemonClient.get(defaultDaemonEndpoint());
  const off = client.onBacklogSignal((s) => useBacklog.getState().handleSignal(s));
  // 启动拉一次全量
  void useBacklog.getState().refresh();
  return off;
}
