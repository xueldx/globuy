# -*- coding: utf-8 -*-
"""DATABASE_URL=file 模式下的认证 JSON Store。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Optional

from app.domain.auth.ports.auth_store import AuthSession, AuthStore, AuthUser


class JsonAuthStore(AuthStore):
    def __init__(self, data_dir: Path) -> None:
        self._path = data_dir / "auth.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()

    def _read(self) -> dict:
        if not self._path.exists():
            return {"users": [], "sessions": []}
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            # 认证文件损坏时必须“失败关闭”。如果假装它是空文件，下一次注册会把
            # 原有账号和会话覆盖掉，既丢数据，也可能造成身份状态混乱。
            raise RuntimeError(f"无法读取认证数据：{self._path}") from err
        if not isinstance(value, dict):
            raise RuntimeError(f"认证数据格式不正确：{self._path}")
        return {
            "users": value.get("users", []),
            "sessions": value.get("sessions", []),
        }

    def _write(self, data: dict) -> None:
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._path)

    async def create_user(self, user: AuthUser) -> bool:
        async with self._lock:
            data = self._read()
            if any(item["email"] == user.email for item in data["users"]):
                return False
            data["users"].append(user.__dict__)
            self._write(data)
            return True

    async def get_user(self, user_id: str) -> Optional[AuthUser]:
        for item in self._read()["users"]:
            if item["user_id"] == user_id:
                return AuthUser(**item)
        return None

    async def get_user_by_email(self, email: str) -> Optional[AuthUser]:
        for item in self._read()["users"]:
            if item["email"] == email:
                return AuthUser(**item)
        return None

    async def create_session(self, session: AuthSession) -> None:
        async with self._lock:
            data = self._read()
            data["sessions"].append(session.__dict__)
            self._write(data)

    async def get_session_by_token_hash(self, token_hash: str) -> Optional[AuthSession]:
        for item in self._read()["sessions"]:
            if item["token_hash"] == token_hash:
                return AuthSession(**item)
        return None

    async def revoke_session(self, token_hash: str, revoked_at: str) -> bool:
        async with self._lock:
            data = self._read()
            for item in data["sessions"]:
                if item["token_hash"] == token_hash and not item.get("revoked_at"):
                    item["revoked_at"] = revoked_at
                    self._write(data)
                    return True
            return False
