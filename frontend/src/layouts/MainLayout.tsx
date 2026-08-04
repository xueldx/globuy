import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useThemeStore } from "@/stores/themeStore";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";

export default function MainLayout() {
  const initialize = useThemeStore((state) => state.initialize);

  // 挂载时恢复持久化主题（StrictMode 下 effect 会跑两次，幂等无副作用）
  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
