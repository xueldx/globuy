import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";
import { useNavigate } from "react-router-dom";

export default function Header() {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const busy = useAuthStore((state) => state.busy);
  const navigate = useNavigate();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <h1 className="text-sm font-semibold">Globuy 跨境购物助手</h1>
      <div className="flex items-center gap-2">
        <span className="hidden text-xs text-muted sm:inline">{user?.display_name}</span>
        <button
          onClick={toggleTheme}
          className="min-h-10 rounded-md border border-border px-3 text-xs transition-[transform,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 hover:bg-surface active:scale-95"
        >
          {theme === "light" ? "🌙 暗色" : "☀️ 亮色"}
        </button>
        <button
          onClick={() => void logout().then(() => navigate("/login", { replace: true }))}
          disabled={busy}
          className="min-h-10 rounded-md px-3 text-xs text-muted transition-[transform,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 hover:bg-surface hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          退出
        </button>
      </div>
    </header>
  );
}
