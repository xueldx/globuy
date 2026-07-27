import { useThemeStore } from "@/stores/themeStore";

export default function Header() {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <h1 className="text-sm font-semibold">Globuy 跨境购物助手</h1>
      <button
        onClick={toggleTheme}
        className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-surface"
      >
        {theme === "light" ? "🌙 暗色" : "☀️ 亮色"}
      </button>
    </header>
  );
}
