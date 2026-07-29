import { API_BASE, request } from "@/lib/api";
import { postSSE } from "@/lib/stream";
import type { SessionSummary, SessionTurn } from "@/types";

/** 意图提交协议（POST /commerce/intents）。F2/F3 接入，F8 补幂等。 */
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

/** SSE 流式意图提交（POST /commerce/stream，F2 主链路）。onEvent 按 event 名分流。 */
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
