# app/services/media_service.py
"""Save, load and delete the media that belongs to database rows.

MinIO is the primary store: the bytes go there and the row records the object
key. When the store is unreachable the bytes go into the row's BYTEA column
instead, so a stored alert never loses its picture. Reads prefer the key and
fall back to the bytes.
"""

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any, Iterable, List, Optional
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.services.object_store import CAMERA_PREFIXES, object_store

logger = logging.getLogger(__name__)

# (table, id column, key column, bytes column) for every stored image.
EVENT_FRAME = ("shoplifting_event", "event_id", "frame_key", "frame_jpeg")


async def save_image(kind: tuple, row_id: Any, key: str, data: Optional[bytes]) -> Optional[str]:
    """Store ``data`` for the row; returns the object key, or None if it went to Postgres."""
    if not data:
        return None
    table, id_column, key_column, bytes_column = kind
    if await object_store.put_bytes(key, data, "image/jpeg"):
        await db_manager.execute_query(
            f"UPDATE {table} SET {key_column} = $2 WHERE {id_column} = $1", (row_id, key)
        )
        return key
    logger.warning("MinIO unavailable; keeping %s %s in Postgres.", table, row_id)
    await db_manager.execute_query(
        f"UPDATE {table} SET {bytes_column} = $2 WHERE {id_column} = $1", (row_id, data)
    )
    return None


async def load(key: Optional[str], fallback: Optional[bytes]) -> Optional[bytes]:
    """The object behind ``key``, or the row's own bytes when there is none or it fails."""
    if key:
        data = await object_store.get_bytes(key)
        if data:
            return data
    return bytes(fallback) if fallback else None


async def load_image(kind: tuple, row_id: Any) -> Optional[bytes]:
    table, id_column, key_column, bytes_column = kind
    row = await db_manager.execute_query(
        f"SELECT {key_column}, {bytes_column} FROM {table} WHERE {id_column} = $1",
        (row_id,),
        fetch_one=True,
    )
    if not row:
        return None
    return await load(row[key_column], row[bytes_column])


async def purge_camera(camera_id: UUID) -> None:
    """Every frame and clip a camera recorded, in MinIO and on disk.

    For after its rows are gone (camera or workspace deleted).
    """
    for prefix in CAMERA_PREFIXES:
        await object_store.remove_prefix(f"{prefix}/{camera_id}/")
    await asyncio.to_thread(shutil.rmtree, Path(config.clip_dir) / str(camera_id), True)


async def purge_events(rows: Iterable[dict]) -> int:
    """The media of deleted incidents (rows with frame_key, clip_key, clip_path).

    Returns how many objects and files went.
    """
    keys: List[str] = []
    paths: List[Path] = []
    root = Path(config.clip_dir)
    for row in rows:
        keys.extend(k for k in (row.get("frame_key"), row.get("clip_key")) if k)
        if row.get("clip_path"):
            paths.append(root / row["clip_path"])
    removed = len(await object_store.remove(keys))

    def unlink() -> int:
        gone = 0
        for path in paths:
            try:
                path.unlink()
                gone += 1
            except OSError:
                pass
        return gone

    return removed + await asyncio.to_thread(unlink)
