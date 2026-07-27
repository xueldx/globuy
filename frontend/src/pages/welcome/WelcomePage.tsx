import { useNavigate } from "react-router-dom";

/** 命名导出 Component：配合 router.tsx 的路由级 lazy（RR6 约定）。 */
export function Component() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-4">
      <h1 className="text-2xl font-bold">Globuy 跨境购物 Agent</h1>
      <p className="max-w-md text-center text-sm leading-6 text-muted">
        多平台比价 · 个性化偏好 · 长链路决策。
        <br />
        输入一句购物意图，Agent 实时展示搜索、比价、下单全过程。
      </p>
      <button
        onClick={() => navigate("/chat")}
        className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        开始对话
      </button>
    </div>
  );
}
