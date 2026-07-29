/**
 * 统一 fetch 封装（F1 骨架）。
 * 面试点：为什么不用 axios——SSE 流式消费必须用 fetch + ReadableStream，
 * 统一用 fetch 保证普通请求与流式请求同栈（F2 复用本模块的超时/取消）。
 * F8 补充：重试、断线兜底。
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** 默认 15s；SSE/长任务由调用方传更长或关掉 */
  timeoutMs?: number;
}

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `请求失败（${res.status}）`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
