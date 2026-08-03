import { createBrowserRouter } from "react-router-dom";
import MainLayout from "./layouts/MainLayout";
import { GuestOnly, RequireAuth } from "./components/auth/AuthGuard";
import { LoginPage, RegisterPage } from "./pages/auth/AuthPage";

/**
 * createBrowserRouter + 路由级 lazy（RR6 约定：页面模块导出命名 `Component`）。
 * 面试点：路由级 code splitting，首屏只载入当前页面分包；会话可 deep-link。
 */
export const router = createBrowserRouter([
  {
    path: "/login",
    element: <GuestOnly><LoginPage /></GuestOnly>,
  },
  {
    path: "/register",
    element: <GuestOnly><RegisterPage /></GuestOnly>,
  },
  {
    path: "/",
    element: <RequireAuth><MainLayout /></RequireAuth>,
    children: [
      { index: true, lazy: () => import("./pages/welcome/WelcomePage") },
      { path: "chat", lazy: () => import("./pages/chat/ChatPage") },
      { path: "chat/:sessionId", lazy: () => import("./pages/chat/ChatPage") },
    ],
  },
]);
