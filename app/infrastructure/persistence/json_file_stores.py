# -*- coding: utf-8 -*-
"""文件持久化实现（零外部依赖的默认形态）

    - 偏好：DATA_DIR/preferences/{buyer_id}.json（追加去重）
    - 会话：DATA_DIR/sessions/{session_id}.json（AgentState 全量快照，重启恢复多轮对话）
    - 对话：DATA_DIR/conversations/{session_id}.jsonl（对话流水 + 事件轨迹）

session/conversation 端口使用 async 接口。文件 IO 本身是同步的，
但端口按数据库实现的需要定义，便于替换实现而不修改调用方。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.domain.buyer.preference import BuyerPreference, PreferenceStore
from app.domain.session.ports.conversation_store import (
    ConversationEventRecord,
    ConversationStore,
    ConversationTurn,
    SessionSummary,
)
from app.domain.session.ports.session_store import SessionStore

logger = logging.getLogger(__name__)


def _safe_name(raw: str) -> str:
    """文件名清洗，避免路径穿越。"""
    safe = "".join(ch for ch in raw if ch.isalnum() or ch in "-_")
    return safe or "anonymous"


class JsonFilePreferenceStore(PreferenceStore):
    def __init__(self, data_dir: Path) -> None:
        self._dir = data_dir / "preferences"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, buyer_id: str) -> Path:
        return self._dir / f"{_safe_name(buyer_id)}.json"

    async def append(self, preference: BuyerPreference) -> None:
        existing = await self.list_by_buyer(preference.buyer_id)
        if any(p.statement == preference.statement and p.kind == preference.kind for p in existing):
            return  # 幂等去重
        existing.append(preference)
        self._write(preference.buyer_id, existing)

    async def list_by_buyer(self, buyer_id: str) -> list[BuyerPreference]:
        path = self._path(buyer_id)
        if not path.exists():
            return []
        try:
            items = json.loads(path.read_text(encoding="utf-8"))
            return [BuyerPreference(**item) for item in items]
        except (ValueError, TypeError) as err:
            logger.warning("偏好文件损坏，按空处理：%s（%s）", path, err)
            return []

    async def delete(self, buyer_id: str, statement: str) -> bool:
        """精确匹配 statement 删除。

        按 statement 而不分 kind：同一句话允许同时存为 like 与 dislike（唯一约束是
        buyer+kind+statement），而买家说“以后别管塑料了”表达的是“忘掉这条说法”，
        而不是“只忘掉它的负向那一面”，所以同 statement 的条目一并清除。
        """
        existing = await self.list_by_buyer(buyer_id)
        remaining = [p for p in existing if p.statement != statement]
        if len(remaining) == len(existing):
            return False
        self._write(buyer_id, remaining)
        return True

    def _write(self, buyer_id: str, preferences: list[BuyerPreference]) -> None:
        payload = [
            {"buyer_id": p.buyer_id, "kind": p.kind, "statement": p.statement, "created_at": p.created_at}
            for p in preferences
        ]
        self._path(buyer_id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


class JsonFileSessionStore(SessionStore):
    """AgentState 快照的文件存取（AgentState 是 pydantic 模型，直接 JSON round-trip）。"""

    def __init__(self, data_dir: Path) -> None:
        self._dir = data_dir / "sessions"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{_safe_name(session_id)}.json"

    async def save(self, session_id: str, state_json: str) -> None:
        self._path(session_id).write_text(state_json, encoding="utf-8")

    async def load(self, session_id: str) -> Optional[str]:
        path = self._path(session_id)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8")


class JsonFileConversationStore(ConversationStore):
    """对话流水的 JSONL 实现：一行一条记录，追加写不覆盖。

    DATABASE_URL=file 时的形态。不做索引与并发控制，仅用于本地开发与排查。

    F3 补充的会话元数据（title / title_custom / deleted_at）无法改写已存在的行，
    所以走 event sourcing 风格：改名 / 软删 / 自动标题都**追加**一条
    `{"kind": "session_meta", ...}` 记录，读取时按追加顺序回放、以最后一条为准。
    """

    def __init__(self, data_dir: Path) -> None:
        self._dir = data_dir / "conversations"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{_safe_name(session_id)}.jsonl"

    def _append_line(self, session_id: str, record: dict) -> None:
        with self._path(session_id).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _read_records(self, session_id: str) -> list[dict]:
        """读出全部行（损坏的单行跳过），顺序即追加顺序。"""
        path = self._path(session_id)
        if not path.exists():
            return []
        records: list[dict] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except ValueError:
                continue  # 单行损坏不影响其余记录
        return records

    @staticmethod
    def _meta_timestamp(record: dict) -> str:
        """从一条记录里取时间戳；无显式时间戳返回空串，由调用方兜底。"""
        return record.get("at") or record.get("created_at") or record.get("occurred_at") or ""

    @staticmethod
    def _scan_meta(records: list[dict]) -> dict:
        """按追加顺序回放会话元数据，返回最后状态。

        主记录字段（buyer_id / locale / currency / created_at）取第一条 session
        记录的；可变字段（title / title_custom / deleted_at）由最后一条
        session_meta 决定——这就是"读时以最后一条为准"。
        """
        state = {
            "buyer_id": "",
            "locale": "",
            "currency": "",
            "created_at": "",
            "title": "",
            "title_custom": False,
            "deleted_at": None,
        }
        for record in records:
            kind = record.get("kind")
            ts = JsonFileConversationStore._meta_timestamp(record)
            if kind == "session":
                for key in ("buyer_id", "locale", "currency"):
                    if record.get(key):
                        state[key] = record[key]
                if not state["created_at"] and ts:
                    state["created_at"] = ts
            elif kind == "session_meta":
                if record.get("title") is not None:
                    state["title"] = record["title"]
                if "title_custom" in record:
                    state["title_custom"] = bool(record["title_custom"])
                if "deleted_at" in record:
                    state["deleted_at"] = record["deleted_at"]
        return state

    def _file_timestamps(self, session_id: str, records: list[dict]) -> tuple[str, str]:
        """会话的 created_at / last_active_at：取会话流水时间戳的 min / max。

        session_meta（改名 / 自动标题 / 软删）只是元数据记账，不参与"最近活跃"——
        否则重命名一条旧会话会把它的 last_active_at 顶到最前、在列表里假装很活跃。

        全部无时间戳（极老的遗留文件）时退回文件 mtime。
        """
        times = [
            self._meta_timestamp(r)
            for r in records
            if r.get("kind") != "session_meta" and self._meta_timestamp(r)
        ]
        if times:
            return min(times), max(times)
        try:
            mtime = datetime.fromtimestamp(self._path(session_id).stat().st_mtime, timezone.utc)
        except OSError:
            return "", ""
        iso = mtime.isoformat()
        return iso, iso

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    async def append_turn(self, turn: ConversationTurn) -> None:
        self._append_line(
            turn.session_id,
            {
                "kind": "turn",
                "buyer_id": turn.buyer_id,
                "role": turn.role,
                "content": turn.content,
                "model": turn.model,
                "latency_ms": turn.latency_ms,
                "created_at": turn.created_at,
            },
        )

    async def append_events(self, events: list[ConversationEventRecord]) -> None:
        for event in events:
            self._append_line(
                event.session_id,
                {
                    "kind": "event",
                    "type": event.type,
                    "payload": event.payload,
                    "occurred_at": event.occurred_at,
                },
            )

    async def list_turns(self, session_id: str, limit: int = 50) -> list[ConversationTurn]:
        turns: list[ConversationTurn] = []
        for record in self._read_records(session_id):
            if record.get("kind") != "turn":
                continue
            turns.append(
                ConversationTurn(
                    session_id=session_id,
                    buyer_id=record.get("buyer_id", ""),
                    role=record["role"],
                    content=record.get("content", ""),
                    model=record.get("model", ""),
                    latency_ms=record.get("latency_ms", 0),
                    created_at=record.get("created_at", ""),
                ),
            )
        return turns[-limit:]

    async def touch_session(self, session_id: str, buyer_id: str, locale: str, currency: str) -> None:
        """文件形态没有独立的会话主表：首轮记一条 session 记录。

        之后的轮次**追加一条 ping** 刷新"最近活跃"——镜像 SQL 实现里
        touch_session 对 last_active_at 的更新，否则 list_sessions 无法按新近排序。
        """
        if self._path(session_id).exists():
            self._append_line(session_id, {"kind": "ping", "at": self._now_iso()})
            return
        self._append_line(
            session_id,
            {
                "kind": "session",
                "buyer_id": buyer_id,
                "locale": locale,
                "currency": currency,
                "created_at": self._now_iso(),
                "at": self._now_iso(),
            },
        )

    async def find_session(self, session_id: str) -> Optional[dict]:
        records = self._read_records(session_id)
        if not records:
            return None
        meta = self._scan_meta(records)
        created_at, last_active_at = self._file_timestamps(session_id, records)
        return {
            "session_id": session_id,
            "buyer_id": meta["buyer_id"],
            "locale": meta["locale"],
            "currency": meta["currency"],
            "title": meta["title"],
            "title_custom": meta["title_custom"],
            "deleted_at": meta["deleted_at"],
            "created_at": meta["created_at"] or created_at,
            "last_active_at": last_active_at,
        }

    async def list_sessions(self, buyer_id: str, limit: int = 50) -> list[SessionSummary]:
        """扫 conversations/ 全目录（O(n)），按最后活跃倒序。

        该形态注释自陈"仅用于本地开发与排查"，全目录扫描可接受。
        """
        results: list[SessionSummary] = []
        for path in self._dir.glob("*.jsonl"):
            session_id = path.stem
            records = self._read_records(session_id)
            if not records:
                continue
            meta = self._scan_meta(records)
            if meta["buyer_id"] != buyer_id:
                continue
            if meta["deleted_at"]:
                continue
            created_at, last_active_at = self._file_timestamps(session_id, records)
            results.append(
                SessionSummary(
                    session_id=session_id,
                    buyer_id=buyer_id,
                    title=meta["title"],
                    created_at=meta["created_at"] or created_at,
                    last_active_at=last_active_at,
                ),
            )
        results.sort(key=lambda summary: summary.last_active_at, reverse=True)
        return results[:limit]

    async def rename_session(self, session_id: str, title: str) -> bool:
        records = self._read_records(session_id)
        if not records:
            return False
        if self._scan_meta(records)["deleted_at"]:
            return False  # 已删会话不可重命名（对齐 SQL 实现的 WHERE deleted_at IS NULL）
        self._append_line(
            session_id,
            {
                "kind": "session_meta",
                "title": title,
                "title_custom": True,  # 用户改名，锁住不被异步标题覆盖
                "at": self._now_iso(),
            },
        )
        return True

    async def soft_delete_session(self, session_id: str) -> bool:
        records = self._read_records(session_id)
        if not records:
            return False
        if self._scan_meta(records)["deleted_at"]:
            return False  # 已软删：不重复追加，返回 False（幂等，与 SQL 实现语义一致）
        self._append_line(
            session_id,
            {"kind": "session_meta", "deleted_at": self._now_iso(), "at": self._now_iso()},
        )
        return True

    async def set_fallback_title(self, session_id: str, title: str) -> bool:
        """兜底标题只在 title 仍为空时写（新会话首轮结束）。"""
        records = self._read_records(session_id)
        if not records:
            return False
        meta = self._scan_meta(records)
        if meta["deleted_at"] or meta["title"]:
            return False
        self._append_line(
            session_id,
            {
                "kind": "session_meta",
                "title": title,
                "title_custom": False,
                "at": self._now_iso(),
            },
        )
        return True

    async def set_auto_title(
        self,
        session_id: str,
        title: str,
        only_if_not_custom: bool = True,
    ) -> bool:
        records = self._read_records(session_id)
        if not records:
            return False
        meta = self._scan_meta(records)
        if meta["deleted_at"]:
            return False
        if only_if_not_custom and meta["title_custom"]:
            return False  # 用户已改名，丢弃
        # 只写 title，不写 title_custom key：语义标题永远不动「用户已命名」这把锁
        #（对齐 SQL 实现的 set_auto_title 只 values(title=…)，title_custom 只在改名时置 True）
        self._append_line(
            session_id,
            {
                "kind": "session_meta",
                "title": title,
                "at": self._now_iso(),
            },
        )
        return True
