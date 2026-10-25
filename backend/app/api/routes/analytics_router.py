# app/api/routes/analytics_router.py
import logging
from typing import Any, Awaitable, Callable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import get_incident_filter, require_role
from app.services.analytics_service import analytics_service
from app.services.filters import IncidentFilter
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["analytics"], prefix="/analytics", dependencies=[Depends(require_role("viewer"))]
)

# Every report takes the incident filter (camera, hierarchy, start/end), a
# window of ``days`` when no start/end is given, and the viewer's timezone.
Days = Query(30, ge=1, le=366, description="1 = last 24 hourly buckets, otherwise daily")
Tz = Query("UTC", max_length=64, description="IANA timezone the buckets are cut in")


async def _report(name: str, compute: Callable[[], Awaitable[Dict[str, Any]]]) -> Dict[str, Any]:
    try:
        data = await compute()
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        logger.error("Error computing %s: %s", name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Could not compute the {name}."
        )
    return create_response(True, f"{name[0].upper()}{name[1:]}.", data)


@router.get("/summary")
async def summary(
    days: int = Query(7, ge=1, le=366), tz: str = Tz,
    filters: IncidentFilter = Depends(get_incident_filter),
) -> Dict[str, Any]:
    """KPIs, the incident series, the weekday x hour heatmap, and the
    breakdowns by camera and severity."""
    return await _report("analytics summary", lambda: analytics_service.summary(filters, days, tz))


@router.get("/executive-summary")
async def executive_summary(
    days: int = Days, tz: str = Tz, filters: IncidentFilter = Depends(get_incident_filter)
) -> Dict[str, Any]:
    """Incident and recorded-loss trend; incidents by location and camera."""
    return await _report(
        "executive summary", lambda: analytics_service.executive_summary(filters, days, tz)
    )


@router.get("/hotspots")
async def hotspots(
    days: int = Query(14, ge=1, le=366), tz: str = Tz,
    filters: IncidentFilter = Depends(get_incident_filter),
) -> Dict[str, Any]:
    """Zone x day incident heatmap and the actions taken per camera."""
    return await _report("hotspots", lambda: analytics_service.hotspots(filters, days, tz))


@router.get("/high-value")
async def high_value(
    days: int = Days, tz: str = Tz, filters: IncidentFilter = Depends(get_incident_filter)
) -> Dict[str, Any]:
    """Recorded loss by date and severity, items stolen by date and zone, the
    most-taken items, and how many confirmed incidents still have no value."""
    return await _report("high-value analysis", lambda: analytics_service.high_value(filters, days, tz))


@router.get("/traffic")
async def traffic(
    days: int = Days, tz: str = Tz, filters: IncidentFilter = Depends(get_incident_filter)
) -> Dict[str, Any]:
    """Person sessions and incidents per 1,000 sessions by zone and location,
    the session series, and the top-risk areas."""
    return await _report("traffic insights", lambda: analytics_service.traffic(filters, days, tz))


@router.get("/confidence-audit")
async def confidence_audit(
    days: int = Query(7, ge=1, le=366), tz: str = Tz,
    filters: IncidentFilter = Depends(get_incident_filter),
) -> Dict[str, Any]:
    """Model accuracy & confidence audit: classifier confidence on alerts, its
    spread per camera, the mean probability per camera across every sample,
    and the dismissals operators marked."""
    return await _report(
        "confidence audit", lambda: analytics_service.confidence_audit(filters, days, tz)
    )


@router.get("/actions")
async def actions(
    days: int = Days, tz: str = Tz, filters: IncidentFilter = Depends(get_incident_filter)
) -> Dict[str, Any]:
    """Actions taken on incidents: overall, by camera, by location and by date."""
    return await _report("action breakdown", lambda: analytics_service.actions(filters, days, tz))


@router.get("/operational-efficiency")
async def operational_efficiency(
    days: int = Days, tz: str = Tz, filters: IncidentFilter = Depends(get_incident_filter)
) -> Dict[str, Any]:
    """Time to acknowledge and resolve, incidents by status, and the open backlog."""
    return await _report(
        "operational efficiency", lambda: analytics_service.operational_efficiency(filters, days, tz)
    )


@router.get("/real-time")
async def real_time(
    minutes: int = Query(2, ge=1, le=60),
    min_probability: Optional[float] = Query(
        None, ge=0, le=1, description="Defaults to half the alert threshold"
    ),
    filters: IncidentFilter = Depends(get_incident_filter),
) -> Dict[str, Any]:
    """People seen in the last few minutes whose shoplifting probability is
    high, the most suspicious first."""
    return await _report(
        "real-time activity", lambda: analytics_service.real_time(filters, minutes, min_probability)
    )
