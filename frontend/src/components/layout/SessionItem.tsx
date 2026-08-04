import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { SessionSummary } from "@/types";
import { cn } from "@/lib/utils";

/**
 * F3 会话行：行内重命名 + 删除二次确认（决策 D12，自研轻量版——globuy 无 shadcn）。
 *
 * 交互规范（对齐 ragent SessionItem）：
 *   - hover 出 ⋯ 菜单（重命名 / 删除），菜单项点击后自动收起；
 *   - 重命名：autoFocus + 全选；Enter 提交 / Esc 取消 / blur 提交 / 空标题视为取消；
 *   - 删除：二次确认（替换行内容的确认态），确认后调 store.deleteSession
 *     （内部先掐流再清分片，删除与流的相撞见决策 D11）。
 * 提交动作都抛给 Sidebar→store，本组件不自己请求，状态推进只负责「UI 态」。
 */
interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  onSelect: () => void;
  /** 乐观重命名；失败已由 store 回滚并提示，这里只要 true/false 决定退出编辑态 */
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}

type Mode = "idle" | "menu" | "rename" | "confirm";

interface MenuPosition {
  left: number;
  top: number;
}

export default function SessionItem({ session, active, onSelect, onRename, onDelete }: SessionItemProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // 菜单由 portal 渲染到 body，避免被会话列表的滚动容器裁切。
  // 不使用全屏遮罩，以免遮住其它会话行上的 ⋯ 按钮。
  useEffect(() => {
    if (mode !== "menu") return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuTriggerRef.current?.contains(target)) return;
      setMode("idle");
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMode("idle");
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mode]);

  const toggleMenu = () => {
    if (mode === "menu") {
      setMode("idle");
      return;
    }

    const rect = menuTriggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const menuWidth = 112;
    const estimatedMenuHeight = 72;
    const viewportPadding = 8;
    const left = Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding));
    const top =
      window.innerHeight - rect.bottom >= estimatedMenuHeight + viewportPadding
        ? rect.bottom + 4
        : Math.max(viewportPadding, rect.top - estimatedMenuHeight - 4);
    setMenuPosition({ left, top });
    setMode("menu");
  };

  // 进重命名态：同步草稿 + 聚焦全选
  useEffect(() => {
    if (mode === "rename") {
      setDraft(session.title);
      const timer = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(timer);
    }
  }, [mode, session.title]);

  /** 提交：空标题视为取消（与 Esc 同语义），否则抛给 store */
  const commitRename = async () => {
    if (mode !== "rename" || busy) return;
    const title = draft.trim();
    if (!title || title === session.title) {
      setMode("idle");
      return;
    }
    setBusy(true);
    try {
      const ok = await onRename(title);
      if (ok) setMode("idle");
      // 失败：store 已回滚标题并弹提示，这里退出编辑态回到旧标题
      else setMode("idle");
    } finally {
      setBusy(false);
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      setMode("idle");
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
      setMode("idle");
    }
  };

  return (
    <div className="relative min-w-40 md:min-w-0">
      {mode === "rename" ? (
        <input
          ref={inputRef}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={() => void commitRename()}
          className="w-full rounded-md border border-primary bg-surface px-2 py-1.5 text-sm outline-none"
          maxLength={200}
        />
      ) : mode === "confirm" ? (
        <div
          className={cn(
            "flex items-center justify-between gap-1 rounded-md border border-red-500/30 px-2 py-1.5",
            active && "bg-surface",
          )}
        >
          <span className="min-w-0 truncate text-xs text-muted">删除该会话？</span>
          <span className="flex shrink-0 gap-1">
            <button
              disabled={busy}
              onClick={() => void handleDelete()}
              className="rounded bg-red-500/90 px-2 py-0.5 text-xs text-white hover:bg-red-500"
            >
              {busy ? "…" : "删除"}
            </button>
            <button
              disabled={busy}
              onClick={() => setMode("idle")}
              className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface"
            >
              取消
            </button>
          </span>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={onSelect}
          onKeyDown={(e) => e.key === "Enter" && onSelect()}
          className={cn(
            "group flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            active ? "bg-surface text-foreground" : "text-muted hover:bg-surface",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{session.title || "新对话"}</span>
          <span className="shrink-0 text-[10px] text-muted/70">{formatListTime(session.last_active_at)}</span>
          {/* hover/激活时露出 ⋯ 菜单入口 */}
          <button
            ref={menuTriggerRef}
            aria-label="会话操作"
            aria-expanded={mode === "menu"}
            aria-haspopup="menu"
            className={cn(
              "shrink-0 rounded px-1 text-xs text-muted transition-opacity",
              mode === "menu" || active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => {
              e.stopPropagation();
              toggleMenu();
            }}
          >
            ⋯
          </button>
        </div>
      )}

      {/* ⋯ 下拉菜单（重命名 / 删除） */}
      {mode === "menu" && menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 w-28 overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
            style={menuPosition}
          >
          <button
            role="menuitem"
            className="flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-surface"
            onClick={(e) => {
              e.stopPropagation();
              setMode("rename");
            }}
          >
            重命名
          </button>
          <button
            role="menuitem"
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-red-500 hover:bg-surface"
            onClick={(e) => {
              e.stopPropagation();
              setMode("confirm");
            }}
          >
            删除
          </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 列表时间：今天显示 HH:mm，更早显示 MM-DD。空串（服务端未返回）直接留白。 */
function formatListTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toTimeString().slice(0, 5);
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
