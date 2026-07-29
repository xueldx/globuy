# -*- coding: utf-8 -*-
"""F3 baseline：把"引入 Alembic 之前"的表结构一次性落地。

背景：本仓此前只有 `bootstrap_schema()` 的 `create_all` 幂等建表，没有迁移历史。
所以 baseline 不是从某次 autogenerate 抓出来的快照，而是一个 bootstrap revision：
upgrade 时让 ORM metadata 按当前模型幂等建表（create_all 自带 checkfirst，
已存在的表直接跳过）。

由此带来的规则（写进实现文档）：
    - 老库（无 alembic_version、表已存在）跑 upgrade 时 baseline 是 no-op，
      真正生效的是后续增量 revision；
    - 全新库跑 upgrade 时 baseline 建出全部表（含此后加的列），
      后续增量靠"列存在性守卫"幂等跳过——所以**今后每个加列迁移都必须带守卫**，
      不允许裸 `op.add_column`。
"""
from __future__ import annotations

from alembic import op

from app.infrastructure.persistence.sql.tables import Base

revision = "1000_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    # 退到 baseline = 一张表都不留。显式命令才触发；误操作可再 upgrade 重建。
    Base.metadata.drop_all(bind=op.get_bind())
