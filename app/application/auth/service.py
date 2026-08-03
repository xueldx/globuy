# -*- coding: utf-8 -*-
"""注册、登录、Session 恢复与 CSRF 校验。"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pwdlib import PasswordHash

from app.domain.auth.ports.auth_store import AuthSession, AuthStore, AuthUser

_EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_PASSWORD_HASH = PasswordHash.recommended()
_DUMMY_HASH = _PASSWORD_HASH.hash("globuy-dummy-password")


class AuthError(Exception):
    """认证输入或凭证错误，不携带敏感内部信息。"""


class EmailAlreadyExists(AuthError):
    pass


@dataclass(frozen=True)
class IssuedSession:
    user: AuthUser
    token: str
    csrf_token: str


@dataclass(frozen=True)
class AuthContext:
    user: AuthUser
    session: AuthSession


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if len(normalized) > 254 or not _EMAIL_PATTERN.fullmatch(normalized):
        raise AuthError("邮箱格式不正确")
    return normalized


class AuthService:
    def __init__(self, store: AuthStore, session_ttl_seconds: int = 604800) -> None:
        self._store = store
        self._session_ttl_seconds = session_ttl_seconds

    async def register(self, email: str, display_name: str, password: str) -> IssuedSession:
        normalized = normalize_email(email)
        name = display_name.strip()
        if not name or len(name) > 40:
            raise AuthError("显示名称长度应为 1 到 40 个字符")
        self._validate_password(password)
        now = datetime.now(timezone.utc).isoformat()
        user = AuthUser(
            user_id=f"buyer-{uuid.uuid4().hex}",
            email=normalized,
            display_name=name,
            password_hash=_PASSWORD_HASH.hash(password),
            status="active",
            created_at=now,
        )
        if not await self._store.create_user(user):
            raise EmailAlreadyExists("该邮箱已经注册")
        return await self._issue_session(user)

    async def login(self, email: str, password: str) -> IssuedSession:
        try:
            normalized = normalize_email(email)
        except AuthError:
            normalized = email.strip().lower()
        user = await self._store.get_user_by_email(normalized)
        password_hash = user.password_hash if user is not None else _DUMMY_HASH
        try:
            valid = _PASSWORD_HASH.verify(password, password_hash)
        except Exception:  # 损坏的哈希按登录失败处理，不能把内部错误暴露给调用方
            valid = False
        if user is None or not valid or user.status != "active":
            raise AuthError("邮箱或密码错误")
        return await self._issue_session(user)

    async def resolve(self, token: str) -> AuthContext:
        if not token:
            raise AuthError("未登录")
        session = await self._store.get_session_by_token_hash(hash_token(token))
        if session is None or session.revoked_at:
            raise AuthError("登录已失效")
        try:
            expires_at = datetime.fromisoformat(session.expires_at)
        except ValueError as err:
            raise AuthError("登录已失效") from err
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= datetime.now(timezone.utc):
            await self._store.revoke_session(session.token_hash, datetime.now(timezone.utc).isoformat())
            raise AuthError("登录已过期")
        user = await self._store.get_user(session.user_id)
        if user is None or user.status != "active":
            raise AuthError("登录已失效")
        return AuthContext(user=user, session=session)

    async def logout(self, token: str) -> None:
        if token:
            await self._store.revoke_session(hash_token(token), datetime.now(timezone.utc).isoformat())

    def verify_csrf(self, context: AuthContext, header_token: str, cookie_token: str) -> bool:
        if not header_token or not cookie_token:
            return False
        if not hmac.compare_digest(header_token, cookie_token):
            return False
        return hmac.compare_digest(hash_token(header_token), context.session.csrf_token_hash)

    async def _issue_session(self, user: AuthUser) -> IssuedSession:
        now = datetime.now(timezone.utc)
        token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        session = AuthSession(
            session_id=f"auth-{uuid.uuid4().hex}",
            user_id=user.user_id,
            token_hash=hash_token(token),
            csrf_token_hash=hash_token(csrf_token),
            expires_at=(now + timedelta(seconds=self._session_ttl_seconds)).isoformat(),
            created_at=now.isoformat(),
        )
        await self._store.create_session(session)
        return IssuedSession(user=user, token=token, csrf_token=csrf_token)

    @staticmethod
    def _validate_password(password: str) -> None:
        if len(password) < 8 or len(password) > 128:
            raise AuthError("密码长度应为 8 到 128 个字符")
