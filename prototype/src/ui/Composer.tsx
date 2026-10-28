import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  CalendarClock,
  GitBranch,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { nativeCommandsFor, useNativeCommands } from "../store/useNativeCommands.ts";
import { fetchWorkspacePaths } from "../adapters/daemon/client.ts";
import type { NativeCommandInfo } from "../core/adapter.ts";
import { isProjectUnit } from "../core/units.ts";
import { BranchPicker } from "./BranchPicker.tsx";
import { GitActionTrigger } from "./GitActionTrigger.tsx";
import { UnitSwitcher } from "./UnitSwitcher.tsx";
import { RunConfigPicker } from "./RuntimePicker.tsx";
import { PermissionModePicker } from "./PermissionModePicker.tsx";
import { ComposerContextPicker } from "./ComposerContextPicker.tsx";
import { SlashCommandMenu, filterNativeCommands } from "./SlashCommandMenu.tsx";
import { AttachmentsBar } from "./AttachmentsBar.tsx";
import { PathMentionMenu } from "./PathMentionMenu.tsx";
import { ChatTerminalToggleButton } from "./ChatTerminalDock.tsx";
import { SteerQueueCard } from "./SteerQueueCard.tsx";
import { ScheduleSendMenu } from "./ScheduleSendMenu.tsx";
import { ContextUsageBadge } from "./ContextUsageBadge.tsx";
import type { ChatAttachment } from "../core/attachments.ts";
import { MAX_ATTACHMENTS, categorizeAttachment, inferAttachmentMimeType } from "../core/attachments.ts";
import {
  type ActiveMention,
  type WorkspacePathSuggestion,
  draftWithMentionReplaced,
  resolveActiveMention,
} from "../core/workspacePaths.ts";
import { createAttachmentFromFile } from "./attachmentFile.ts";
import { useIsMobile } from "./mobile/useIsMobile.ts";
import { cn } from "./cn.ts";
import {
  QuestionnaireComposer,
  detectQuestionnaireFromTimeline,
} from "./chat/items/QuestionnaireCard.tsx";

/**
 * 输入区 —— 全页焦点元素。
 *
 * 移动端结构：
 * - 顶部卡片栏：单元文件夹名称 + 分支 (Branch) + 角色徽标
 * - 核心文本输入框 (自动高度)
 * - 底部工具栏：
 *   - 左侧：[+] 扩展菜单（斜杠指令/附件/技能） + 运行模式形式（计划模式/变更确认/自主模式/完全访问）
 *   - 右侧：执行器/模型/思考强度（合并单钮，滑动条调档） + 发送/停止按钮
 */
export function Composer({ onOpenDrawer }: { onOpenDrawer?: () => void } = {}) {
  const { isMobile } = useIsMobile();
  const chatColumnWidth = useShell((s) => s.chatColumnWidth);
  const draft = useWorkbench((s) => s.draft);
  const setDraft = useWorkbench((s) => s.setDraft);
  const run = useWorkbench((s) => s.run);
  const busy = useWorkbench((s) => s.busy);
  const pendingFork = useWorkbench((s) => s.pendingFork);
  const cancelFork = useWorkbench((s) => s.cancelFork);
  const unit = useWorkbench(selectActiveUnit);
  const activeRuntime = useWorkbench((s) => s.activeRuntimeId);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const schedRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const isSubmittingRef = useRef(false);

  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 800,
  );
  const baseH = isMobile ? 64 : 76;
  // 高度上限分端：移动端顶到导航栏下（原逻辑，方便编辑）；PC 端钳 60% 视口 ——
  // 撤回超长 prompt 回填时输入框不能把整个对话页挤没了（页面"卡死"观感的根因）
  const maxH = isMobile
    ? Math.max(baseH, Math.floor(viewportH - 170))
    : Math.max(baseH, Math.floor(viewportH * 0.6));

  const [inputHeight, setInputHeight] = useState(baseH);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  /** 定时发送弹层（[+] 菜单入口；挂在同一个锚点上，点外共用关闭逻辑） */
  const [schedOpen, setSchedOpen] = useState(false);

  // ---- ↑/↓ 输入历史（终端语义）---------------------------------------------
  // histPos：null = 未浏览；数字 = 当前停在 inputHistory 的下标（末尾 = 最新）。
  // savedDraft：进入浏览那一刻的草稿，↓ 走到头 / Esc 时还原（bash 同款）。
  const inputHistory = useWorkbench((s) => s.inputHistory);
  const [histPos, setHistPos] = useState<number | null>(null);
  const histSavedDraft = useRef("");

  const applyHistoryText = (text: string): void => {
    setDraft(text);
    setCursorOffset(text.length);
    pendingCaretRef.current = text.length;
  };

  /** 回溯/前进一条。返回 false = 无事可做（让默认光标行为走） */
  const navigateHistory = (dir: -1 | 1): boolean => {
    const hist = useWorkbench.getState().inputHistory;
    if (hist.length === 0) return false;
    if (dir === -1) {
      const next = histPos === null ? hist.length - 1 : histPos - 1;
      if (next < 0) return false; // 已到最老一条
      if (histPos === null) histSavedDraft.current = draft;
      setHistPos(next);
      applyHistoryText(hist[next]!);
      return true;
    }
    // ↓（仅浏览中可达）：向后走，走到头恢复浏览前草稿并退出
    const next = (histPos ?? 0) + 1;
    if (next > hist.length - 1) {
      setHistPos(null);
      applyHistoryText(histSavedDraft.current);
      return true;
    }
    setHistPos(next);
    applyHistoryText(hist[next]!);
    return true;
  };

  /** Esc 放弃浏览：还原浏览前草稿（terminal Ctrl+G 同款收场） */
  const exitHistory = (): void => {
    if (histPos === null) return;
    setHistPos(null);
    const back = histSavedDraft.current;
    if (back !== draft) applyHistoryText(back);
  };

  // ---- @ 路径提及（交互对齐 ZCode file-mention）----------------------------
  // 光标位置单独跟踪：@ 触发看「光标前最近的一个 @」，光标移动（点击/方向键）
  // 都要重算，不能只靠 draft 变化。
  const [cursorOffset, setCursorOffset] = useState(draft.length);
  const [mentionDismissedKey, setMentionDismissedKey] = useState<string | null>(null);
  const [mention, setMention] = useState<{
    readonly items: readonly WorkspacePathSuggestion[];
    readonly status: "loading" | "ready" | "error";
    readonly truncated: boolean;
    readonly error?: string;
  }>({ items: [], status: "loading", truncated: false });
  const [mentionIndex, setMentionIndex] = useState(0);
  /** 补全后待恢复的光标位置（受控 textarea 值替换后光标会跳到末尾） */
  const pendingCaretRef = useRef<number | null>(null);

  const handleAddFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) return;
    const toAdd = incoming.slice(0, availableSlots);
    const created: ChatAttachment[] = [];
    for (const f of toAdd) {
      try {
        const att = await createAttachmentFromFile(f);
        created.push(att);
      } catch {
        // 忽略单文件读取异常
      }
    }
    if (created.length > 0) {
      setAttachments((prev) => [...prev, ...created]);
    }
  };

  // 监听可视视口尺寸变化（支持手机端软键盘弹出缩减视口、窗口缩放）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      setViewportH(h);
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  // 点击外部关闭 [+] 菜单 / 定时发送弹层（各自独立锚点：菜单在底栏左，弹层在顶栏右）
  useEffect(() => {
    if (!plusMenuOpen && !schedOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 两个锚点各自判：点在定时发送按钮/面板里不该把 [+] 菜单也关了，反之亦然
      if (plusMenuRef.current?.contains(target) !== true) setPlusMenuOpen(false);
      if (schedRef.current?.contains(target) !== true) setSchedOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [plusMenuOpen, schedOpen]);

  // 当文字被填入时自适应加高：
  // 默认高度容纳 3~4 行；输入多行内容时持续长高，上限直顶 header 的下底边，绝不在 5 行截断或回缩
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!draft) {
      setInputHeight(baseH);
      return;
    }
    ta.style.height = `${baseH}px`;
    const scrollH = ta.scrollHeight;
    const targetH = Math.min(Math.max(scrollH, baseH), maxH);
    ta.style.height = `${targetH}px`;
    setInputHeight(targetH);
  }, [draft, isMobile, baseH, maxH]);

  // 草稿被外部填入时，把焦点交给输入框
  useEffect(() => {
    if (draft) taRef.current?.focus();
  }, [draft]);

  // 监听是否呈现斜杠命令菜单（用户在输入命令本体、尚未输入参数空格时触发）
  const hasSpace = draft.includes(" ");
  const isSlashActive = draft.startsWith("/") && !draft.includes("\n") && !hasSpace && !slashMenuDismissed;
  const slashFilter = isSlashActive ? draft.slice(1) : "";

  // ---- 执行器原生斜杠命令 --------------------------------------------------
  const bareRuntimeId = activeRuntime.startsWith("daemon:") ? activeRuntime.slice("daemon:".length) : activeRuntime;
  const commandsRoot = unit?.rootPath ?? "/";
  const nativeEntry = useNativeCommands((s) => nativeCommandsFor(s, bareRuntimeId, commandsRoot));
  const executorName =
    useWorkbench((s) => s.runtimes.find((r) => r.id === s.activeRuntimeId)?.presentation.displayName) ?? bareRuntimeId;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingOver) setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleAddFiles(e.dataTransfer.files);
    }
  };

  // 当草稿为 "/name ..."（带有空格且指令已就位）时，展示当前选定命令的原生参数提示
  const activeCommandHint = useMemo(() => {
    if (!draft.startsWith("/") || !hasSpace) return null;
    const firstWord = draft.slice(1).split(/\s+/)[0]?.toLowerCase();
    if (!firstWord) return null;
    return (
      nativeEntry.commands.find(
        (c) => c.name.toLowerCase() === firstWord || (c.aliases?.some((a) => a.toLowerCase() === firstWord) ?? false),
      ) ?? null
    );
  }, [draft, hasSpace, nativeEntry.commands]);

  useEffect(() => {
    if (bareRuntimeId) void useNativeCommands.getState().ensure(bareRuntimeId, commandsRoot);
  }, [bareRuntimeId, commandsRoot]);

  /** 选中原生命令：只把 "/name " 放进草稿（参数留给用户补），收起菜单，Enter 发送。 */
  const handleSelectNativeCommand = (cmd: NativeCommandInfo) => {
    setDraft(`/${cmd.name} `);
    setSlashMenuDismissed(true);
    taRef.current?.focus();
  };

  // ---- @ 路径提及：触发解析 + 建议（ZCode file-mention 同款语义）------------

  const activeMention: ActiveMention | undefined = useMemo(
    () => (unit?.rootPath ? resolveActiveMention(draft, cursorOffset) : undefined),
    [draft, cursorOffset, unit?.rootPath],
  );
  const mentionKey = activeMention
    ? `${activeMention.triggerIndex}:${activeMention.endOffset}:${activeMention.token}`
    : "";
  /** Esc 关的是「这一处 @ 触发」（按 @ 位置识别）：继续打字补全 token、挪光标
   *  回来都不重弹；删掉 @ 重新输入、或触发别的 @ 才恢复。键里不能掺
   *  token/endOffset —— 那样 Esc 之后多打一个字就换键，菜单立刻复活并劫持 Enter */
  const mentionDismissKey = activeMention ? String(activeMention.triggerIndex) : "";
  const mentionOpen = activeMention !== undefined && mentionDismissedKey !== mentionDismissKey;
  // 触发本身消失（删掉 @ / 光标离开这个 token）就复位 dismissal ——
  // 否则原地重打一个 @ 会因为位置相同而永远弹不出来
  useEffect(() => {
    if (activeMention === undefined && mentionDismissedKey !== null) setMentionDismissedKey(null);
  }, [activeMention, mentionDismissedKey]);

  // token 变化即拉取（上一笔 abort 掉；本地 readdir 快路径，不做防抖 —— ZCode 同款）
  useEffect(() => {
    if (!mentionOpen || !activeMention || !unit?.rootPath) return;
    const controller = new AbortController();
    // 清掉旧 token 的残余建议：加载窗口里旧列表还能被 Enter/Tab 选中（或误导
    // 点击），跟手输入必须只留当前 token 的结果
    setMention({ items: [], status: "loading", truncated: false, error: undefined });
    setMentionIndex(0);
    void fetchWorkspacePaths(unit.rootPath, activeMention.token, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setMention({ items: result.items, status: "ready", truncated: result.truncated });
        setMentionIndex(0);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setMention({
          items: [],
          status: "error",
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mentionKey 已覆盖 token/位置变化
  }, [mentionKey, mentionOpen, unit?.rootPath]);

  /** 补全 @ 提及：目录 → 落 `@dir/` 继续下钻；文件 → 加附件 + 落 `@path `（ZCode 同款） */
  const completeMention = (item: WorkspacePathSuggestion) => {
    if (!activeMention) return;
    const { draft: next, caret } = draftWithMentionReplaced(
      draft,
      activeMention,
      item.path,
      item.kind === "directory",
    );
    setDraft(next);
    setCursorOffset(caret);
    pendingCaretRef.current = caret;
    if (item.kind === "file") {
      setAttachments((prev) => {
        if (prev.length >= MAX_ATTACHMENTS) return prev;
        // 同一路径只挂一份（ZCode 按 placeholder 判重，这里按工作区相对路径）
        if (prev.some((a) => a.localPath === item.path)) return prev;
        const mimeType = inferAttachmentMimeType(item.name);
        return [
          ...prev,
          {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: item.name,
            size: item.size ?? 0,
            mimeType,
            category: categorizeAttachment(item.name, mimeType),
            // 工作区相对路径 —— 执行器 cwd 就是工作区根，按路径自读（ZCode local_ref 语义）
            localPath: item.path,
          },
        ];
      });
    }
    taRef.current?.focus();
  };

  // 受控 textarea 的值被程序替换后光标会跳到末尾，这里恢复到补全位置
  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });

  // 划词引用追问等外部事件触发输入框自动获焦
  useEffect(() => {
    const onFocus = () => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    };
    window.addEventListener("aw:focus-composer", onFocus);
    return () => window.removeEventListener("aw:focus-composer", onFocus);
  }, []);

  /** 提交输入内容："/" 开头的文本原样发给执行器（原生命令透传语义），支持仅带附件或图文混发。 */
  const submit = () => {
    if (isSubmittingRef.current) return;
    const v = draft.trim();
    if (!v && attachments.length === 0) return;
    isSubmittingRef.current = true;
    const currentAttachments = [...attachments];
    setDraft("");
    setAttachments([]);
    setSlashMenuDismissed(false);
    setPlusMenuOpen(false);
    setSchedOpen(false);
    setMentionDismissedKey(null);
    setCursorOffset(0);
    setHistPos(null);
    histSavedDraft.current = "";
    void Promise.resolve(run(v, { attachments: currentAttachments })).finally(() => {
      setTimeout(() => {
        isSubmittingRef.current = false;
      }, 300);
    });
  };

  const timeline = useWorkbench((s) => s.timeline);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const detectedQuestionnaire = useMemo(() => {
    const sessionTimeline = timeline.filter(
      (t) => "sessionId" in t.event && t.event.sessionId === activeSessionId,
    );
    return detectQuestionnaireFromTimeline(sessionTimeline);
  }, [timeline, activeSessionId]);

  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // 当切换会话时重置关闭状态
  useEffect(() => {
    setDismissedFor(null);
  }, [activeSessionId]);

  if (detectedQuestionnaire && dismissedFor !== detectedQuestionnaire.rawText) {
    return (
      <QuestionnaireComposer
        questionnaire={detectedQuestionnaire}
        onDismiss={() => setDismissedFor(detectedQuestionnaire.rawText)}
      />
    );
  }

  const placeholder = busy
    ? "上一轮仍在进行 —— 现在发送将排队，本轮完成后自动发出（可立刻发送 / 编辑 / 删除）"
    : !unit
      ? "先选一个 bot 或项目，或新建一个 bot… (输入 / 查看命令/技能/子智能体)"
      : !isProjectUnit(unit)
        ? `给「${unit.name}」派活…（可添加图片/代码附件，输入 / 调出 ${executorName} 命令面板）`
        : `对「${unit.name}」下任务…（可添加图片/代码附件，输入 / 调出 ${executorName} 命令面板）`;

  return (
    <div className="shrink-0">
      {/* 内边距与列宽联动（@container，挂在对话列 main 上）：面板/侧栏任何一列
          占宽时 Composer 按自己的实际宽度收紧，而不是按整窗宽度摆阔 —— 否则
          列已被挤窄、工具条还按宽屏规格排，溢出出横向滚动条。
          列宽与时间线阅读列共用 useShell.chatColumnWidth —— 输入框和对话永远等宽 */}
      <div
        style={{ maxWidth: chatColumnWidth }}
        className={cn("mx-auto w-full", isMobile ? "px-3 pb-2 pt-1" : "px-3 pb-4 pt-2 @min-[560px]:px-8")}
      >
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "chat-composer-box relative rounded-[20px] border bg-canvas shadow-subtle transition",
            isMobile ? "p-2.5 border-line/80 shadow-xs" : "px-4 py-3 border-line",
            "focus-within:border-teal/50 focus-within:ring-2 focus-within:ring-teal/20",
            isDraggingOver && "border-teal ring-2 ring-teal/30 bg-teal-tint/10",
          )}
        >
          {/* 隐藏的附件选择器 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleAddFiles(e.target.files);
                e.target.value = "";
              }
            }}
          />

          {/* 对话卡片顶栏：单元切换器 + 分支 (Branch) */}
          <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-1.5 px-0.5 select-none">
            <div className="flex items-center gap-2 min-w-0">
              {/* 专属 bot/项目切换面板（与 ⌘K 搜索分家）；移动端点开抽屉 */}
              <UnitSwitcher current={unit} isMobile={isMobile} onOpenDrawer={onOpenDrawer} />

              {/* 分支选择器（ZCode 同款交互，ADR 0009 窄面）：非 git 仓库时自动隐藏 */}
              <BranchPicker rootPath={unit?.rootPath} />
              {/* 落库触发器（ADR 0010 的 ②）：状态驱动图标，始终展示、干净时置灰 */}
              <GitActionTrigger rootPath={unit?.rootPath} />
            </div>

            {/* 附件数量提示 + 输入历史浏览指示 + 定时发送常驻按钮 */}
            <div className="flex items-center gap-2">
              {attachments.length > 0 && (
                <span className="text-[11px] font-medium text-teal font-mono">
                  {attachments.length}/{MAX_ATTACHMENTS} 附件
                </span>
              )}
              {histPos !== null && inputHistory.length > 0 && (
                <span
                  className="text-[11px] font-mono text-teal"
                  title="↑ 更早 · ↓ 更晚，走到头恢复浏览前的草稿；Esc 放弃并还原"
                >
                  ↑ 历史 {inputHistory.length - histPos}/{inputHistory.length}
                </span>
              )}

              {/* 定时发送 —— 顶栏右上角的常驻独立按钮。
                  原先它藏在底栏左下角的 [+] 菜单里：折叠一层的入口几乎没人会注意到，
                  功能等于不存在（「这功能我找不到」就是这么来的）。给它一个不折叠的位置。 */}
              <div className="relative" ref={schedRef}>
                <button
                  type="button"
                  onClick={() => {
                    setSchedOpen((v) => !v);
                    // 草稿为空就把光标送回输入框：面板开着照样能打字，预览实时跟着变
                    if (!isMobile && draft.trim() === "") taRef.current?.focus();
                  }}
                  aria-expanded={schedOpen}
                  aria-label="定时发送本条消息"
                  title="定时发送本条消息 —— N 分钟后或指定时刻，发到本对话"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 text-teal hover:bg-line-soft active:scale-95 transition",
                    "h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8",
                    schedOpen && "bg-teal-tint text-teal ring-1 ring-teal/30",
                  )}
                >
                  <CalendarClock size={isMobile ? 14 : 16} />
                </button>

                {/* 定时发送弹层：跟斜杠菜单 / @ 提及菜单同惯例，向上弹（不遮正在写的草稿） */}
                {schedOpen && <ScheduleSendMenu onClose={() => setSchedOpen(false)} />}
              </div>
            </div>
          </div>

          {/* 附件条：已选择的图片和文件列表 */}
          <AttachmentsBar
            attachments={attachments}
            onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
            className="mb-2"
          />

          {/* 待发送队列卡片（daemon steer 权威快照）：排队消息的可见 + 可操作面 */}
          <SteerQueueCard />

          {/* 分叉意图条（ADR 0013「意图 + 发送才建段」）：可见、可撤，取消零持久化 */}
          {pendingFork !== null && (
            <div className="mb-2 flex items-center gap-2 rounded-btn border border-teal/30 bg-teal-tint/40 px-3 py-1.5 text-caption text-graphite">
              <GitBranch size={12} className="shrink-0 text-teal" />
              <span className="min-w-0 flex-1">
                {pendingFork.kind === "branch"
                  ? "发送后将从所选回复之后分叉开启新段：新段携带此前对话的只读前缀，当前分支保留可回看"
                  : "发送后将编辑重发：在新段里替换那一轮（那轮之前保留为只读前缀；附件与工作区文件改动不回滚）"}
              </span>
              <button
                onClick={cancelFork}
                className="flex shrink-0 items-center gap-1 rounded-btn px-2 py-0.5 text-caption text-graphite transition hover:bg-line-soft hover:text-ink"
                title="放弃分叉意图（不产生任何持久化）"
              >
                <X size={12} />
                <span>取消</span>
              </button>
            </div>
          )}

          {/* 斜杠指令参数提示条（命令已选定、输入参数阶段） */}
          {activeCommandHint && !slashMenuDismissed && (
            <div className="absolute bottom-full -left-px -right-px mb-2 px-3.5 py-2 rounded-xl border border-line bg-card/95 shadow-md backdrop-blur-md flex items-center gap-2.5 text-xs animate-in fade-in duration-100 z-40">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold leading-none">
                /
              </span>
              <span className="font-mono font-bold text-ink shrink-0">/{activeCommandHint.name}</span>
              {activeCommandHint.argumentHint ? (
                <span className="font-mono text-[11px] text-teal px-1.5 py-0.5 rounded bg-teal-tint font-medium shrink-0">
                  {activeCommandHint.argumentHint}
                </span>
              ) : null}
              {activeCommandHint.description ? (
                <span className="text-graphite text-xs truncate flex-1 min-w-0">
                  {activeCommandHint.description}
                </span>
              ) : null}
            </div>
          )}

          {/* 斜杠指令弹出菜单（执行器原生命令） */}
          {isSlashActive && (
            <SlashCommandMenu
              filter={slashFilter}
              onSelect={handleSelectNativeCommand}
              onClose={() => setSlashMenuDismissed(true)}
              native={{
                commands: nativeEntry.commands,
                status: nativeEntry.status,
                error: nativeEntry.error,
                executorName,
              }}
            />
          )}

          {/* @ 路径提及弹出菜单（工作区文件/目录引用） */}
          {mentionOpen && activeMention && (
            <PathMentionMenu
              workspaceName={unit?.name ?? "单元"}
              items={mention.items}
              status={mention.status}
              truncated={mention.truncated}
              error={mention.error}
              query={activeMention.token}
              activeIndex={Math.min(mentionIndex, Math.max(0, mention.items.length - 1))}
              onSelect={completeMention}
              onHover={setMentionIndex}
              onClose={() => setMentionDismissedKey(mentionDismissKey)}
            />
          )}

          <textarea
            ref={taRef}
            value={draft}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              // 亲手改动 = 放弃历史浏览（保留改后的文本为当前草稿）
              setHistPos(null);
              setSlashMenuDismissed(false);
              setCursorOffset(e.target.selectionStart ?? e.target.value.length);
            }}
            // 光标移动（方向键/点击/选区）都要重算 @ 触发：提及看的是「光标前最近的一个 @」
            onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCursorOffset(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                void handleAddFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return;
              // @ 提及菜单开着且有可选项：↑↓ 导航，Enter/Tab 选定（焦点留在输入框）
              if (mentionOpen && mention.items.length > 0) {
                const picked = mention.items[Math.min(mentionIndex, mention.items.length - 1)];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mention.items.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mention.items.length) % mention.items.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && picked) {
                  e.preventDefault();
                  completeMention(picked);
                  return;
                }
              }
              if (e.key === "Escape" && mentionOpen) {
                setMentionDismissedKey(mentionDismissKey);
                return;
              }
              // 输入历史浏览中 Esc：还原浏览前草稿并退出
              if (e.key === "Escape" && histPos !== null && !mentionOpen) {
                e.preventDefault();
                exitHistory();
                return;
              }
              // ↑/↓ 输入历史（终端语义）：↑ 在空输入 / 行首 / 浏览中向前回溯；
              // ↓ 仅浏览中向后回，走到头恢复浏览前草稿。@ 提及菜单开着时让位。
              if (
                !mentionOpen &&
                e.key === "ArrowUp" &&
                (histPos !== null || draft.length === 0 || cursorOffset === 0) &&
                navigateHistory(-1)
              ) {
                e.preventDefault();
                return;
              }
              if (!mentionOpen && histPos !== null && e.key === "ArrowDown" && navigateHistory(1)) {
                e.preventDefault();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                const menuHasItems =
                  isSlashActive && filterNativeCommands(nativeEntry.commands, slashFilter).length > 0;
                if (!menuHasItems) {
                  e.preventDefault();
                  submit();
                }
              } else if (e.key === "Escape") {
                setSlashMenuDismissed(true);
              }
            }}
            placeholder={
              isMobile
                ? unit
                  ? `向「${unit.name}」发消息… (可传图/文件，输入 / 调命令)`
                  : "输入任务或指令… (可传图/文件，输入 / 调命令)"
                : placeholder
            }
            aria-label="任务输入"
            className={cn(
              "w-full resize-none overflow-y-auto bg-transparent text-ink !outline-none focus:!outline-none focus-visible:!outline-none focus-visible:!ring-0 placeholder:text-graphite",
              isMobile ? "text-body-sm min-h-[64px] leading-[2]" : "text-thread min-h-[76px]",
            )}
            style={{ height: `${inputHeight}px`, maxHeight: `${maxH}px`, outline: "none", boxShadow: "none" }}
          />

          {/* 拖拽上传覆盖提示 */}
          {isDraggingOver && (
            <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center rounded-[20px] bg-teal-tint/90 backdrop-blur-xs border-2 border-dashed border-teal text-teal">
              <Paperclip size={28} className="animate-bounce mb-1" />
              <span className="text-sm font-semibold">松开鼠标添加附件</span>
              <span className="text-xs opacity-75">支持图片、源代码与各类文档</span>
            </div>
          )}

          {/* 底部工具栏。压缩优先级（均为容器查询，跟对话列实际宽度）：
              文字标签先于一切让位且按次序收——完全访问（<640 隐）→ 执行器模型名
              （<480 隐，最后收，此时只剩图标）；图标钮不缩，列再窄到连图标行都
              放不下时 flex-wrap 兜底换行（右组 ml-auto 保持右对齐），而不是溢出
              出滚动条 */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
            {/* 左侧操作：[+] 扩展菜单（附件/斜杠指令/@引用） + 模式形式 (plan / accept edits / ask / bypass) */}
            <div className="flex items-center gap-1 @min-[480px]:gap-1.5 shrink-0">
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => setPlusMenuOpen((v) => !v)}
                  aria-expanded={plusMenuOpen}
                  aria-label="添加指令或附件"
                  title="添加附件、快捷指令，或 @ 引用文件"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg border border-line-soft bg-card/60 text-teal hover:bg-line-soft active:scale-95 transition",
                    "h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8",
                    plusMenuOpen && "bg-teal-tint text-teal ring-1 ring-teal/30",
                  )}
                >
                  <Plus size={isMobile ? 14 : 16} strokeWidth={2.5} />
                </button>

                {/* [+] 弹出菜单：添加附件 / 斜杠指令 / @ 引用 */}
                {plusMenuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-line bg-canvas p-1.5 shadow-xl backdrop-blur-md z-50 text-ink animate-in fade-in zoom-in-95 duration-100">
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <Paperclip size={14} className="shrink-0 text-teal" />
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">添加文件与图片附件</span>
                        <span className="block text-[10px] text-ash">支持图片、代码、文本 (最多8个)</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        setDraft("/");
                        setSlashMenuDismissed(false);
                        taRef.current?.focus();
                      }}
                      className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink text-canvas font-mono text-[10px] font-bold">
                        /
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">快捷斜杠命令与技能</span>
                        <span className="block text-[10px] text-ash">呼出 / 命令面板</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        const next = draft ? `${draft} @` : "@";
                        setDraft(next);
                        setCursorOffset(next.length);
                        setMentionDismissedKey(null);
                        taRef.current?.focus();
                      }}
                      className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-graphite hover:bg-line-soft hover:text-ink transition"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-line-soft text-teal font-mono text-[11px] font-bold">
                        @
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">引用文件 (@)</span>
                        <span className="block text-[10px] text-ash">输入 @ 选择文件或目录作为上下文</span>
                      </div>
                    </button>
                  </div>
                )}
              </div>

              {/* 权限模式选择器（计划模式 / 变更确认 / 自主模式 / 完全访问） */}
              <PermissionModePicker compact={isMobile} align="left" />

              {/* 上下文注入快捷控制（自由选择本轮/首轮注入项） */}
              <ComposerContextPicker compact={isMobile} />

              {/* 对话终端唤起按钮：对话页底部快捷小终端（Shell 在设置 → 终端里选，默认 PowerShell 7） */}
              <ChatTerminalToggleButton />
            </div>

            {/* 右侧操作：上下文容量/额度徽标 + 执行器/模型/思考强度（合并单钮） + 发送/停止按钮。
                ml-auto：与左侧组同排放不下而换行时，独占一行也保持右对齐 */}
            <div className="ml-auto flex items-center gap-1 @min-[480px]:gap-1.5 shrink-0">
              <ContextUsageBadge />
              <RunConfigPicker compact={isMobile} align="right" />

              {busy ? (
                <button
                  type="button"
                  onClick={() => useWorkbench.getState().cancelRun()}
                  aria-label="停止"
                  title="停止"
                  className="flex shrink-0 items-center justify-center rounded-lg bg-ink text-canvas hover:opacity-90 active:scale-95 transition h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8"
                >
                  <Square size={isMobile ? 10 : 12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim() && attachments.length === 0}
                  aria-label="发送"
                  title="发送 · Enter"
                  className="flex shrink-0 items-center justify-center rounded-full bg-ink text-canvas hover:opacity-90 active:scale-95 disabled:opacity-30 transition h-7 w-7 @min-[480px]:h-8 @min-[480px]:w-8"
                >
                  <ArrowUp size={isMobile ? 14 : 16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
