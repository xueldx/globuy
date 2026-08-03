import { afterEach, describe, expect, it, vi } from "vitest";
import { request, setUnauthorizedHandler } from "./api";

describe("authenticated fetch", () => {
  afterEach(() => {
    setUnauthorizedHandler(undefined);
    vi.unstubAllGlobals();
    document.cookie = "globuy_csrf=; Max-Age=0; Path=/";
  });

  it("写请求携带 Cookie 和 CSRF 请求头", async () => {
    document.cookie = "globuy_csrf=csrf-token; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await request("/commerce/example", { method: "POST", body: { value: 1 } });

    expect(fetchMock).toHaveBeenCalledWith("/api/commerce/example", expect.objectContaining({
      credentials: "include",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf-token",
      }),
    }));
  });

  it("401 触发统一未登录处理，并提取 FastAPI detail", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "请先登录" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));

    await expect(request("/commerce/sessions")).rejects.toThrow("请先登录");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
