"""
Database Session
================

PostgreSQL database connection for Scout.

Two engines, both cached on first use:

- ``get_sql_engine()`` — scoped to the ``scout`` schema. Writes to ``public``
  or ``ai`` (agno sdk schema) are rejected at the SQLAlchemy layer by
  the ``_guard_non_scout_writes`` hook. This is belt-and-suspenders on top
  of ``search_path=scout,public``: a confused write against ``public.foo``
  raises a loud error instead of silently landing somewhere unexpected.

- ``get_readonly_engine()`` — transactions are set read-only at the PostgreSQL
  level via ``default_transaction_read_only=on``. INSERT / UPDATE / DELETE /
  CREATE / ALTER / DROP are rejected by the database itself; cannot be
  bypassed by prompt tricks.
"""

import re
from functools import lru_cache

from agno.db.postgres import PostgresDb
from agno.knowledge import Knowledge
from agno.knowledge.embedder.openai import OpenAIEmbedder
from agno.vectordb.pgvector import PgVector, SearchType
from sqlalchemy import Engine, create_engine, event, text

from db.url import db_url

DB_ID = "scout-db"

# PostgreSQL schema for user data tables (scout_contacts, scout_notes, etc.).
# Agno sdk tables (sessions, knowledge vectors) live in the default "ai"
# schema; we never write there from agent code.
SCOUT_SCHEMA = "scout"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def get_sql_engine() -> Engine:
    """SQLAlchemy engine scoped to the ``scout`` schema (cached).

    Bootstraps the schema on first call, then returns an engine with
    ``search_path=scout,public`` and a write-guard hook that blocks writes
    against ``public`` or ``ai``.
    """
    bootstrap = create_engine(db_url)
    with bootstrap.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCOUT_SCHEMA}"))
    bootstrap.dispose()
    engine = create_engine(
        db_url,
        connect_args={"options": f"-c search_path={SCOUT_SCHEMA},public"},
        pool_size=10,
        max_overflow=20,
    )
    event.listen(engine, "before_cursor_execute", _guard_non_scout_writes)
    return engine


@lru_cache(maxsize=1)
def get_readonly_engine() -> Engine:
    """SQLAlchemy engine with read-only transactions (cached).

    Uses PostgreSQL's ``default_transaction_read_only`` so any INSERT,
    UPDATE, DELETE, CREATE, DROP, or ALTER is rejected at the database level.
    Hand this to read-only agents (Scout's CRM read sub-agent) so their
    SQLTools cannot mutate state regardless of how they're prompted.

    Also sets ``search_path=scout,public`` so unqualified references like
    ``SELECT * FROM scout_notes`` resolve — matching the scout engine's
    behaviour. Without this, the read sub-agent's SQL would fail on anything
    but ``scout.scout_notes``.
    """
    return create_engine(
        db_url,
        connect_args={
            "options": f"-c default_transaction_read_only=on -c search_path={SCOUT_SCHEMA},public",
        },
        pool_size=10,
        max_overflow=20,
    )


def get_postgres_db(contents_table: str | None = None) -> PostgresDb:
    """Create a PostgresDb instance.

    Args:
        contents_table: Optional table name for storing knowledge contents.

    Returns:
        Configured PostgresDb instance.
    """
    if contents_table is not None:
        return PostgresDb(id=DB_ID, db_url=db_url, knowledge_table=contents_table)
    return PostgresDb(id=DB_ID, db_url=db_url)


def create_knowledge(name: str, table_name: str) -> Knowledge:
    """Create a Knowledge instance with PgVector hybrid search.

    Args:
        name: Display name for the knowledge base.
        table_name: PostgreSQL table name for vector storage.

    Returns:
        Configured Knowledge instance.
    """
    return Knowledge(
        name=name,
        vector_db=PgVector(
            db_url=db_url,
            table_name=table_name,
            search_type=SearchType.hybrid,
            embedder=OpenAIEmbedder(id="text-embedding-3-small"),
        ),
        contents_db=get_postgres_db(contents_table=f"{table_name}_contents"),
    )


# ---------------------------------------------------------------------------
# Write guard for the scout engine
# ---------------------------------------------------------------------------
# Catches explicit writes to public.* / ai.* (the shapes agents actually
# produce). Reads are allowed — the CRM write sub-agent introspects the
# information_schema before DDL. Not comprehensive: misses CREATE SCHEMA,
# COPY … FROM, GRANT/REVOKE, DO blocks, function side-effects. DB-level
# grants + search_path are the primary defense.


_NON_SCOUT_WRITE_RE = re.compile(
    r"""(?ix)
    # DDL targeting public/ai schema
    (?:create|alter|drop)\s+
    (?:or\s+replace\s+)?
    (?:(?:temp|temporary|unlogged|materialized)\s+)?
    (?:table|view|index|sequence|function|procedure|trigger|type)\s+
    (?:if\s+(?:not\s+)?exists\s+)?
    "?(?:public|ai)"?\s*\.
    |
    # DML targeting public/ai schema
    insert\s+into\s+"?(?:public|ai)"?\s*\.
    |
    update\s+"?(?:public|ai)"?\s*\.
    |
    delete\s+from\s+"?(?:public|ai)"?\s*\.
    |
    truncate\s+(?:table\s+)?"?(?:public|ai)"?\s*\.
    """,
)


def _guard_non_scout_writes(conn, cursor, statement, parameters, context, executemany) -> None:
    """Reject DDL/DML targeting non-scout schemas on the Scout engine."""
    if _NON_SCOUT_WRITE_RE.search(statement):
        raise RuntimeError(
            "Cannot write to public or ai schema from the Scout engine. "
            "All CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, and TRUNCATE "
            "operations must target the scout schema."
        )
