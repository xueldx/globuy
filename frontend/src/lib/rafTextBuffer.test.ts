import { afterEach, describe, expect, it, vi } from "vitest";
import { createRafTextBuffer } from "./rafTextBuffer";

describe("createRafTextBuffer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("同一帧内的多次 delta 只提交一次", () => {
    let callback: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const commits: string[] = [];
    const buffer = createRafTextBuffer("", (content) => commits.push(content));

    for (let index = 0; index < 20; index += 1) buffer.append(String(index % 10));

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([]);
    callback?.(16);
    expect(commits).toEqual(["01234567890123456789"]);
  });

  it("终态文本立即提交并取消待执行帧", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    const cancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const commits: string[] = [];
    const buffer = createRafTextBuffer("", (content) => commits.push(content));

    buffer.append("半条");
    buffer.replaceAndFlush("完整结果");

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(commits).toEqual(["完整结果"]);
  });
});
