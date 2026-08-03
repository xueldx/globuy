import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestOnly, RequireAuth } from "./AuthGuard";

const auth = vi.hoisted(() => ({
  state: {
    user: null as null | { user_id: string; email: string; display_name: string },
    status: "bootstrapping" as "bootstrapping" | "authenticated" | "anonymous",
    busy: false,
  },
}));

vi.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: typeof auth.state) => unknown) => selector(auth.state),
}));

describe("认证路由守卫", () => {
  beforeEach(() => {
    auth.state = { user: null, status: "bootstrapping", busy: false };
  });

  it("登录状态尚未恢复时不提前显示受保护页面", () => {
    render(
      <MemoryRouter>
        <RequireAuth><p>私有页面</p></RequireAuth>
      </MemoryRouter>,
    );

    expect(screen.getByText("正在确认登录状态…")).toBeInTheDocument();
    expect(screen.queryByText("私有页面")).not.toBeInTheDocument();
  });

  it("未登录访问私有页会跳到登录页", () => {
    auth.state = { ...auth.state, status: "anonymous" };
    render(
      <MemoryRouter initialEntries={["/chat/session-1"]}>
        <Routes>
          <Route path="/login" element={<p>登录页</p>} />
          <Route
            path="/chat/:id"
            element={<RequireAuth><p>私有页面</p></RequireAuth>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("登录页")).toBeInTheDocument();
  });

  it("已登录访问登录页会回到首页", () => {
    auth.state = {
      status: "authenticated",
      user: { user_id: "buyer-1", email: "a@example.com", display_name: "A" },
      busy: false,
    };
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/" element={<p>首页</p>} />
          <Route path="/login" element={<GuestOnly><p>登录页</p></GuestOnly>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("首页")).toBeInTheDocument();
  });
});
