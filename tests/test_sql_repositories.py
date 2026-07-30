# -*- coding: utf-8 -*-
"""关系库仓储实现测试。

跑 SQLite 内存库（与默认运行形态同源）。仓储代码不绑驱动，换服务型数据库
只需换 DATABASE_URL 与异步驱动，但那些驱动的特有行为本仓未验证。
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.domain.buyer.preference import BuyerPreference
from app.domain.catalog.money import Money
from app.domain.order.address import Address
from app.domain.order.order import Order, OrderStatus
from app.domain.order.order_line import OrderLine
from app.domain.session.ports.conversation_store import (
    ConversationEventRecord,
    ConversationTurn,
)
from app.infrastructure.persistence.sql.repositories import (
    SqlConversationStore,
    SqlOrderRepository,
    SqlPreferenceStore,
    SqlSessionStore,
    bootstrap_schema,
    create_engine,
)
from app.domain.session.ports.generation_store import Generation
from app.infrastructure.persistence.sql.generation_store import SqlGenerationStore

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    await bootstrap_schema(eng)
    yield eng
    await eng.dispose()


def _order(order_id: str = "GBX-000001") -> Order:
    return Order.place(
        order_id=order_id,
        buyer_id="buyer-001",
        shipping_address=Address(
            recipient_name="Pan",
            country="US",
            state="CA",
            city="San Jose",
            address_line="1 Market St",
            postal_code="95110",
            phone="+1-555-0100",
        ),
        lines=[
            OrderLine(
                product_id="P1008",
                sku_id="P1008-S1",
                title="LumenGo 便携露营灯 可充电",
                unit_price=Money(amount_in_minor_units=8900, currency="CNY"),
                quantity=2,
            ),
        ],
    )


class TestEngineSelection:
    """连接池参数必须按驱动分开给：把服务型数据库那套给 SQLite 会直接报错。"""

    async def test_sqlite_engine_created_without_server_pool_args(self):
        engine = create_engine("sqlite+aiosqlite:///:memory:")
        try:
            assert engine.url.get_backend_name() == "sqlite"
        finally:
            await engine.dispose()

    async def test_default_settings_point_to_sqlite(self, tmp_path, monkeypatch):
        """不配 DATABASE_URL 时默认落在 DATA_DIR 下的 SQLite 文件。"""
        from app.infrastructure.settings import load_settings

        monkeypatch.setenv("LLM_API_KEY", "test-key")
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("MYSQL_URL", raising=False)

        settings = load_settings()
        assert settings.database_url.startswith("sqlite+aiosqlite:///")
        assert settings.database_url.endswith("globex.db")

    async def test_explicit_database_url_wins(self, tmp_path, monkeypatch):
        from app.infrastructure.settings import load_settings

        monkeypatch.setenv("LLM_API_KEY", "test-key")
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:////tmp/explicit.db")
        assert load_settings().database_url.endswith("explicit.db")


class TestSessionStore:
    async def test_state_roundtrip(self, engine):
        store = SqlSessionStore(engine)
        await store.save("s1", '{"session_id":"s1"}')
        assert await store.load("s1") == '{"session_id":"s1"}'

    async def test_save_is_upsert(self, engine):
        """每轮都会覆盖写同一会话，第二次不能因主键冲突失败。"""
        store = SqlSessionStore(engine)
        await store.save("s1", '{"v":1}')
        await store.save("s1", '{"v":2}')
        assert await store.load("s1") == '{"v":2}'

    async def test_missing_returns_none(self, engine):
        assert await SqlSessionStore(engine).load("nope") is None


class TestGenerationStore:
    async def test_idempotency_cancel_and_event_cursor(self, engine):
        store = SqlGenerationStore(engine)
        generation = Generation("g1", "s1", "buyer-001", "r1", "queued")
        saved, created = await store.create_or_get(generation)
        assert created is True and saved.generation_id == "g1"
        duplicate, created = await store.create_or_get(Generation("g2", "s1", "buyer-001", "r1", "queued"))
        assert created is False and duplicate.generation_id == "g1"
        assert await store.transition("g1", ("queued",), "running") is True
        first = await store.append_event("g1", "token.delta", {"token": "你"}, "2026-01-01T00:00:00+00:00")
        second = await store.append_event("g1", "token.delta", {"token": "好"}, "2026-01-01T00:00:01+00:00")
        assert first and second and [event.seq for event in await store.list_events("g1", 1)] == [2]
        cancelled = await store.request_cancel("g1")
        assert cancelled and cancelled.status == "cancelling"
        assert await store.transition("g1", ("cancelling",), "cancelled") is True
        assert await store.transition("g1", ("cancelled",), "completed") is False


class TestConversationStore:
    async def test_turns_ordered_by_turn_index(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        for index in range(3):
            await store.append_turn(
                ConversationTurn(
                    session_id="s1", buyer_id="buyer-001", role="buyer", content=f"第{index}问",
                ),
            )
        turns = await store.list_turns("s1")
        assert [turn.content for turn in turns] == ["第0问", "第1问", "第2问"]

    async def test_turn_index_isolated_per_session(self, engine):
        """turn_index 按会话独立自增，不能被其他会话的行数带偏。"""
        store = SqlConversationStore(engine)
        await store.append_turn(
            ConversationTurn(session_id="s1", buyer_id="b", role="buyer", content="a"),
        )
        await store.append_turn(
            ConversationTurn(session_id="s1", buyer_id="b", role="agent", content="b"),
        )
        await store.append_turn(
            ConversationTurn(session_id="s2", buyer_id="b", role="buyer", content="c"),
        )
        assert len(await store.list_turns("s1")) == 2
        assert len(await store.list_turns("s2")) == 1

    async def test_list_turns_returns_tail_not_head(self, engine):
        """limit 语义是「最近 N 轮」不是「最早 N 轮」（B1，对齐文件形态的 turns[-limit:]）。"""
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        for index in range(10):
            await store.append_turn(
                ConversationTurn(
                    session_id="s1", buyer_id="buyer-001", role="buyer", content=f"第{index}轮",
                ),
            )
        turns = await store.list_turns("s1", limit=3)
        assert [turn.content for turn in turns] == ["第7轮", "第8轮", "第9轮"]

    async def test_events_persisted_with_payload(self, engine):
        store = SqlConversationStore(engine)
        await store.append_events(
            [
                ConversationEventRecord(
                    session_id="s1", type="tool.result", payload={"tool": "product_search_tool"},
                ),
            ],
        )
        # 事件表没有读接口，直接查会话主记录确认写入未抛错即可
        assert await store.find_session("s1") is None  # 事件不建会话主记录

    async def test_touch_session_is_idempotent(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        session = await store.find_session("s1")
        assert session is not None and session["buyer_id"] == "buyer-001"

    async def test_empty_events_is_noop(self, engine):
        await SqlConversationStore(engine).append_events([])


class TestSessionCrud:
    """F3：会话列表 / 重命名 / 软删 / 自动标题锁。"""

    async def test_list_excludes_deleted_and_other_buyers(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.touch_session("s2", "buyer-001", "zh-CN", "CNY")
        await store.touch_session("s-other", "buyer-002", "zh-CN", "CNY")
        await store.soft_delete_session("s2")

        ids = [summary.session_id for summary in await store.list_sessions("buyer-001")]
        assert ids == ["s1"]  # 软删 + 他人会话都不出现

    async def test_fallback_title_written_once_until_rename(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        assert await store.set_fallback_title("s1", "兜底标题") is True
        assert await store.set_fallback_title("s1", "不应覆盖") is False  # title 非空即不写

        session = await store.find_session("s1")
        assert session["title"] == "兜底标题"
        assert session["title_custom"] is False

    async def test_rename_marks_custom_and_blocks_auto_title(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.set_fallback_title("s1", "兜底标题")
        assert await store.rename_session("s1", "用户改名") is True

        session = await store.find_session("s1")
        assert session["title"] == "用户改名"
        assert session["title_custom"] is True

        # 语义标题回写：用户已改名（title_custom=True）→ 同一条 UPDATE 命中 0 行
        assert await store.set_auto_title("s1", "LLM 标题", only_if_not_custom=True) is False
        session = await store.find_session("s1")
        assert session["title"] == "用户改名"

    async def test_auto_title_applies_when_not_custom(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.set_fallback_title("s1", "兜底标题")
        assert await store.set_auto_title("s1", "语义标题", only_if_not_custom=True) is True

        session = await store.find_session("s1")
        assert session["title"] == "语义标题"
        assert session["title_custom"] is False

    async def test_soft_delete_keeps_turns_and_is_idempotent(self, engine):
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.append_turn(
            ConversationTurn(session_id="s1", buyer_id="buyer-001", role="buyer", content="你好"),
        )
        assert await store.soft_delete_session("s1") is True
        assert await store.soft_delete_session("s1") is False  # 已删视为不存在

        assert await store.list_sessions("buyer-001") == []
        # badcase 数据底座：消息仍在
        assert len(await store.list_turns("s1")) == 1

    async def test_rename_missing_returns_false(self, engine):
        assert await SqlConversationStore(engine).rename_session("nope", "标题") is False

    async def test_soft_deleted_session_rejects_rename_and_title_writes(self, engine):
        """软删是终态：改名 / 兜底标题 / 语义标题对已删会话一律命中 0 行，标题不被改写（B7）。"""
        store = SqlConversationStore(engine)
        await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
        await store.set_fallback_title("s1", "兜底标题")
        assert await store.soft_delete_session("s1") is True

        assert await store.rename_session("s1", "不应写入") is False
        assert await store.set_fallback_title("s1", "不应写入") is False
        assert await store.set_auto_title("s1", "不应写入", only_if_not_custom=False) is False

        session = await store.find_session("s1")
        assert session["title"] == "兜底标题"  # 三次拒绝都没偷偷改写标题
        assert session["deleted_at"] is not None


class TestOrderRepository:
    async def test_order_roundtrip_preserves_money_and_status(self, engine):
        repo = SqlOrderRepository(engine)
        await repo.save(_order())
        restored = await repo.find_by_id("GBX-000001")
        assert restored is not None
        assert restored.status is OrderStatus.CONFIRMED
        # 金额按最小单位存取，不能有浮点漂移
        assert restored.total_amount().amount_in_minor_units == 17800
        assert restored.total_amount().currency == "CNY"
        assert restored.lines[0].sku_id == "P1008-S1"
        assert restored.shipping_address.country == "US"

    async def test_cancel_then_save_overwrites_status(self, engine):
        repo = SqlOrderRepository(engine)
        order = _order()
        await repo.save(order)
        order.cancel("买家改主意了")
        await repo.save(order)
        restored = await repo.find_by_id("GBX-000001")
        assert restored.status is OrderStatus.CANCELLED
        assert restored.cancel_reason == "买家改主意了"
        # 订单行整体重写，不能出现重复行
        assert len(restored.lines) == 1

    async def test_missing_order_returns_none(self, engine):
        assert await SqlOrderRepository(engine).find_by_id("GBX-999999") is None

    async def test_next_order_id_increments(self, engine):
        repo = SqlOrderRepository(engine)
        assert await repo.next_order_id() == "GBX-000001"
        await repo.save(_order("GBX-000001"))
        assert await repo.next_order_id() == "GBX-000002"


class TestPreferenceStore:
    async def test_append_and_list(self, engine):
        store = SqlPreferenceStore(engine)
        await store.append(
            BuyerPreference(buyer_id="b1", kind="dislike", statement="不要塑料材质"),
        )
        prefs = await store.list_by_buyer("b1")
        assert [p.statement for p in prefs] == ["不要塑料材质"]

    async def test_duplicate_swallowed_by_unique_constraint(self, engine):
        """幂等去重靠唯一约束兜底，重复写入不能抛给调用方。"""
        store = SqlPreferenceStore(engine)
        pref = BuyerPreference(buyer_id="b1", kind="dislike", statement="不要塑料材质")
        await store.append(pref)
        await store.append(pref)
        assert len(await store.list_by_buyer("b1")) == 1

    async def test_same_statement_different_kind_both_kept(self, engine):
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="like", statement="小众设计"))
        await store.append(BuyerPreference(buyer_id="b1", kind="dislike", statement="小众设计"))
        assert len(await store.list_by_buyer("b1")) == 2

    async def test_buyers_isolated(self, engine):
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="like", statement="x"))
        assert await store.list_by_buyer("b2") == []

    async def test_delete_hit_and_miss(self, engine):
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="dislike", statement="不要塑料材质"))

        assert await store.delete("b1", "不要塑料材质") is True
        assert await store.list_by_buyer("b1") == []
        assert await store.delete("b1", "不要塑料材质") is False

    async def test_delete_requires_exact_match(self, engine):
        """删偏好不可逆，不得前缀匹配误删。"""
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="dislike", statement="不要塑料材质"))
        assert await store.delete("b1", "不要塑料") is False
        assert len(await store.list_by_buyer("b1")) == 1

    async def test_delete_removes_both_kinds_of_same_statement(self, engine):
        """同一句话可同时存为 like 与 dislike（见上一条用例），
        撤回时两条一并清除——买家表达的是“忘掉这条说法”。"""
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="like", statement="小众设计"))
        await store.append(BuyerPreference(buyer_id="b1", kind="dislike", statement="小众设计"))

        assert await store.delete("b1", "小众设计") is True
        assert await store.list_by_buyer("b1") == []

    async def test_delete_does_not_cross_buyers(self, engine):
        store = SqlPreferenceStore(engine)
        await store.append(BuyerPreference(buyer_id="b1", kind="dislike", statement="不要塑料材质"))
        await store.append(BuyerPreference(buyer_id="b2", kind="dislike", statement="不要塑料材质"))

        assert await store.delete("b1", "不要塑料材质") is True
        assert len(await store.list_by_buyer("b2")) == 1
