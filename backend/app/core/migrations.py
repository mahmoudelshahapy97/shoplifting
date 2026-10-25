# app/core/migrations.py
"""Versioned schema migrations: database/migrations/NNN_name.sql, applied once each.

schema.sql only runs on the first boot of an empty volume, so a change made to
it later never reaches an existing database. Each such change also goes into a
numbered file under database/migrations/. At startup every file not yet
recorded in ``schema_migration`` is applied, in name order and each in its own
transaction, and then recorded with its checksum.

Files must be idempotent (IF NOT EXISTS, DO blocks): a fresh volume already has
everything from schema.sql, so there they run as no-ops and are just recorded.
A recorded file is never re-run; editing one only logs a checksum warning, so
add a new file instead.

    python -m app.core.migrations           # apply what is pending
    python -m app.core.migrations --list    # show applied / pending
"""

import argparse
import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import asyncpg

from app.core.config import config

logger = logging.getLogger(__name__)

_FILE_PATTERN = re.compile(r"^(\d{3,})_[\w-]+\.sql$")
# Any constant works; it only has to be the same in every API process.
_ADVISORY_LOCK_KEY = 0x534C_4D49  # "SLMI"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migration (
    version     TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
"""


@dataclass(frozen=True)
class Migration:
    version: str  # the file name, e.g. "002_event_resolution.sql"
    path: Path
    checksum: str

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


def migrations_dir() -> Path:
    """MIGRATIONS_DIR (the compose mount), else the repo's database/migrations
    when running from a checkout."""
    configured = Path(config.migrations_dir)
    if configured.is_dir():
        return configured
    # backend/app/core/migrations.py -> <repo>/database/migrations
    return Path(__file__).resolve().parents[3] / "database" / "migrations"


def discover(directory: Optional[Path] = None) -> List[Migration]:
    directory = directory or migrations_dir()
    if not directory.is_dir():
        logger.warning("Migrations directory %s not found; no migrations applied.", directory)
        return []
    found = []
    for path in sorted(directory.iterdir()):
        if path.is_file() and _FILE_PATTERN.match(path.name):
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            found.append(Migration(version=path.name, path=path, checksum=checksum))
    return found


async def _applied(conn: asyncpg.Connection) -> Dict[str, str]:
    rows = await conn.fetch("SELECT version, checksum FROM schema_migration")
    return {row["version"]: row["checksum"] for row in rows}


async def apply_pending(conn: asyncpg.Connection, directory: Optional[Path] = None) -> List[str]:
    """Apply every unrecorded migration; returns the versions applied now."""
    await conn.execute(_CREATE_TABLE)
    await conn.execute("SELECT pg_advisory_lock($1)", _ADVISORY_LOCK_KEY)
    try:
        applied = await _applied(conn)
        done: List[str] = []
        for migration in discover(directory):
            recorded = applied.get(migration.version)
            if recorded is not None:
                if recorded != migration.checksum:
                    logger.warning(
                        "Migration %s changed after it was applied; it is not re-run. "
                        "Put new changes in a new file.",
                        migration.version,
                    )
                continue
            async with conn.transaction():
                await conn.execute(migration.sql)
                await conn.execute(
                    "INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)",
                    migration.version,
                    migration.checksum,
                )
            logger.info("Applied migration %s", migration.version)
            done.append(migration.version)
        return done
    finally:
        await conn.execute("SELECT pg_advisory_unlock($1)", _ADVISORY_LOCK_KEY)


async def run_migrations() -> List[str]:
    """Startup hook: apply pending migrations over the shared pool."""
    from app.core.database import get_pool

    pool = get_pool()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        done = await apply_pending(conn)
    logger.info("Migrations: %s applied now.", len(done) if done else "none")
    return done


async def status(conn: asyncpg.Connection) -> List[Dict[str, Optional[str]]]:
    await conn.execute(_CREATE_TABLE)
    rows = {
        row["version"]: row
        for row in await conn.fetch("SELECT version, checksum, applied_at FROM schema_migration")
    }
    out = []
    for migration in discover():
        row = rows.pop(migration.version, None)
        state = "pending"
        if row is not None:
            state = "applied" if row["checksum"] == migration.checksum else "applied (file changed)"
        out.append({
            "version": migration.version,
            "state": state,
            "applied_at": row["applied_at"].isoformat() if row else None,
        })
    for version, row in rows.items():
        out.append({"version": version, "state": "applied (file missing)",
                    "applied_at": row["applied_at"].isoformat()})
    return out


async def _main(list_only: bool) -> None:
    conn = await asyncpg.connect(dsn=config.database_dsn)
    try:
        if not list_only:
            done = await apply_pending(conn)
            print(f"Applied {len(done)} migration(s): {', '.join(done) or '-'}")
        for row in await status(conn):
            print(f"{row['version']:<40} {row['state']:<24} {row['applied_at'] or ''}")
    finally:
        await conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Apply or list database migrations.")
    parser.add_argument("--list", action="store_true", help="only show applied / pending")
    asyncio.run(_main(parser.parse_args().list))
