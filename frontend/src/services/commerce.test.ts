import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeneration, subscribeGenerationWithResume } from "./commerce";

function sseResponse(frame: string, status = 200) {
  return new Response(frame, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function generationResponse(status: "running" | "completed") {
  return new Response(JSON.stringify({
    generation_id: "gen-1",
    session_id: "s1",
    status,
    last_event_seq: status === "completed" ? 2 : 1,
    final_text: status === "completed" ? "你好" : "",
    error_code: "",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("generation SSE service", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("断流后从最后 seq 恢复，不会重新创建 generation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(
        'id: 1\nevent: token.delta\ndata: {"generation_id":"gen-1","seq":1,"payload":{"token":"你"}}\n\n',
      ))
      .mockResolvedValueOnce(generationResponse("running"))
      .mockResolvedValueOnce(sseResponse(
        'id: 2\nevent: final.result\ndata: {"generation_id":"gen-1","seq":2,"payload":{"text":"你好"}}\n\n',
      ));
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];

    const result = subscribeGenerationWithResume("gen-1", 0, (event) => events.push(event));
    await vi.advanceTimersByTimeAsync(400);
    await result;

    expect(events).toEqual(["token.delta", "final.result"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("after_seq=1");
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ "Last-Event-ID": "1" });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/generations") || !String(url).includes("/sessions/"))).toBe(true);
  });

  it("generation 已终止但缺少终态事件时直接报协议错误", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(
        'id: 1\nevent: token.delta\ndata: {"generation_id":"gen-1","seq":1,"payload":{"token":"你"}}\n\n',
      ))
      .mockResolvedValueOnce(generationResponse("completed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(subscribeGenerationWithResume("gen-1", 0, vi.fn())).rejects.toThrow(
      "事件流缺少业务终态",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("创建请求网络失败时复用同一个 request_id", async () => {
    vi.useFakeTimers();
    const payload = {
      request_id: "req-1",
      buyer_id: "buyer-1",
      locale: "zh-CN",
      currency: "CNY",
      raw_query: "hello",
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(generationResponse("running"));
    vi.stubGlobal("fetch", fetchMock);

    const result = createGeneration("s1", payload);
    await vi.advanceTimersByTimeAsync(300);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(fetchMock.mock.calls[0][1]?.body).toContain('"request_id":"req-1"');
  });
});
