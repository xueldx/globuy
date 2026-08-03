# -*- coding: utf-8 -*-
"""新增用户与可撤销登录 Session。"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "1003_add_auth_sessions"
down_revision = "1002_add_generation_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = set(inspect(op.get_bind()).get_table_names())
    if "auth_users" not in existing:
        op.create_table(
            "auth_users",
            sa.Column("user_id", sa.String(64), primary_key=True),
            sa.Column("email", sa.String(254), nullable=False),
            sa.Column("display_name", sa.String(40), nullable=False),
            sa.Column("password_hash", sa.String(255), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("email", name="uq_auth_user_email"),
        )
        op.create_index("ix_auth_user_email", "auth_users", ["email"])
    if "auth_sessions" not in existing:
        op.create_table(
            "auth_sessions",
            sa.Column("session_id", sa.String(64), primary_key=True),
            sa.Column("user_id", sa.String(64), sa.ForeignKey("auth_users.user_id"), nullable=False),
            sa.Column("token_hash", sa.String(64), nullable=False),
            sa.Column("csrf_token_hash", sa.String(64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("token_hash", name="uq_auth_session_token_hash"),
        )
        op.create_index("ix_auth_session_user", "auth_sessions", ["user_id"])
        op.create_index("ix_auth_session_token", "auth_sessions", ["token_hash"])
        op.create_index("ix_auth_session_expires", "auth_sessions", ["expires_at"])


def downgrade() -> None:
    existing = set(inspect(op.get_bind()).get_table_names())
    if "auth_sessions" in existing:
        op.drop_table("auth_sessions")
    if "auth_users" in existing:
        op.drop_table("auth_users")
