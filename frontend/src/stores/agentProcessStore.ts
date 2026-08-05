import { create } from "zustand";
import type { TradeEvent } from "@/types";
import { processEventIdentity } from "@/lib/agentProcess";

export const MAX_PROCESS_EVENTS_PER_SESSION = 160;

export interface AgentProcessState {
  /** 每个会话当前一轮的过程事件；后台流也写自己的分片。 */
  eventsBySession: Record<string, TradeEvent[]>;
  /** 事件通道连接状态（F8 补断线重连） */
  connected: boolean;
  beginRun: (sessionId: string) => void;
  pushEvent: (sessionId: string, event: TradeEvent) => void;
  clearSession: (sessionId: string) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useAgentProcessStore = create<AgentProcessState>((set) => ({
  eventsBySession: {},
  connected: false,
  beginRun: (sessionId) => set((state) => ({
    eventsBySession: { ...state.eventsBySession, [sessionId]: [] },
  })),
  pushEvent: (sessionId, event) => set((state) => {
    if (event.type === "token.delta") return state;
    const current = state.eventsBySession[sessionId] ?? [];
    const identity = processEventIdentity(event);
    if (identity && current.some((item) => processEventIdentity(item) === identity)) return state;
    const next = [...current, event].slice(-MAX_PROCESS_EVENTS_PER_SESSION);
    return { eventsBySession: { ...state.eventsBySession, [sessionId]: next } };
  }),
  clearSession: (sessionId) => set((state) => {
    if (!(sessionId in state.eventsBySession)) return state;
    const { [sessionId]: _removed, ...rest } = state.eventsBySession;
    return { eventsBySession: rest };
  }),
  setConnected: (connected) => set({ connected }),
  reset: () => set({ eventsBySession: {}, connected: false }),
}));
