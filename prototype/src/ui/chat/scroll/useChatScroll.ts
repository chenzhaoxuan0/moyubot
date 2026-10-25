import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const PINNED_THRESHOLD_PX = 48;
const FAB_TRIGGER_THRESHOLD_PX = 120;
const USER_INTENT_TTL_MS = 1500;

export interface UseChatScrollResult {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly isPinned: boolean;
  readonly showBackToBottom: boolean;
  readonly scrollToBottom: (smooth?: boolean) => void;
  readonly scrollItemIntoView: (selector: string) => void;
}

/**
 * 工业级聊天视口滚动控制器（借鉴 ZCode timelineScrollAnchor 与 DeepSeek use-chat-scroll）
 *
 * 核心设计：
 * 1. 意图跟踪（Intent Tracking）：监听用户滚轮、触控与上翻按键，维持 1500ms 意图 TTL。
 *    用户向上翻看历史时，绝对不强行拽底，保证阅读连贯。
 * 2. 贴底惯性（Sticky Bottom）：处于底部（<48px）且无上翻意图时，每帧渲染同步贴底（useLayoutEffect）。
 * 3. 悬浮回到底部状态（FAB）：距离底部 >120px 时触发浮标展示。
 */
export function useChatScroll(changeSignal?: unknown): UseChatScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  const userIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollIntentRef = useRef(false);

  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const [isPinned, setIsPinned] = useState(true);

  const clearUserIntent = useCallback(() => {
    if (userIntentTimerRef.current !== null) {
      clearTimeout(userIntentTimerRef.current);
      userIntentTimerRef.current = null;
    }
    userScrollIntentRef.current = false;
  }, []);

  const armUserIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userIntentTimerRef.current !== null) {
      clearTimeout(userIntentTimerRef.current);
    }
    userIntentTimerRef.current = setTimeout(() => {
      userScrollIntentRef.current = false;
      userIntentTimerRef.current = null;
    }, USER_INTENT_TTL_MS);
  }, []);

  // 监听交互意图与滚动位置
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        armUserIntent();
      } else if (e.deltaY > 0) {
        // 向下滚快速取消上翻意图
        const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distBottom < PINNED_THRESHOLD_PX) {
          clearUserIntent();
        }
      }
    };

    const onTouchMove = () => {
      armUserIntent();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(e.key)) {
        armUserIntent();
      }
    };

    const onScroll = () => {
      const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distBottom < PINNED_THRESHOLD_PX;
      stuckRef.current = pinned;
      setIsPinned(pinned);

      if (pinned) {
        clearUserIntent();
      }

      setShowBackToBottom(distBottom > FAB_TRIGGER_THRESHOLD_PX);
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scroll", onScroll);
      if (userIntentTimerRef.current !== null) {
        clearTimeout(userIntentTimerRef.current);
      }
    };
  }, [armUserIntent, clearUserIntent]);

  // 渲染后同步贴底（仅当贴底且用户未显式上翻时）
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el !== null && stuckRef.current && !userScrollIntentRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [changeSignal]);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (el === null) return;
    clearUserIntent();
    stuckRef.current = true;
    setIsPinned(true);
    setShowBackToBottom(false);

    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [clearUserIntent]);

  const scrollItemIntoView = useCallback((selector: string) => {
    const el = containerRef.current;
    if (el === null) return;
    const target = el.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return {
    containerRef,
    isPinned,
    showBackToBottom,
    scrollToBottom,
    scrollItemIntoView,
  };
}
