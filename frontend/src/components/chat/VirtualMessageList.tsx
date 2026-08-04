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
import { SafeStreamingMarkdown } from "@/components/chat/SafeStreamingMarkdown";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types";

export const BOTTOM_THRESHOLD_PX = 80;
export const VIRTUAL_OVERSCAN = { top: 320, bottom: 640 } as const;

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
  const heightFrameRef = useRef<number | null>(null);
  const hasReachedBottomRef = useRef(false);
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
  }, []);

  const scheduleLatestAlignment = useCallback(() => {
    if (heightFrameRef.current !== null) return;
    heightFrameRef.current = window.requestAnimationFrame(() => {
      heightFrameRef.current = null;
      scrollToLatest();
    });
  }, [scrollToLatest]);

  const restoreLatest = useCallback(() => {
    setScrollMode("RESTORING");
    scheduleLatestAlignment();
  }, [scheduleLatestAlignment, setScrollMode]);

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
    },
    [],
  );

  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (atBottom) {
        hasReachedBottomRef.current = true;
        setScrollMode("FOLLOWING");
        return;
      }

      // 首次定位到 LAST 前，Virtuoso 可能短暂报告 false。这不是用户滚动，不进入阅读态。
      if (!hasReachedBottomRef.current || scrollModeRef.current === "RESTORING") return;
      setScrollMode("USER_READING");
    },
    [setScrollMode],
  );

  const handleTotalHeightChanged = useCallback(() => {
    if (scrollModeRef.current !== "USER_READING") scheduleLatestAlignment();
  }, [scheduleLatestAlignment]);

  const followOutput = useCallback((isAtBottom: boolean): "auto" | false => {
    if (scrollModeRef.current === "USER_READING" && !isAtBottom) return false;
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
    <div data-message-id={message.id} className={`mb-3 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`min-w-0 rounded-lg border bg-surface px-3 py-2 text-sm ${
          isUser ? "max-w-[80%] border-primary/30" : "max-w-[88%]"
        }`}
      >
        {!isUser && <p className="mb-1 text-xs text-muted">Agent</p>}
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
    <div data-message-id={`streaming-${sessionId}`} className="mb-3 flex justify-start">
      <div className="min-w-0 max-w-[88%] rounded-lg border bg-surface px-3 py-2 text-sm">
        <p className="mb-1 text-xs text-muted">Agent</p>
        <SafeStreamingMarkdown
          content={streamingContent}
          isStreaming
          messageId={`streaming-${sessionId}`}
        />
      </div>
    </div>
  );
}
