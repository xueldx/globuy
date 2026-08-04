import { forwardRef, useImperativeHandle, type Ref } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";

interface MockVirtuosoProps {
  data: ChatMessage[];
  alignToBottom?: boolean;
  initialTopMostItemIndex?: { index: "LAST"; align: "end" };
  computeItemKey?: (index: number, item: ChatMessage) => string;
  increaseViewportBy?: { top: number; bottom: number };
  minOverscanItemCount?: { top: number; bottom: number };
  atBottomThreshold?: number;
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: (isAtBottom: boolean) => "auto" | false;
  totalListHeightChanged?: (height: number) => void;
  itemContent: (index: number, item: ChatMessage) => React.ReactNode;
}

const virtuosoHarness = vi.hoisted(() => ({
  props: null as MockVirtuosoProps | null,
  scrollToIndex: vi.fn(),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: MockVirtuosoProps,
    ref: Ref<{ scrollToIndex: typeof virtuosoHarness.scrollToIndex }>,
  ) {
    virtuosoHarness.props = props;
    useImperativeHandle(ref, () => ({ scrollToIndex: virtuosoHarness.scrollToIndex }));

    // jsdom 没有布局引擎，这里模拟虚拟内核只交付一个固定窗口。
    const visibleWindow = props.data.slice(0, 10);
    return (
      <div data-testid="virtuoso-window">
        {visibleWindow.map((item, index) => (
          <div key={props.computeItemKey?.(index, item) ?? index}>
            {props.itemContent(index, item)}
          </div>
        ))}
      </div>
    );
  }),
}));

vi.mock("@/components/chat/SafeStreamingMarkdown", () => ({
  SafeStreamingMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

import {
  BOTTOM_THRESHOLD_PX,
  VIRTUAL_OVERSCAN,
  VirtualMessageList,
} from "./VirtualMessageList";

function message(index: number, role: ChatMessage["role"] = index % 2 ? "assistant" : "user") {
  return {
    id: `message-${index}`,
    role,
    content: `第 ${index} 条消息`,
    status: "done" as const,
    createdAt: `2026-08-04T${String(index % 24).padStart(2, "0")}:00:00+08:00`,
  };
}

const baseProps = {
  streamingMessageId: null,
  sessionId: "session-a",
  isStreaming: false,
  loadingHistory: false,
  hasCurrentSession: true,
};

function currentProps(): MockVirtuosoProps {
  if (!virtuosoHarness.props) throw new Error("Virtuoso mock has not rendered");
  return virtuosoHarness.props;
}

describe("VirtualMessageList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    virtuosoHarness.props = null;
    virtuosoHarness.scrollToIndex.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("把完整数据交给虚拟内核，并用稳定 id、末条定位和差异化 overscan", () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => message(index));

    render(<VirtualMessageList {...baseProps} messages={messages} />);

    expect(currentProps().data).toHaveLength(1_000);
    expect(screen.getAllByText(/第 \d+ 条消息/)).toHaveLength(10);
    expect(currentProps().computeItemKey?.(27, messages[27])).toBe("message-27");
    expect(currentProps().initialTopMostItemIndex).toEqual({ index: "LAST", align: "end" });
    expect(currentProps().alignToBottom).toBe(true);
    expect(currentProps().increaseViewportBy).toEqual(VIRTUAL_OVERSCAN);
    expect(currentProps().minOverscanItemCount).toEqual({ top: 2, bottom: 4 });
    expect(currentProps().atBottomThreshold).toBe(BOTTOM_THRESHOLD_PX);
  });

  it("用户离开底部后保持阅读位置，点击按钮才恢复跟随", () => {
    render(<VirtualMessageList {...baseProps} messages={[message(0), message(1)]} />);

    act(() => currentProps().atBottomStateChange?.(true));
    act(() => currentProps().atBottomStateChange?.(false));

    expect(screen.getByRole("button", { name: "↓ 回到最新" })).toBeInTheDocument();
    expect(currentProps().followOutput?.(false)).toBe(false);

    act(() => {
      currentProps().totalListHeightChanged?.(500);
      vi.runAllTimers();
    });
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "↓ 回到最新" }));
    act(() => vi.runAllTimers());

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    act(() => currentProps().atBottomStateChange?.(true));
    expect(screen.queryByRole("button", { name: "↓ 回到最新" })).not.toBeInTheDocument();
    expect(currentProps().followOutput?.(true)).toBe("auto");
  });

  it("跟随态把同一帧的多次高度变化合并为一次贴底", () => {
    render(<VirtualMessageList {...baseProps} messages={[message(0), message(1)]} />);
    act(() => currentProps().atBottomStateChange?.(true));

    act(() => {
      currentProps().totalListHeightChanged?.(520);
      currentProps().totalListHeightChanged?.(548);
      currentProps().totalListHeightChanged?.(566);
    });
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalled();

    act(() => vi.runAllTimers());
    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("用户在历史位置发送新消息时恢复到最新内容", () => {
    const initialMessages = [message(0), message(1)];
    const { rerender } = render(
      <VirtualMessageList {...baseProps} messages={initialMessages} />,
    );
    act(() => currentProps().atBottomStateChange?.(true));
    act(() => currentProps().atBottomStateChange?.(false));

    const nextMessages = [
      ...initialMessages,
      message(2, "user"),
      { ...message(3, "assistant"), status: "streaming" as const },
    ];
    rerender(
      <VirtualMessageList
        {...baseProps}
        messages={nextMessages}
        streamingMessageId="message-3"
        isStreaming
      />,
    );
    act(() => vi.runAllTimers());

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("切换会话重建滚动意图，且卸载时取消待执行帧", () => {
    const { rerender, unmount } = render(
      <VirtualMessageList key="session-a" {...baseProps} messages={[message(0), message(1)]} />,
    );
    act(() => currentProps().atBottomStateChange?.(true));
    act(() => currentProps().atBottomStateChange?.(false));
    expect(screen.getByRole("button", { name: "↓ 回到最新" })).toBeInTheDocument();

    rerender(
      <VirtualMessageList
        key="session-b"
        {...baseProps}
        sessionId="session-b"
        messages={[message(20), message(21)]}
      />,
    );
    expect(screen.queryByRole("button", { name: "↓ 回到最新" })).not.toBeInTheDocument();

    act(() => currentProps().totalListHeightChanged?.(420));
    unmount();
    act(() => vi.runAllTimers());
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalled();
  });

  it("保留加载态和新会话空态", () => {
    const { rerender } = render(
      <VirtualMessageList {...baseProps} messages={[]} loadingHistory />,
    );
    expect(screen.getByText("加载会话历史…")).toBeInTheDocument();

    rerender(
      <VirtualMessageList
        {...baseProps}
        sessionId={null}
        messages={[]}
        hasCurrentSession={false}
      />,
    );
    expect(screen.getByText("输入购物意图，开始一次跨境购物 Agent 对话")).toBeInTheDocument();
  });
});
