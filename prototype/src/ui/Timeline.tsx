import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useAppearance } from "../store/useAppearance.ts";
import { useShell } from "../store/useShell.ts";
import { botAvatarStyle } from "./Sidebar.tsx";
import { cn } from "./cn.ts";
import { ChatViewport } from "./chat/ChatViewport.tsx";

/**
 * 时间线 —— Personal Agent 归一化事件流渲染层。
 *
 * 全面升级为现代对话架构（对齐 ZCode v4、DeepSeek、Hermes）：
 * 1. 双段虚拟化架构（Settled History 虚拟滚动 + LiveTail 活跃单元独立渲染）
 * 2. 意图感知滚动引擎（useChatScroll）与未读流式呼吸 FAB 回底按钮
 * 3. 专用语义工具卡片（Bash、FileDiff、Search、Generic）与文件交付物聚合
 * 4. DeepSeek 式流式思考微光摘要（ReasoningShimmerBlock）与计时秒表
 * 5. 对话内全局 Ctrl+F 检索条（InChatFindBar）与高亮导航
 * 6. 轮次大纲微型导览条（TurnNavigator）
 * 7. 划词交互快捷工具栏（SelectionTooltip）
 */
export function Timeline() {
  const timeline = useWorkbench((s) => s.timeline);
  const busy = useWorkbench((s) => s.busy);
  const unit = useWorkbench(selectActiveUnit);
  const sessions = useWorkbench((s) => s.sessions);
  const runtimes = useWorkbench((s) => s.runtimes);
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);

  return (
    <ChatViewport
      timeline={timeline}
      busy={busy}
      unit={unit}
      sessions={sessions}
      runtimes={runtimes}
      chatColumnWidth={chatColumnWidth}
    />
  );
}

/* ------------------------------------------------------------- 空态 */

/**
 * 对话空态主角（头像 + 问候 + 交代任务提示）。由 WorkspaceShell 渲染为对话列
 * 上的绝对定位覆盖层（固定预留居中，与输入区高度解耦）
 */
export function EmptyState() {
  const unit = useWorkbench(selectActiveUnit);
  const avatarFrame = useAppearance((s) => s.avatarFrame);

  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? "夜深了"
      : hour < 9
        ? "早上好"
        : hour < 12
          ? "上午好"
          : hour < 14
            ? "中午好"
            : hour < 18
              ? "下午好"
              : "晚上好";

  const avatar = unit ? botAvatarStyle(unit.name, avatarFrame) : null;

  return (
    <div className="flex flex-col items-center select-none">
      {unit && (
        unit.avatar ? (
          <img
            src={unit.avatar}
            alt=""
            className={cn("mb-3 h-14 w-14 object-cover shadow-subtle", avatar?.shape)}
          />
        ) : (
          <div
            className={cn(
              "mb-3 flex h-14 w-14 items-center justify-center bg-line-soft text-body-lg font-medium text-graphite shadow-subtle",
              avatar?.shape,
            )}
          >
            {unit.name.slice(0, 1)}
          </div>
        )
      )}
      <p className="text-caption text-ash">{greeting}</p>
      <p className="mt-1 text-body-lg font-medium text-ink">
        {!unit ? "选一个 bot 开始" : `向「${unit.name}」交代任务`}
      </p>
      <p className="mt-1 text-body-sm text-graphite">
        {!unit
          ? "新建一个 bot —— 指向已有文件夹即为认领（原地注册）"
          : unit.identity?.role
            ? `已装载岗位：${unit.identity.role} · 读 AGENTS.md`
            : "从对话或快捷任务开始"}
      </p>
    </div>
  );
}
