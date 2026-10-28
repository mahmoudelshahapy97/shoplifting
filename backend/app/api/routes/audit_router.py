# app/api/routes/audit_router.py
"""The audit log, for admins: filter, page, export."""

from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from app.api.deps import require_role
from app.services.audit_service import audit_service

router = APIRouter(tags=["audit"], prefix="/audit-logs", dependencies=[Depends(require_role("admin"))])


def _filters(
    action: Optional[str] = Query(None, max_length=60),
    actor: Optional[str] = Query(None, max_length=120, description="Part of the username"),
    since: Optional[datetime] = Query(None),
    until: Optional[datetime] = Query(None),
) -> Dict[str, Any]:
    return {"action": action, "actor": actor, "since": since, "until": until}


@router.get("")
async def list_audit_log(
    filters: Dict[str, Any] = Depends(_filters),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    """Newest first: {items, total}."""
    return await audit_service.list(filters, limit=limit, offset=offset)


@router.get("/export.csv")
async def export_audit_log(filters: Dict[str, Any] = Depends(_filters)) -> Response:
    return Response(
        content=await audit_service.export_csv(filters),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
    )
