from __future__ import annotations

import pytest

from app.domain.session.ports.generation_store import Generation
from app.infrastructure.persistence.json_generation_store import JsonGenerationStore

pytestmark = pytest.mark.asyncio


async def test_json_generation_idempotency_cursor_and_terminal_guard(tmp_path):
    store = JsonGenerationStore(tmp_path)
    original = Generation("g1", "s1", "b1", "request-1", "queued")

    saved, created = await store.create_or_get(original)
    assert created is True and saved == original

    duplicate, created = await store.create_or_get(
        Generation("g2", "s1", "b1", "request-1", "queued"),
    )
    assert created is False and duplicate.generation_id == "g1"

    assert await store.transition("g1", ("queued",), "running") is True
    await store.append_event("g1", "token.delta", {"token": "你"}, "t1")
    await store.append_event("g1", "token.delta", {"token": "好"}, "t2")
    assert [item.seq for item in await store.list_events("g1", 1)] == [2]
    assert await store.count_active("b1") == 1
    assert [item.generation_id for item in await store.list_active_for_session("s1")] == ["g1"]

    await store.request_cancel("g1")
    assert await store.transition("g1", ("cancelling",), "cancelled") is True
    assert await store.transition("g1", ("cancelled",), "completed") is False
    assert await store.count_active("b1") == 0
