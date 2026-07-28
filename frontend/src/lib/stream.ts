import { API_BASE } from "./api";

/**
 * SSE 流式引擎：fetch POST + ReadableStream 帧解析。
 *
 * 为什么不用 EventSource：要 POST 携带意图 body（session/query），EventSource 只支持 GET 且不能带
 * 自定义 header；fetch 拿到 ReadableStream 后可做同样流式，且天然支持 AbortController 取消（停止生成）。
 * 帧解析器移植自 ragent `useStreamResponse.ts`：buffer 累积分片、按行切、空行触发派发、event:/data: 行协议。
 */

export interface PostSSEOptions {
  url: string;
  body: unknown;
  signal?: AbortSignal;
  retryCount?: number;
  retryDelayMs?: number;
  /** 每收到一个完整帧回调（event 为事件名，payload 为 JSON 反序列化结果） */
  onEvent: (event: string, payload: unknown) => void;
  /** 重试耗尽或致命错误 */
  onError?: (error: Error) => void;
}

function parseData(raw: string): unknown {
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    // data 非 JSON（理论上后端统一 JSON 化），原样交给上层
    return raw;
  }
}

async function readSseStream(
  response: Response,
  onEvent: PostSSEOptions["onEvent"],
): Promise<void> {
  if (!response.body) throw new Error("流式响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) return;
    onEvent(eventName, parseData(dataLines.join("\n")));
    eventName = "message";
    dataLines = [];
  };

  while (true) {
    // signal 被 abort 时，本次 read() 会以 AbortError reject（标准行为），
    // 取消沿 catch 上抛，调用方据此区分「停止」与「完成」，不做静默吞掉
    const { value, done } = await reader.read();
    if (done) {
      dispatch();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    // 最后一段可能是不完整行，留回 buffer 等下一分片
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) {
        dispatch(); // 空行 = 帧结束
        continue;
      }
      if (line.startsWith(":")) continue; // 注释/心跳行
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }
}

/**
 * POST 一个 SSE 流式请求。
 *
 * 重试边界（关键）：只对「连接建立前」的瞬时失败做指数退避重试——此刻请求还没发出去、
 * 服务端还没开始生成，重发无副作用。一旦开始收流（readSseStream 进行中），任何错误都
 * **直接上抛不再重试**——重发会重复调用 LLM/Agent 产生重复回复（非幂等）。服务端正常
 * 收流（final.result 后关闭）视为成功返回。非 2xx 是服务端明确拒绝，同样不重试。
 */
export async function postSSE(options: PostSSEOptions): Promise<void> {
  const retryCount = options.retryCount ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 600;
  let attempt = 0;

  // 阶段一：连接建立（唯一允许重试的阶段）
  let response: Response;
  while (true) {
    try {
      response = await fetch(`${API_BASE}${options.url}`, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(options.body),
        signal: options.signal,
      });
      break;
    } catch (error) {
      const err = error as Error;
      if (options.signal?.aborted) throw err; // 主动取消不算错误，直接上抛
      if (attempt >= retryCount) {
        options.onError?.(err);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      attempt += 1;
    }
  }

  if (!response.ok) {
    const err = new Error(`SSE 请求失败（${response.status}）`);
    options.onError?.(err);
    throw err;
  }

  // 阶段二：流一旦开始，绝不再发第二次
  await readSseStream(response, options.onEvent);
}
