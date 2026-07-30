# -*- coding: utf-8 -*-
"""FastAPI 服务入口

路由：
    POST /commerce/intents                 提交买家意图（同步返回最终回复；启用队列时内部入队后等结果）
    POST /commerce/intents/async           提交买家意图（立即返回 task_id，结果走 WS 或轮询）
    POST /commerce/stream                  提交买家意图并 SSE 流式返回该会话事件（F2 前端主链路）
    GET  /commerce/tasks/{task_id}         查任务状态（queued / running / done / failed）
    WS   /commerce/events                  订阅会话事件流
    GET  /commerce/orders/{order_id}       查询订单（直连 UseCase，不过 Agent）
    POST /commerce/orders/{order_id}/cancel  取消订单（直连 UseCase）
    # F3 会话管理（服务端为真相源的读写入口）
    GET    /commerce/sessions              会话列表（软删排除、最近活跃倒序）
    GET    /commerce/sessions/{id}/turns   会话历史（已定型消息，轮末才落库）
    PATCH  /commerce/sessions/{id}         重命名（置 title_custom=True）
    DELETE /commerce/sessions/{id}         软删会话（messages/events 保留）
    GET  /health                           健康检查（含依赖连通性与队列深度）

启动：
    uv run uvicorn app.presentation.server:app --port 8000
    uv run python -m app.worker          # 启用队列时另起消费进程

同步接口为什么保留：13 case 评测脚本与前端都依赖它直接返回 final_text，
改成纯异步会一次性搞挂回归与前端。削峰由 worker 并发度保证，与接口形态无关。
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from typing import AsyncGenerator, Optional

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from app.application.agents.orchestrator import SubmitIntentInput
from app.composition import Container, build_container
from app.domain.queue.ports.task_queue import IntentTask, TaskStatus
from app.presentation.connection import ConnectionManager
from app.presentation.dto import (
    CancelOrderRequest,
    RenameSessionRequest,
    SessionSummaryOut,
    SubmitIntentRequest,
    SubmitIntentResponse,
    TurnOut,
    CreateGenerationRequest,
    GenerationOut,
)
from app.domain.session.ports.generation_store import Generation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

logger = logging.getLogger(__name__)

# 幂等键有效期：同一会话同一句话在此窗口内重复提交视为重复请求
_IDEMPOTENCY_TTL_SECONDS = 600
# 轮数计数器存活时长：比幂等窗口长得多，让一整段会话都能被正确分类
_TURN_COUNTER_TTL_SECONDS = 86400


def build_app() -> FastAPI:
    state: dict = {}

    def generation_out(generation) -> GenerationOut:  # noqa: ANN001
        return GenerationOut(
            generation_id=generation.generation_id,
            session_id=generation.session_id,
            status=generation.status,
            last_event_seq=generation.last_event_seq,
            final_text=generation.final_text,
            error_code=generation.error_code,
        )

    async def run_generation(c: Container, generation_id: str, intent: SubmitIntentInput) -> None:
        """执行与事件持久化分离，浏览器断开不影响任务。"""
        await c.generation_store.transition(generation_id, ("queued",), "running")
        queue = c.bus.subscribe(intent.shopping_session_id)
        async def persist_events() -> None:
            while True:
                event = await queue.get()
                try:
                    # generation 的终态只由本执行器落一次，避免总线事件与显式收尾重复。
                    if event.type not in ("final.result", "error", "cancelled"):
                        await c.generation_store.append_event(
                            generation_id, event.type, event.payload, event.occurred_at,
                        )
                finally:
                    queue.task_done()
        recorder = asyncio.create_task(persist_events())
        try:
            result = await c.orchestrator.handle_intent(intent)
            await queue.join()
            current = await c.generation_store.get(generation_id)
            if current is not None and current.status in ("cancelling", "cancelled"):
                # 某些 Agent runtime 会吞掉 task.cancel()，转而返回一条 interruption 文本。
                # 服务端取消状态优先，不能把该文本当 final.result 覆盖已流出的半截内容。
                if current.status == "cancelling":
                    await c.generation_store.append_event(
                        generation_id, "cancelled", {}, datetime.now(timezone.utc).isoformat(),
                    )
                    await c.generation_store.transition(
                        generation_id, ("cancelling",), "cancelled",
                    )
                return
            if result.final_text.startswith("[error]"):
                await c.generation_store.append_event(
                    generation_id, "error", {"error": result.final_text},
                    datetime.now(timezone.utc).isoformat(),
                )
                await c.generation_store.transition(
                    generation_id, ("running",), "failed", error_code="agent_error",
                )
            else:
                await c.generation_store.append_event(
                    generation_id, "final.result", {"text": result.final_text},
                    datetime.now(timezone.utc).isoformat(),
                )
                await c.generation_store.transition(
                    generation_id, ("running",), "completed", final_text=result.final_text,
                )
        except asyncio.CancelledError:
            await c.generation_store.append_event(
                generation_id, "cancelled", {}, datetime.now(timezone.utc).isoformat(),
            )
            await c.generation_store.transition(
                generation_id, ("queued", "running", "cancelling"), "cancelled",
            )
            raise
        except Exception as err:  # noqa: BLE001
            await c.generation_store.append_event(
                generation_id, "error", {"error": str(err)}, datetime.now(timezone.utc).isoformat(),
            )
            await c.generation_store.transition(
                generation_id, ("queued", "running", "cancelling"), "failed", error_code=str(err),
            )
        finally:
            recorder.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recorder
            c.bus.unsubscribe(intent.shopping_session_id, queue)
            state.get("generation_tasks", {}).pop(generation_id, None)

    async def _forward_remote_events(c: Container) -> None:
        """把其他进程（worker）广播的事件转发给本进程的 WS 订阅者。"""
        if c.backplane is None:
            return
        try:
            async for event in c.backplane.listen():
                c.bus.deliver_local(event)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            logger.warning("事件背板监听中断：%s", err)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        c = await build_container()
        state["c"] = c
        state["connections"] = ConnectionManager(c.bus)
        await c.startup()
        if c.backplane is not None:
            # 跨进程事件转发：不开这个任务，worker 产生的流式事件到不了前端
            state["forwarder"] = asyncio.create_task(_forward_remote_events(c))
        try:
            yield
        finally:
            forwarder = state.pop("forwarder", None)
            if forwarder is not None:
                forwarder.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await forwarder
            # 正常停服时主动收口本进程 generation，避免数据库遗留 running 僵尸状态。
            generation_tasks = list(state.get("generation_tasks", {}).values())
            for task in generation_tasks:
                task.cancel()
            if generation_tasks:
                await asyncio.gather(*generation_tasks, return_exceptions=True)
            state.pop("c", None)
            await c.shutdown()

    api = FastAPI(title="Globuy 跨境电商 Agent", version="0.4.0", lifespan=lifespan)

    def container() -> Container:
        if "c" not in state:
            raise HTTPException(status_code=503, detail="服务尚未就绪")
        return state["c"]

    settings_origins = build_container_origins()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=settings_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api.get("/health")
    async def health() -> dict:
        """依赖连通性一并报出，避免"进程活着但存储已挂"被当成健康。"""
        c = container()
        database = "disabled"
        if c.db_engine is not None:
            try:
                async with c.db_engine.connect() as conn:
                    await conn.execute(text("select 1"))
                database = c.db_engine.url.get_backend_name()
            except Exception as err:  # noqa: BLE001
                database = f"error: {err}"
        redis_state = "disabled"
        if c.cache.enabled:
            redis_state = "ok" if await c.cache.ping() else "error"
        return {
            "status": "ok",
            "model": c.settings.llm_model,
            "database": database,
            "redis": redis_state,
            "semantic_cache": c.semantic_cache.enabled,
            "queue": "enabled" if c.task_queue is not None else "disabled",
            "queue_depth": await c.task_queue.depth() if c.task_queue is not None else 0,
        }

    @api.post("/commerce/intents", response_model=SubmitIntentResponse)
    async def submit_intent(body: SubmitIntentRequest) -> SubmitIntentResponse:
        c = container()
        session_id = body.shopping_session_id or f"session-{uuid.uuid4().hex[:8]}"
        intent = SubmitIntentInput(
            shopping_session_id=session_id,
            buyer_id=body.buyer_id,
            locale=body.locale,
            currency=body.currency,
            raw_query=body.raw_query,
        )
        if c.task_queue is None:
            result = await c.orchestrator.handle_intent(intent)
            return SubmitIntentResponse(
                shopping_session_id=result.shopping_session_id, final_text=result.final_text,
            )

        task_id = await _enqueue(c, intent)
        final_text = await _await_result(c, task_id, session_id)
        return SubmitIntentResponse(shopping_session_id=session_id, final_text=final_text)

    @api.post("/commerce/intents/async")
    async def submit_intent_async(body: SubmitIntentRequest) -> dict:
        c = container()
        session_id = body.shopping_session_id or f"session-{uuid.uuid4().hex[:8]}"
        intent = SubmitIntentInput(
            shopping_session_id=session_id,
            buyer_id=body.buyer_id,
            locale=body.locale,
            currency=body.currency,
            raw_query=body.raw_query,
        )
        if c.task_queue is None:
            raise HTTPException(status_code=503, detail="队列未启用，请使用 /commerce/intents")
        task_id = await _enqueue(c, intent)
        return {"shopping_session_id": session_id, "task_id": task_id, "state": "queued"}

    @api.post("/commerce/stream")
    async def stream_intent(body: SubmitIntentRequest) -> StreamingResponse:
        """SSE 流式端点：提交意图后把该会话的 token.delta/过程事件/final.result 逐帧推送。

        与同步 /commerce/intents 同策略（队列启用则入队，否则直跑），但**先订阅再启动**，
        避免「任务已开始、订阅未就绪」的窗口期丢事件。
        """
        c = container()
        session_id = body.shopping_session_id or f"session-{uuid.uuid4().hex[:8]}"
        intent = SubmitIntentInput(
            shopping_session_id=session_id,
            buyer_id=body.buyer_id,
            locale=body.locale,
            currency=body.currency,
            raw_query=body.raw_query,
        )
        queue = c.bus.subscribe(session_id)
        try:
            if c.task_queue is None:
                _track_stream_task(asyncio.create_task(c.orchestrator.handle_intent(intent)))
            else:
                await _enqueue(c, intent)
        except Exception:
            c.bus.unsubscribe(session_id, queue)
            raise
        return StreamingResponse(
            _stream_events(c, session_id, queue, c.settings.queue_wait_seconds),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    @api.post("/commerce/sessions/{session_id}/generations", response_model=GenerationOut)
    async def create_generation(session_id: str, body: CreateGenerationRequest) -> GenerationOut:
        """幂等创建一次运行。SSE 订阅另走 generation 事件端点。"""
        c = container()
        # 同一 API 进程内串行完成“幂等创建 + 配额判断”，避免重复请求被 429 拒绝。
        async with state.setdefault("generation_create_lock", asyncio.Lock()):
            generation = Generation(
                generation_id=f"gen-{uuid.uuid4().hex}", session_id=session_id,
                buyer_id=body.buyer_id, request_id=body.request_id, status="queued",
            )
            saved, created = await c.generation_store.create_or_get(generation)
            if not created:
                return generation_out(saved)
            if await c.generation_store.count_active(body.buyer_id) > 3:
                await c.generation_store.transition(
                    generation.generation_id, ("queued",), "failed",
                    error_code="generation_limit_reached",
                )
                raise HTTPException(status_code=429, detail="generation_limit_reached")
            # 正在运行的本轮尚未进入长期 turns。把用户原始输入作为首个可回放事件，
            # 刷新恢复时才能同时重建 user 消息和 assistant 占位。
            await c.generation_store.append_event(
                generation.generation_id, "user.message", {"text": body.raw_query},
                datetime.now(timezone.utc).isoformat(),
            )
        await c.conversation_store.touch_session(session_id, body.buyer_id, body.locale, body.currency)
        if c.task_queue is not None:
            await _enqueue(c, SubmitIntentInput(
                shopping_session_id=session_id, buyer_id=body.buyer_id, locale=body.locale,
                currency=body.currency, raw_query=body.raw_query,
            ), generation_id=generation.generation_id)
            return generation_out(generation)
        task = asyncio.create_task(run_generation(c, generation.generation_id, SubmitIntentInput(
            shopping_session_id=session_id, buyer_id=body.buyer_id, locale=body.locale,
            currency=body.currency, raw_query=body.raw_query,
        )))
        state.setdefault("generation_tasks", {})[generation.generation_id] = task
        return generation_out(generation)

    @api.get("/commerce/generations/{generation_id}", response_model=GenerationOut)
    async def get_generation(generation_id: str) -> GenerationOut:
        generation = await container().generation_store.get(generation_id)
        if generation is None:
            raise HTTPException(status_code=404, detail="generation 不存在")
        return generation_out(generation)

    @api.get("/commerce/sessions/{session_id}/generations/latest", response_model=GenerationOut)
    async def latest_active_generation(session_id: str) -> GenerationOut:
        """刷新恢复入口：只返回该会话仍未终态的一次运行。"""
        c = container()
        active = await c.generation_store.list_active_for_session(session_id)
        if not active:
            raise HTTPException(status_code=404, detail="没有活跃 generation")
        latest = active[-1]
        if c.task_queue is None and latest.generation_id not in state.get("generation_tasks", {}):
            # 直跑模式没有外部 worker。进程重启后仍为 active 的记录不可能自行恢复，
            # 诚实标为失败，避免前端永远订阅一个没有执行者的 running 任务。
            await c.generation_store.transition(
                latest.generation_id, ("queued", "running", "cancelling"), "failed",
                error_code="orphaned_after_restart",
            )
            raise HTTPException(status_code=404, detail="活跃 generation 已因服务重启中断")
        return generation_out(latest)

    @api.delete("/commerce/generations/{generation_id}", response_model=GenerationOut)
    async def cancel_generation(generation_id: str) -> GenerationOut:
        c = container()
        generation = await c.generation_store.request_cancel(generation_id)
        if generation is None:
            raise HTTPException(status_code=404, detail="generation 不存在")
        task = state.get("generation_tasks", {}).get(generation_id)
        if task is not None:
            task.cancel()
        return generation_out(generation)

    @api.get("/commerce/generations/{generation_id}/events")
    async def generation_events(generation_id: str, after_seq: int = 0) -> StreamingResponse:
        c = container()
        if await c.generation_store.get(generation_id) is None:
            raise HTTPException(status_code=404, detail="generation 不存在")
        async def stream() -> AsyncGenerator[str, None]:
            cursor = max(0, after_seq)
            idle_polls = 0
            while True:
                events = await c.generation_store.list_events(generation_id, cursor)
                for item in events:
                    cursor = item.seq
                    payload = json.dumps({"generation_id": generation_id, "seq": item.seq, "payload": item.payload}, ensure_ascii=False)
                    yield f"event: {item.type}\ndata: {payload}\n\n"
                if events:
                    idle_polls = 0
                generation = await c.generation_store.get(generation_id)
                if generation is None or generation.status in ("completed", "cancelled", "failed"):
                    return
                idle_polls += 1
                if idle_polls >= 50:
                    yield ": keepalive\n\n"
                    idle_polls = 0
                await asyncio.sleep(0.2)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @api.get("/commerce/tasks/{task_id}")
    async def get_task(task_id: str) -> dict:
        c = container()
        if c.task_queue is None:
            raise HTTPException(status_code=503, detail="队列未启用")
        status = await c.task_queue.get_status(task_id)
        if status is None:
            raise HTTPException(status_code=404, detail=f"任务不存在或已过期：{task_id}")
        return {
            "task_id": status.task_id,
            "state": status.state,
            "final_text": status.final_text,
            "error": status.error,
            "queue_position": status.queue_position,
        }

    @api.websocket("/commerce/events")
    async def commerce_events(websocket: WebSocket) -> None:
        await state["connections"].serve(websocket)

    @api.get("/commerce/orders/{order_id}")
    async def get_order(order_id: str) -> dict:
        try:
            return await container().query_order.execute(order_id)
        except ValueError as err:
            raise HTTPException(status_code=404, detail=str(err)) from err

    @api.post("/commerce/orders/{order_id}/cancel")
    async def cancel_order_endpoint(order_id: str, body: CancelOrderRequest) -> dict:
        try:
            return await container().cancel_order.execute(order_id, body.reason)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    # ===== F3 会话管理（服务端为真相源的读写入口）=====

    @api.get("/commerce/sessions", response_model=list[SessionSummaryOut])
    async def list_sessions(buyer_id: str, limit: int = 50) -> list[SessionSummaryOut]:
        """买家会话列表：排除软删、按最近活跃倒序（侧边栏数据源）。"""
        summaries = await container().conversation_store.list_sessions(
            buyer_id=buyer_id,
            limit=max(1, min(limit, 200)),
        )
        return [
            SessionSummaryOut(
                id=summary.session_id,
                title=summary.title,
                created_at=summary.created_at,
                last_active_at=summary.last_active_at,
            )
            for summary in summaries
        ]

    @api.get("/commerce/sessions/{session_id}/turns", response_model=list[TurnOut])
    async def session_turns(session_id: str, limit: int = 200) -> list[TurnOut]:
        """会话已定型消息（每轮轮末写入）。正在流的当轮不在其中。"""
        session = await container().conversation_store.find_session(session_id)
        if session is None or session.get("deleted_at"):
            raise HTTPException(status_code=404, detail=f"会话不存在：{session_id}")
        turns = await container().conversation_store.list_turns(
            session_id, limit=max(1, min(limit, 500)),
        )
        return [
            TurnOut(role=turn.role, content=turn.content, created_at=turn.created_at)
            for turn in turns
        ]

    @api.patch("/commerce/sessions/{session_id}", response_model=SessionSummaryOut)
    async def rename_session(session_id: str, body: RenameSessionRequest) -> SessionSummaryOut:
        """用户重命名：置 title_custom=True，之后异步语义标题不再覆盖。"""
        title = body.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="标题不能为空")
        if not await container().conversation_store.rename_session(session_id, title):
            raise HTTPException(status_code=404, detail=f"会话不存在：{session_id}")
        session = await container().conversation_store.find_session(session_id) or {}
        return SessionSummaryOut(
            id=session_id,
            title=title,
            created_at=session.get("created_at", ""),
            last_active_at=session.get("last_active_at", ""),
        )

    @api.delete("/commerce/sessions/{session_id}")
    async def delete_session(session_id: str) -> dict:
        """软删：写 deleted_at，messages/events 仍保留（badcase 数据底座）。"""
        c = container()
        for generation in await c.generation_store.list_active_for_session(session_id):
            await c.generation_store.request_cancel(generation.generation_id)
            task = state.get("generation_tasks", {}).get(generation.generation_id)
            if task is not None:
                task.cancel()
        if not await c.conversation_store.soft_delete_session(session_id):
            raise HTTPException(status_code=404, detail=f"会话不存在：{session_id}")
        return {"session_id": session_id, "deleted": True}

    return api


async def _queue_priority(c: Container, session_id: str) -> int:
    """按对话轮数定队列优先级（0 = 正常，1 = 大请求）。

    长会话上下文大、单次耗时长，分到低优先流，避免堵住新会话。
    轮数计数存 Redis（计数不原子，但优先级本身是启发式，差一两次无影响）；
    Redis 不可用或开关关闭时一律返回 0，退化为单队列。
    """
    if not c.settings.queue_priority_enabled or not c.cache.enabled:
        return 0
    key = f"globex:turns:{session_id}"
    try:
        current = int(await c.cache.get_raw(key) or 0) + 1
        await c.cache.set_json(key, current, _TURN_COUNTER_TTL_SECONDS)
    except Exception:  # noqa: BLE001 —— 计数失败不能影响入队
        return 0
    return 1 if current >= c.settings.queue_large_request_turns else 0


async def _enqueue(c: Container, intent: SubmitIntentInput, generation_id: str = "") -> str:
    """入队并做幂等保护。

    队列是 at-least-once，且买家/前端可能重复提交。用「会话 + 问句」指纹做幂等键，
    命中说明短时间内已提交过同样内容，直接复用原 task_id，不再入队一次。
    这一步对写操作（下单）尤其关键：重复消费等于重复下单。
    """
    fingerprint_source = generation_id or f"{intent.shopping_session_id}\n{intent.raw_query}"
    fingerprint = hashlib.sha256(fingerprint_source.encode()).hexdigest()[:32]
    idem_key = f"idem:{fingerprint}"
    task_id = generation_id or f"task-{uuid.uuid4().hex[:12]}"

    acquired = await c.cache.set_if_absent(idem_key, task_id, _IDEMPOTENCY_TTL_SECONDS)
    if not acquired:
        previous = await c.cache.get_raw(idem_key)
        if previous:
            logger.info("幂等命中，复用已有任务：%s", previous)
            return previous

    await c.task_queue.enqueue(  # type: ignore[union-attr]
        IntentTask(
            task_id=task_id,
            shopping_session_id=intent.shopping_session_id,
            buyer_id=intent.buyer_id,
            locale=intent.locale,
            currency=intent.currency,
            raw_query=intent.raw_query,
            generation_id=generation_id,
            priority=await _queue_priority(c, intent.shopping_session_id),
        ),
    )
    await c.task_queue.set_status(TaskStatus(task_id=task_id, state="queued"))  # type: ignore[union-attr]
    c.bus.publish(intent.shopping_session_id, "task.queued", {"task_id": task_id})
    return task_id


async def _await_result(c: Container, task_id: str, session_id: str) -> str:
    """等 worker 跑完。

    优先等 final.result 事件（实时）；同时定期查任务状态兜底——
    worker 崩溃或任务进死信时事件永远不会来，只靠等事件会把请求挂死。
    """
    queue = c.bus.subscribe(session_id)
    deadline = time.monotonic() + c.settings.queue_wait_seconds
    try:
        while time.monotonic() < deadline:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                status = await c.task_queue.get_status(task_id)  # type: ignore[union-attr]
                if status is not None and status.state == "done":
                    return status.final_text
                if status is not None and status.state == "failed":
                    return f"[error] {status.error}"
                continue
            if event.type == "final.result":
                return str(event.payload.get("text", ""))
        return "[error] 处理超时，请稍后重试或改用异步接口查询任务状态"
    finally:
        c.bus.unsubscribe(session_id, queue)


# ===== SSE 流式端点（F2）=====
# 后台任务的强引用集合：防止协程返回后任务被 GC 回收
_STREAM_TASKS: set[asyncio.Task] = set()


def _track_stream_task(task: asyncio.Task) -> None:
    _STREAM_TASKS.add(task)
    task.add_done_callback(_STREAM_TASKS.discard)


async def _stream_events(
    c: Container,
    session_id: str,
    queue: asyncio.Queue,
    timeout: float,
) -> AsyncGenerator[str, None]:
    """订阅总线并逐事件产出 SSE 帧，直到 final.result / error / 超时。

    跨进程事件：worker 产生的事件经 backplane forwarder deliver_local 到本进程总线，
    与 WS 订阅同机制，这里订阅同一队列即可收到。
    """
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                # 注释行是 SSE 心跳，防止中间代理静默断开；前端解析器会跳过 ": " 行
                yield ": keepalive\n\n"
                continue
            payload = json.dumps(event.payload, ensure_ascii=False)
            yield f"event: {event.type}\ndata: {payload}\n\n"
            if event.type in ("final.result", "error"):
                return
        yield 'event: error\ndata: {"error":"处理超时，请稍后重试"}\n\n'
    finally:
        c.bus.unsubscribe(session_id, queue)


def build_container_origins() -> list[str]:
    """CORS 需要在 app 构造期就确定，此处单独读一次配置。"""
    from app.infrastructure.settings import load_settings

    return load_settings().cors_origins


app = build_app()


if __name__ == "__main__":
    import uvicorn

    from app.infrastructure.settings import load_settings

    uvicorn.run(app, host="0.0.0.0", port=load_settings().port)
