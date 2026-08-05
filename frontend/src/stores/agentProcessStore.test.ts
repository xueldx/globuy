import { beforeEach, describe, expect, it } from "vitest";
import type { TradeEvent } from "@/types";
import { MAX_PROCESS_EVENTS_PER_SESSION, useAgentProcessStore } from "./agentProcessStore";

function event(seq: number, generationId = "gen-1"): TradeEvent {
  return {
    type: "plan.update",
    payload: { tasks: [] },
    occurred_at: `2026-08-05T12:00:${String(seq % 60).padStart(2, "0")}+08:00`,
    generation_id: generationId,
    seq,
  };
}

describe("agentProcessStore", () => {
  beforeEach(() => useAgentProcessStore.getState().reset());

  it("按会话分片保存后台事件", () => {
    const store = useAgentProcessStore.getState();
    store.pushEvent("session-a", event(1, "gen-a"));
    store.pushEvent("session-b", event(1, "gen-b"));

    const state = useAgentProcessStore.getState();
    expect(state.eventsBySession["session-a"]).toHaveLength(1);
    expect(state.eventsBySession["session-b"]).toHaveLength(1);
    expect(state.eventsBySession["session-a"][0].generation_id).toBe("gen-a");
  });

  it("按 generation 与 seq 忽略回放重复事件", () => {
    const store = useAgentProcessStore.getState();
    store.pushEvent("session-a", event(7));
    store.pushEvent("session-a", { ...event(7), payload: { tasks: [{ state: "done" }] } });

    expect(useAgentProcessStore.getState().eventsBySession["session-a"]).toHaveLength(1);
  });

  it("忽略 token 并限制单会话事件数量", () => {
    const store = useAgentProcessStore.getState();
    store.pushEvent("session-a", { ...event(1), type: "token.delta" });
    for (let seq = 1; seq <= MAX_PROCESS_EVENTS_PER_SESSION + 9; seq += 1) {
      useAgentProcessStore.getState().pushEvent("session-a", event(seq));
    }

    const events = useAgentProcessStore.getState().eventsBySession["session-a"];
    expect(events).toHaveLength(MAX_PROCESS_EVENTS_PER_SESSION);
    expect(events[0].seq).toBe(10);
  });

  it("新一轮与删除会话只清目标分片", () => {
    const store = useAgentProcessStore.getState();
    store.pushEvent("session-a", event(1, "gen-a"));
    store.pushEvent("session-b", event(1, "gen-b"));
    store.beginRun("session-a");

    expect(useAgentProcessStore.getState().eventsBySession["session-a"]).toEqual([]);
    expect(useAgentProcessStore.getState().eventsBySession["session-b"]).toHaveLength(1);

    useAgentProcessStore.getState().clearSession("session-a");
    expect(useAgentProcessStore.getState().eventsBySession["session-a"]).toBeUndefined();
    expect(useAgentProcessStore.getState().eventsBySession["session-b"]).toHaveLength(1);
  });
});
