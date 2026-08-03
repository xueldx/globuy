import { API_BASE, notifyUnauthorized } from "./api";

/** 传输层解析后的标准 SSE 事件。data 保持原始文本，由业务层决定如何反序列化。 */
export interface SSEMessage {
  event: string;
  data: string;
  id: string;
  retry?: number;
}

export class SSEHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SSEHttpError";
    this.status = status;
  }
}

export class SSEProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSEProtocolError";
  }
}

type MessageHandler = (message: SSEMessage) => void;

/**
 * 从 buffer 中逐行取数据。末尾单独的 CR 先保留，因为下一 Chunk 可能以 LF 开头。
 */
function takeLine(buffer: string, eof = false): { line: string; rest: string } | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === "\n") {
      return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    }
    if (char === "\r") {
      if (index === buffer.length - 1) {
        return eof ? { line: buffer.slice(0, index), rest: "" } : null;
      }
      const width = buffer[index + 1] === "\n" ? 2 : 1;
      return { line: buffer.slice(0, index), rest: buffer.slice(index + width) };
    }
  }
  return null;
}

/** 按 WHATWG 规则解析一条字段行，只移除冒号后的一个可选空格。 */
function splitField(line: string): { field: string; value: string } {
  const colon = line.indexOf(":");
  if (colon < 0) return { field: line, value: "" };
  let value = line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { field: line.slice(0, colon), value };
}

/**
 * 读取并解析一个 SSE Response。
 *
 * 网络 Chunk 与 SSE Event 没有一一对应关系，因此先增量解码，再按空行派发完整事件。
 * EOF 不会补发未闭合事件，这是 SSE 标准规定，也能避免把截断响应误判为完整业务数据。
 */
export async function readSSEStream(
  response: Response,
  onMessage: MessageHandler,
  signal?: AbortSignal,
  onRetry?: (retryMs: number) => void,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new SSEProtocolError(`响应不是 SSE（Content-Type: ${contentType || "missing"}）`);
  }
  if (!response.body) throw new SSEProtocolError("流式响应为空");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let lastEventId = "";
  let eventRetry: number | undefined;
  let reachedEof = false;

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventRetry = undefined;
      return;
    }
    if (!signal?.aborted) {
      onMessage({
        event: eventName || "message",
        data: dataLines.join("\n"),
        id: lastEventId,
        retry: eventRetry,
      });
    }
    eventName = "message";
    dataLines = [];
    eventRetry = undefined;
  };

  const processBufferedLines = (eof = false) => {
    while (true) {
      const next = takeLine(buffer, eof);
      if (!next) return;
      buffer = next.rest;
      const line = next.line;
      if (line === "") {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) continue;

      const { field, value } = splitField(line);
      if (field === "event") {
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      } else if (field === "id" && !value.includes("\0")) {
        lastEventId = value;
      } else if (field === "retry" && /^\d+$/.test(value)) {
        eventRetry = Number(value);
        onRetry?.(eventRetry);
      }
    }
  };

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        buffer += decoder.decode();
        processBufferedLines(true);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      processBufferedLines();
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export interface SubscribeSSEOptions {
  url: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  onMessage: MessageHandler;
  onRetry?: (retryMs: number) => void;
}

/** GET 订阅已存在的 generation。Abort 只关闭观看连接，不会取消服务端任务。 */
export async function subscribeSSE(options: SubscribeSSEOptions): Promise<void> {
  const response = await fetch(`${API_BASE}${options.url}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/event-stream", ...options.headers },
    signal: options.signal,
  });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const detail = await response.text().catch(() => "");
    throw new SSEHttpError(response.status, detail || `SSE 订阅失败（${response.status}）`);
  }
  await readSSEStream(response, options.onMessage, options.signal, options.onRetry);
}
