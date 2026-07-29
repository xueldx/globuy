# -*- coding: utf-8 -*-
"""会话自动标题（三段式里"兜底"与"语义"两步）

标题三段式：
    1. 兜底：首轮结束立即把「首条 buyer 消息」截断成一行标题写库——
       侧边栏永远不会出现占位符；
    2. 语义：fire-and-forget 用备用小模型（LLM_FALLBACK_MODEL）把整轮意图
       提炼成一句话标题；
    3. 锁：回写走 ConversationStore.set_auto_title(only_if_not_custom=True)，
       判断放在同一条 UPDATE 的 WHERE 里——用户改过名（title_custom=True）
       就命中 0 行自动丢弃，不存在"先查后写"的 TOCTOU 窗口。

整条链是 best-effort：模型缺凭据、生成失败、回写失败都只告警，
标题停在兜底截断，绝不反向搞坏已经成功的一轮对话。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from agentscope.message import Msg

logger = logging.getLogger(__name__)

_FALLBACK_LIMIT = 30
# 语义标题是后台 best-effort 任务：模型卡死/慢响应不能无限等（等太久只会让
# 这条 fire-and-forget 任务挂成僵尸，堆积在事件循环里），给个硬超时让它及时收手
_SEMANTIC_TIMEOUT_SECONDS = 30.0
# Msg 的 name 只是标识，不影响对话内容；语义标题用 user/system 两段即可
_SYSTEM_PROMPT = (
    "你是会话标题生成器。给一段购物助手对话起一个不超过 20 字的简洁中文标题，"
    "直接输出标题本身，不要引号、标点或解释。"
)


def _as_text(response: Any) -> str:
    """宽容取最终文本。

    agentscope 的 ChatResponse 对缺失字段可能抛 KeyError（见 llm.py 同款注释），
    且不同版本的文本载体可能是 `.text` 或 Msg 的 `get_text_content()`——
    逐项兜底，统一吞掉异常，避免把标题任务变成主链路的雷。
    """
    try:
        text = getattr(response, "text", None)
    except Exception:  # noqa: BLE001
        text = None
    if text:
        return str(text)
    try:
        if hasattr(response, "get_text_content"):
            return str(response.get_text_content() or "")
    except Exception:  # noqa: BLE001
        pass
    return ""


class AutoTitler:
    """生成语义标题；模型为 None 时跳过语义化，只保留兜底标题。"""

    def __init__(self, model: Optional[Any] = None, fallback_limit: int = _FALLBACK_LIMIT) -> None:
        self._model = model
        self._fallback_limit = fallback_limit

    def fallback_title(self, first_query: str) -> str:
        """把首条买家消息压成一行标题：折叠空白 + 超长截断加省略号。"""
        collapsed = " ".join(first_query.split())
        if len(collapsed) <= self._fallback_limit:
            return collapsed
        return collapsed[: self._fallback_limit] + "…"

    async def generate_semantic(
        self,
        session_id: str,
        first_query: str,
        reply: str,
    ) -> Optional[str]:
        """把整轮意图提炼成一个标题；任何失败都返回 None（停在兜底）。"""
        if self._model is None:
            return None
        user_text = (
            f"买家第一句：{first_query}\n"
            f"助手最终回复（截断）：{reply[:200]}"
        )
        try:
            # 硬超时护栏：备用模型响应慢/卡死时及时收手，不让后台标题任务无限挂等
            response = await asyncio.wait_for(
                self._model(
                    [
                        Msg(name="system", content=_SYSTEM_PROMPT, role="system"),
                        Msg(name="user", content=user_text, role="user"),
                    ],
                ),
                timeout=_SEMANTIC_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning("语义标题生成超时（会话 %s），停在兜底标题", session_id)
            return None
        except Exception as err:  # noqa: BLE001 —— 生成失败只告警
            logger.warning("语义标题生成失败（会话 %s）：%s", session_id, err)
            return None
        title = _as_text(response).strip().strip('"“”').strip()
        title = title.splitlines()[0].strip() if title else ""
        return title[: self._fallback_limit] or None
