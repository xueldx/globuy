import { useEffect, useState, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { VirtualMessageList } from "@/components/chat/VirtualMessageList";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types";

/** 空态共享引用：selector 在无分片时返回同一引用，避免每次 store 更新都重渲染 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 聊天页：F2 SSE + F3 会话分片 + F4 安全 Markdown + F5 虚拟滚动。 */
export function Component() {
  const { sessionId } = useParams();
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const notice = useChatStore((s) => s.notice);
  const dismissNotice = useChatStore((s) => s.dismissNotice);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStream = useChatStore((s) => s.stopStream);

  // 展示键 = 路由优先。防止「从 /chat/B 切到 /chat/A」时，selectSession 生效前的
  // 一帧里还按 currentSessionId(=B) 读到 B 的分片串台；无路由 id（新会话入口）再退回 currentSessionId。
  const viewSessionId = sessionId ?? currentSessionId;

  // 只取「展示会话」分片的叶子：别的会话在后台流式时，这里的引用全都不变 → 零重渲染
  const messages = useChatStore((s) =>
    viewSessionId ? (s.messagesBySession[viewSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const streamingMessageId = useChatStore((s) =>
    viewSessionId ? (s.streamingMsgIdBySession[viewSessionId] ?? null) : null,
  );
  const isStreaming = useChatStore((s) =>
    viewSessionId ? s.statusBySession[viewSessionId] === "streaming" : false,
  );
  const loadingHistory = useChatStore((s) =>
    viewSessionId ? (s.loadingBySession[viewSessionId] ?? false) : false,
  );

  const [input, setInput] = useState("");

  // deep-link / 切路由时锚定会话（副作用放 effect，不在 render 里写状态）。
  // 无 sessionId（新建会话入口）→ 置空当前会话；有 → selectSession（内含幂等守卫与拉历史）
  useEffect(() => {
    if (sessionId) void selectSession(sessionId);
    else setCurrentSession(null);
  }, [sessionId, selectSession, setCurrentSession]);

  const handleSend = async () => {
    const query = input.trim();
    if (!query) return;
    // 消息进入发送流程就立刻清空，不能等整条 SSE 结束；否则旧请求结束时还会误清新草稿。
    const originalInput = input;
    setInput("");
    const started = await sendMessage(query);
    // 被并发上限等前置条件拒绝时恢复原输入；用户已键入新草稿则不覆盖。
    if (!started) setInput((current) => current || originalInput);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasCurrentSession = Boolean(viewSessionId);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <VirtualMessageList
          key={viewSessionId ?? "new-session"}
          messages={messages}
          streamingMessageId={streamingMessageId}
          sessionId={viewSessionId}
          isStreaming={isStreaming}
          loadingHistory={loadingHistory}
          hasCurrentSession={hasCurrentSession}
        />
      </div>

      <div className="shrink-0 border-t border-border bg-background/95 px-4 py-3">
        <div className="w-full">
          {notice && (
            <p className="mb-2 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              <span>{notice}</span>
              <button onClick={dismissNotice} className="shrink-0 text-xs underline underline-offset-2">
                知道了
              </button>
            </p>
          )}
          <div className="rounded-xl border border-border bg-surface p-2 shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder="描述你的购物需求，如：帮我找一款适合通勤的降噪耳机"
              className="block min-h-[52px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted/70"
            />
            <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 pt-2">
              <p className="text-xs text-muted">Enter 发送 · Shift + Enter 换行</p>
              {isStreaming ? (
                <button
                  // 停在「正在展示」的会话上（对后台会话点停止 = 不存在的场景，viewSessionId 兜底语义）
                  onClick={() => stopStream(viewSessionId ?? undefined)}
                  className="shrink-0 rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 active:scale-95"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  className="shrink-0 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
