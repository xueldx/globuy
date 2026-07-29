# -*- coding: utf-8 -*-
"""ConversationStore 端口 + 对话记录值对象

把每轮对话与过程事件结构化落库，供事后追溯、客服排查，
也为 bad case 采集与回放预留数据底座。

与 SessionStore 的区别：
    SessionStore      存 AgentState 快照（框架内部结构，只为恢复上下文）
    ConversationStore 存业务可读的对话流水（谁在什么时候说了什么、调了哪些工具）
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

VALID_ROLES = ("buyer", "agent")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ConversationTurn:
    """一轮完整问答。turn_index 由存储层按会话自增，写入时可留空。"""

    session_id: str
    buyer_id: str
    role: str  # buyer / agent
    content: str
    model: str = ""
    latency_ms: int = 0
    created_at: str = field(default_factory=_now_iso)

    def __post_init__(self) -> None:
        if self.role not in VALID_ROLES:
            raise ValueError(f"ConversationTurn.role 必须是 {VALID_ROLES}：{self.role}")
        if not self.session_id:
            raise ValueError("ConversationTurn.session_id required")


@dataclass(frozen=True)
class ConversationEventRecord:
    """过程事件的持久化形态（对应 TradeEventBus 的一条事件）。"""

    session_id: str
    type: str
    payload: dict[str, Any]
    occurred_at: str = field(default_factory=_now_iso)


@dataclass(frozen=True)
class SessionSummary:
    """侧边栏列表条目。title 可能为空（首轮结束前尚未生成）。"""

    session_id: str
    buyer_id: str
    title: str = ""
    created_at: str = ""
    last_active_at: str = ""

    def __post_init__(self) -> None:
        if not self.session_id:
            raise ValueError("SessionSummary.session_id required")


class ConversationStore(ABC):
    @abstractmethod
    async def append_turn(self, turn: ConversationTurn) -> None:
        """追加一轮问答。"""

    @abstractmethod
    async def append_events(self, events: list[ConversationEventRecord]) -> None:
        """批量追加过程事件（一轮结束后一次性写，减少往返）。"""

    @abstractmethod
    async def list_turns(self, session_id: str, limit: int = 50) -> list[ConversationTurn]:
        """按 turn_index 升序返回该会话的对话流水。"""

    @abstractmethod
    async def touch_session(
        self,
        session_id: str,
        buyer_id: str,
        locale: str,
        currency: str,
    ) -> None:
        """确保会话主记录存在并刷新活跃时间（upsert）。"""

    @abstractmethod
    async def find_session(self, session_id: str) -> Optional[dict]:
        """会话主记录，不存在返回 None。

        返回字段除主记录外含 title / title_custom / deleted_at（软删时间，
        非空即视为已删除），供接口层做存在性与已删判断。
        """

    # ---- F3：会话列表 / 重命名 / 软删 / 自动标题 ----

    @abstractmethod
    async def list_sessions(self, buyer_id: str, limit: int = 50) -> list[SessionSummary]:
        """某买家未软删的会话，按最近活跃倒序（截断到 limit）。"""

    @abstractmethod
    async def rename_session(self, session_id: str, title: str) -> bool:
        """用户改名：更新 title 并置 title_custom=True。会话不存在/已删返回 False。"""

    @abstractmethod
    async def soft_delete_session(self, session_id: str) -> bool:
        """软删：写 deleted_at（messages/events 不动，保 badcase 数据底座）。
        会话不存在/已删返回 False。"""

    @abstractmethod
    async def set_fallback_title(self, session_id: str, title: str) -> bool:
        """首轮兜底标题：只在 title 仍为空的会话上写，不置 title_custom。
        返回是否真的写入（False = 该会话已有标题/不存在）。"""

    @abstractmethod
    async def set_auto_title(
        self,
        session_id: str,
        title: str,
        only_if_not_custom: bool = True,
    ) -> bool:
        """异步 LLM 语义标题回写：只在 title_custom=False 的行上生效。

        竞态防护的关键：only_if_not_custom 的判断放在**同一条 UPDATE 的 WHERE**
        里，而不是先 SELECT 再写——否则用户恰好在这两步之间重命名就会被覆盖。
        返回该 UPDATE 是否命中（True = 写上了，False = 用户已改名，丢弃）。"""
