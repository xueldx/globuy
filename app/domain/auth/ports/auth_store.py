# -*- coding: utf-8 -*-
"""用户与登录 Session 的持久化端口。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    email: str
    display_name: str
    password_hash: str
    status: str
    created_at: str


@dataclass(frozen=True)
class AuthSession:
    session_id: str
    user_id: str
    token_hash: str
    csrf_token_hash: str
    expires_at: str
    revoked_at: str = ""
    created_at: str = ""


class AuthStore(ABC):
    @abstractmethod
    async def create_user(self, user: AuthUser) -> bool:
        """创建用户。邮箱已存在时返回 False。"""

    @abstractmethod
    async def get_user(self, user_id: str) -> Optional[AuthUser]:
        ...

    @abstractmethod
    async def get_user_by_email(self, email: str) -> Optional[AuthUser]:
        ...

    @abstractmethod
    async def create_session(self, session: AuthSession) -> None:
        ...

    @abstractmethod
    async def get_session_by_token_hash(self, token_hash: str) -> Optional[AuthSession]:
        ...

    @abstractmethod
    async def revoke_session(self, token_hash: str, revoked_at: str) -> bool:
        ...
