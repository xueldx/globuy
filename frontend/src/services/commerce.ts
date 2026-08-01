import { API_BASE, ApiError, request } from "@/lib/api";
import { SSEHttpError, SSEProtocolError, subscribeSSE, type SSEMessage } from "@/lib/stream";
import type { GenerationSummary, SessionSummary, SessionTurn } from "@/types";

/** 意图提交协议。旧同步接口仍使用它，generation 创建会额外携带 request_id。 */
export interface IntentPayload {
  shopping_session_id: string;
  buyer_id: string;
  locale: string;
  currency: string;
  raw_query: string;
}

/** F3 无登录态，前后端以固定买家身份跑（服务端按 buyer_id 隔离会话）。 */
export const DEMO_BUYER_ID = "demo-buyer";

/** 会话历史轮数默认上限，与服务端限长对齐 */
export const TURNS_LIMIT = 200;
export const SESSIONS_LIMIT = 50;

export function postIntent(payload: IntentPayload) {
  return request<unknown>("/commerce/intents", { method: "POST", body: payload });
}

type GenerationPayload = Omit<IntentPayload, "shopping_session_id"> & { request_id: string };

function isRetryableRequestError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 创建请求只用同一个 request_id 重试，服务端据此返回同一个 generation。 */
export async function createGeneration(
  sessionId: string,
  payload: GenerationPayload,
  signal?: AbortSignal,
): Promise<GenerationSummary> {
  let attempt = 0;
  while (true) {
    try {
      return await request<GenerationSummary>(
        `/commerce/sessions/${encodeURIComponent(sessionId)}/generations`,
        { method: "POST", body: payload, signal },
      );
    } catch (error) {
      if (signal?.aborted || !isRetryableRequestError(error) || attempt >= 2) throw error;
      await abortableDelay(300 * 2 ** attempt, signal);
      attempt += 1;
    }
  }
}

interface GenerationEventEnvelope {
  generation_id: string;
  seq: number;
  payload: unknown;
}

class GenerationEventError extends Error {}

function parseGenerationEvent(generationId: string, message: SSEMessage): GenerationEventEnvelope {
  let envelope: GenerationEventEnvelope;
  try {
    envelope = JSON.parse(message.data) as GenerationEventEnvelope;
  } catch {
    throw new GenerationEventError(`generation ${generationId} 收到非 JSON 事件：${message.event}`);
  }
  const id = Number(message.id);
  if (
    envelope.generation_id !== generationId ||
    !Number.isSafeInteger(envelope.seq) ||
    envelope.seq <= 0 ||
    !Number.isSafeInteger(id) ||
    id !== envelope.seq
  ) {
    throw new GenerationEventError(`generation ${generationId} 收到身份或序号不一致的事件`);
  }
  return envelope;
}

export function getGeneration(generationId: string) {
  return request<GenerationSummary>(`/commerce/generations/${encodeURIComponent(generationId)}`);
}

export function subscribeGeneration(
  generationId: string,
  afterSeq: number,
  onEvent: (event: string, payload: GenerationEventEnvelope) => void,
  onRetryHint?: (retryMs: number) => void,
  signal?: AbortSignal,
) {
  return subscribeSSE({
    url: `/commerce/generations/${encodeURIComponent(generationId)}/events?after_seq=${afterSeq}`,
    headers: { "Last-Event-ID": String(afterSeq) },
    signal,
    onRetry: onRetryHint,
    onMessage: (message) => {
      onEvent(message.event, parseGenerationEvent(generationId, message));
    },
  });
}

/** generation 已在服务端存在，重连 GET SSE 不会重复启动 Agent，因此可安全按 seq 重试。 */
export async function subscribeGenerationWithResume(
  generationId: string,
  initialSeq: number,
  onEvent: (event: string, payload: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = initialSeq;
  let attempt = 0;
  let retryBaseMs = 400;
  while (!signal?.aborted) {
    let terminalEventSeen = false;
    try {
      await subscribeGeneration(
        generationId,
        cursor,
        (event, envelope) => {
          cursor = Math.max(cursor, envelope.seq);
          attempt = 0;
          if (["final.result", "cancelled", "error"].includes(event)) terminalEventSeen = true;
          onEvent(event, envelope);
        },
        (retryMs) => {
          retryBaseMs = Math.min(5000, Math.max(100, retryMs));
        },
        signal,
      );
      if (terminalEventSeen) return;
      const generation = await getGeneration(generationId);
      if (["completed", "cancelled", "failed"].includes(generation.status)) {
        throw new GenerationEventError(`generation ${generationId} 已终止，但事件流缺少业务终态`);
      }
      throw new Error(`generation ${generationId} 的 SSE 在业务终态前关闭`);
    } catch (err) {
      const retryable =
        !(err instanceof SSEProtocolError) &&
        !(err instanceof GenerationEventError) &&
        (!(err instanceof SSEHttpError) || err.status >= 500);
      if (signal?.aborted || !retryable || attempt >= 6) throw err;
      const backoff = Math.min(5000, retryBaseMs * 2 ** attempt);
      const jitteredDelay = Math.round(backoff * (0.8 + Math.random() * 0.4));
      await abortableDelay(jitteredDelay, signal);
      attempt += 1;
    }
  }
}

export function cancelGeneration(generationId: string) {
  return request<GenerationSummary>(`/commerce/generations/${encodeURIComponent(generationId)}`, { method: "DELETE" });
}

export function fetchLatestGeneration(sessionId: string) {
  return request<GenerationSummary>(
    `/commerce/sessions/${encodeURIComponent(sessionId)}/generations/latest`,
  );
}

// ===== F3 会话管理（服务端为真相源：列表 / 历史 / 重命名 / 软删）=====

/** 会话列表（软删已排除、按最近活跃倒序）。 */
export function listSessions(buyerId: string = DEMO_BUYER_ID, limit: number = SESSIONS_LIMIT) {
  return request<SessionSummary[]>(
    `/commerce/sessions?buyer_id=${encodeURIComponent(buyerId)}&limit=${limit}`,
  );
}

/** 会话已定型消息（轮末才落库，正在流的当轮不在其中）。 */
export function fetchTurns(sessionId: string, limit: number = TURNS_LIMIT) {
  return request<SessionTurn[]>(
    `/commerce/sessions/${encodeURIComponent(sessionId)}/turns?limit=${limit}`,
  );
}

/** 用户重命名：服务端置 title_custom=True，此后异步语义标题不再覆盖。 */
export function renameSession(sessionId: string, title: string) {
  return request<SessionSummary>(`/commerce/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: { title },
  });
}

/** 软删会话（messages/events 留在服务端供追溯，只是列表不再可见）。 */
export function deleteSession(sessionId: string) {
  return request<{ session_id: string; deleted: boolean }>(
    `/commerce/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

/** AGUI 事件通道 WS 地址（后端 /commerce/events，按 shopping_session_id 路由）。F8 接入。 */
export function eventsUrl(): string {
  return `${API_BASE.replace(/^http/, "ws")}/commerce/events`;
}
