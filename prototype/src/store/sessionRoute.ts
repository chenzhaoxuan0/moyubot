/**
 * 会话路由层（2026-10-27，参照 T3code「路由即会话身份」的混合实现）：
 *
 * hash 是 (unit, session) 身份的镜像，store（useWorkbench）仍是渲染事实源——
 * 现有切换代码（openSession / selectUnit / 各处 set）一行不改，本模块在旁边做四件事：
 *
 *   1. 镜像：activeUnitId / activeSessionId 变化 → pushState 改 hash（150ms 去抖，
 *      selectUnit + openSession 一串异步 set 只落一条历史，后退不会经过中间态）；
 *   2. 后退/前进：popstate → 解析 hash → selectUnit / openSession 回放目标会话，
 *      浏览器历史免费充当切换历史（ZCode 为此手写了 taskNavigationHistory）；
 *   3. 启动恢复：启动时按 hash 回放一次 —— 刷新 / 重开 / 深链落回上次会话；
 *   4. 快捷键：Alt+← / Alt+→ = history.back / forward。
 *
 * hash 形态：#/u/<unitId> 或 #/u/<unitId>/s/<sessionId>；无单元时 #/。
 * 只编码会话身份 —— mainView / conversationView 等视图态仍归 useShell，
 * 路由回放时把它们带回聊天页（与点击历史行的行为一致）。
 */

import { useWorkbench } from "./useWorkbench.ts";
import { useShell } from "./useShell.ts";
import { asSessionId, asUnitId } from "../core/units.ts";

interface RouteTarget {
  readonly unitId: string;
  readonly sessionId: string | null;
}

function encodeHash(t: RouteTarget | null): string {
  if (t === null || t.unitId === "") return "#/";
  return t.sessionId === null
    ? `#/u/${encodeURIComponent(t.unitId)}`
    : `#/u/${encodeURIComponent(t.unitId)}/s/${encodeURIComponent(t.sessionId)}`;
}

function parseHash(hash: string): RouteTarget | null {
  const m = /^#\/u\/([^/]+)(?:\/s\/(.+))?$/.exec(hash);
  if (m === null) return null;
  return {
    unitId: decodeURIComponent(m[1]!),
    sessionId: m[2] !== undefined ? decodeURIComponent(m[2]) : null,
  };
}

function currentTarget(): RouteTarget | null {
  const s = useWorkbench.getState();
  if (s.activeUnitId === null) return null;
  return {
    unitId: String(s.activeUnitId),
    sessionId: s.activeSessionId === null ? null : String(s.activeSessionId),
  };
}

/** 目标是否就是当前 store 状态（是则回放无事可做） */
function isCurrent(target: RouteTarget): boolean {
  const s = useWorkbench.getState();
  return (
    String(s.activeUnitId) === target.unitId &&
    (target.sessionId === null
      ? s.activeSessionId === null
      : String(s.activeSessionId) === target.sessionId)
  );
}

/**
 * 回放一个路由目标：切单元 →（有会话则）openSession → 带回聊天页。
 * runtimeId 从 daemon 台账查（openSession 必填，而路由里只有两个 id）。
 */
async function applyTarget(target: RouteTarget): Promise<void> {
  let wb = useWorkbench.getState();
  if (wb.units.find((u) => String(u.id) === target.unitId) === undefined) {
    // 单元还没加载 / 已注销：popstate 场景不动现状；boot 场景由等待循环重试
    return;
  }
  if (String(wb.activeUnitId) !== target.unitId) {
    wb.selectUnit(asUnitId(target.unitId));
    wb = useWorkbench.getState();
  }
  if (target.sessionId === null) return;

  const { fetchSessions, defaultDaemonEndpoint } = await import("../adapters/daemon/client.ts");
  let runtimeId: string | undefined;
  try {
    const rows = await fetchSessions(defaultDaemonEndpoint());
    runtimeId = rows.find((r) => String(r.id) === target.sessionId)?.runtimeId;
  } catch {
    /* daemon 抖动：下面 openSession 会给出更具体的提示 */
  }
  if (runtimeId === undefined) {
    wb.pushNotice("路由恢复失败", `台账里没有会话 ${target.sessionId}，或执行器不可用。`, { level: "warn" });
    return;
  }
  await wb.openSession({
    sessionId: asSessionId(target.sessionId),
    unitId: asUnitId(target.unitId),
    runtimeId,
  });
  if (String(useWorkbench.getState().activeSessionId) === target.sessionId) {
    const sh = useShell.getState();
    sh.setMainView("chat");
    sh.setConversationView("chat");
  }
}

let started = false;
/** popstate / 启动恢复驱动的变更不走镜像推送（hash 已经是目标值，再 push 会多一条历史） */
let syncingFromHistory = false;
/** 启动恢复完成前不做镜像推送：boot 早期 store 还是「无单元」空态，推 #/ 会盖掉待恢复的 hash */
let bootSettled = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function initSessionRoute(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // ① 镜像：store → hash（150ms 去抖合并一次用户动作触发的一串 set）
  const schedulePush = (): void => {
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (syncingFromHistory || !bootSettled) return;
      const next = encodeHash(currentTarget());
      if (next === window.location.hash) return;
      try {
        window.history.pushState(null, "", next);
      } catch {
        /* 非 standard 浏览上下文：镜像失败不影响功能本身 */
      }
    }, 150);
  };
  useWorkbench.subscribe(() => {
    if (!syncingFromHistory) schedulePush();
  });

  // ② 后退/前进：hash → store
  window.addEventListener("popstate", () => {
    const target = parseHash(window.location.hash);
    if (target === null || isCurrent(target)) return;
    syncingFromHistory = true;
    void applyTarget(target).finally(() => {
      syncingFromHistory = false;
      schedulePush();
    });
  });

  // ③ 启动恢复：等目标单元加载（最长 15s，300ms 一探），再回放一次
  void (async () => {
    const target = parseHash(window.location.hash);
    if (target !== null) {
      const deadline = Date.now() + 15_000;
      while (
        !useWorkbench.getState().units.some((u) => String(u.id) === target.unitId) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!isCurrent(target)) {
        syncingFromHistory = true;
        try {
          await applyTarget(target);
        } finally {
          syncingFromHistory = false;
        }
      }
    }
    bootSettled = true;
    schedulePush(); // 恢复期间被用户抢先操作过的场景：以 store 现值对齐一次 hash
  })();

  // ④ Alt+← / → 前进后退（Electron / 浏览器一致的键盘入口）。
  //    聚焦可编辑元素时让行：macOS 的 Option+方向键是逐词跳转，全局劫持会毁掉输入体验
  window.addEventListener("keydown", (ev) => {
    if (!ev.altKey || ev.defaultPrevented) return;
    const t = ev.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")
    ) {
      return;
    }
    if (ev.key === "ArrowLeft") window.history.back();
    else if (ev.key === "ArrowRight") window.history.forward();
  });
}
