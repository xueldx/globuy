import { afterEach, describe, expect, it, vi } from "vitest";

const commerce = vi.hoisted(() => ({
  fetchLatestGeneration: vi.fn(),
  fetchTurns: vi.fn(),
}));

vi.mock("@/services/commerce", () => ({
  cancelGeneration: vi.fn(),
  createGeneration: vi.fn(),
  deleteSession: vi.fn(),
  fetchLatestGeneration: commerce.fetchLatestGeneration,
  fetchTurns: commerce.fetchTurns,
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  subscribeGenerationWithResume: vi.fn(),
}));

import { useChatStore } from "./chatStore";

describe("chatStore selectSession", () => {
  afterEach(() => {
    commerce.fetchLatestGeneration.mockReset();
    commerce.fetchTurns.mockReset();
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
