"""F3.1 generation API 集成回归。"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.application.agents.orchestrator import SubmitIntentOutput
from app.domain.session.ports.generation_store import Generation
from app.infrastructure.eventbus import TradeEventBus
from app.infrastructure.persistence.json_file_stores import JsonFileConversationStore
from app.infrastructure.persistence.json_generation_store import JsonGenerationStore
from app.presentation import server


class _FakeOrchestrator:
    def __init__(self, bus: TradeEventBus) -> None:
        self._bus = bus

    async def handle_intent(self, intent) -> SubmitIntentOutput:  # noqa: ANN001
        if intent.raw_query == "block":
            await asyncio.Event().wait()
        if intent.raw_query == "swallow-cancel":
            self._bus.publish(intent.shopping_session_id, "token.delta", {"token": "partial"})
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # 模拟 AgentScope 把任务取消转成一条普通最终消息，而不是继续抛 CancelledError。
                return SubmitIntentOutput(
                    intent.shopping_session_id, "I notice the interruption. How can I help you?",
                )
        self._bus.publish(intent.shopping_session_id, "token.delta", {"token": "ok"})
        self._bus.publish(intent.shopping_session_id, "final.result", {"text": "ok"})
        return SubmitIntentOutput(intent.shopping_session_id, "ok")


class _FakeContainer:
    def __init__(self, data_dir: Path) -> None:
        self.bus = TradeEventBus()
        self.orchestrator = _FakeOrchestrator(self.bus)
        self.conversation_store = JsonFileConversationStore(data_dir)
        self.generation_store = JsonGenerationStore(data_dir)
        self.task_queue = None
        self.backplane = None
        self.settings = SimpleNamespace()

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None


def _payload(request_id: str, raw_query: str = "hello") -> dict[str, str]:
    return {
        "request_id": request_id,
        "buyer_id": "buyer-api",
        "locale": "zh-CN",
        "currency": "CNY",
        "raw_query": raw_query,
    }


def _wait_status(client: TestClient, generation_id: str, expected: str) -> dict:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        result = client.get(f"/commerce/generations/{generation_id}")
        assert result.status_code == 200
        if result.json()["status"] == expected:
            return result.json()
        time.sleep(0.01)
    raise AssertionError(f"generation {generation_id} 未进入 {expected}")


def _wait_seq(client: TestClient, generation_id: str, minimum: int) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if client.get(f"/commerce/generations/{generation_id}").json()["last_event_seq"] >= minimum:
            return
        time.sleep(0.01)
    raise AssertionError(f"generation {generation_id} 未写入 seq {minimum}")


def test_generation_api_idempotency_replay_cancel_and_limit(tmp_path, monkeypatch):
    container = _FakeContainer(tmp_path)
    orphan = Generation("gen-orphan", "s-orphan", "buyer-api", "req-orphan", "running")
    asyncio.run(container.generation_store.create_or_get(orphan))

    async def fake_build_container() -> _FakeContainer:
        return container

    monkeypatch.setattr(server, "build_container", fake_build_container)
    app = server.build_app()

    with TestClient(app) as client:
        interrupted = client.get("/commerce/sessions/s-orphan/generations/latest")
        assert interrupted.status_code == 404
        assert client.get("/commerce/generations/gen-orphan").json() == {
            "generation_id": "gen-orphan",
            "session_id": "s-orphan",
            "status": "failed",
            "last_event_seq": 0,
            "final_text": "",
            "error_code": "orphaned_after_restart",
        }

        created = client.post("/commerce/sessions/s-done/generations", json=_payload("req-same"))
        assert created.status_code == 200
        generation_id = created.json()["generation_id"]
        completed = _wait_status(client, generation_id, "completed")
        assert completed["final_text"] == "ok"

        duplicate = client.post("/commerce/sessions/s-done/generations", json=_payload("req-same"))
        assert duplicate.status_code == 200
        assert duplicate.json()["generation_id"] == generation_id

        replay = client.get(f"/commerce/generations/{generation_id}/events?after_seq=0")
        assert replay.status_code == 200
        assert replay.text.count("event: user.message") == 1
        assert replay.text.count("event: token.delta") == 1
        assert replay.text.count("event: final.result") == 1
        assert '"seq": 1' in replay.text and '"seq": 3' in replay.text

        after_first = client.get(f"/commerce/generations/{generation_id}/events?after_seq=1")
        assert "event: user.message" not in after_first.text
        assert after_first.text.count("event: token.delta") == 1
        assert after_first.text.count("event: final.result") == 1

        blocking = client.post(
            "/commerce/sessions/s-cancel/generations", json=_payload("req-cancel", "block"),
        )
        cancelled_id = blocking.json()["generation_id"]
        cancelled = client.delete(f"/commerce/generations/{cancelled_id}")
        assert cancelled.status_code == 200
        _wait_status(client, cancelled_id, "cancelled")
        cancel_events = client.get(f"/commerce/generations/{cancelled_id}/events").text
        assert cancel_events.count("event: cancelled") == 1

        swallowed = client.post(
            "/commerce/sessions/s-swallow/generations",
            json=_payload("req-swallow", "swallow-cancel"),
        )
        swallowed_id = swallowed.json()["generation_id"]
        _wait_seq(client, swallowed_id, 2)
        client.delete(f"/commerce/generations/{swallowed_id}")
        _wait_status(client, swallowed_id, "cancelled")
        swallowed_events = client.get(f"/commerce/generations/{swallowed_id}/events").text
        assert "partial" in swallowed_events
        assert "I notice the interruption" not in swallowed_events
        assert "event: final.result" not in swallowed_events
        assert swallowed_events.count("event: cancelled") == 1

        active_ids: list[str] = []
        for index in range(3):
            response = client.post(
                f"/commerce/sessions/s-limit-{index}/generations",
                json=_payload(f"req-limit-{index}", "block"),
            )
            assert response.status_code == 200
            active_ids.append(response.json()["generation_id"])

        rejected = client.post(
            "/commerce/sessions/s-limit-4/generations", json=_payload("req-limit-4", "block"),
        )
        assert rejected.status_code == 429
        assert rejected.json()["detail"] == "generation_limit_reached"

        for active_id in active_ids:
            client.delete(f"/commerce/generations/{active_id}")
            _wait_status(client, active_id, "cancelled")
