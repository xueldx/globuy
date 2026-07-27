import { create } from "zustand";
import type { TradeEvent } from "@/types";

export interface AgentProcessState {
  /** AGUI 事件流（WS /commerce/events 透传），F6 归并成步骤时间线 */
  events: TradeEvent[];
  /** 事件通道连接状态（F8 补断线重连） */
  connected: boolean;
  pushEvent: (event: TradeEvent) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useAgentProcessStore = create<AgentProcessState>((set) => ({
  events: [],
  connected: false,
  pushEvent: (event) => set((state) => ({ events: [...state.events, event] })),
  setConnected: (connected) => set({ connected }),
  reset: () => set({ events: [], connected: false }),
}));
