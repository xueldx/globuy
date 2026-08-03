import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const location = useLocation();

  if (status === "bootstrapping") return <AuthLoading />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  if (status === "bootstrapping") return <AuthLoading />;
  if (status === "authenticated") return <Navigate to="/" replace />;
  return children;
}

function AuthLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted">
      正在确认登录状态…
    </div>
  );
}
