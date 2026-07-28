import { API_BASE, request } from "@/lib/api";
import { postSSE } from "@/lib/stream";

/** 意图提交协议（POST /commerce/intents）。F2/F3 接入，F8 补幂等。 */
export interface IntentPayload {
  shopping_session_id: string;
  buyer_id: string;
  locale: string;
  currency: string;
  raw_query: string;
}

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

/** AGUI 事件通道 WS 地址（后端 /commerce/events，按 shopping_session_id 路由）。F8 接入。 */
export function eventsUrl(): string {
  return `${API_BASE.replace(/^http/, "ws")}/commerce/events`;
}
