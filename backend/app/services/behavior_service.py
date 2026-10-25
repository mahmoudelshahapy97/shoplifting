# app/services/behavior_service.py
"""Per-person shoplifting detection over a sliding window of pose features.

InsightEye kept one 120-sample window per camera and filled it from whichever
person YOLO listed first, so two shoppers in view were blended into one
nonsense sequence, and an alert could not say who it was about. Here every
tracked person has their own window:

    sample   at ``sample_fps``, append extract_features(person's keypoints);
             while the tracker has lost them, an all-zero row - exactly what
             InsightEye's buffer received for a frame with nobody in it
    judge    once ``min_window_samples`` of them are real, on every new sample
             (sliding window): the Shoplifting probability, averaged over the
             last ``smooth_window`` judgements (InsightEye's smoothing). A
             window not yet full is left-padded with zero rows, which is what
             InsightEye's per-camera buffer held before someone walked in
    alert    when the smoothed probability reaches ``threshold``, at most once
             per person per ``track_cooldown_seconds`` and once per camera per
             ``camera_cooldown_seconds``

Every judged window on the camera goes through one batched forward pass.

ByteTrack sometimes gives a person a new id - an occlusion behind a shelf
end, a few missed detections - and a fresh id would mean a fresh, empty
window. So a new id that appears within ``handover_seconds`` of a person
vanishing, with a similar body height, takes over that person's window and
session (``_handover``). It is deliberately narrow: only someone the detector
still remembers as just lost, never a person still in view.

A person's visit is also a *session*: from first sighting until the tracker
has lost them for ``track_max_misses`` processed frames. Sessions are what the
traffic analytics count (InsightEye incremented a counter once a minute with
pg_cron instead), and a session is ``flagged`` when it raised an alert.

The classifier is injected as a callable, so this module runs in tests with a
stub and no torch model.
"""

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, List, Optional

import numpy as np

from app.core.config import config
from app.services.pose_tracker import PersonDetection
from app.services.shoplifting_model import NUM_FEATURES, NUM_FRAMES, NUM_KEYPOINTS, extract_features
from app.utils.geometry_utils import Box

# A new id whose box height is within this factor of a vanished person's can
# take over their window (see _handover).
HANDOVER_HEIGHT_RATIO = 1.5

# A session shorter than this many processed frames is tracker flicker (a
# mannequin, a reflection), not a shopper; it is not recorded.
MIN_SESSION_FRAMES = 3

# Live-view states, as reported by snapshot()
BUFFERING = "BUFFERING"
NORMAL = "NORMAL"
SUSPICIOUS = "SUSPICIOUS"   # above half the threshold: worth watching
ALERT = "ALERT"             # raised an alert within its cooldown


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


@dataclass
class DetectorParams:
    sample_fps: float = 3.0
    threshold: float = 0.5
    smooth_window: int = 3
    min_person_height_px: float = 60.0
    track_cooldown_seconds: float = 300.0
    camera_cooldown_seconds: float = 30.0
    track_max_misses: int = 15
    handover_seconds: float = 5.0
    min_window_samples: int = 30
    observation_interval_s: float = 5.0

    # Keys a camera's ``settings`` may override; anything else is ignored.
    OVERRIDABLE = (
        "sample_fps",
        "threshold",
        "smooth_window",
        "min_person_height_px",
        "track_cooldown_seconds",
        "camera_cooldown_seconds",
        "track_max_misses",
        "handover_seconds",
        "min_window_samples",
    )

    @classmethod
    def from_settings(cls, settings: Optional[Dict[str, Any]] = None) -> "DetectorParams":
        params = cls(
            sample_fps=config.sample_fps,
            threshold=config.shoplifting_threshold,
            smooth_window=config.smooth_window,
            min_person_height_px=config.min_person_height_px,
            track_cooldown_seconds=config.track_cooldown_seconds,
            camera_cooldown_seconds=config.camera_cooldown_seconds,
            track_max_misses=config.track_max_misses,
            handover_seconds=config.track_handover_seconds,
            min_window_samples=config.min_window_samples,
            observation_interval_s=config.observation_interval_s,
        )
        for key in cls.OVERRIDABLE:
            value = (settings or {}).get(key)
            if value is None or isinstance(value, bool):
                continue
            try:
                setattr(params, key, type(getattr(params, key))(value))
            except (TypeError, ValueError):
                continue
        params.sample_fps = max(0.1, params.sample_fps)
        params.smooth_window = max(1, params.smooth_window)
        params.min_window_samples = max(1, min(NUM_FRAMES, params.min_window_samples))
        return params


@dataclass
class ShopliftingAlert:
    track_id: int
    track_key: str
    probability: float
    peak: float
    box: Optional[Box]
    started_at: float      # epoch: the person's first sighting
    detected_at: float     # epoch
    forced: bool = False   # a test alert (POST /cameras/{id}/test-alert)


@dataclass
class PersonSession:
    track_key: str
    track_id: int
    started_at: float
    ended_at: float
    frames: int
    samples: int
    max_probability: Optional[float]
    flagged: bool


@dataclass
class Observation:
    track_id: int
    probability: float
    observed_at: float


@dataclass
class DetectorUpdate:
    alerts: List[ShopliftingAlert] = field(default_factory=list)
    sessions: List[PersonSession] = field(default_factory=list)
    observations: List[Observation] = field(default_factory=list)


@dataclass
class _Track:
    track_id: int
    track_key: str
    first_seen: float
    last_seen: float
    box: Box
    window: Deque[np.ndarray]
    judgements: Deque[float]
    prev_kpts: Optional[np.ndarray] = None
    real: Deque[bool] = field(default_factory=lambda: deque(maxlen=NUM_FRAMES))  # row is the person, not padding

    @property
    def real_samples(self) -> int:
        return sum(self.real)
    last_sample_at: Optional[float] = None
    last_observed_at: Optional[float] = None
    last_alert_at: Optional[float] = None
    alerts: int = 0
    probability: Optional[float] = None   # smoothed, latest
    peak: Optional[float] = None
    frames: int = 0
    samples: int = 0
    misses: int = 0


class ShopliftingDetector:
    """Not thread-safe: one per camera worker, called from one thread at a time.

    ``snapshot()`` may be read from another thread; it returns a list built at
    the end of the last update.
    """

    def __init__(
        self,
        classify: Callable[[np.ndarray], np.ndarray],
        params: Optional[DetectorParams] = None,
    ) -> None:
        self.classify = classify
        self.params = params or DetectorParams.from_settings()
        self.tracks: Dict[int, _Track] = {}
        self._last_session_ms = 0
        self._session = self._new_session()
        self._camera_last_alert: Optional[float] = None
        self._forced = 0
        self._snapshot: List[Dict[str, Any]] = []

    def _new_session(self) -> str:
        # Track ids restart with the tracker; the token keeps keys unique, even
        # across two resets in the same millisecond.
        self._last_session_ms = max(int(time.time() * 1000), self._last_session_ms + 1)
        return _base36(self._last_session_ms)

    # ------------------------------------------------------------------ input
    def force_alert(self) -> None:
        """Raise one test alert on the next update, to exercise the evidence path."""
        self._forced += 1

    def update(self, people: List[PersonDetection], ts: float) -> DetectorUpdate:
        out = DetectorUpdate()
        seen = {person.track_id for person in people}
        due: List[_Track] = []

        for person in people:
            track = self.tracks.get(person.track_id)
            if track is None:
                track = self._handover(person, ts, seen) or self._open(person, ts)
            track.last_seen = ts
            track.box = person.box
            track.misses = 0
            track.frames += 1
            if person.height < self.params.min_person_height_px:
                continue
            if self._sample(track, person, ts) and track.real_samples >= self.params.min_window_samples:
                due.append(track)

        if due:
            probs = self.classify(np.stack([self._window(t) for t in due]))
            for track, prob in zip(due, probs):
                self._judge(track, float(prob), ts, out)

        if self._forced:
            self._forced -= 1
            out.alerts.append(self._forced_alert(people, ts))

        for track in list(self.tracks.values()):
            if track.track_id not in seen:
                track.misses += 1
                if track.misses > self.params.track_max_misses:
                    self._close(track, out)
                else:
                    self._sample_absent(track, ts)
            self._observe(track, ts, out)

        self._snapshot = self._build_snapshot(ts)
        return out

    def flush(self) -> List[PersonSession]:
        """End every open session (the worker is stopping or reconnecting)."""
        out = DetectorUpdate()
        for track in list(self.tracks.values()):
            self._close(track, out)
        self._snapshot = []
        return out.sessions

    def reset(self) -> List[PersonSession]:
        """Forget every person (track ids are meaningless after a reconnect)."""
        sessions = self.flush()
        self._session = self._new_session()
        return sessions

    # --------------------------------------------------------------- per track
    def _open(self, person: PersonDetection, ts: float) -> _Track:
        track = _Track(
            track_id=person.track_id,
            track_key=f"{person.track_id}@{self._session}",
            first_seen=ts,
            last_seen=ts,
            box=person.box,
            window=deque(maxlen=NUM_FRAMES),
            judgements=deque(maxlen=self.params.smooth_window),
        )
        self.tracks[person.track_id] = track
        return track

    def _handover(self, person: PersonDetection, ts: float, in_view: set) -> Optional[_Track]:
        """The vanished person a new track id most likely is, re-keyed to it; or None.

        Candidates were last seen within ``handover_seconds`` and are not in
        view under their own id now, and their box height is within
        HANDOVER_HEIGHT_RATIO of the newcomer's. Of those, the one with the
        fullest window wins - it has the most to lose.
        """
        if self.params.handover_seconds <= 0 or person.height <= 0:
            return None
        candidates = [
            t
            for t in self.tracks.values()
            if t.track_id not in in_view
            and 0 < ts - t.last_seen <= self.params.handover_seconds
            and 1 / HANDOVER_HEIGHT_RATIO
            <= (t.box[3] - t.box[1]) / person.height
            <= HANDOVER_HEIGHT_RATIO
        ]
        if not candidates:
            return None
        track = max(candidates, key=lambda t: (len(t.window), t.last_seen))
        del self.tracks[track.track_id]
        track.track_id = person.track_id
        # A jump to a new place is not movement: no velocity across the gap.
        track.prev_kpts = None
        self.tracks[person.track_id] = track
        return track

    def _due(self, track: _Track, ts: float) -> bool:
        interval = 1.0 / self.params.sample_fps
        # A quarter-interval of slack absorbs scheduling jitter, so processing at
        # exactly sample_fps samples every frame instead of every other one.
        return track.last_sample_at is None or ts - track.last_sample_at >= interval * 0.75

    @staticmethod
    def _append(track: _Track, row: np.ndarray, real: bool) -> None:
        track.window.append(row)
        track.real.append(real)

    def _sample(self, track: _Track, person: PersonDetection, ts: float) -> bool:
        """Append a sample when one is due; True if it was."""
        if not self._due(track, ts):
            return False
        self._append(track, extract_features(person.keypoints_xyn, track.prev_kpts), real=True)
        track.prev_kpts = np.asarray(person.keypoints_xyn, dtype=np.float32).copy()
        track.last_sample_at = ts
        track.samples += 1
        return True

    def _sample_absent(self, track: _Track, ts: float) -> None:
        """The person is briefly lost: an empty row, as InsightEye's buffer got."""
        if not self._due(track, ts):
            return
        self._append(track, np.zeros((NUM_KEYPOINTS, NUM_FEATURES), dtype=np.float32), real=False)
        track.prev_kpts = None
        track.last_sample_at = ts

    @staticmethod
    def _window(track: _Track) -> np.ndarray:
        """(T, 17, 12): the person's rows, left-padded with empty ones."""
        rows = list(track.window)
        if len(rows) < NUM_FRAMES:
            pad = np.zeros((NUM_FRAMES - len(rows), NUM_KEYPOINTS, NUM_FEATURES), dtype=np.float32)
            return np.concatenate([pad, np.stack(rows)])
        return np.stack(rows)

    def _judge(self, track: _Track, prob: float, ts: float, out: DetectorUpdate) -> None:
        track.judgements.append(prob)
        smoothed = sum(track.judgements) / len(track.judgements)
        track.probability = smoothed
        track.peak = smoothed if track.peak is None else max(track.peak, smoothed)

        if smoothed < self.params.threshold:
            return
        if track.last_alert_at is not None and ts - track.last_alert_at < self.params.track_cooldown_seconds:
            return
        if (
            self._camera_last_alert is not None
            and ts - self._camera_last_alert < self.params.camera_cooldown_seconds
        ):
            return

        track.last_alert_at = ts
        track.alerts += 1
        self._camera_last_alert = ts
        out.alerts.append(
            ShopliftingAlert(
                track_id=track.track_id,
                # A person who keeps at it past the cooldown raises a second,
                # separate incident.
                track_key=track.track_key if track.alerts == 1 else f"{track.track_key}#{track.alerts}",
                probability=smoothed,
                peak=track.peak,
                box=track.box,
                started_at=track.first_seen,
                detected_at=ts,
            )
        )

    def _forced_alert(self, people: List[PersonDetection], ts: float) -> ShopliftingAlert:
        """Pinned to the most suspicious person in view, else to nobody.

        A test touches no cooldown and flags no session: it must not hold back,
        or count as, a real alert about the same person.
        """
        track = max(
            (self.tracks[p.track_id] for p in people if p.track_id in self.tracks),
            key=lambda t: t.probability or 0.0,
            default=None,
        )
        return ShopliftingAlert(
            track_id=track.track_id if track else -1,
            track_key=f"test@{_base36(int(ts * 1000))}",
            probability=0.99,
            peak=0.99,
            box=track.box if track else None,
            started_at=track.first_seen if track else ts,
            detected_at=ts,
            forced=True,
        )

    def _observe(self, track: _Track, ts: float, out: DetectorUpdate) -> None:
        if track.probability is None or track.misses:
            return
        if track.last_observed_at is not None and ts - track.last_observed_at < self.params.observation_interval_s:
            return
        track.last_observed_at = ts
        out.observations.append(Observation(track.track_id, track.probability, ts))

    def _close(self, track: _Track, out: DetectorUpdate) -> None:
        self.tracks.pop(track.track_id, None)
        if track.frames < MIN_SESSION_FRAMES:
            return
        out.sessions.append(
            PersonSession(
                track_key=track.track_key,
                track_id=track.track_id,
                started_at=track.first_seen,
                ended_at=track.last_seen,
                frames=track.frames,
                samples=track.samples,
                max_probability=track.peak,
                flagged=track.alerts > 0,
            )
        )

    # ------------------------------------------------------------------- view
    def _status(self, track: _Track, ts: float) -> str:
        if track.last_alert_at is not None and ts - track.last_alert_at < self.params.track_cooldown_seconds:
            return ALERT
        if track.probability is None:
            return BUFFERING
        if track.probability >= self.params.threshold / 2:
            return SUSPICIOUS
        return NORMAL

    def _build_snapshot(self, ts: float) -> List[Dict[str, Any]]:
        return [
            {
                "track_id": t.track_id,
                "status": self._status(t, ts),
                "box": [round(v, 1) for v in t.box],
                "probability": round(t.probability, 4) if t.probability is not None else None,
                "peak": round(t.peak, 4) if t.peak is not None else None,
                "window_fill": round(min(1.0, t.real_samples / self.params.min_window_samples), 3),
                "seconds_in_view": round(t.last_seen - t.first_seen, 1),
                "alerts": t.alerts,
                # Remembered but missed on the latest frame(s): the pose model
                # loses small, far-off people now and then.
                "in_view": not t.misses,
            }
            for t in self.tracks.values()
        ]

    def snapshot(self) -> List[Dict[str, Any]]:
        return self._snapshot
