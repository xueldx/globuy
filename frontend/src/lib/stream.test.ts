import { describe, expect, it, vi } from "vitest";
import { readSSEStream, SSEProtocolError, type SSEMessage } from "./stream";

function responseFromChunks(chunks: Uint8Array[], contentType = "text/event-stream") {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": contentType } });
}

describe("readSSEStream", () => {
  it("跨字节分片解析 UTF-8、标准字段、多行 data 和三种换行", async () => {
    const source =
      ": keepalive\r\n" +
      "id: 17\r" +
      "retry: 900\n" +
      "event: token.delta\r\n" +
      "data:  你\n" +
      "data:好  \r\n\r\n";
    const bytes = new TextEncoder().encode(source);
    const chineseStart = bytes.findIndex((value) => value > 127);
    const chunks = [
      bytes.slice(0, 3),
      bytes.slice(3, chineseStart + 1),
      bytes.slice(chineseStart + 1, chineseStart + 2),
      bytes.slice(chineseStart + 2),
    ];
    const messages: SSEMessage[] = [];

    await readSSEStream(responseFromChunks(chunks), (message) => messages.push(message));

    expect(messages).toEqual([
      { event: "token.delta", data: " 你\n好  ", id: "17", retry: 900 },
    ]);
  });

  it("一个 Chunk 可派发多个 Event，并保留最近的 id", async () => {
    const bytes = new TextEncoder().encode(
      "id: 1\ndata: first\n\nevent: done\ndata: second\n\n",
    );
    const messages: SSEMessage[] = [];

    await readSSEStream(responseFromChunks([bytes]), (message) => messages.push(message));

    expect(messages.map(({ event, data, id }) => ({ event, data, id }))).toEqual([
      { event: "message", data: "first", id: "1" },
      { event: "done", data: "second", id: "1" },
    ]);
  });

  it("没有 data 的 retry 控制块也会更新重连提示", async () => {
    const bytes = new TextEncoder().encode("retry: 1200\n\n");
    const onRetry = vi.fn();

    await readSSEStream(responseFromChunks([bytes]), vi.fn(), undefined, onRetry);

    expect(onRetry).toHaveBeenCalledWith(1200);
  });

  it("EOF 丢弃没有空行闭合的事件", async () => {
    const bytes = new TextEncoder().encode("event: token.delta\ndata: partial\n");
    const onMessage = vi.fn();

    await readSSEStream(responseFromChunks([bytes]), onMessage);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("拒绝非 SSE 响应", async () => {
    const response = responseFromChunks([new Uint8Array()], "application/json");

    await expect(readSSEStream(response, vi.fn())).rejects.toBeInstanceOf(SSEProtocolError);
  });

  it("预先 Abort 时取消 reader 且不回调", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    const controller = new AbortController();
    controller.abort();
    const onMessage = vi.fn();

    await readSSEStream(response, onMessage, controller.signal);

    expect(cancel).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
