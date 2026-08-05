import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import EventTimeline, { LiveEventTimeline } from "@/components/agent/EventTimeline";
import { SafeStreamingMarkdown } from "@/components/chat/SafeStreamingMarkdown";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types";

export const BOTTOM_THRESHOLD_PX = 80;
export const VIRTUAL_OVERSCAN = { top: 320, bottom: 640 } as const;
const USER_SCROLL_INTENT_TTL_MS = 500;

export type ScrollMode = "FOLLOWING" | "USER_READING" | "RESTORING";

interface VirtualMessageListProps {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  sessionId: string | null;
  isStreaming: boolean;
  loadingHistory: boolean;
  hasCurrentSession: boolean;
}

const ListContainer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = "", ...props }, ref) => (
    <div ref={ref} className={`px-4 pb-5 pt-4 ${className}`} {...props} />
  ),
);
ListContainer.displayName = "VirtualMessageListContainer";

const listComponents = { List: ListContainer };
const initialBottomLocation = { index: "LAST" as const, align: "end" as const };

/**
 * F5 动态高度虚拟消息列表。
 *
 * Virtuoso 负责可视区计算与真实高度测量；本组件只保留业务层必须知道的滚动意图。
 * USER_READING 时任何流式增高都不能抢滚动，RESTORING/FOLLOWING 才允许贴底。
 */
export function VirtualMessageList({
  messages,
  streamingMessageId,
  sessionId,
  isStreaming,
  loadingHistory,
  hasCurrentSession,
}: VirtualMessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const heightFrameRef = useRef<number | null>(null);
  const userScrollIntentAtRef = useRef<number | null>(null);
  const userScrollIntentExpiryRef = useRef<number | null>(null);
  const touchYRef = useRef<number | null>(null);
  const scrollbarPointerActiveRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const [scrollMode, setScrollModeState] = useState<ScrollMode>("RESTORING");
  const scrollModeRef = useRef<ScrollMode>("RESTORING");

  const setScrollMode = useCallback((mode: ScrollMode) => {
    scrollModeRef.current = mode;
    setScrollModeState(mode);
  }, []);

  const latestUserMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return messages[index].id;
    }
    return null;
  }, [messages]);
  const previousLatestUserIdRef = useRef(latestUserMessageId);

  const scrollToLatest = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    // 索引定位依赖尺寸缓存；Markdown 刚完成布局时再用真实 scrollHeight 消除最后的误差。
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  const scheduleLatestAlignment = useCallback(() => {
    if (heightFrameRef.current !== null) return;
    heightFrameRef.current = window.requestAnimationFrame(() => {
      heightFrameRef.current = null;
      const intentAt = userScrollIntentAtRef.current;
      const hasFreshUserIntent =
        intentAt !== null && Date.now() - intentAt <= USER_SCROLL_INTENT_TTL_MS;
      if (scrollModeRef.current !== "USER_READING" && !hasFreshUserIntent) scrollToLatest();
    });
  }, [scrollToLatest]);

  const cancelLatestAlignment = useCallback(() => {
    if (heightFrameRef.current === null) return;
    window.cancelAnimationFrame(heightFrameRef.current);
    heightFrameRef.current = null;
  }, []);

  const restoreLatest = useCallback(() => {
    userScrollIntentAtRef.current = null;
    if (userScrollIntentExpiryRef.current !== null) {
      window.clearTimeout(userScrollIntentExpiryRef.current);
      userScrollIntentExpiryRef.current = null;
    }
    setScrollMode("RESTORING");
    scheduleLatestAlignment();
  }, [scheduleLatestAlignment, setScrollMode]);

  const recordUserScrollIntent = useCallback(() => {
    userScrollIntentAtRef.current = Date.now();
    cancelLatestAlignment();
    if (userScrollIntentExpiryRef.current !== null) {
      window.clearTimeout(userScrollIntentExpiryRef.current);
    }
    userScrollIntentExpiryRef.current = window.setTimeout(() => {
      userScrollIntentExpiryRef.current = null;
      userScrollIntentAtRef.current = null;
      if (scrollModeRef.current !== "USER_READING") scheduleLatestAlignment();
    }, USER_SCROLL_INTENT_TTL_MS);
  }, [cancelLatestAlignment, scheduleLatestAlignment]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.deltaY < 0) recordUserScrollIntent();
    },
    [recordUserScrollIntent],
  );

  const handleTouchStart = useCallback((event: TouchEvent) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback(
    (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY !== null && touchYRef.current !== null && nextY > touchYRef.current) {
        recordUserScrollIntent();
      }
      touchYRef.current = nextY;
    },
    [recordUserScrollIntent],
  );

  const handlePointerDown = useCallback((event: PointerEvent) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.target !== scroller) return;

    scrollbarPointerActiveRef.current = true;
    previousScrollTopRef.current = scroller.scrollTop;
  }, []);

  const handleScrollerScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nextScrollTop = scroller.scrollTop;
    if (scrollbarPointerActiveRef.current && nextScrollTop < previousScrollTopRef.current) {
      recordUserScrollIntent();
    }
    previousScrollTopRef.current = nextScrollTop;
  }, [recordUserScrollIntent]);

  const handlePointerEnd = useCallback(() => {
    scrollbarPointerActiveRef.current = false;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) recordUserScrollIntent();
    },
    [recordUserScrollIntent],
  );

  const setScroller = useCallback(
    (nextScroller: HTMLElement | Window | null) => {
      const previousScroller = scrollerRef.current;
      if (previousScroller) {
        previousScroller.removeEventListener("wheel", handleWheel);
        previousScroller.removeEventListener("touchstart", handleTouchStart);
        previousScroller.removeEventListener("touchmove", handleTouchMove);
        previousScroller.removeEventListener("pointerdown", handlePointerDown);
        previousScroller.removeEventListener("scroll", handleScrollerScroll);
        previousScroller.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
      }

      scrollerRef.current = nextScroller instanceof HTMLElement ? nextScroller : null;
      if (scrollerRef.current) {
        previousScrollTopRef.current = scrollerRef.current.scrollTop;
        scrollerRef.current.addEventListener("wheel", handleWheel, { passive: true });
        scrollerRef.current.addEventListener("touchstart", handleTouchStart, { passive: true });
        scrollerRef.current.addEventListener("touchmove", handleTouchMove, { passive: true });
        scrollerRef.current.addEventListener("pointerdown", handlePointerDown, { passive: true });
        scrollerRef.current.addEventListener("scroll", handleScrollerScroll, { passive: true });
        scrollerRef.current.addEventListener("keydown", handleKeyDown);
        window.addEventListener("pointerup", handlePointerEnd, { passive: true });
        window.addEventListener("pointercancel", handlePointerEnd, { passive: true });
      }
    },
    [
      handleKeyDown,
      handlePointerDown,
      handlePointerEnd,
      handleScrollerScroll,
      handleTouchMove,
      handleTouchStart,
      handleWheel,
    ],
  );

  useEffect(() => {
    const previousId = previousLatestUserIdRef.current;
    previousLatestUserIdRef.current = latestUserMessageId;
    if (latestUserMessageId && previousId !== latestUserMessageId) restoreLatest();
  }, [latestUserMessageId, restoreLatest]);

  useEffect(
    () => () => {
      if (heightFrameRef.current !== null) {
        window.cancelAnimationFrame(heightFrameRef.current);
        heightFrameRef.current = null;
      }
      if (userScrollIntentExpiryRef.current !== null) {
        window.clearTimeout(userScrollIntentExpiryRef.current);
        userScrollIntentExpiryRef.current = null;
      }
    },
    [],
  );

  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (atBottom) {
        userScrollIntentAtRef.current = null;
        if (userScrollIntentExpiryRef.current !== null) {
          window.clearTimeout(userScrollIntentExpiryRef.current);
          userScrollIntentExpiryRef.current = null;
        }
        setScrollMode("FOLLOWING");
        return;
      }

      // 动态高度初次测量也会让“已到底”短暂变成 false。只有真实滚动输入才代表用户要读历史。
      const intentAt = userScrollIntentAtRef.current;
      const hasFreshUserIntent = intentAt !== null && Date.now() - intentAt <= USER_SCROLL_INTENT_TTL_MS;
      if (!hasFreshUserIntent) {
        userScrollIntentAtRef.current = null;
        setScrollMode("RESTORING");
        scheduleLatestAlignment();
        return;
      }

      userScrollIntentAtRef.current = null;
      if (userScrollIntentExpiryRef.current !== null) {
        window.clearTimeout(userScrollIntentExpiryRef.current);
        userScrollIntentExpiryRef.current = null;
      }
      cancelLatestAlignment();
      setScrollMode("USER_READING");
    },
    [cancelLatestAlignment, scheduleLatestAlignment, setScrollMode],
  );

  const handleTotalHeightChanged = useCallback(() => {
    const intentAt = userScrollIntentAtRef.current;
    const hasFreshUserIntent =
      intentAt !== null && Date.now() - intentAt <= USER_SCROLL_INTENT_TTL_MS;
    if (scrollModeRef.current !== "USER_READING" && !hasFreshUserIntent) {
      scheduleLatestAlignment();
    }
  }, [scheduleLatestAlignment]);

  const followOutput = useCallback((isAtBottom: boolean): "auto" | false => {
    const intentAt = userScrollIntentAtRef.current;
    const hasFreshUserIntent =
      intentAt !== null && Date.now() - intentAt <= USER_SCROLL_INTENT_TTL_MS;
    if ((scrollModeRef.current === "USER_READING" || hasFreshUserIntent) && !isAtBottom) {
      return false;
    }
    return "auto";
  }, []);

  if (messages.length === 0) {
    if (loadingHistory) {
      return <p className="mt-24 text-center text-sm text-muted">加载会话历史…</p>;
    }
    if (!isStreaming) {
      return (
        <p className="mt-24 px-4 text-center text-sm text-muted">
          {hasCurrentSession ? "还没有消息，说点什么开始吧" : "输入购物意图，开始一次跨境购物 Agent 对话"}
        </p>
      );
    }
  }

  return (
    <div className="relative h-full min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={setScroller}
        data={messages}
        className="h-full"
        components={listComponents}
        alignToBottom
        initialTopMostItemIndex={initialBottomLocation}
        computeItemKey={(_, message) => message.id}
        increaseViewportBy={VIRTUAL_OVERSCAN}
        minOverscanItemCount={{ top: 2, bottom: 4 }}
        atBottomThreshold={BOTTOM_THRESHOLD_PX}
        atBottomStateChange={handleAtBottomChange}
        followOutput={followOutput}
        totalListHeightChanged={handleTotalHeightChanged}
        itemContent={(_, message) =>
          message.id === streamingMessageId ? (
            <StreamingBubble sessionId={sessionId ?? ""} />
          ) : (
            <MemoMessageRow message={message} />
          )
        }
      />

      {scrollMode === "USER_READING" && (
        <button
          type="button"
          onClick={restoreLatest}
          className="absolute bottom-4 left-1/2 z-10 min-h-10 -translate-x-1/2 touch-manipulation rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background shadow-[0_4px_16px_rgba(0,0,0,0.18)] transition-[transform,background-color] duration-150 active:translate-y-px active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(hover:hover)]:hover:bg-foreground/85"
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div data-message-id={message.id} className={`flex pb-3 ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`min-w-0 rounded-lg border bg-surface px-3 py-2 text-sm ${
          isUser ? "max-w-[80%] border-primary/30" : "max-w-[88%]"
        }`}
      >
        {!isUser && <p className="mb-1 text-xs text-muted">Agent</p>}
        {!isUser && message.process && message.process.length > 0 && (
          <EventTimeline
            steps={message.process}
            status={message.status === "done" ? "completed" : message.status === "cancelled" ? "cancelled" : "failed"}
          />
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <SafeStreamingMarkdown content={message.content} messageId={message.id} />
        )}
        {!isUser && message.status === "cancelled" && (
          <p className="mt-1 text-xs text-muted">（已停止）</p>
        )}
        {!isUser && message.status === "error" && (
          <p className="mt-1 text-xs text-muted">（出错了）</p>
        )}
      </div>
    </div>
  );
}

const MemoMessageRow = memo(MessageRow);

function StreamingBubble({ sessionId }: { sessionId: string }) {
  const streamingContent = useChatStore((state) =>
    sessionId ? (state.streamingBySession[sessionId] ?? "") : "",
  );

  return (
    <div data-message-id={`streaming-${sessionId}`} className="flex justify-start pb-3">
      <div className="min-w-0 max-w-[88%] rounded-lg border bg-surface px-3 py-2 text-sm">
        <p className="mb-1 text-xs text-muted">Agent</p>
        <LiveEventTimeline sessionId={sessionId} />
        <SafeStreamingMarkdown
          content={streamingContent}
          isStreaming
          messageId={`streaming-${sessionId}`}
        />
      </div>
    </div>
  );
}
