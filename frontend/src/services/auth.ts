import { request } from "@/lib/api";
import type { CurrentUser } from "@/types";

export interface RegisterPayload {
  email: string;
  display_name: string;
  password: string;
}

export function register(payload: RegisterPayload) {
  return request<CurrentUser>("/auth/register", { method: "POST", body: payload });
}

export function login(email: string, password: string) {
  return request<CurrentUser>("/auth/login", { method: "POST", body: { email, password } });
}

export function getCurrentUser() {
  return request<CurrentUser>("/auth/me");
}

export function logout() {
  return request<void>("/auth/logout", { method: "POST" });
}
