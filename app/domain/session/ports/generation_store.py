"""一次 Agent 运行的持久化端口。

会话保存长期历史；generation 保存一次可取消、可重连的运行。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal, Optional

GenerationStatus = Literal["queued", "running", "cancelling", "completed", "cancelled", "failed"]
ACTIVE_GENERATION_STATUSES = ("queued", "running", "cancelling")


@dataclass(frozen=True)
class Generation:
    generation_id: str
    session_id: str
    buyer_id: str
    request_id: str
    status: GenerationStatus
    last_event_seq: int = 0
    final_text: str = ""
    error_code: str = ""


@dataclass(frozen=True)
class GenerationEvent:
    generation_id: str
    seq: int
    type: str
    payload: dict[str, Any]
    occurred_at: str


class GenerationStore(ABC):
    @abstractmethod
    async def create_or_get(self, generation: Generation) -> tuple[Generation, bool]: ...

    @abstractmethod
    async def get(self, generation_id: str) -> Optional[Generation]: ...

    @abstractmethod
    async def count_active(self, buyer_id: str) -> int: ...

    @abstractmethod
    async def transition(self, generation_id: str, from_statuses: tuple[str, ...], to_status: GenerationStatus, *, final_text: str = "", error_code: str = "") -> bool: ...

    @abstractmethod
    async def request_cancel(self, generation_id: str) -> Optional[Generation]: ...

    @abstractmethod
    async def append_event(self, generation_id: str, type: str, payload: dict[str, Any], occurred_at: str) -> Optional[GenerationEvent]: ...

    @abstractmethod
    async def list_events(self, generation_id: str, after_seq: int) -> list[GenerationEvent]: ...
