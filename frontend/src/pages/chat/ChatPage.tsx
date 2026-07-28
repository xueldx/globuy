import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types";

/** 聊天页：F2 接入 SSE 流式引擎与增量渲染。Markdown（F4）/虚拟滚动（F5）后续替换气泡渲染。 */
export function Component() {
  const { sessionId } = useParams();
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStream = useChatStore((s) => s.stopStream);

  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // deep-link 时锚定当前会话（副作用放 effect，不在 render 里写状态）
  useEffect(() => {
    if (sessionId) setCurrentSession(sessionId);
  }, [sessionId, setCurrentSession]);

  // 新消息/流式增量时滚到底（F5 细化为受控滚动锚定）
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, streamingContent]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    void sendMessage(input);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-24 text-center text-sm text-muted">
            输入购物意图，开始一次跨境购物 Agent 对话
          </p>
        )}
        {messages.map((msg) =>
          // 激活消息用流式气泡（订阅 streamingContent，逐 token 更新）；其余用 memo 短路，零重渲染
          msg.id === streamingMessageId ? (
            <StreamingBubble key={msg.id} message={msg} />
          ) : (
            <MemoMessageRow key={msg.id} message={msg} />
          ),
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="描述你的购物需求，如：帮我找一款适合通勤的降噪耳机"
            className="flex-1 resize-none rounded-md border bg-surface p-3 text-sm outline-none focus:border-primary"
          />
          {isStreaming ? (
            <button
              onClick={stopStream}
              className="shrink-0 rounded-md border border-primary px-3 py-2 text-sm text-primary hover:bg-primary/10"
            >
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`mb-3 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg border bg-surface px-3 py-2 text-sm ${
          isUser ? "border-primary/30" : ""
        }`}
      >
        {!isUser && <p className="mb-1 text-xs text-muted">Agent</p>}
        <p className="whitespace-pre-wrap break-words">
          {message.content}
          {message.status === "cancelled" && (
            <span className="ml-1 text-xs text-muted">（已停止）</span>
          )}
          {message.status === "error" && (
            <span className="ml-1 text-xs text-muted">（出错了）</span>
          )}
        </p>
      </div>
    </div>
  );
}

// 流式期间 messages 数组引用不变 → memo 短路，非激活消息零重渲染
const MemoMessageRow = memo(MessageRow);

function StreamingBubble({ message }: { message: ChatMessage }) {
  // 只订阅 streamingContent：每来一个 token 仅此组件重渲染（增量渲染核心）
  const streamingContent = useChatStore((s) => s.streamingContent);
  return (
    <div className="mb-3 flex justify-start">
      <div className="max-w-[80%] rounded-lg border bg-surface px-3 py-2 text-sm">
        <p className="mb-1 text-xs text-muted">Agent</p>
        <p className="whitespace-pre-wrap break-words">
          {streamingContent}
          <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />
        </p>
      </div>
    </div>
  );
}
