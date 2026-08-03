import { create } from "zustand";
import { ApiError, setUnauthorizedHandler } from "@/lib/api";
import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from "@/services/auth";
import type { CurrentUser } from "@/types";
import { useChatStore } from "./chatStore";

export type AuthStatus = "bootstrapping" | "authenticated" | "anonymous";

interface AuthState {
  user: CurrentUser | null;
  status: AuthStatus;
  busy: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  markAnonymous: () => void;
}

let suspendedUserId: string | null = null;

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: "bootstrapping",
  busy: false,

  bootstrap: async () => {
    try {
      const user = await getCurrentUser();
      suspendedUserId = user.user_id;
      set({ user, status: "authenticated" });
    } catch (error) {
      set({ user: null, status: "anonymous" });
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  },

  login: async (email, password) => {
    set({ busy: true });
    try {
      const user = await loginRequest(email, password);
      if (suspendedUserId && suspendedUserId !== user.user_id) {
        useChatStore.getState().resetForLogout();
      }
      suspendedUserId = user.user_id;
      set({ user, status: "authenticated" });
    } finally {
      set({ busy: false });
    }
  },

  register: async (email, displayName, password) => {
    set({ busy: true });
    try {
      const user = await registerRequest({ email, display_name: displayName, password });
      useChatStore.getState().resetForLogout();
      suspendedUserId = user.user_id;
      set({ user, status: "authenticated" });
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    set({ busy: true });
    try {
      await logoutRequest();
    } catch {
      // 即使网络已断，本页也必须立刻清理身份与用户数据。
    } finally {
      useChatStore.getState().resetForLogout();
      suspendedUserId = null;
      set({ user: null, status: "anonymous", busy: false });
    }
  },

  markAnonymous: () => {
    const user = useAuthStore.getState().user;
    suspendedUserId = user?.user_id ?? suspendedUserId;
    useChatStore.getState().pauseForAuth();
    set({ user: null, status: "anonymous", busy: false });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().markAnonymous());
