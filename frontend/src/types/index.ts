// ===== AGUI 事件协议（后端透传，F6 过程可视化 / F7 商品卡片消费）=====

export type TradeEventType =
  | "agent.dispatch"
  | "tool.invoke"
  | "tool.result"
  | "token.delta"
  | "plan.update"
  | "context.compressed"
  | "model.fallback"
  | "cache.hit"
  | "task.queued"
  | "task.started"
  | "final.result"
  | "error";

export interface TradeEvent {
  type: TradeEventType;
  payload: Record<string, any>;
  occurred_at: string;
}

export interface LandedPrice {
  ship_to: string;
  subtotal_major: number;
  freight_major: number;
  tariff_major: number;
  tariff_rate: number;
  de_minimis_applied: boolean;
  landed_total_major: number;
  currency: string;
  unavailable_reason?: string;
}

export interface ProductCard {
  product_id: string;
  title: string;
  brand: string;
  category: string;
  origin_country: string;
  price_major: number;
  currency: string;
  highlights: string[];
  skus: { sku_id: string; spec: string; price_major: number; currency: string; stock: number }[];
  score: number;
  landed_price?: LandedPrice;
}

// ===== 会话与消息（F1 引入，F3 填充完整状态机）=====

export type ChatMessageStatus = "streaming" | "done" | "cancelled" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
  /** Agent 思考过程（F6 渲染） */
  thinking?: string;
}

/** 会话列表条目（服务端 GET /commerce/sessions 直出，服务端是真相源）。
 *  title 首轮结束前可能为空串；时间字段为 ISO 字符串，空时是 ""。 */
export interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  last_active_at: string;
}

/** 会话历史里的一轮消息（GET /commerce/sessions/{id}/turns，轮末才定型落库）。 */
export interface SessionTurn {
  role: "buyer" | "agent";
  content: string;
  created_at: string;
}

export interface GenerationSummary {
  generation_id: string;
  session_id: string;
  status: "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
  last_event_seq: number;
  final_text: string;
  error_code: string;
}
