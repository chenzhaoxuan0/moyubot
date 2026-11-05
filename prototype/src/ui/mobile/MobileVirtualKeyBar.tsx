/**
 * 移动端终端虚拟辅助按键栏 (Mobile Virtual Key Bar)
 *
 * 【形式参照声明与版权声明】
 * 按键排列布局形式参照 Termux (termux-app，GPL-3.0) 的经典两行式 extra-keys 布局：
 * - 布局结构：两行七列（2 Rows × 7 Columns）网格化排列，彻底消除横向滚动；
 * - 左侧控制区（前 3 列）：ESC, /, - 与 TAB, CTRL, ALT（包含 Termux 标志性的 `-` 上滑为 `|`）；
 * - 右侧导航区（后 4 列）：HOME, ↑, END, PGUP 与 ←, ↓, →, PGDN（倒 T 字方向键 + 行首/行尾 + 翻页导航集群）；
 * - 交互形态：CTRL / ALT 粘滞修饰键状态机（点按单次生效 / 双击常驻锁定）、长按自动连击（Repetitive keys）、上滑副键触发（Popup keys）。
 *
 * 【开源许可证边界说明】
 * 本项目为 MIT 许可，Termux 为 GPL-3.0 许可。
 * 严守开源许可证边界，本项目未复制或使用 Termux 仓库的任何源码与资产，
 * 仅参照其公开的形式与交互逻辑，在 React 19 + TypeScript + Tailwind CSS 环境下进行独立全新的全自研实现。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useTerminalStore } from "../../store/useTerminalStore.ts";
import { useChatTerminal } from "../../store/useChatTerminal.ts";
import { terminalSessionRegistry } from "../../store/TerminalSessionManager.ts";
import { cn } from "../cn.ts";

export type ModifierState = "off" | "active" | "locked";

interface PopupDef {
  label: string;
  data: string;
  hint: string;
}

interface KeyDef {
  id: string;
  label: string;
  data: string;
  hint: string;
  isModifier?: "ctrl" | "alt";
  isRepetitive?: boolean;
  popup?: PopupDef;
}

/**
 * 形式对齐 Termux DEFAULT_IVALUE_EXTRA_KEYS：
 * Row 1: ESC,  /,     -,     HOME,  UP,    END,   PGUP
 * Row 2: TAB,  CTRL,  ALT,   LEFT,  DOWN,  RIGHT, PGDN
 */
const EXTRA_KEY_ROWS: KeyDef[][] = [
  // 第一行（Row 1）
  [
    {
      id: "esc",
      label: "ESC",
      data: "\x1b",
      hint: "Esc 退出/取消",
      popup: { label: "CLR", data: "\x0c", hint: "清屏 (Ctrl+L)" },
    },
    {
      id: "slash",
      label: "/",
      data: "/",
      hint: "斜杠命令/路径",
      popup: { label: "\\", data: "\\", hint: "反斜杠 \\" },
    },
    {
      id: "dash",
      label: "-",
      data: "-",
      hint: "参数连字符",
      popup: { label: "|", data: "|", hint: "管道符 | (Termux 同款)" },
    },
    {
      id: "home",
      label: "HOME",
      data: "\x1b[H",
      hint: "光标移至行首",
      popup: { label: "DEL", data: "\x1b[3~", hint: "向前删除键 (Delete)" },
    },
    {
      id: "up",
      label: "↑",
      data: "\x1b[A",
      hint: "历史上一条 / 上移",
      isRepetitive: true,
    },
    {
      id: "end",
      label: "END",
      data: "\x1b[F",
      hint: "光标移至行尾",
      popup: { label: "~", data: "~", hint: "波浪号 ~ (Home 目录)" },
    },
    {
      id: "pgup",
      label: "PGUP",
      data: "\x1b[5~",
      hint: "上一页 (Page Up)",
      isRepetitive: true,
    },
  ],

  // 第二行（Row 2）
  [
    {
      id: "tab",
      label: "TAB",
      data: "\t",
      hint: "Tab 自动补全",
      popup: { label: "`", data: "`", hint: "反引号 `" },
    },
    {
      id: "ctrl",
      label: "CTRL",
      data: "",
      hint: "Ctrl 修饰键（点按激活 / 双击锁定 / 上滑中断）",
      isModifier: "ctrl",
      popup: { label: "^C", data: "\x03", hint: "中断前台进程 (Ctrl+C)" },
    },
    {
      id: "alt",
      label: "ALT",
      data: "",
      hint: "Alt 修饰键（点按激活 / 双击锁定）",
      isModifier: "alt",
    },
    {
      id: "left",
      label: "←",
      data: "\x1b[D",
      hint: "左移光标",
      isRepetitive: true,
    },
    {
      id: "down",
      label: "↓",
      data: "\x1b[B",
      hint: "历史下一条 / 下移",
      isRepetitive: true,
    },
    {
      id: "right",
      label: "→",
      data: "\x1b[C",
      hint: "右移光标",
      isRepetitive: true,
    },
    {
      id: "pgdn",
      label: "PGDN",
      data: "\x1b[6~",
      hint: "下一页 (Page Down)",
      isRepetitive: true,
    },
  ],
];

/** 当 Ctrl 被点按激活或锁定时代开的快速宏操作快捷栏 */
const CTRL_SHORTCUTS = [
  { label: "Ctrl+C", data: "\x03", hint: "中断运行 (SIGINT)", primary: true },
  { label: "Ctrl+D", data: "\x04", hint: "EOF / 退出会话" },
  { label: "Ctrl+Z", data: "\x1a", hint: "挂起后台 (SIGTSTP)" },
  { label: "Ctrl+L", data: "\x0c", hint: "清除屏幕" },
  { label: "Ctrl+A", data: "\x01", hint: "跳至行首" },
  { label: "Ctrl+E", data: "\x05", hint: "跳至行尾" },
  { label: "Ctrl+R", data: "\x12", hint: "反向搜索命令历史" },
];

export interface MobileVirtualKeyBarProps {
  /** 目标终端模式：main 为主页面终端，chat 为对话框下方浮动终端 */
  target?: "main" | "chat";
}

export function MobileVirtualKeyBar({ target = "main" }: MobileVirtualKeyBarProps) {
  const activeMainInstanceId = useTerminalStore((s) => s.activePaneId);
  const activeChatTabId = useChatTerminal((s) => s.activeTabId);
  const chatTabs = useChatTerminal((s) => s.tabs);

  const [ctrlState, setCtrlState] = useState<ModifierState>("off");
  const [altState, setAltState] = useState<ModifierState>("off");

  // 触控交互状态：滑动偏移与长按自动连发
  const [swipingKeyId, setSwipingKeyId] = useState<string | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didRepeatRef = useRef(false);
  const isSwipedUpRef = useRef(false);

  /** 获取当前激活的目标终端会话 */
  const getTargetSession = useCallback(() => {
    if (target === "chat") {
      const tabId = activeChatTabId ?? chatTabs[0]?.id;
      return tabId ? terminalSessionRegistry.get(tabId) : null;
    }
    return activeMainInstanceId ? terminalSessionRegistry.get(activeMainInstanceId) : null;
  }, [target, activeMainInstanceId, activeChatTabId, chatTabs]);

  /** 触发震动触觉反馈（若平台支持） */
  const triggerHaptic = () => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(10);
      } catch {}
    }
  };

  /** 清除连击与长按定时器 */
  const clearTimers = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  /** 发送数据并消费单次激活的修饰键 */
  const sendData = useCallback(
    (data: string) => {
      const session = getTargetSession();
      if (!session || !data) return;
      session.sendData(data);

      // 消费单次修饰键（若处于 locked 状态则保留）
      setCtrlState((prev) => (prev === "active" ? "off" : prev));
      setAltState((prev) => (prev === "active" ? "off" : prev));
    },
    [getTargetSession],
  );

  /**
   * 监听全局键盘事件：当用户通过软键盘输入字母且处于 CTRL/ALT 激活态时，
   * 自动转换为标准终端控制符 (Ctrl+C = \x03, Ctrl+D = \x04 等)
   */
  useEffect(() => {
    if (ctrlState === "off" && altState === "off") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const key = e.key;

      if (ctrlState !== "off" && key.length === 1 && !e.ctrlKey && !e.metaKey) {
        const upper = key.toUpperCase();
        const code = upper.charCodeAt(0) - 64;
        if (code >= 1 && code <= 26) {
          e.preventDefault();
          e.stopPropagation();
          sendData(String.fromCharCode(code));
          return;
        }
      }

      if (altState !== "off" && key.length === 1 && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        sendData(`\x1b${key}`);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [ctrlState, altState, sendData]);

  /** 切换修饰键状态：off -> active -> locked -> off */
  const toggleModifier = (type: "ctrl" | "alt") => {
    triggerHaptic();
    if (type === "ctrl") {
      setCtrlState((prev) => {
        if (prev === "off") return "active";
        if (prev === "active") return "locked";
        return "off";
      });
    } else {
      setAltState((prev) => {
        if (prev === "off") return "active";
        if (prev === "active") return "locked";
        return "off";
      });
    }
  };

  /** 计算修饰键影响下的按键实际序列（例如 Ctrl+↑ / Alt+←） */
  const resolveModifiedKeyData = useCallback(
    (keyDef: KeyDef): string => {
      if (ctrlState !== "off") {
        if (keyDef.id === "up") return "\x1b[1;5A";
        if (keyDef.id === "down") return "\x1b[1;5B";
        if (keyDef.id === "right") return "\x1b[1;5C";
        if (keyDef.id === "left") return "\x1b[1;5D";
        if (keyDef.id === "home") return "\x1b[1;5H";
        if (keyDef.id === "end") return "\x1b[1;5F";
      }
      if (altState !== "off") {
        if (keyDef.id === "left") return "\x1bb"; // Readline 向左移动一个单词
        if (keyDef.id === "right") return "\x1bf"; // Readline 向右移动一个单词
        if (keyDef.id === "up") return "\x1b[1;3A";
        if (keyDef.id === "down") return "\x1b[1;3B";
      }
      return keyDef.data;
    },
    [ctrlState, altState],
  );

  /** 触控/按压开始 */
  const handlePointerDown = (e: React.PointerEvent, keyDef: KeyDef) => {
    // 关键：阻止默认事件以防止终端激活的输入光标失焦、避免移动端虚拟键盘意外收起
    e.preventDefault();
    triggerHaptic();

    touchStartPosRef.current = { x: e.clientX, y: e.clientY };
    didRepeatRef.current = false;
    isSwipedUpRef.current = false;
    setSwipingKeyId(null);

    if (keyDef.isModifier) {
      toggleModifier(keyDef.isModifier);
      return;
    }

    // 立即响应首击，零延迟
    const initialData = resolveModifiedKeyData(keyDef);
    sendData(initialData);

    // 对于支持长按重复的按键（如方向键与翻页键，参照 Termux Repetitive Keys）
    if (keyDef.isRepetitive) {
      clearTimers();
      repeatTimerRef.current = setTimeout(() => {
        didRepeatRef.current = true;
        repeatIntervalRef.current = setInterval(() => {
          sendData(resolveModifiedKeyData(keyDef));
        }, 70);
      }, 320);
    }
  };

  /** 触控滑动（检测上滑手势触发副键） */
  const handlePointerMove = (e: React.PointerEvent, keyDef: KeyDef) => {
    if (!touchStartPosRef.current) return;
    const dy = e.clientY - touchStartPosRef.current.y;

    // 上滑超过 14px 时判定为上滑手势，点亮副键反馈
    if (dy < -14 && keyDef.popup) {
      if (!isSwipedUpRef.current) {
        isSwipedUpRef.current = true;
        setSwipingKeyId(keyDef.id);
        clearTimers(); // 上滑时取消重复击发
      }
    } else {
      if (isSwipedUpRef.current) {
        isSwipedUpRef.current = false;
        setSwipingKeyId(null);
      }
    }
  };

  /** 触控释放 */
  const handlePointerUp = (e: React.PointerEvent, keyDef: KeyDef) => {
    e.preventDefault();
    clearTimers();

    if (isSwipedUpRef.current && keyDef.popup) {
      triggerHaptic();
      sendData(keyDef.popup.data);
    }

    touchStartPosRef.current = null;
    isSwipedUpRef.current = false;
    didRepeatRef.current = false;
    setSwipingKeyId(null);
  };

  /** 触控取消 */
  const handlePointerCancel = () => {
    clearTimers();
    touchStartPosRef.current = null;
    isSwipedUpRef.current = false;
    didRepeatRef.current = false;
    setSwipingKeyId(null);
  };

  return (
    <div
      role="toolbar"
      aria-label="移动端终端辅助按键栏（形式参照 Termux）"
      className="w-full shrink-0 border-t border-line/80 bg-rail px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom,0px))] select-none touch-none"
    >
      {/* 1. 当 Ctrl 处于激活或锁定态时，展示快捷常用命令栏 */}
      {ctrlState !== "off" && (
        <div className="mb-1.5 flex h-7.5 w-full items-center gap-1 overflow-x-auto rounded-lg border border-teal/30 bg-teal/10 px-1.5 py-1 text-caption scrollbar-none animate-in fade-in zoom-in-95 duration-100">
          <span className="shrink-0 font-mono text-[10px] font-semibold text-teal uppercase tracking-wider pl-0.5 pr-1">
            Ctrl {ctrlState === "locked" ? "锁定" : "就绪"}
          </span>
          {CTRL_SHORTCUTS.map((sc) => (
            <button
              key={sc.label}
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                triggerHaptic();
                sendData(sc.data);
              }}
              title={sc.hint}
              aria-label={`执行快捷指令 ${sc.label}`}
              className={cn(
                "flex h-5.5 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] font-medium transition active:scale-95",
                sc.primary
                  ? "bg-loss text-white font-semibold shadow-2xs"
                  : "border border-line bg-card text-ink hover:border-teal/50",
              )}
            >
              {sc.label}
            </button>
          ))}
        </div>
      )}

      {/* 2. 主体两行七列（2 Rows × 7 Columns）网格，完全对齐 Termux 经典布局 */}
      <div className="flex flex-col gap-1 w-full">
        {EXTRA_KEY_ROWS.map((row, rowIdx) => (
          <div key={`row-${rowIdx}`} className="grid grid-cols-7 gap-1 w-full">
            {row.map((keyDef) => {
              const isCtrl = keyDef.isModifier === "ctrl";
              const isAlt = keyDef.isModifier === "alt";
              const modifierActive = (isCtrl && ctrlState !== "off") || (isAlt && altState !== "off");
              const modifierLocked = (isCtrl && ctrlState === "locked") || (isAlt && altState === "locked");
              const isSwiping = swipingKeyId === keyDef.id;

              return (
                <button
                  key={keyDef.id}
                  type="button"
                  onPointerDown={(e) => handlePointerDown(e, keyDef)}
                  onPointerMove={(e) => handlePointerMove(e, keyDef)}
                  onPointerUp={(e) => handlePointerUp(e, keyDef)}
                  onPointerCancel={handlePointerCancel}
                  onPointerLeave={handlePointerCancel}
                  title={keyDef.hint}
                  aria-label={`终端虚拟键 ${keyDef.label}`}
                  aria-pressed={modifierActive}
                  className={cn(
                    "relative flex h-8 items-center justify-center rounded-lg border text-[11px] font-mono font-medium transition active:scale-95 touch-none select-none",
                    // 修饰键激活/锁定高亮
                    modifierActive
                      ? "border-teal bg-teal text-white shadow-xs font-semibold ring-1 ring-teal/30"
                      : "border-line bg-card text-ink shadow-2xs hover:bg-surface-hover active:bg-line-soft",
                    // 正在上滑预览副键时的反馈
                    isSwiping && "ring-2 ring-teal bg-teal-tint/80",
                  )}
                >
                  {/* 主键文本 */}
                  <span className="truncate">
                    {keyDef.label}
                    {modifierLocked && <span className="ml-0.5 text-[9px] leading-none">•</span>}
                  </span>

                  {/* 上滑副键小标（Termux signature popup hint） */}
                  {keyDef.popup && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute -top-0.5 right-1 pointer-events-none font-mono text-[8.5px] leading-tight transition-transform",
                        isSwiping
                          ? "text-teal font-bold scale-125"
                          : modifierActive
                            ? "text-white/70"
                            : "text-ash/90",
                      )}
                    >
                      {keyDef.popup.label}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
