import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
// 导入即触发 themeStore 模块副作用：同步读取持久化主题并应用到 <html>（先于渲染，无 FOUC）。
// 见 themeStore.ts 顶部注释：zustand persist 水合是异步的，不能依赖 getState() 拿持久化值。
import { useThemeStore } from "./stores/themeStore";
import "streamdown/styles.css";
import "./index.css";

// 防御性双保险：确保主题一定在首帧前落 DOM（幂等，重复调用无副作用）
useThemeStore.getState().initialize();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
