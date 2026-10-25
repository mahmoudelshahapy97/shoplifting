"""The versioned migration runner (app/core/migrations.py).

File discovery runs without a database. The apply tests need a live Postgres
(the same DB_* variables as test_integration.py) and run inside a throwaway
schema, so the real ``schema_migration`` table is never touched.
"""

import logging
import uuid
from pathlib import Path

import asyncpg
import pytest

from app.core.config import config
from app.core.migrations import apply_pending, discover, migrations_dir


def _write(directory: Path, name: str, sql: str) -> None:
    (directory / name).write_text(sql, encoding="utf-8")


def test_discover_orders_by_name_and_ignores_other_files(tmp_path):
    _write(tmp_path, "010_later.sql", "SELECT 1;")
    _write(tmp_path, "002_first.sql", "SELECT 1;")
    _write(tmp_path, "README.md", "not a migration")
    _write(tmp_path, "draft.sql", "no number")
    assert [m.version for m in discover(tmp_path)] == ["002_first.sql", "010_later.sql"]


def test_repo_migrations_are_numbered_uniquely():
    # Empty while schema.sql is still the first release; never two of a number.
    assert migrations_dir().is_dir(), "database/migrations is missing"
    versions = [m.version.split("_", 1)[0] for m in discover(migrations_dir())]
    assert len(versions) == len(set(versions))


@pytest.fixture
async def scratch_conn():
    try:
        conn = await asyncpg.connect(dsn=config.database_dsn, timeout=5)
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")
    schema = f"mig_test_{uuid.uuid4().hex[:8]}"
    await conn.execute(f"CREATE SCHEMA {schema}")
    await conn.execute(f"SET search_path TO {schema}")
    try:
        yield conn
    finally:
        await conn.execute(f"DROP SCHEMA {schema} CASCADE")
        await conn.close()


async def test_applies_pending_once_in_order(scratch_conn, tmp_path):
    _write(tmp_path, "001_table.sql", "CREATE TABLE IF NOT EXISTS t (id INT);")
    _write(tmp_path, "002_row.sql", "INSERT INTO t VALUES (1);")

    assert await apply_pending(scratch_conn, tmp_path) == ["001_table.sql", "002_row.sql"]
    # A second start applies nothing, so the INSERT does not run twice.
    assert await apply_pending(scratch_conn, tmp_path) == []
    assert await scratch_conn.fetchval("SELECT COUNT(*) FROM t") == 1

    _write(tmp_path, "003_more.sql", "INSERT INTO t VALUES (2);")
    assert await apply_pending(scratch_conn, tmp_path) == ["003_more.sql"]
    assert await scratch_conn.fetchval("SELECT COUNT(*) FROM t") == 2


async def test_failed_migration_rolls_back_and_is_not_recorded(scratch_conn, tmp_path):
    _write(tmp_path, "001_ok.sql", "CREATE TABLE t (id INT);")
    _write(tmp_path, "002_broken.sql", "INSERT INTO t VALUES (1); SELECT * FROM missing_table;")

    with pytest.raises(asyncpg.PostgresError):
        await apply_pending(scratch_conn, tmp_path)
    assert await scratch_conn.fetchval("SELECT COUNT(*) FROM t") == 0
    recorded = await scratch_conn.fetch("SELECT version FROM schema_migration")
    assert [r["version"] for r in recorded] == ["001_ok.sql"]


async def test_edited_applied_file_only_warns(scratch_conn, tmp_path, caplog):
    _write(tmp_path, "001_table.sql", "CREATE TABLE t (id INT);")
    await apply_pending(scratch_conn, tmp_path)

    _write(tmp_path, "001_table.sql", "CREATE TABLE t (id INT, extra TEXT);")
    with caplog.at_level(logging.WARNING, logger="app.core.migrations"):
        assert await apply_pending(scratch_conn, tmp_path) == []
    assert "changed after it was applied" in caplog.text
