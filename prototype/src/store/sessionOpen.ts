import { asUnitId } from "../core/units.ts";
import { dispatchTerminal } from "../adapters/daemon/client.ts";
import { useShell } from "./useShell.ts";
import { useTerminalStore } from "./useTerminalStore.ts";
import { useWorkbench } from "./useWorkbench.ts";

/**
 * 会话打开入口（docs/31 迁移收口）—— 侧栏 / 新建会话页 / 历史弹窗共用的
 * 「给 bot 开新 TUI」单源。派发前登记 pending（useTerminalStore），防止
 * created 帧在途期间被重复派发（双进程竞态）。
 */

/** bot 主绑定执行器（bindings.primary 优先，回落全局当前）—— TerminalPanel boundExecutor 同款口径 */
export function boundExecutorOf(unit: { bindings: ReadonlyArray<{ primary?: boolean; runtimeId: string }> }): string {
  const wb = useWorkbench.getState();
  const binding = unit.bindings.find((b) => b.primary) ?? unit.bindings[0];
  const rid = binding?.runtimeId;
  if (rid === undefined || rid === "") return wb.activeRuntimeId;
  return (
    wb.runtimes.find((r) => r.id === rid)?.id ??
    wb.runtimes.find((r) => r.id === `daemon:${rid}`)?.id ??
    wb.activeRuntimeId
  );
}

/** 在该 bot 的工作空间直接起一个绑定执行器的全新 TUI（「新建会话」的终端形态） */
export function openNewTuiForUnit(unit: {
  id: string;
  name: string;
  rootPath: string;
  bindings: ReadonlyArray<{ primary?: boolean; runtimeId: string }>;
}): void {
  const bare = boundExecutorOf(unit).replace(/^daemon:/, "");
  if (bare === "") return;
  const wb = useWorkbench.getState();
  if (String(wb.activeUnitId) !== String(unit.id)) wb.selectUnit(asUnitId(unit.id));
  useTerminalStore.getState().notePendingUnitDispatch(unit.id);
  void dispatchTerminal({ unitId: unit.id, unitName: unit.name, rootPath: unit.rootPath, runtimeId: bare })
    .then(() => {
      useShell.getState().setMainView("chat");
    })
    .catch((err: unknown) => console.error("[sessionOpen] 新建 TUI 派发失败:", err));
}
