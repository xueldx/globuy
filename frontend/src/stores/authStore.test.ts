import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from "@/services/auth";
import { useAuthStore } from "./authStore";

const chatActions = vi.hoisted(() => ({
  resetForLogout: vi.fn(),
  pauseForAuth: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
}));

vi.mock("./chatStore", () => ({
  useChatStore: {
    getState: () => chatActions,
  },
}));

const buyer = {
  user_id: "buyer-1",
  email: "buyer@example.com",
  display_name: "Buyer",
};

describe("authStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: null,
      status: "bootstrapping",
      busy: false,
    });
  });

  it("启动时通过 /auth/me 恢复登录用户", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(buyer);

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState()).toMatchObject({
      user: buyer,
      status: "authenticated",
    });
  });

  it("/auth/me 返回 401 时进入未登录状态", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiError(401, "请先登录"));

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState()).toMatchObject({ user: null, status: "anonymous" });
  });

  it("登录成功只保存用户资料，不保存 Session Token", async () => {
    vi.mocked(loginRequest).mockResolvedValue(buyer);

    await useAuthStore.getState().login("buyer@example.com", "password-123");

    const state = useAuthStore.getState();
    expect(state.user).toEqual(buyer);
    expect(state.status).toBe("authenticated");
    expect(state).not.toHaveProperty("token");
  });

  it("退出接口失败时仍清空本地登录状态", async () => {
    vi.mocked(logoutRequest).mockRejectedValue(new Error("offline"));
    useAuthStore.setState({ user: buyer, status: "authenticated" });

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      status: "anonymous",
      busy: false,
    });
    expect(registerRequest).not.toHaveBeenCalled();
  });
});
