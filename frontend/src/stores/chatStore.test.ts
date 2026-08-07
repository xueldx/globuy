import { afterEach, describe, expect, it, vi } from "vitest";

const commerce = vi.hoisted(() => ({
  createGeneration: vi.fn(),
  fetchLatestGeneration: vi.fn(),
  fetchTurns: vi.fn(),
  listSessions: vi.fn(),
  subscribeGenerationWithResume: vi.fn(),
}));

vi.mock("@/services/commerce", () => ({
  cancelGeneration: vi.fn(),
  createGeneration: commerce.createGeneration,
  deleteSession: vi.fn(),
  fetchLatestGeneration: commerce.fetchLatestGeneration,
  fetchTurns: commerce.fetchTurns,
  listSessions: commerce.listSessions,
  renameSession: vi.fn(),
  subscribeGenerationWithResume: commerce.subscribeGenerationWithResume,
}));

import { useChatStore } from "./chatStore";

describe("chatStore selectSession", () => {
  afterEach(() => {
    Object.values(commerce).forEach((mock) => mock.mockReset());
    useChatStore.getState().resetForLogout();
  });

  it("并发选中冷会话时只加载一次历史，避免 Strict Mode 把历史重复合并", async () => {
    commerce.fetchLatestGeneration.mockRejectedValue(new Error("没有活跃 generation"));
    commerce.fetchTurns.mockResolvedValue([
      { role: "buyer", content: "帮我找耳机", created_at: "2026-09-05T00:00:00Z" },
      { role: "agent", content: "推荐一款降噪耳机", created_at: "2026-09-05T00:00:01Z" },
    ]);

    await Promise.all([
      useChatStore.getState().selectSession("session-cold"),
      useChatStore.getState().selectSession("session-cold"),
    ]);

    expect(commerce.fetchLatestGeneration).toHaveBeenCalledTimes(1);
    expect(commerce.fetchTurns).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messagesBySession["session-cold"]?.map((message) => message.content))
      .toEqual(["帮我找耳机", "推荐一款降噪耳机"]);
  });
});

describe("chatStore commerce snapshots", () => {
  afterEach(() => {
    Object.values(commerce).forEach((mock) => mock.mockReset());
    useChatStore.getState().resetForLogout();
  });

  it("在终态到达前把商品和回答来源冻结进对应助手消息", async () => {
    useChatStore.setState({
      currentSessionId: "session-f7",
      sessions: [{
        id: "session-f7",
        title: "旅行装备",
        created_at: "2026-08-07T17:00:00+08:00",
        last_active_at: "2026-08-07T17:00:00+08:00",
      }],
      messagesBySession: { "session-f7": [] },
    });
    commerce.createGeneration.mockResolvedValue({
      generation_id: "gen-f7",
      session_id: "session-f7",
      status: "running",
      last_event_seq: 0,
      final_text: "",
      error_code: "",
    });
    commerce.subscribeGenerationWithResume.mockImplementation(
      async (_generationId, _afterSeq, onEvent) => {
        onEvent("tool.result", {
          generation_id: "gen-f7",
          seq: 1,
          payload: {
            tool: "product_search_tool",
            hits: [{
              product_id: "P1001",
              title: "旅行三件套",
              brand: "GoLight",
              category: "旅行装备",
              origin_country: "CN",
              price_major: 199,
              currency: "CNY",
              highlights: ["轻便"],
              skus: [],
              score: 0.9,
              citations: [],
            }],
          },
        });
        onEvent("tool.result", {
          generation_id: "gen-f7",
          seq: 2,
          payload: {
            tool: "category_insight_tool",
            sources: [{
              source_id: "knowledge:travel",
              source_type: "knowledge",
              label: "旅行装备指南",
              summary: "先看重量，再看耐用性。",
            }],
          },
        });
        onEvent("final.result", {
          generation_id: "gen-f7",
          seq: 3,
          payload: { text: "给你找到一款合适的旅行套装。" },
        });
      },
    );

    expect(await useChatStore.getState().sendMessage("推荐旅行装备")).toBe(true);

    const messages = useChatStore.getState().messagesBySession["session-f7"];
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("done");
    expect(assistant?.products?.[0].product_id).toBe("P1001");
    expect(assistant?.sources?.[0].source_id).toBe("knowledge:travel");
    expect(assistant?.content).toBe("给你找到一款合适的旅行套装。");
  });
});
