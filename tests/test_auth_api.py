"""登录 Session、Cookie 与 CSRF 的 API 回归。"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.application.auth.service import AuthService
from app.infrastructure.eventbus import TradeEventBus
from app.infrastructure.persistence.json_auth_store import JsonAuthStore
from app.presentation import server


class _AuthContainer:
    def __init__(self, data_dir: Path) -> None:
        self.bus = TradeEventBus()
        self.auth_service = AuthService(JsonAuthStore(data_dir))
        self.backplane = None
        self.cache = SimpleNamespace(enabled=False)
        self.settings = SimpleNamespace(
            auth_session_ttl_seconds=604800,
            auth_cookie_secure=False,
        )

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None


def _app(tmp_path: Path, monkeypatch):
    container = _AuthContainer(tmp_path)

    async def fake_build_container() -> _AuthContainer:
        return container

    monkeypatch.setattr(server, "build_container", fake_build_container)
    return server.build_app()


def _register(client: TestClient, email: str = "learner@example.com"):
    return client.post("/auth/register", json={
        "email": email,
        "display_name": "前端学习者",
        "password": "correct-horse",
    })


def _csrf(client: TestClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("globuy_csrf") or ""}


def test_register_restore_logout_and_secret_storage(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        registered = _register(client, " Learner@Example.com ")
        assert registered.status_code == 201
        assert registered.json()["email"] == "learner@example.com"
        session_token = client.cookies.get("globuy_session")
        csrf_token = client.cookies.get("globuy_csrf")
        assert session_token and csrf_token
        set_cookie = ",".join(registered.headers.get_list("set-cookie")).lower()
        assert "globuy_session=" in set_cookie
        assert "httponly" in set_cookie
        assert "samesite=lax" in set_cookie

        me = client.get("/auth/me")
        assert me.status_code == 200
        assert me.json()["display_name"] == "前端学习者"
        assert me.headers["cache-control"] == "no-store"

        assert client.post("/auth/logout").status_code == 403
        assert client.post("/auth/logout", headers={"X-CSRF-Token": "forged"}).status_code == 403
        assert client.post("/auth/logout", headers=_csrf(client)).status_code == 204
        assert client.get("/auth/me").status_code == 401

    stored = (tmp_path / "auth.json").read_text(encoding="utf-8")
    assert "correct-horse" not in stored
    assert session_token not in stored
    assert csrf_token not in stored
    payload = json.loads(stored)
    assert payload["users"][0]["password_hash"].startswith("$argon2")
    assert payload["sessions"][0]["revoked_at"]


def test_duplicate_login_failure_and_rate_limit(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        assert _register(client).status_code == 201
        assert _register(client).status_code == 409
        client.cookies.clear()

        missing = client.post("/auth/login", json={
            "email": "missing@example.com", "password": "wrong-password",
        })
        wrong = client.post("/auth/login", json={
            "email": "learner@example.com", "password": "wrong-password",
        })
        assert missing.status_code == wrong.status_code == 401
        assert missing.json() == wrong.json() == {"detail": "邮箱或密码错误"}

        success = client.post("/auth/login", json={
            "email": "LEARNER@example.com", "password": "correct-horse",
        })
        assert success.status_code == 200

        client.cookies.clear()
        statuses = [
            client.post("/auth/login", json={
                "email": "limited@example.com", "password": "wrong-password",
            }).status_code
            for _ in range(6)
        ]
        assert statuses == [401, 401, 401, 401, 401, 429]


def test_login_falls_back_to_local_limit_when_redis_is_down(tmp_path, monkeypatch):
    class BrokenRedis:
        async def incr(self, _key: str) -> int:
            raise ConnectionError("redis unavailable")

        async def delete(self, _key: str) -> None:
            raise ConnectionError("redis unavailable")

    container = _AuthContainer(tmp_path)
    container.cache = SimpleNamespace(enabled=True, client=BrokenRedis())

    async def fake_build_container() -> _AuthContainer:
        return container

    monkeypatch.setattr(server, "build_container", fake_build_container)
    app = server.build_app()

    with TestClient(app) as client:
        assert _register(client).status_code == 201
        client.cookies.clear()
        response = client.post("/auth/login", json={
            "email": "learner@example.com",
            "password": "correct-horse",
        })
        assert response.status_code == 200
