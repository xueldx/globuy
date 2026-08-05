/**
 * generation 事件的协议级终态判断。
 *
 * `error` 同时承载诊断提醒与真正失败：只有非空 `payload.error` 才结束任务。
 * 这条规则必须由 SSE 重连和 UI 投影共同使用，避免一边继续、一边停流。
 */
export function isTerminalGenerationEvent(event: string, payload: unknown): boolean {
  if (event === "final.result" || event === "cancelled") return true;
  if (event !== "error" || typeof payload !== "object" || payload === null) return false;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0;
}
