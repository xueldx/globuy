# -*- coding: utf-8 -*-
"""Alembic 迁移运行环境。

URL 处理：app 用的是 aiosqlite 异步驱动（`sqlite+aiosqlite:///...`），Alembic
跑同步迁移、不认识这个前缀，这里剥成同步 `sqlite:///...`。

DATABASE_URL 解析与 app/infrastructure/settings.py 保持一致，但**容忍未配
LLM_API_KEY**：迁移只关心连哪张库，不应被模型密钥卡住（例如 CI 里只跑迁移）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from alembic import context

# 保证 `app.*` 可导入：无论从项目根目录起 CLI 还是在 API 进程内程序化调用，
# 都能以本文件所在目录推导出项目根
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.infrastructure.persistence.sql.tables import Base  # noqa: E402

config = context.config

# alembic.ini 不含 logging 配置段，跳过 fileConfig 以免对不存在段落报错

# ---- 解析同步 URL（与 settings.load_settings 的默认规则一致，但零密钥依赖）----
_data_dir = Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data")))
_database_url = (
    os.getenv("DATABASE_URL")
    or os.getenv("MYSQL_URL")
    or f"sqlite+aiosqlite:///{_data_dir / 'globex.db'}"
)
if _database_url.startswith("sqlite+aiosqlite:"):
    # sqlite+aiosqlite:///<path> → sqlite:///<path>
    _database_url = "sqlite:///" + _database_url[len("sqlite+aiosqlite:///") :]
if _database_url.startswith("sqlite:///"):
    # 与 settings.load_settings 同步：SQLite 建库前目录必须存在。
    # 程序化路径里 settings 已 mkdir 过；这里覆盖独立 CLI 起迁移的场景。
    from sqlalchemy.engine import make_url

    database_path = make_url(_database_url).database
    if database_path and database_path != ":memory:":
        Path(database_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
config.set_main_option("sqlalchemy.url", _database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：只生成 SQL 不连库（--sql）。"""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连库逐 revision 执行。用 NullPool，跑完即断、不占连接。"""
    from sqlalchemy import engine_from_config, pool

    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
