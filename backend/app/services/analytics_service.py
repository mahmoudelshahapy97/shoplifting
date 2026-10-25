# app/services/analytics_service.py
"""Windowed aggregates behind the Dashboard and Analytics pages.

Every chart InsightEye's shoplifting dashboard draws, from real columns:

    summary                KPIs, the incident series, weekday x hour heatmap,
                           per camera and per severity
    executive_summary      loss and incident trend, incidents by location
    hotspots               zone x day heatmap, actions taken per camera
    high_value             recorded loss by severity, items stolen by zone
    traffic                person sessions, flagged share and incidents per
                           1,000 sessions by zone and location
    confidence_audit       the classifier's confidence on alerts, the per-camera
                           spread, and operator verdicts as ground truth
    actions                what operators did, by camera, date and location
    operational_efficiency time to acknowledge and resolve, open backlog
    real_time              people currently scoring high

InsightEye guessed a missing value from the severity (critical = 1000 ...) and
fed sessions from a pg_cron counter. Here value is what operators record when
they triage, an incident without one is counted as unvalued rather than
invented, and sessions are the person tracks the detector reports.

Time buckets are cut in the viewer's timezone, so "busiest hour" means the
hours the operator lives in. The window is the last ``days`` days, or an
explicit start/end from the filter.
"""

import logging
from dataclasses import replace
from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple

import asyncpg

from app.core.config import config
from app.core.database import db_manager
from app.services.filters import IncidentFilter

logger = logging.getLogger(__name__)

HISTOGRAM_BUCKETS = 10
LATEST_EVENTS = 50
BACKLOG_LIMIT = 50
# Locations need this many sessions before their incident rate counts as a
# top-risk area; three visits and one incident is not a 333-per-1k hotspot.
MIN_SESSIONS_FOR_RATE = 20
TOP_RISK_AREAS = 5
MAX_CUSTOM_DAYS = 366

# Columns of shoplifting_event (e), camera (c) and the other tables are joined
# the same way everywhere.
_EVENTS = "shoplifting_event e JOIN camera c ON c.camera_id = e.camera_id"
_SESSIONS = "person_session s JOIN camera c ON c.camera_id = s.camera_id"
_OBSERVATIONS = "shoplifting_observation o JOIN camera c ON c.camera_id = o.camera_id"


def _num(value: Any) -> Optional[float]:
    """numeric/Decimal and double alike, as a plain float (or None)."""
    return float(value) if value is not None else None


def _pct(part: Optional[int], whole: Optional[int]) -> Optional[float]:
    return round(100.0 * part / whole, 1) if whole else None


def _per_thousand(part: int, whole: int) -> Optional[float]:
    return round(1000.0 * part / whole, 1) if whole else None


class AnalyticsService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # ----------------------------------------------------------------- window
    async def _window(self, days: int, tz: str, filters: IncidentFilter) -> Dict[str, Any]:
        """The bucket grid, computed by Postgres so its tz database is the one used.

        Without start/end: one day is the last 24 hourly buckets, anything
        longer is ``days`` daily buckets ending with today. With them, daily
        buckets from start's day to end's day (or today). Both are aligned to
        bucket boundaries in ``tz``.
        """
        try:
            if filters.start or filters.end:
                row = await self.db_manager.execute_query(
                    """
                    WITH t AS (
                        SELECT COALESCE($1::timestamptz, NOW() - INTERVAL '30 days') AS s,
                               COALESCE($2::timestamptz, NOW())                     AS e
                    )
                    SELECT date_trunc('day', s AT TIME ZONE $3) AS start_local,
                           date_trunc('day', e AT TIME ZONE $3) AS end_local,
                           s AS start_at, e AS end_at, NOW() AS now
                    FROM t
                    """,
                    (filters.start, filters.end, tz),
                    fetch_one=True,
                )
                span = (row["end_local"] - row["start_local"]).days + 1
                if span > MAX_CUSTOM_DAYS:
                    raise ValueError(f"The date range is limited to {MAX_CUSTOM_DAYS} days.")
                return {"bucket": "day", "step": timedelta(days=1), **row}

            bucket = "hour" if days == 1 else "day"
            step = timedelta(hours=1) if bucket == "hour" else timedelta(days=1)
            count = 24 if bucket == "hour" else days
            row = await self.db_manager.execute_query(
                """
                WITH t AS (SELECT date_trunc($1, NOW() AT TIME ZONE $2) AS end_local)
                SELECT end_local,
                       end_local - $3::interval                    AS start_local,
                       (end_local - $3::interval) AT TIME ZONE $2  AS start_at,
                       NOW()                                       AS end_at,
                       NOW()                                       AS now
                FROM t
                """,
                (bucket, tz, step * (count - 1)),
                fetch_one=True,
            )
        except asyncpg.exceptions.InvalidParameterValueError as e:
            # "time zone ... not recognized" - the caller's input, not our fault.
            raise ValueError(f"Unknown timezone: {tz}") from e
        return {"bucket": bucket, "step": step, **row}

    async def _prepare(
        self, days: int, tz: str, filters: IncidentFilter
    ) -> Tuple[Dict[str, Any], IncidentFilter]:
        window = await self._window(days, tz, filters)
        return window, replace(filters, start=window["start_at"], end=window["end_at"])

    @staticmethod
    def _window_info(window: Dict[str, Any], tz: str) -> Dict[str, Any]:
        return {"start": window["start_at"], "end": window["end_at"], "bucket": window["bucket"], "tz": tz}

    async def _series(
        self,
        window: Dict[str, Any],
        tz: str,
        source: str,
        time_column: str,
        where: str,
        params: List[Any],
        aggregates: str,
    ) -> List[Dict[str, Any]]:
        """One row per bucket of the window (empty ones included) with ``aggregates``
        computed over the rows of ``source`` that fall in it."""
        n = len(params)
        rows = await self.db_manager.execute_query(
            f"""
            WITH buckets AS (
                SELECT generate_series(${n + 1}::timestamp, ${n + 2}::timestamp, ${n + 3}::interval)
                       AS bucket_start
            ),
            src AS (
                SELECT date_trunc(${n + 4}, {time_column} AT TIME ZONE ${n + 5}) AS bucket_start,
                       {time_column.split(".")[0]}.*
                FROM {source}
                WHERE {where}
            )
            SELECT b.bucket_start, {aggregates}
            FROM buckets b
            LEFT JOIN src ON src.bucket_start = b.bucket_start
            GROUP BY b.bucket_start
            ORDER BY b.bucket_start
            """,
            tuple(params)
            + (window["start_local"], window["end_local"], window["step"], window["bucket"], tz),
            fetch_all=True,
        )
        # Naive local timestamps: they are wall-clock times in ``tz``.
        return [{**row, "bucket_start": row["bucket_start"].isoformat()} for row in rows]

    # ---------------------------------------------------------------- summary
    async def summary(self, filters: IncidentFilter, days: int = 7, tz: str = "UTC") -> Dict[str, Any]:
        window, scoped = await self._prepare(days, tz, filters)

        params: List[Any] = []
        where = scoped.where(params)
        totals = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*)                                                     AS incidents,
                   COUNT(*) FILTER (WHERE e.status IN ('detected', 'under_review')) AS open,
                   COUNT(*) FILTER (WHERE e.status = 'confirmed')               AS confirmed,
                   COUNT(*) FILTER (WHERE e.status = 'resolved')                AS resolved,
                   COUNT(*) FILTER (WHERE e.status = 'dismissed')               AS dismissed,
                   COUNT(*) FILTER (WHERE e.severity IN ('high', 'critical'))   AS high_severity,
                   AVG(e.confidence)::float                                     AS avg_confidence,
                   COALESCE(SUM(e.estimated_value) FILTER (WHERE e.status <> 'dismissed'), 0)::float
                                                                                AS recorded_loss,
                   COALESCE(SUM(cardinality(e.items_stolen))
                            FILTER (WHERE e.status <> 'dismissed'), 0)::int     AS items_stolen,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (
                       ORDER BY EXTRACT(EPOCH FROM (e.acknowledged_at - e.detected_at))
                   ) FILTER (WHERE e.acknowledged_at IS NOT NULL)               AS median_response_s
            FROM {_EVENTS}
            WHERE {where}
            """,
            tuple(params),
            fetch_one=True,
        )

        sparams: List[Any] = []
        swhere = scoped.where(sparams, time_column="s.started_at", event_alias=None)
        sessions = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS sessions,
                   COUNT(*) FILTER (WHERE s.flagged) AS flagged,
                   AVG(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)))::float AS avg_dwell_s
            FROM {_SESSIONS}
            WHERE {swhere}
            """,
            tuple(sparams),
            fetch_one=True,
        )

        series = await self._series(
            window, tz, _EVENTS, "e.detected_at", where, list(params),
            """COUNT(src.event_id)                                       AS incidents,
               COUNT(*) FILTER (WHERE src.status = 'confirmed')          AS confirmed,
               COUNT(*) FILTER (WHERE src.status = 'dismissed')          AS dismissed,
               COALESCE(SUM(src.estimated_value), 0)::float              AS value""",
        )

        n = len(params)
        heatmap = await self.db_manager.execute_query(
            f"""
            SELECT EXTRACT(DOW  FROM e.detected_at AT TIME ZONE ${n + 1})::int AS weekday,
                   EXTRACT(HOUR FROM e.detected_at AT TIME ZONE ${n + 1})::int AS hour,
                   COUNT(*)                                                  AS events
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY weekday, hour
            ORDER BY weekday, hour
            """,
            tuple(params) + (tz,),
            fetch_all=True,
        )

        by_camera = await self.db_manager.execute_query(
            f"""
            SELECT e.camera_id, c.name AS camera_name, c.location, c.zone,
                   COUNT(*)                                                     AS incidents,
                   COUNT(*) FILTER (WHERE e.status IN ('detected', 'under_review')) AS open,
                   COUNT(*) FILTER (WHERE e.status = 'dismissed')               AS dismissed,
                   AVG(e.confidence)::float                                     AS avg_confidence,
                   COALESCE(SUM(e.estimated_value), 0)::float                   AS value
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY e.camera_id, c.name, c.location, c.zone
            ORDER BY incidents DESC, camera_name
            """,
            tuple(params),
            fetch_all=True,
        )

        by_severity = await self.db_manager.execute_query(
            f"""
            SELECT e.severity, COUNT(*) AS incidents
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY e.severity
            """,
            tuple(params),
            fetch_all=True,
        )
        severity_counts = {row["severity"]: row["incidents"] for row in by_severity}

        incidents = totals["incidents"]
        closed = totals["confirmed"] + totals["resolved"] + totals["dismissed"]
        return {
            "window": self._window_info(window, tz),
            "kpis": {
                **{k: v for k, v in totals.items() if k != "median_response_s"},
                "median_response_s": _num(totals["median_response_s"]),
                # Of the incidents an operator has ruled on, the share dismissed.
                "false_positive_pct": _pct(totals["dismissed"], closed),
                "sessions": sessions["sessions"],
                "flagged_sessions": sessions["flagged"],
                "avg_dwell_s": sessions["avg_dwell_s"],
                "incidents_per_1000_sessions": _per_thousand(incidents, sessions["sessions"]),
            },
            "series": series,
            "heatmap": heatmap,
            "by_camera": [{**row, "false_positive_pct": _pct(row["dismissed"], row["incidents"])} for row in by_camera],
            "by_severity": [
                {"severity": s, "incidents": severity_counts.get(s, 0)}
                for s in ("low", "medium", "high", "critical")
            ],
        }

    # ------------------------------------------------------ executive summary
    async def executive_summary(
        self, filters: IncidentFilter, days: int = 30, tz: str = "UTC"
    ) -> Dict[str, Any]:
        """The trend of incidents and recorded loss, and where they happen."""
        window, scoped = await self._prepare(days, tz, filters)
        params: List[Any] = []
        where = scoped.where(params) + " AND e.status <> 'dismissed'"

        trend = await self._series(
            window, tz, _EVENTS, "e.detected_at", where, list(params),
            """COUNT(src.event_id)                         AS incident_count,
               COALESCE(SUM(src.estimated_value), 0)::float AS total_value""",
        )
        by_location = await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(c.location, 'Unassigned')        AS location,
                   COUNT(*)                                  AS incident_count,
                   COALESCE(SUM(e.estimated_value), 0)::float AS total_value
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1
            ORDER BY incident_count DESC, location
            """,
            tuple(params),
            fetch_all=True,
        )
        by_camera = await self.db_manager.execute_query(
            f"""
            SELECT e.camera_id, c.name AS camera_name,
                   COUNT(*)                                  AS incident_count,
                   COALESCE(SUM(e.estimated_value), 0)::float AS total_value
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY e.camera_id, c.name
            ORDER BY incident_count DESC, camera_name
            """,
            tuple(params),
            fetch_all=True,
        )
        return {
            "window": self._window_info(window, tz),
            "trend": trend,
            "incidents_by_location": by_location,
            "incidents_by_camera": by_camera,
        }

    # --------------------------------------------------------------- hotspots
    async def hotspots(self, filters: IncidentFilter, days: int = 14, tz: str = "UTC") -> Dict[str, Any]:
        """Incidents per zone per day, and what operators did at each camera."""
        window, scoped = await self._prepare(days, tz, filters)
        params: List[Any] = []
        where = scoped.where(params) + " AND e.status <> 'dismissed'"
        n = len(params)

        cells = await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(c.zone, c.name)                               AS zone,
                   to_char(date_trunc('day', e.detected_at AT TIME ZONE ${n + 1}), 'YYYY-MM-DD') AS day,
                   COUNT(*)                                               AS incidents
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            tuple(params) + (tz,),
            fetch_all=True,
        )
        days_axis = await self.db_manager.execute_query(
            """
            SELECT to_char(d, 'YYYY-MM-DD') AS day
            FROM generate_series(date_trunc('day', $1::timestamp), $2::timestamp, INTERVAL '1 day') d
            """,
            (window["start_local"], window["end_local"]),
            fetch_all=True,
        )
        actions = await self.db_manager.execute_query(
            f"""
            SELECT c.name AS camera_name, COALESCE(e.action_taken, 'pending') AS action_taken,
                   COUNT(*) AS count
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            tuple(params),
            fetch_all=True,
        )
        zone_totals: Dict[str, int] = {}
        for cell in cells:
            zone_totals[cell["zone"]] = zone_totals.get(cell["zone"], 0) + cell["incidents"]
        return {
            "window": self._window_info(window, tz),
            "days": [row["day"] for row in days_axis],
            "zones": sorted(zone_totals, key=lambda z: (-zone_totals[z], z)),
            "heatmap": cells,
            "actions_by_camera": actions,
        }

    # ------------------------------------------------------------- high value
    async def high_value(self, filters: IncidentFilter, days: int = 30, tz: str = "UTC") -> Dict[str, Any]:
        """Recorded loss by date and severity, and items stolen by date and zone.

        Only what operators recorded counts. Confirmed or resolved incidents
        without a value are reported as ``unvalued`` so the gap is visible.
        """
        window, scoped = await self._prepare(days, tz, filters)
        params: List[Any] = []
        where = scoped.where(params) + " AND e.status <> 'dismissed'"
        n = len(params)

        value_rows = await self.db_manager.execute_query(
            f"""
            SELECT to_char(date_trunc('day', e.detected_at AT TIME ZONE ${n + 1}), 'YYYY-MM-DD') AS day,
                   e.severity, SUM(e.estimated_value)::float AS total_value, COUNT(*) AS incidents
            FROM {_EVENTS}
            WHERE {where} AND e.estimated_value IS NOT NULL
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            tuple(params) + (tz,),
            fetch_all=True,
        )
        item_rows = await self.db_manager.execute_query(
            f"""
            SELECT to_char(date_trunc('day', e.detected_at AT TIME ZONE ${n + 1}), 'YYYY-MM-DD') AS day,
                   COALESCE(c.zone, c.name) AS zone,
                   SUM(cardinality(e.items_stolen))::int AS item_count
            FROM {_EVENTS}
            WHERE {where} AND cardinality(e.items_stolen) > 0
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            tuple(params) + (tz,),
            fetch_all=True,
        )
        top_items = await self.db_manager.execute_query(
            f"""
            SELECT lower(item) AS item, COUNT(*) AS count
            FROM {_EVENTS}, unnest(e.items_stolen) AS item
            WHERE {where}
            GROUP BY 1
            ORDER BY count DESC, item
            LIMIT 10
            """,
            tuple(params),
            fetch_all=True,
        )
        totals = await self.db_manager.execute_query(
            f"""
            SELECT COALESCE(SUM(e.estimated_value), 0)::float                       AS recorded_loss,
                   COUNT(*) FILTER (WHERE e.estimated_value IS NOT NULL)            AS valued,
                   COUNT(*) FILTER (WHERE e.estimated_value IS NULL
                                      AND e.status IN ('confirmed', 'resolved'))    AS unvalued,
                   MAX(e.estimated_value)::float                                    AS largest_loss
            FROM {_EVENTS}
            WHERE {where}
            """,
            tuple(params),
            fetch_one=True,
        )
        return {
            "window": self._window_info(window, tz),
            "totals": totals,
            "total_estimated_value": value_rows,
            "items_stolen": item_rows,
            "top_items": top_items,
        }

    # ---------------------------------------------------------------- traffic
    async def traffic(self, filters: IncidentFilter, days: int = 30, tz: str = "UTC") -> Dict[str, Any]:
        """Footfall (person sessions) against incidents, by zone and location."""
        window, scoped = await self._prepare(days, tz, filters)
        sparams: List[Any] = []
        swhere = scoped.where(sparams, time_column="s.started_at", event_alias=None)
        eparams: List[Any] = []
        ewhere = scoped.where(eparams) + " AND e.status <> 'dismissed'"

        async def grouped(key: str) -> List[Dict[str, Any]]:
            sessions = await self.db_manager.execute_query(
                f"""
                SELECT COALESCE({key}, 'Unassigned') AS name,
                       COUNT(*) AS sessions,
                       COUNT(*) FILTER (WHERE s.flagged) AS flagged,
                       AVG(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)))::float AS avg_dwell_s
                FROM {_SESSIONS}
                WHERE {swhere}
                GROUP BY 1
                """,
                tuple(sparams),
                fetch_all=True,
            )
            incidents = await self.db_manager.execute_query(
                f"SELECT COALESCE({key}, 'Unassigned') AS name, COUNT(*) AS incidents "
                f"FROM {_EVENTS} WHERE {ewhere} GROUP BY 1",
                tuple(eparams),
                fetch_all=True,
            )
            merged: Dict[str, Dict[str, Any]] = {
                row["name"]: {**row, "incidents": 0} for row in sessions
            }
            for row in incidents:
                merged.setdefault(
                    row["name"], {"name": row["name"], "sessions": 0, "flagged": 0, "avg_dwell_s": None}
                )["incidents"] = row["incidents"]
            out = []
            for row in merged.values():
                out.append(
                    {
                        **row,
                        "flagged_pct": _pct(row["flagged"], row["sessions"]),
                        "incidents_per_1000_sessions": _per_thousand(row["incidents"], row["sessions"]),
                    }
                )
            return sorted(out, key=lambda r: (-r["sessions"], r["name"]))

        by_zone = await grouped("c.zone")
        by_location = await grouped("c.location")
        series = await self._series(
            window, tz, _SESSIONS, "s.started_at", swhere, list(sparams),
            """COUNT(src.session_id)                     AS sessions,
               COUNT(*) FILTER (WHERE src.flagged)       AS flagged""",
        )
        ranked = [r for r in by_location if r["sessions"] >= MIN_SESSIONS_FOR_RATE]
        ranked.sort(key=lambda r: -(r["incidents_per_1000_sessions"] or 0))
        return {
            "window": self._window_info(window, tz),
            "by_zone": by_zone,
            "by_location": by_location,
            "series": series,
            "top_risk_areas": ranked[:TOP_RISK_AREAS],
            "min_sessions_for_rate": MIN_SESSIONS_FOR_RATE,
        }

    # ------------------------------------------------------- confidence audit
    async def confidence_audit(
        self, filters: IncidentFilter, days: int = 7, tz: str = "UTC"
    ) -> Dict[str, Any]:
        """How sure the classifier was about the alerts in the window.

        Totals, a 10-bucket histogram over [0, 1], the spread per camera and
        the latest alerts. Operator verdicts stand in for ground truth, so each
        part also counts dismissals. ``low_confidence`` counts alerts within
        0.1 of the alert threshold, the ones most worth a second look. The
        per-camera mean of every probability sample (observations, not just
        alerts) is InsightEye's "model accuracy" chart.
        """
        window, scoped = await self._prepare(days, tz, filters)
        threshold = float(config.shoplifting_threshold)
        low_cutoff = round(min(1.0, threshold + 0.1), 4)

        params: List[Any] = []
        where = scoped.where(params) + " AND e.detection_method <> 'test'"
        n = len(params)
        low = f"${n + 1}"

        totals = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*)                                                 AS events,
                   AVG(e.confidence)::float                                 AS avg_confidence,
                   MIN(e.confidence)::float                                 AS min_confidence,
                   MAX(e.confidence)::float                                 AS max_confidence,
                   COUNT(*) FILTER (WHERE e.confidence < {low})             AS low_confidence,
                   COUNT(*) FILTER (WHERE e.status = 'confirmed')           AS confirmed,
                   COUNT(*) FILTER (WHERE e.status = 'resolved')            AS resolved,
                   COUNT(*) FILTER (WHERE e.status = 'dismissed')           AS dismissed,
                   AVG(e.confidence) FILTER (WHERE e.status IN ('confirmed', 'resolved'))::float
                                                                            AS avg_confidence_confirmed,
                   AVG(e.confidence) FILTER (WHERE e.status = 'dismissed')::float
                                                                            AS avg_confidence_dismissed
            FROM {_EVENTS}
            WHERE {where}
            """,
            tuple(params) + (low_cutoff,),
            fetch_one=True,
        )

        bucket_rows = await self.db_manager.execute_query(
            f"""
            SELECT LEAST(width_bucket(e.confidence, 0, 1, {HISTOGRAM_BUCKETS}), {HISTOGRAM_BUCKETS}) AS b,
                   COUNT(*)                                        AS count,
                   COUNT(*) FILTER (WHERE e.status = 'dismissed')  AS dismissed
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1
            """,
            tuple(params),
            fetch_all=True,
        )
        by_bucket = {row["b"]: row for row in bucket_rows}
        step = 1 / HISTOGRAM_BUCKETS
        histogram = [
            {
                "bucket": f"{(i - 1) * step:.1f}-{i * step:.1f}",
                "min": round((i - 1) * step, 2),
                "max": round(i * step, 2),
                "count": by_bucket[i]["count"] if i in by_bucket else 0,
                "dismissed": by_bucket[i]["dismissed"] if i in by_bucket else 0,
            }
            for i in range(1, HISTOGRAM_BUCKETS + 1)
        ]

        by_camera = await self.db_manager.execute_query(
            f"""
            SELECT e.camera_id, c.name AS camera_name,
                   COUNT(*)                                        AS events,
                   AVG(e.confidence)::float                        AS avg_confidence,
                   MIN(e.confidence)::float                        AS min_confidence,
                   MAX(e.confidence)::float                        AS max_confidence,
                   COUNT(*) FILTER (WHERE e.confidence < {low})    AS low_confidence,
                   COUNT(*) FILTER (WHERE e.status = 'dismissed')  AS dismissed
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY e.camera_id, c.name
            ORDER BY avg_confidence DESC NULLS LAST, camera_name
            """,
            tuple(params) + (low_cutoff,),
            fetch_all=True,
        )

        oparams: List[Any] = []
        owhere = scoped.where(oparams, time_column="o.observed_at", event_alias=None)
        above = f"${len(oparams) + 1}"
        observations = await self.db_manager.execute_query(
            f"""
            SELECT o.camera_id, c.name AS camera_name,
                   COUNT(*)                                      AS samples,
                   AVG(o.probability)::float                     AS avg_probability,
                   COUNT(*) FILTER (WHERE o.probability >= {above}) AS above_threshold
            FROM {_OBSERVATIONS}
            WHERE {owhere}
            GROUP BY o.camera_id, c.name
            ORDER BY camera_name
            """,
            tuple(oparams) + (threshold,),
            fetch_all=True,
        )

        latest = await self.db_manager.execute_query(
            f"""
            SELECT e.event_id, e.detected_at, e.camera_id, c.name AS camera_name,
                   e.severity, e.confidence::float AS confidence, e.status
            FROM {_EVENTS}
            WHERE {where}
            ORDER BY e.detected_at DESC, e.event_id
            LIMIT {LATEST_EVENTS}
            """,
            tuple(params),
            fetch_all=True,
        )

        ruled = totals["confirmed"] + totals["resolved"] + totals["dismissed"]
        return {
            "window": self._window_info(window, tz),
            "summary": {
                **totals,
                "low_confidence_pct": _pct(totals["low_confidence"], totals["events"]),
                "false_positive_pct": _pct(totals["dismissed"], ruled),
                "threshold": threshold,
                "low_confidence_cutoff": low_cutoff,
            },
            "histogram": histogram,
            "by_camera": [
                {**row, "false_positive_pct": _pct(row["dismissed"], row["events"])} for row in by_camera
            ],
            "observations_by_camera": observations,
            "latest": latest,
        }

    # ---------------------------------------------------------------- actions
    async def actions(self, filters: IncidentFilter, days: int = 30, tz: str = "UTC") -> Dict[str, Any]:
        """What operators did about incidents (InsightEye's /actions/* in one)."""
        window, scoped = await self._prepare(days, tz, filters)
        params: List[Any] = []
        where = scoped.where(params)
        action = "COALESCE(e.action_taken, 'pending')"

        async def by(key: str, label: str) -> List[Dict[str, Any]]:
            return await self.db_manager.execute_query(
                f"""
                SELECT {key} AS {label}, {action} AS action_taken, COUNT(*) AS count
                FROM {_EVENTS}
                WHERE {where}
                GROUP BY 1, 2
                ORDER BY 1, 2
                """,
                tuple(params),
                fetch_all=True,
            )

        summary = await self.db_manager.execute_query(
            f"""
            SELECT {action} AS action_taken, COUNT(*) AS count
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1
            ORDER BY count DESC
            """,
            tuple(params),
            fetch_all=True,
        )
        n = len(params)
        by_date = await self.db_manager.execute_query(
            f"""
            SELECT to_char(date_trunc('day', e.detected_at AT TIME ZONE ${n + 1}), 'YYYY-MM-DD') AS day,
                   {action} AS action_taken, COUNT(*) AS count
            FROM {_EVENTS}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            tuple(params) + (tz,),
            fetch_all=True,
        )
        return {
            "window": self._window_info(window, tz),
            "summary": summary,
            "by_camera": await by("c.name", "camera_name"),
            "by_location": await by("COALESCE(c.location, 'Unassigned')", "location"),
            "by_date": by_date,
        }

    # ------------------------------------------------- operational efficiency
    async def operational_efficiency(
        self, filters: IncidentFilter, days: int = 30, tz: str = "UTC"
    ) -> Dict[str, Any]:
        """How fast incidents are picked up and closed, and what is still open."""
        window, scoped = await self._prepare(days, tz, filters)
        params: List[Any] = []
        where = scoped.where(params)

        times = await self.db_manager.execute_query(
            f"""
            WITH t AS (
                SELECT EXTRACT(EPOCH FROM (e.acknowledged_at - e.detected_at)) AS ack_s,
                       EXTRACT(EPOCH FROM (e.resolved_at - e.detected_at))     AS resolve_s
                FROM {_EVENTS}
                WHERE {where}
            )
            SELECT AVG(ack_s)::float                                          AS avg_acknowledge_s,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ack_s)         AS median_acknowledge_s,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ack_s)         AS p90_acknowledge_s,
                   AVG(resolve_s)::float                                      AS avg_resolve_s,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resolve_s)     AS median_resolve_s,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY resolve_s)     AS p90_resolve_s,
                   COUNT(ack_s)                                               AS acknowledged,
                   COUNT(resolve_s)                                           AS closed
            FROM t
            """,
            tuple(params),
            fetch_one=True,
        )
        by_status = await self.db_manager.execute_query(
            f"SELECT e.status, COUNT(*) AS count FROM {_EVENTS} WHERE {where} GROUP BY 1",
            tuple(params),
            fetch_all=True,
        )
        status_counts = {row["status"]: row["count"] for row in by_status}

        # The backlog is everything still open, whenever it was raised.
        bparams: List[Any] = []
        bwhere = replace(filters, start=None, end=None, status=[]).where(bparams)
        backlog = await self.db_manager.execute_query(
            f"""
            SELECT e.event_id, e.detected_at, e.severity, e.status, e.confidence::float AS confidence,
                   c.name AS camera_name, c.zone,
                   EXTRACT(EPOCH FROM (NOW() - e.detected_at))::float AS age_s
            FROM {_EVENTS}
            WHERE {bwhere} AND e.status IN ('detected', 'under_review')
            ORDER BY e.detected_at
            LIMIT {BACKLOG_LIMIT}
            """,
            tuple(bparams),
            fetch_all=True,
        )
        ages = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) FILTER (WHERE e.detected_at > NOW() - INTERVAL '1 hour')  AS under_1h,
                   COUNT(*) FILTER (WHERE e.detected_at <= NOW() - INTERVAL '1 hour'
                                      AND e.detected_at > NOW() - INTERVAL '1 day')  AS under_1d,
                   COUNT(*) FILTER (WHERE e.detected_at <= NOW() - INTERVAL '1 day'
                                      AND e.detected_at > NOW() - INTERVAL '7 days') AS under_7d,
                   COUNT(*) FILTER (WHERE e.detected_at <= NOW() - INTERVAL '7 days') AS older,
                   COUNT(*)                                                           AS total
            FROM {_EVENTS}
            WHERE {bwhere} AND e.status IN ('detected', 'under_review')
            """,
            tuple(bparams),
            fetch_one=True,
        )
        return {
            "window": self._window_info(window, tz),
            "response_times": {k: _num(v) if k.endswith("_s") else v for k, v in times.items()},
            "by_status": [
                {"status": s, "count": status_counts.get(s, 0)}
                for s in ("detected", "under_review", "confirmed", "dismissed", "resolved")
            ],
            "backlog": backlog,
            "backlog_age": ages,
        }

    # -------------------------------------------------------------- real time
    async def real_time(
        self, filters: IncidentFilter, minutes: int = 2, min_probability: Optional[float] = None
    ) -> Dict[str, Any]:
        """The latest sample of each person seen in the last ``minutes``, the
        most suspicious first (the Real-Time Activity Monitor)."""
        if min_probability is None:
            min_probability = round(config.shoplifting_threshold / 2, 4)
        params: List[Any] = []
        where = replace(filters, start=None, end=None).where(
            params, time_column="o.observed_at", event_alias=None
        )
        n = len(params)
        rows = await self.db_manager.execute_query(
            f"""
            SELECT DISTINCT ON (o.camera_id, o.track_key)
                   o.camera_id, c.name AS camera_name, c.location, c.building, c.floor_level, c.zone,
                   o.track_key, o.probability::float AS probability, o.observed_at
            FROM {_OBSERVATIONS}
            WHERE {where} AND o.observed_at > NOW() - make_interval(mins => ${n + 1})
            ORDER BY o.camera_id, o.track_key, o.observed_at DESC
            """,
            tuple(params) + (minutes,),
            fetch_all=True,
        )
        people = sorted(
            (r for r in rows if r["probability"] >= min_probability),
            key=lambda r: -r["probability"],
        )
        return {
            "minutes": minutes,
            "min_probability": min_probability,
            "threshold": config.shoplifting_threshold,
            "people_seen": len(rows),
            "people": people,
        }


analytics_service = AnalyticsService()
