# -*- coding: utf-8 -*-
"""F3 增量：conversation_sessions 增加 title / title_custom / deleted_at 三列。

    - title       String(200) NULL       兜底标题 / 语义标题 / 用户改名都写这里
    - title_custom Boolean NOT NULL 默认0 用户手动改过名即置 True；语义标题回写
                                        只命中 title_custom=False 的行（防覆盖）
    - deleted_at  DateTime  NULL         软删时间戳；非空即视为已删除

为什么逐列加存在性守卫：baseline 在全新库上用"当前 ORM metadata"建表，而该
metadata 已含这三列 → 全新库跑这条增量前列已存在；老库（create_all 时代）则缺列。
守卫让同一条增量在两种库上都幂等可用。**后续加列迁移沿用同一模式。**

三列全是新增列，SQLite 原生 ADD COLUMN 支持，无需 batch_alter_table 重建表。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, String
from sqlalchemy import inspect

from alembic import op

revision = "1001_add_session_title_columns"
down_revision = "1000_baseline"
branch_labels = None
depends_on = None


def _existing_columns(table: str) -> set[str]:
    return {col["name"] for col in inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    table = "conversation_sessions"
    existing = _existing_columns(table)
    if "title" not in existing:
        op.add_column(table, Column("title", String(200), nullable=True))
    if "title_custom" not in existing:
        op.add_column(
            table,
            # NOT NULL 必须带 server_default，否则老库存量行补不出默认值
            Column("title_custom", Boolean, nullable=False, server_default="0"),
        )
    if "deleted_at" not in existing:
        op.add_column(table, Column("deleted_at", DateTime, nullable=True))


def downgrade() -> None:
    table = "conversation_sessions"
    existing = _existing_columns(table)
    for name in ("title", "title_custom", "deleted_at"):
        if name in existing:
            op.drop_column(table, name)
