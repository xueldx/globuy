# -*- coding: utf-8 -*-
"""presentation DTO

REST 请求 / 响应模型。shopping_session_id 缺省时由服务端生成。
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SubmitIntentRequest(BaseModel):
    shopping_session_id: Optional[str] = Field(default=None, description="会话 ID，缺省则新建会话")
    buyer_id: str = Field(min_length=1, description="买家 ID")
    locale: str = Field(default="zh-CN")
    currency: str = Field(default="CNY")
    raw_query: str = Field(min_length=1, description="买家自然语言购物意图")


class SubmitIntentResponse(BaseModel):
    shopping_session_id: str
    final_text: str


class CancelOrderRequest(BaseModel):
    reason: str = Field(min_length=1, description="取消原因")


# ---- F3 会话管理 ----

class SessionSummaryOut(BaseModel):
    """侧边栏列表条目。title 首轮结束前可能为空串。"""

    id: str
    title: str = ""
    created_at: str = ""
    last_active_at: str = ""


class RenameSessionRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200, description="会话新标题")


class TurnOut(BaseModel):
    role: str  # buyer / agent
    content: str
    created_at: str = ""


# ---- F3.1 generation 生命周期 ----

class CreateGenerationRequest(SubmitIntentRequest):
    request_id: str = Field(min_length=1, max_length=64)


class GenerationOut(BaseModel):
    generation_id: str
    session_id: str
    status: str
    last_event_seq: int = 0
    final_text: str = ""
    error_code: str = ""
