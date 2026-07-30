"""JSONL generation store, used only by DATABASE_URL=file development mode."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.domain.session.ports.generation_store import Generation, GenerationEvent, GenerationStatus, GenerationStore


class JsonGenerationStore(GenerationStore):
    def __init__(self, data_dir: Path) -> None:
        self._dir = data_dir / "generations"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, generation_id: str) -> Path:
        return self._dir / f"{generation_id}.jsonl"

    def _records(self, generation_id: str) -> list[dict]:
        path = self._path(generation_id)
        if not path.exists(): return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _append(self, generation_id: str, record: dict) -> None:
        with self._path(generation_id).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _current(self, generation_id: str) -> Optional[Generation]:
        records = self._records(generation_id)
        state: dict = {}
        for record in records:
            if record["kind"] == "generation": state.update(record)
        if not state: return None
        return Generation(generation_id, state["session_id"], state["buyer_id"], state["request_id"], state["status"], state.get("last_event_seq", 0), state.get("final_text", ""), state.get("error_code", ""))

    async def create_or_get(self, generation: Generation) -> tuple[Generation, bool]:
        existing = self._current(generation.generation_id)
        if existing: return existing, False
        for path in self._dir.glob("*.jsonl"):
            found = self._current(path.stem)
            if found and found.session_id == generation.session_id and found.request_id == generation.request_id: return found, False
        self._append(generation.generation_id, {"kind": "generation", **generation.__dict__})
        return generation, True

    async def get(self, generation_id: str) -> Optional[Generation]: return self._current(generation_id)

    async def transition(self, generation_id: str, from_statuses: tuple[str, ...], to_status: GenerationStatus, *, final_text: str = "", error_code: str = "") -> bool:
        current = self._current(generation_id)
        if not current or current.status not in from_statuses: return False
        self._append(generation_id, {"kind": "generation", **current.__dict__, "status": to_status, "final_text": final_text or current.final_text, "error_code": error_code or current.error_code, "finished_at": datetime.now(timezone.utc).isoformat()})
        return True

    async def request_cancel(self, generation_id: str) -> Optional[Generation]:
        await self.transition(generation_id, ("queued", "running"), "cancelling")
        return self._current(generation_id)

    async def append_event(self, generation_id: str, type: str, payload: dict, occurred_at: str) -> Optional[GenerationEvent]:
        current = self._current(generation_id)
        if not current: return None
        seq = current.last_event_seq + 1
        self._append(generation_id, {"kind": "generation_event", "seq": seq, "type": type, "payload": payload, "occurred_at": occurred_at})
        self._append(generation_id, {"kind": "generation", **current.__dict__, "last_event_seq": seq})
        return GenerationEvent(generation_id, seq, type, payload, occurred_at)

    async def list_events(self, generation_id: str, after_seq: int) -> list[GenerationEvent]:
        return [GenerationEvent(generation_id, r["seq"], r["type"], r["payload"], r["occurred_at"]) for r in self._records(generation_id) if r["kind"] == "generation_event" and r["seq"] > after_seq]
