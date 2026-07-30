"""SQL generation 生命周期与事件游标实现。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.domain.session.ports.generation_store import Generation, GenerationEvent, GenerationStatus, GenerationStore
from app.infrastructure.persistence.sql.tables import ConversationGenerationEventRow, ConversationGenerationRow


def _generation(row: ConversationGenerationRow) -> Generation:
    return Generation(row.generation_id, row.session_id, row.buyer_id, row.request_id, row.status, row.last_event_seq, row.final_text or "", row.error_code or "")


class SqlGenerationStore(GenerationStore):
    def __init__(self, engine: AsyncEngine) -> None:
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def create_or_get(self, generation: Generation) -> tuple[Generation, bool]:
        async with self._sessions() as db:
            existing = await db.scalar(select(ConversationGenerationRow).where(ConversationGenerationRow.session_id == generation.session_id, ConversationGenerationRow.request_id == generation.request_id))
            if existing:
                return _generation(existing), False
            row = ConversationGenerationRow(generation_id=generation.generation_id, session_id=generation.session_id, buyer_id=generation.buyer_id, request_id=generation.request_id, status=generation.status)
            db.add(row)
            await db.commit()
            return _generation(row), True

    async def get(self, generation_id: str) -> Optional[Generation]:
        async with self._sessions() as db:
            row = await db.get(ConversationGenerationRow, generation_id)
            return _generation(row) if row else None

    async def count_active(self, buyer_id: str) -> int:
        async with self._sessions() as db:
            count = await db.scalar(select(func.count()).select_from(ConversationGenerationRow).where(
                ConversationGenerationRow.buyer_id == buyer_id,
                ConversationGenerationRow.status.in_(("queued", "running", "cancelling")),
            ))
            return int(count or 0)

    async def transition(self, generation_id: str, from_statuses: tuple[str, ...], to_status: GenerationStatus, *, final_text: str = "", error_code: str = "") -> bool:
        values = {"status": to_status}
        if to_status in ("completed", "cancelled", "failed"):
            values["finished_at"] = datetime.now(timezone.utc)
        if final_text:
            values["final_text"] = final_text
        if error_code:
            values["error_code"] = error_code
        async with self._sessions() as db:
            result = await db.execute(update(ConversationGenerationRow).where(
                ConversationGenerationRow.generation_id == generation_id,
                ConversationGenerationRow.status.in_(from_statuses),
                ConversationGenerationRow.status.not_in(("completed", "cancelled", "failed")),
            ).values(**values))
            await db.commit()
            return bool(result.rowcount)

    async def request_cancel(self, generation_id: str) -> Optional[Generation]:
        await self.transition(generation_id, ("queued", "running"), "cancelling")
        async with self._sessions() as db:
            await db.execute(update(ConversationGenerationRow).where(ConversationGenerationRow.generation_id == generation_id, ConversationGenerationRow.status == "cancelling").values(cancel_requested_at=datetime.now(timezone.utc)))
            await db.commit()
        return await self.get(generation_id)

    async def append_event(self, generation_id: str, type: str, payload: dict, occurred_at: str) -> Optional[GenerationEvent]:
        async with self._sessions() as db:
            row = await db.get(ConversationGenerationRow, generation_id)
            if not row:
                return None
            row.last_event_seq += 1
            event = ConversationGenerationEventRow(generation_id=generation_id, seq=row.last_event_seq, type=type, payload=payload, occurred_at=occurred_at)
            db.add(event)
            await db.commit()
            return GenerationEvent(generation_id, event.seq, type, payload, occurred_at)

    async def list_events(self, generation_id: str, after_seq: int) -> list[GenerationEvent]:
        async with self._sessions() as db:
            rows = (await db.scalars(select(ConversationGenerationEventRow).where(ConversationGenerationEventRow.generation_id == generation_id, ConversationGenerationEventRow.seq > after_seq).order_by(ConversationGenerationEventRow.seq))).all()
            return [GenerationEvent(row.generation_id, row.seq, row.type, row.payload, row.occurred_at) for row in rows]
