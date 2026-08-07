# -*- coding: utf-8 -*-
"""网页搜索工具来源事件测试，不访问真实网络。"""
import json

import httpx

from app.application.tools.web_search_tool import build_web_search_tool
from app.infrastructure.context import ShoppingContext, ShoppingContextSnapshot
from app.infrastructure.eventbus import TradeEventBus
from app.infrastructure.settings import Settings


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {
            "results": [
                {
                    "title": "跨境政策说明",
                    "url": "https://example.com/policy",
                    "content": "关税规则" * 120,
                },
            ],
        }


class _FakeAsyncClient:
    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        return None

    async def post(self, *args, **kwargs) -> _FakeResponse:
        return _FakeResponse()


async def test_web_search_event_carries_bounded_sources(monkeypatch, tmp_path):
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    settings = Settings(
        llm_base_url="", llm_api_key="", llm_model="", port=8000, log_level="info",
        embedding_base_url="", embedding_api_key="", embedding_model="", embedding_dim=8,
        qdrant_url="", qdrant_collection="test", reranker_base_url="", reranker_model="",
        tavily_api_key="test-key", otlp_endpoint="", data_dir=tmp_path,
        category_kb_collection="test", context_size=128000, tool_result_limit=20000,
        reply_token_budget=0, tool_failure_threshold=3, tool_circuit_reset_seconds=60,
        cors_origins=["http://localhost:5173"],
    )
    bus = TradeEventBus()
    queue = bus.subscribe("s-web")
    tool = build_web_search_tool(settings, bus)
    token = ShoppingContext.set(
        ShoppingContextSnapshot(
            shopping_session_id="s-web", buyer_id="b1", locale="zh-CN", currency="CNY",
        ),
    )
    try:
        response = await tool(query="最新跨境政策")
    finally:
        ShoppingContext.reset(token)

    assert json.loads(response.content[0].text)["results"][0]["title"] == "跨境政策说明"
    queue.get_nowait()
    result_event = queue.get_nowait()
    source = result_event.payload["sources"][0]
    assert source["source_type"] == "web"
    assert source["url"] == "https://example.com/policy"
    assert len(source["summary"]) == 180
