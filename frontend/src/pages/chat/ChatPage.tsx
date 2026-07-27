import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useChatStore } from "@/stores/chatStore";

/** 聊天页壳：F1 只验证路由/布局/store 骨架。流式引擎（F2）、状态机（F3）、渲染（F4/F5）逐步接入。 */
export function Component() {
  const { sessionId } = useParams();
  const setCurrentSession = useChatStore((state) => state.setCurrentSession);
  const messages = useChatStore((state) => state.messages);

  // deep-link 时锚定当前会话（副作用放 effect，不在 render 里写状态）
  useEffect(() => {
    if (sessionId) setCurrentSession(sessionId);
  }, [sessionId, setCurrentSession]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-24 text-center text-sm text-muted">
            输入购物意图，开始一次跨境购物 Agent 对话
            <br />
            <span className="text-xs">流式引擎将在 F2 接入</span>
          </p>
        )}
      </div>
      <div className="shrink-0 border-t p-3">
        <textarea
          disabled
          rows={3}
          placeholder="流式引擎接入后可用（F2）"
          className="w-full resize-none rounded-md border bg-surface p-3 text-sm outline-none"
        />
      </div>
    </div>
  );
}
