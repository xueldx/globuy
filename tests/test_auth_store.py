"""SQL 与 JSON 认证 Store 的共同语义。"""
from __future__ import annotations

import pytest

from app.application.auth.service import AuthError, AuthService
from app.infrastructure.persistence.json_auth_store import JsonAuthStore
from app.infrastructure.persistence.sql.auth_store import SqlAuthStore
from app.infrastructure.persistence.sql.repositories import bootstrap_schema, create_engine


@pytest.mark.parametrize("kind", ["json", "sql"])
async def test_auth_store_session_round_trip_and_revoke(tmp_path, kind):
    engine = None
    if kind == "json":
        store = JsonAuthStore(tmp_path)
    else:
        engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'auth.db'}")
        await bootstrap_schema(engine)
        store = SqlAuthStore(engine)

    service = AuthService(store, session_ttl_seconds=60)
    issued = await service.register("User@Example.com", "用户", "password-123")

    context = await service.resolve(issued.token)
    assert context.user.user_id == issued.user.user_id
    assert context.user.email == "user@example.com"
    assert service.verify_csrf(context, issued.csrf_token, issued.csrf_token)
    assert not service.verify_csrf(context, "forged", "forged")

    await service.logout(issued.token)
    with pytest.raises(AuthError):
        await service.resolve(issued.token)

    if engine is not None:
        await engine.dispose()


async def test_json_store_fails_closed_when_auth_file_is_corrupt(tmp_path):
    (tmp_path / "auth.json").write_text("{broken", encoding="utf-8")
    service = AuthService(JsonAuthStore(tmp_path))

    with pytest.raises(RuntimeError, match="无法读取认证数据"):
        await service.register("user@example.com", "用户", "password-123")
