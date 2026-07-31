import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRafBatchedValue } from "./useRafBatchedValue";

describe("useRafBatchedValue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("同一帧内只提交最新值", () => {
    let callback: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { result, rerender } = renderHook(
      ({ value }) => useRafBatchedValue(value),
      { initialProps: { value: "A" } },
    );

    rerender({ value: "AB" });
    rerender({ value: "ABC" });
    expect(result.current).toBe("A");
    expect(requestFrame).toHaveBeenCalledTimes(1);

    act(() => callback?.(16));
    expect(result.current).toBe("ABC");
  });

  it("静态模式立即刷新并取消待执行帧", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    const cancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const { result, rerender } = renderHook(
      ({ value, immediate }) => useRafBatchedValue(value, immediate),
      { initialProps: { value: "半条", immediate: false } },
    );

    rerender({ value: "完整消息", immediate: true });
    expect(result.current).toBe("完整消息");
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
