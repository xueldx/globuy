import { useNavigate } from "react-router-dom";
import { useChatStore } from "@/stores/chatStore";

export default function Sidebar() {
  const sessions = useChatStore((state) => state.sessions);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const navigate = useNavigate();

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-2 border-r p-3">
      <button
        onClick={() => navigate("/chat")}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        + 新建会话
      </button>
      <nav className="flex flex-col gap-1">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted">暂无会话</p>
        )}
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => navigate(`/chat/${session.id}`)}
            className={`truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface ${
              currentSessionId === session.id ? "bg-surface" : ""
            }`}
          >
            {session.title}
          </button>
        ))}
      </nav>
    </aside>
  );
}
