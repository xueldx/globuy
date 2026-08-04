import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useChatStore } from "@/stores/chatStore";
import SessionItem from "./SessionItem";

/** 会话侧边栏：F3 接入真实列表（服务端真相源）+ 区分加载/空/错误态 + 新建会话入口。
 *  会话行的重命名/删除都从这里接 store（乐观更新与失败回滚在 store 层，组件只管交互）。 */
export default function Sidebar() {
  const sessions = useChatStore((state) => state.sessions);
  const sessionsLoaded = useChatStore((state) => state.sessionsLoaded);
  const sessionsLoading = useChatStore((state) => state.sessionsLoading);
  const sessionsFailed = useChatStore((state) => state.sessionsFailed);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const setCurrentSession = useChatStore((state) => state.setCurrentSession);
  const renameSession = useChatStore((state) => state.renameSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const navigate = useNavigate();

  // 首次进入加载一次列表（只拉一次；幂等性由 store 的 sessionsLoaded 保证）
  useEffect(() => {
    if (!sessionsLoaded && !sessionsLoading) void loadSessions();
  }, [sessionsLoaded, sessionsLoading, loadSessions]);

  const handleNewChat = () => {
    setCurrentSession(null); // 回到"无当前会话"，输入框发出即新建
    navigate("/chat");
  };

  return (
    <aside className="flex w-full shrink-0 items-center gap-2 border-b bg-background p-2 md:w-60 md:flex-col md:items-stretch md:border-b-0 md:border-r md:p-3">
      <button
        onClick={handleNewChat}
        className="min-h-10 shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        + 新建会话
      </button>

      {!sessionsLoaded && !sessionsFailed ? (
        <p className="px-2 py-6 text-center text-xs text-muted">加载会话中…</p>
      ) : sessionsFailed && sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6">
          <p className="text-center text-xs text-muted">会话列表加载失败</p>
          <button
            onClick={() => void loadSessions()}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface"
          >
            重试
          </button>
        </div>
      ) : (
        <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto md:flex-col md:overflow-y-auto">
          {sessions.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted">
              暂无会话，点「新建会话」开始
            </p>
          )}
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              active={currentSessionId === session.id}
              onSelect={() => navigate(`/chat/${session.id}`)}
              onRename={(title) => renameSession(session.id, title)}
              onDelete={async () => {
                // 删的是当前会话：成功（或 404 幂等）后把路由带回新会话页；
                // 失败 store 已回滚列表并弹提示，这里原地不动
                const wasCurrent = currentSessionId === session.id;
                const deleted = await deleteSession(session.id);
                if (deleted && wasCurrent) navigate("/chat");
              }}
            />
          ))}
        </nav>
      )}
    </aside>
  );
}
