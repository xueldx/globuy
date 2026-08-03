# -*- coding: utf-8 -*-
"""用户与登录 Session 的 SQLAlchemy Store。"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.domain.auth.ports.auth_store import AuthSession, AuthStore, AuthUser
from app.infrastructure.persistence.sql.tables import AuthSessionRow, AuthUserRow


def _user(row: AuthUserRow) -> AuthUser:
    return AuthUser(
        user_id=row.user_id,
        email=row.email,
        display_name=row.display_name,
        password_hash=row.password_hash,
        status=row.status,
        created_at=row.created_at.isoformat(),
    )


def _session(row: AuthSessionRow) -> AuthSession:
    return AuthSession(
        session_id=row.session_id,
        user_id=row.user_id,
        token_hash=row.token_hash,
        csrf_token_hash=row.csrf_token_hash,
        expires_at=row.expires_at.isoformat(),
        revoked_at=row.revoked_at.isoformat() if row.revoked_at else "",
        created_at=row.created_at.isoformat(),
    )


class SqlAuthStore(AuthStore):
    def __init__(self, engine: AsyncEngine) -> None:
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def create_user(self, user: AuthUser) -> bool:
        async with self._sessions() as db:
            db.add(AuthUserRow(
                user_id=user.user_id,
                email=user.email,
                display_name=user.display_name,
                password_hash=user.password_hash,
                status=user.status,
            ))
            try:
                await db.commit()
                return True
            except IntegrityError:
                await db.rollback()
                return False

    async def get_user(self, user_id: str) -> Optional[AuthUser]:
        async with self._sessions() as db:
            row = await db.get(AuthUserRow, user_id)
            return _user(row) if row else None

    async def get_user_by_email(self, email: str) -> Optional[AuthUser]:
        async with self._sessions() as db:
            row = await db.scalar(select(AuthUserRow).where(AuthUserRow.email == email))
            return _user(row) if row else None

    async def create_session(self, session: AuthSession) -> None:
        from datetime import datetime

        async with self._sessions() as db:
            db.add(AuthSessionRow(
                session_id=session.session_id,
                user_id=session.user_id,
                token_hash=session.token_hash,
                csrf_token_hash=session.csrf_token_hash,
                expires_at=datetime.fromisoformat(session.expires_at),
            ))
            await db.commit()

    async def get_session_by_token_hash(self, token_hash: str) -> Optional[AuthSession]:
        async with self._sessions() as db:
            row = await db.scalar(select(AuthSessionRow).where(AuthSessionRow.token_hash == token_hash))
            return _session(row) if row else None

    async def revoke_session(self, token_hash: str, revoked_at: str) -> bool:
        from datetime import datetime

        async with self._sessions() as db:
            result = await db.execute(
                update(AuthSessionRow)
                .where(AuthSessionRow.token_hash == token_hash, AuthSessionRow.revoked_at.is_(None))
                .values(revoked_at=datetime.fromisoformat(revoked_at)),
            )
            await db.commit()
            return bool(result.rowcount)
