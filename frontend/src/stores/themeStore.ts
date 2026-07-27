import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "globuy.theme";

interface ThemeState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  /** 幂等：把当前 store 的 theme 应用到 <html>（挂载/水合兜底） */
  initialize: () => void;
}

/** 把主题应用到 DOM。既切 .dark class，也同步 color-scheme（滚动条/原生控件配色）。 */
function applyThemeToDom(theme: ThemeMode) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.setProperty("color-scheme", theme);
}

/**
 * 同步读 localStorage 拿到已持久化的主题。
 * 为什么必须同步：zustand v4 的 persist 水合是【异步微任务】（storage.getItem 被 toThenable
 * 包裹，merge+set 在 .then() 里才执行），模块作用域里 getState() 永远拿不到水合后的值。
 * 所以初始 state 直接在这里同步读——首帧就是正确主题，彻底绕开水合时序。
 */
function readStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return "light";
    const parsed = JSON.parse(raw) as { state?: { theme?: ThemeMode } };
    return parsed.state?.theme === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: readStoredTheme(), // 同步初值 = 持久化值，消除水合竞态
      setTheme: (theme) => {
        applyThemeToDom(theme);
        set({ theme });
      },
      toggleTheme: () => {
        get().setTheme(get().theme === "light" ? "dark" : "light");
      },
      initialize: () => {
        applyThemeToDom(get().theme);
      },
    }),
    {
      name: STORAGE_KEY,
      // 水合完成后再对齐一次 DOM（防御性：正常已被同步初值覆盖，幂等无副作用）
      onRehydrateStorage: () => (state) => {
        if (state) applyThemeToDom(state.theme);
      },
    },
  ),
);

// 模块加载即应用主题（先于 React 渲染，首帧无 FOUC）。初始化在组件渲染前，幂等。
applyThemeToDom(useThemeStore.getState().theme);
