"""F3.1 generation lifecycle and replay log."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "1002_add_generation_lifecycle"
down_revision = "1001_add_session_title_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = set(inspect(op.get_bind()).get_table_names())
    if "conversation_generations" not in existing:
        op.create_table(
            "conversation_generations",
            sa.Column("generation_id", sa.String(64), primary_key=True),
            sa.Column("session_id", sa.String(64), nullable=False),
            sa.Column("buyer_id", sa.String(64), nullable=False),
            sa.Column("request_id", sa.String(64), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("cancel_requested_at", sa.DateTime(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("final_text", sa.Text(), nullable=True),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("last_event_seq", sa.Integer(), nullable=False, server_default="0"),
            sa.UniqueConstraint("session_id", "request_id", name="uq_generation_session_request"),
        )
        op.create_index("ix_generation_session", "conversation_generations", ["session_id"])
        op.create_index("ix_generation_buyer", "conversation_generations", ["buyer_id"])
        op.create_index("ix_generation_status", "conversation_generations", ["status"])
    if "conversation_generation_events" not in existing:
        op.create_table(
            "conversation_generation_events",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("generation_id", sa.String(64), nullable=False),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(32), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("occurred_at", sa.String(40), nullable=False),
            sa.UniqueConstraint("generation_id", "seq", name="uq_generation_event_seq"),
        )
        op.create_index("ix_generation_event_generation", "conversation_generation_events", ["generation_id"])


def downgrade() -> None:
    existing = set(inspect(op.get_bind()).get_table_names())
    if "conversation_generation_events" in existing:
        op.drop_table("conversation_generation_events")
    if "conversation_generations" in existing:
        op.drop_table("conversation_generations")
