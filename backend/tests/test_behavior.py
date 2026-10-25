"""The per-person shoplifting detector with synthetic people and a stub classifier.

The stub reads each window's last row: a person whose keypoints all sit at
x = p "scores" p, so a test decides who looks like a shoplifter by where it
puts them. No model, no camera.
"""

import numpy as np
import pytest

from app.services.behavior_service import (
    ALERT,
    BUFFERING,
    NORMAL,
    SUSPICIOUS,
    DetectorParams,
    ShopliftingDetector,
)
from app.services.pose_tracker import PersonDetection
from app.services.shoplifting_model import NUM_FEATURES, NUM_FRAMES, NUM_KEYPOINTS

STEP = 1 / 3  # one sample per update at the default 3 fps


def person(track_id, p=0.1, height=200.0, top=10.0):
    return PersonDetection(
        track_id=track_id,
        confidence=0.9,
        box=(10.0, top, 60.0, top + height),
        keypoints_xyn=np.full((NUM_KEYPOINTS, 2), p, dtype=np.float32),
    )


class Stub:
    """Classifier stand-in that also records what it was given."""

    def __init__(self):
        self.batches = []

    def __call__(self, windows):
        self.batches.append(windows.copy())
        return windows[:, -1, 0, 0]


def make(**overrides):
    params = DetectorParams(
        sample_fps=3.0,
        threshold=0.5,
        smooth_window=3,
        min_person_height_px=60.0,
        track_cooldown_seconds=300.0,
        camera_cooldown_seconds=0.0,
        track_max_misses=15,
        handover_seconds=5.0,
        min_window_samples=30,
        observation_interval_s=5.0,
    )
    for key, value in overrides.items():
        setattr(params, key, value)
    stub = Stub()
    return ShopliftingDetector(classify=stub, params=params), stub


def run(detector, frames, start=0.0, step=STEP):
    """Feed ``frames`` (a list of people lists); returns every update."""
    return [detector.update(people, start + i * step) for i, people in enumerate(frames)]


def snap(detector, track_id):
    return next(t for t in detector.snapshot() if t["track_id"] == track_id)


# ---------------------------------------------------------------- windows
def test_nobody_is_judged_until_their_window_has_enough_of_them():
    detector, stub = make()
    run(detector, [[person(1)]] * 29)
    assert stub.batches == []
    assert snap(detector, 1)["status"] == BUFFERING
    assert snap(detector, 1)["window_fill"] == pytest.approx(29 / 30, abs=1e-3)

    run(detector, [[person(1)]], start=29 * STEP)
    assert len(stub.batches) == 1
    assert snap(detector, 1)["status"] == NORMAL


def test_a_short_window_is_left_padded_with_empty_rows():
    detector, stub = make()
    run(detector, [[person(1, p=0.2)]] * 30)
    window = stub.batches[-1][0]
    assert window.shape == (NUM_FRAMES, NUM_KEYPOINTS, NUM_FEATURES)
    assert not window[: NUM_FRAMES - 30].any()       # InsightEye's "nobody here" rows
    assert (window[NUM_FRAMES - 30 :, :, 0] == pytest.approx(0.2))


def test_the_window_slides_once_full():
    detector, stub = make()
    run(detector, [[person(1)]] * (NUM_FRAMES + 10))
    assert len(detector.tracks[1].window) == NUM_FRAMES
    assert stub.batches[-1].shape[1] == NUM_FRAMES
    assert stub.batches[-1][0].any(axis=(1, 2)).all()  # no padding left


def test_samples_follow_sample_fps_not_the_frame_rate():
    detector, _ = make()
    run(detector, [[person(1)]] * 60, step=1 / 6)     # 6 fps in, 3 fps sampled
    assert detector.tracks[1].samples == 30
    assert detector.tracks[1].frames == 60


def test_a_briefly_lost_person_gets_empty_rows_and_no_velocity_jump():
    detector, _ = make()
    run(detector, [[person(1, p=0.3)]] * 5 + [[]] * 3)
    track = detector.tracks[1]
    assert [bool(row.any()) for row in track.window] == [True] * 5 + [False] * 3
    assert track.real_samples == 5
    assert track.prev_kpts is None
    # Still listed in the live view, marked as out of sight.
    assert snap(detector, 1)["in_view"] is False


def test_people_too_small_to_read_are_tracked_but_not_sampled():
    detector, stub = make()
    run(detector, [[person(1, height=40)]] * 40)
    assert detector.tracks[1].samples == 0
    assert stub.batches == []


# ------------------------------------------------------------------ alerts
def test_smoothed_probability_raises_one_alert_per_person():
    detector, _ = make()
    updates = run(detector, [[person(1, p=0.05)]] * 30)
    assert not any(u.alerts for u in updates)

    updates = run(detector, [[person(1, p=0.9)]] * 10, start=30 * STEP)
    alerts = [a for u in updates for a in u.alerts]
    assert len(alerts) == 1
    # Smoothing: (0.05 + 0.9) / 2 stays under 0.5; (0.05 + 0.9 + 0.9) / 3 does not.
    assert alerts[0].probability == pytest.approx((0.05 + 0.9 + 0.9) / 3, abs=1e-6)
    assert alerts[0].track_key == detector.tracks[1].track_key
    assert snap(detector, 1)["status"] == ALERT


def test_alert_again_after_the_cooldown_with_a_new_key():
    detector, _ = make(track_cooldown_seconds=10.0)
    updates = run(detector, [[person(1, p=0.9)]] * 70)
    alerts = [a for u in updates for a in u.alerts]
    assert len(alerts) == 2
    assert alerts[1].track_key == f"{alerts[0].track_key}#2"
    assert alerts[1].detected_at - alerts[0].detected_at >= 10.0


def test_only_the_person_behaving_suspiciously_alerts():
    detector, stub = make()
    updates = run(detector, [[person(1, p=0.05), person(2, p=0.95)]] * 32)
    alerts = [a for u in updates for a in u.alerts]
    assert [a.track_id for a in alerts] == [2]
    # Both people go through the same forward pass.
    assert max(len(batch) for batch in stub.batches) == 2


def test_camera_cooldown_holds_back_a_second_person():
    detector, _ = make(camera_cooldown_seconds=60.0)
    updates = run(detector, [[person(1, p=0.95), person(2, p=0.95)]] * 32)
    assert len([a for u in updates for a in u.alerts]) == 1


def test_suspicious_is_above_half_the_threshold():
    detector, _ = make()
    run(detector, [[person(1, p=0.3)]] * 32)
    assert snap(detector, 1)["status"] == SUSPICIOUS


def test_forced_alert_lands_on_the_person_in_view():
    detector, _ = make()
    run(detector, [[person(4)]] * 3)
    detector.force_alert()
    (update,) = run(detector, [[person(4)]], start=3 * STEP)
    (alert,) = update.alerts
    assert alert.forced and alert.track_id == 4 and alert.box == person(4).box
    assert alert.track_key.startswith("test@")
    assert detector.tracks[4].last_alert_at is None and detector.tracks[4].alerts == 0

    detector.force_alert()
    (update,) = run(detector, [[]], start=4 * STEP)
    assert update.alerts[0].track_id == -1 and update.alerts[0].box is None


# ---------------------------------------------------------------- handover
def test_a_new_id_moments_after_someone_vanished_continues_their_window():
    detector, _ = make()
    run(detector, [[person(1, p=0.4)]] * 20 + [[]] * 3)
    key = detector.tracks[1].track_key
    run(detector, [[person(9, p=0.4)]] * 12, start=23 * STEP)
    assert 1 not in detector.tracks
    track = detector.tracks[9]
    assert track.track_key == key
    assert track.real_samples == 32 and snap(detector, 9)["status"] != BUFFERING


def test_no_handover_to_someone_of_a_different_size_or_long_gone():
    detector, _ = make()
    run(detector, [[person(1)]] * 10 + [[]] * 2)
    run(detector, [[person(2, height=400)]], start=12 * STEP)
    assert detector.tracks[2].track_key != detector.tracks[1].track_key

    detector, _ = make(handover_seconds=1.0)
    run(detector, [[person(1)]] * 10 + [[]] * 6)
    run(detector, [[person(2)]], start=16 * STEP)
    assert detector.tracks[2].track_key != detector.tracks[1].track_key


def test_no_handover_from_someone_still_in_view():
    detector, _ = make()
    run(detector, [[person(1)]] * 10)
    run(detector, [[person(1), person(2)]], start=10 * STEP)
    assert detector.tracks[2].track_key != detector.tracks[1].track_key


# ---------------------------------------------------------------- sessions
def test_a_session_ends_after_max_misses_and_records_the_visit():
    detector, _ = make(track_max_misses=3)
    updates = run(detector, [[person(1, p=0.9)]] * 32 + [[]] * 4)
    sessions = [s for u in updates for s in u.sessions]
    assert len(sessions) == 1
    session = sessions[0]
    assert session.frames == 32 and session.samples == 32 and session.flagged
    assert session.ended_at - session.started_at == pytest.approx(31 * STEP)
    assert session.max_probability == pytest.approx(0.9, abs=1e-6)
    assert 1 not in detector.tracks


def test_flicker_is_not_a_session():
    detector, _ = make(track_max_misses=1)
    updates = run(detector, [[person(1)]] * 2 + [[]] * 3)
    assert not [s for u in updates for s in u.sessions]


def test_flush_and_reset_end_open_sessions():
    detector, _ = make()
    run(detector, [[person(1)], [person(1)], [person(1)]])
    old = detector.tracks[1].track_key
    sessions = detector.reset()
    assert [s.track_key for s in sessions] == [old]
    assert detector.tracks == {} and detector.snapshot() == []
    run(detector, [[person(1)]], start=10)
    assert detector.tracks[1].track_key != old   # ids restart; keys do not repeat


# ------------------------------------------------------------ observations
def test_one_observation_per_person_per_interval_once_judged():
    detector, _ = make()
    updates = run(detector, [[person(1, p=0.2)]] * 60)   # 20 s
    observations = [o for u in updates for o in u.observations]
    assert observations and all(o.track_id == 1 for o in observations)
    times = [o.observed_at for o in observations]
    assert all(b - a >= 5.0 - 1e-9 for a, b in zip(times, times[1:]))
    assert times[0] >= 29 * STEP                      # nothing before the first judgement


# ------------------------------------------------------------------ params
def test_camera_settings_override_the_defaults_and_bad_values_are_ignored():
    params = DetectorParams.from_settings(
        {"threshold": "0.7", "sample_fps": 0, "smooth_window": "x", "unknown": 1, "track_max_misses": True}
    )
    assert params.threshold == 0.7
    assert params.sample_fps == 0.1          # clamped, never a division by zero
    assert params.smooth_window >= 1
    assert params.track_max_misses == DetectorParams.from_settings().track_max_misses
