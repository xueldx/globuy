import { createBrowserRouter } from "react-router-dom";
import MainLayout from "./layouts/MainLayout";

/**
 * createBrowserRouter + 路由级 lazy（RR6 约定：页面模块导出命名 `Component`）。
 * 面试点：路由级 code splitting，首屏只载入当前页面分包；会话可 deep-link。
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, lazy: () => import("./pages/welcome/WelcomePage") },
      { path: "chat", lazy: () => import("./pages/chat/ChatPage") },
      { path: "chat/:sessionId", lazy: () => import("./pages/chat/ChatPage") },
    ],
  },
]);
