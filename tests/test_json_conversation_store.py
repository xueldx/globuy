# -*- coding: utf-8 -*-
"""JsonFileConversationStore 的 F3 会话 CRUD 测试。

该形态是一会话一文件、append-only JSONL：改名 / 软删 / 自动标题都靠追加
`session_meta` 记录，读时以最后一条为准（event sourcing 风格）。
"""
from __future__ import annotations

import pytest

from app.domain.session.ports.conversation_store import ConversationTurn
from app.infrastructure.persistence.json_file_stores import JsonFileConversationStore

pytestmark = pytest.mark.asyncio


@pytest.fixture
def store(tmp_path):
    return JsonFileConversationStore(tmp_path)


async def test_touch_then_list(store):
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.append_turn(
        ConversationTurn(session_id="s1", buyer_id="buyer-001", role="buyer", content="你好"),
    )
    summaries = await store.list_sessions("buyer-001")
    assert [summary.session_id for summary in summaries] == ["s1"]
    assert summaries[0].title == ""


async def test_rename_and_auto_title_after_rename_is_dropped(store):
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    assert await store.set_fallback_title("s1", "兜底标题") is True
    assert await store.set_fallback_title("s1", "不应覆盖") is False

    session = await store.find_session("s1")
    assert session["title"] == "兜底标题"

    assert await store.rename_session("s1", "用户改名") is True
    session = await store.find_session("s1")
    assert session["title"] == "用户改名"
    assert session["title_custom"] is True

    # 用户已改名 → 语义标题被丢弃（标题不回到兜底/被 LLM 覆盖）
    assert await store.set_auto_title("s1", "LLM 标题", only_if_not_custom=True) is False
    session = await store.find_session("s1")
    assert session["title"] == "用户改名"


async def test_auto_title_applies_when_not_custom(store):
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.set_fallback_title("s1", "兜底标题")
    assert await store.set_auto_title("s1", "语义标题", only_if_not_custom=True) is True

    session = await store.find_session("s1")
    assert session["title"] == "语义标题"
    assert session["title_custom"] is False


async def test_soft_delete_keeps_turns_and_filters_list(store):
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.append_turn(
        ConversationTurn(session_id="s1", buyer_id="buyer-001", role="buyer", content="你好"),
    )
    assert await store.soft_delete_session("s1") is True
    assert await store.soft_delete_session("s1") is False

    session = await store.find_session("s1")
    assert session["deleted_at"] is not None
    assert await store.list_sessions("buyer-001") == []
    # 消息仍在（badcase 数据底座）
    assert len(await store.list_turns("s1")) == 1


async def test_buyers_are_isolated(store):
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.touch_session("s2", "buyer-002", "zh-CN", "CNY")
    assert [s.session_id for s in await store.list_sessions("buyer-001")] == ["s1"]
    assert [s.session_id for s in await store.list_sessions("buyer-002")] == ["s2"]


async def test_soft_deleted_session_rejects_rename_and_title_writes(store):
    """软删是终态：改名 / 兜底标题 / 语义标题对已删会话一律拒绝，也不追加改写记录（B7）。"""
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.set_fallback_title("s1", "兜底标题")
    assert await store.soft_delete_session("s1") is True

    assert await store.rename_session("s1", "不应写入") is False
    assert await store.set_fallback_title("s1", "不应写入") is False
    assert await store.set_auto_title("s1", "不应写入", only_if_not_custom=False) is False

    session = await store.find_session("s1")
    assert session["title"] == "兜底标题"  # 三次拒绝都没追加改写
    assert session["deleted_at"] is not None


async def test_rename_does_not_bump_last_active_at(store):
    """改名是元数据记账，不该把旧会话顶成「最近活跃」而重排列表（B3）。"""
    await store.touch_session("s1", "buyer-001", "zh-CN", "CNY")
    await store.append_turn(
        ConversationTurn(session_id="s1", buyer_id="buyer-001", role="buyer", content="先问"),
    )
    await store.touch_session("s2", "buyer-001", "zh-CN", "CNY")
    await store.append_turn(
        ConversationTurn(session_id="s2", buyer_id="buyer-001", role="buyer", content="后问"),
    )

    before = await store.find_session("s1")
    await store.rename_session("s1", "用户改名")
    after = await store.find_session("s1")

    # s1 的最后活跃仍是它最后一条流水的时间，改名发生的更晚也不该改它
    assert after["last_active_at"] == before["last_active_at"]
    assert after["title"] == "用户改名"
    summaries = await store.list_sessions("buyer-001")
    assert [summary.session_id for summary in summaries] == ["s2", "s1"]  # 排序不被改名扰动


async def test_rename_missing_returns_false(store):
    assert await store.rename_session("nope", "标题") is False
