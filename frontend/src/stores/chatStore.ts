import { create } from "zustand";
import type { ChatMessage, SessionSummary } from "@/types";

export interface ChatState {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  messages: ChatMessage[];
  /** 流式进行中标志（F3 完整状态机填充） */
  isStreaming: boolean;
  /**
   * 竞态守卫：流式回调只对"当前激活消息"生效。
   * 预埋 ragent chatStore 的同款模式——F3 在每个流式 handler 开头核对此 id。
   */
  streamingMessageId: string | null;
  setCurrentSession: (id: string | null) => void;
  /** F3 填充：sendMessage / cancelGeneration / appendStreamContent / 持久化 */
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  isStreaming: false,
  streamingMessageId: null,
  setCurrentSession: (id) => set({ currentSessionId: id }),
}));
