# -*- coding: utf-8 -*-
"""启动路径的 Alembic 迁移入口。

app/composition.py 的 startup 里调 `await upgrade_head()`，把建表职责从
`create_all` 交还给迁移框架。CLI 用法不变：`uv run alembic upgrade head`。

Alembic 走同步引擎，这里包一层 asyncio.to_thread，避免在事件循环里同步建库。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from alembic import command
from alembic.config import Config

# migrate.py 位于 app/infrastructure/persistence/sql/ → 上溯 4 层到项目根
_PROJECT_ROOT = Path(__file__).resolve().parents[4]
_ALEMBIC_INI = _PROJECT_ROOT / "alembic.ini"


def _config() -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    # Config 默认按 ini 所在目录解析相对 script_location；显式换成绝对路径，
    # 保证进程 cwd 与 ini 位置不一致（如从别处起服务）也能找到迁移脚本。
    cfg.set_main_option("script_location", str(_PROJECT_ROOT / "alembic"))
    return cfg


def upgrade_head_sync() -> None:
    command.upgrade(_config(), "head")


async def upgrade_head() -> None:
    """在 API 进程内执行迁移到 head。"""
    await asyncio.to_thread(upgrade_head_sync)
