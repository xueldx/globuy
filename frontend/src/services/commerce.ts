import { API_BASE, request } from "@/lib/api";
import { postSSE, subscribeSSE } from "@/lib/stream";
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

/** 旧版 POST SSE 兼容入口；F3.1 前端主链路已改为 createGeneration + GET 订阅。 */
export function streamIntent(
  payload: IntentPayload,
  handlers: { onEvent: (event: string, payload: unknown) => void; onError?: (error: Error) => void },
  signal?: AbortSignal,
) {
  return postSSE({
    url: "/commerce/stream",
    body: payload,
    signal,
    onEvent: handlers.onEvent,
    onError: handlers.onError,
  });
}

export function createGeneration(sessionId: string, payload: Omit<IntentPayload, "shopping_session_id"> & { request_id: string }) {
  return request<GenerationSummary>(`/commerce/sessions/${encodeURIComponent(sessionId)}/generations`, {
    method: "POST", body: payload,
  });
}

export function subscribeGeneration(generationId: string, afterSeq: number, onEvent: (event: string, payload: unknown) => void, signal?: AbortSignal) {
  return subscribeSSE(`/commerce/generations/${encodeURIComponent(generationId)}/events?after_seq=${afterSeq}`, onEvent, signal);
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
  while (!signal?.aborted) {
    try {
      await subscribeGeneration(generationId, cursor, (event, raw) => {
        const envelope = raw as { seq?: number };
        cursor = Math.max(cursor, envelope.seq ?? cursor);
        onEvent(event, raw);
      }, signal);
      return;
    } catch (err) {
      if (signal?.aborted || attempt >= 6) throw err;
      const delay = Math.min(5000, 400 * 2 ** attempt);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
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
