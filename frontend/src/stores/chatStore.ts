import { create } from "zustand";
import type { ChatMessage, ChatMessageStatus, SessionSummary, TradeEventType } from "@/types";
import { streamIntent } from "@/services/commerce";
import { useAgentProcessStore } from "./agentProcessStore";

export interface ChatState {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  /** 已提交消息列表。流式增量不写进这里——保证每来一个 token 消息列表不重渲染 */
  messages: ChatMessage[];
  /** 竞态守卫：流式回调只对「当前激活消息」生效（F3 补完整状态机） */
  streamingMessageId: string | null;
  /** 激活消息的实时文本。只此字段随 token 高频更新 → 只有订阅它的气泡组件重渲染（增量渲染核心） */
  streamingContent: string;
  isStreaming: boolean;
  setCurrentSession: (id: string | null) => void;
  /** 发送购物意图并启动 SSE 流式输出 */
  sendMessage: (rawQuery: string) => Promise<void>;
  /** 停止当前生成（abort） */
  stopStream: () => void;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 模块级：同一时刻只有一条激活流（sendMessage 以 isStreaming 互斥），stopStream 据此 abort
let currentController: AbortController | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  streamingMessageId: null,
  streamingContent: "",
  isStreaming: false,
  setCurrentSession: (id) => set({ currentSessionId: id }),

  sendMessage: async (rawQuery) => {
    const query = rawQuery.trim();
    if (!query || get().isStreaming) return;

    // 首次对话时兜底生成会话（F3 接入服务端会话管理/持久化）
    const sessionId = get().currentSessionId ?? `session-${Date.now().toString(36)}`;
    if (!get().currentSessionId) set({ currentSessionId: sessionId });

    const userMsg: ChatMessage = {
      id: makeId("u"), role: "user", content: query, status: "done", createdAt: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      id: makeId("a"), role: "assistant", content: "", status: "streaming", createdAt: new Date().toISOString(),
    };

    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      isStreaming: true,
      streamingMessageId: assistantMsg.id,
      streamingContent: "",
    }));

    const controller = new AbortController();
    currentController = controller;

    // 竞态守卫：只认「当前激活消息」，杜绝 A 请求的 token 写进 B 消息
    const isActive = () => get().streamingMessageId === assistantMsg.id;

    /** 收口：把流式文本定型进消息并清空守卫（done/cancelled/error 三态统一走这里） */
    const finish = (status: ChatMessageStatus) => {
      if (!isActive()) return;
      const content = get().streamingContent;
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, content, status } : m)),
        isStreaming: false,
        streamingMessageId: null,
        streamingContent: "",
      }));
    };

    try {
      await streamIntent(
        {
          shopping_session_id: sessionId,
          buyer_id: "demo-buyer",
          locale: "zh-CN",
          currency: "CNY",
          raw_query: query,
        },
        {
          onEvent: (event, payload) => {
            if (!isActive()) return;
            switch (event) {
              case "token.delta": {
                const token = (payload as { token?: string }).token ?? "";
                if (!token) return;
                // 只更新 streamingContent：messages 引用不变 → 消息列表零重渲染
                set((s) => ({ streamingContent: s.streamingContent + token }));
                break;
              }
              case "final.result": {
                const text = (payload as { text?: string }).text;
                if (typeof text === "string") set({ streamingContent: text });
                finish("done");
                break;
              }
              case "error": {
                const message = (payload as { error?: string })?.error;
                if (message) set({ streamingContent: message });
                finish("error");
                break;
              }
              default:
                // 过程事件（agent.dispatch/tool.*/plan.update/...）入库，F6 渲染
                if (typeof payload === "object" && payload !== null) {
                  useAgentProcessStore.getState().pushEvent({
                    type: event as TradeEventType,
                    payload: payload as Record<string, unknown>,
                    occurred_at: new Date().toISOString(),
                  });
                }
            }
          },
          onError: (err) => {
            // 重试耗尽等真实错误；abort 走 catch，不在此处理
            if (!isActive() || controller.signal.aborted) return;
            set({ streamingContent: get().streamingContent || `[error] ${err.message}` });
            finish("error");
          },
        },
        controller.signal,
      );

      // 正常收流但未收到 final.result（服务端异常关闭）：统一收口
      if (isActive()) finish(controller.signal.aborted ? "cancelled" : "done");
    } catch (err) {
      if (!isActive()) return;
      // abort（用户点停止）→ cancelled；其他（fetch 失败等）→ error
      if (controller.signal.aborted) finish("cancelled");
      else {
        set({ streamingContent: get().streamingContent || `[error] ${(err as Error).message}` });
        finish("error");
      }
    } finally {
      if (currentController === controller) currentController = null;
    }
  },

  stopStream: () => {
    currentController?.abort();
  },
}));
