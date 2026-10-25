"""Geometry, cropping, annotation and clip-range tests."""

import numpy as np
import pytest

from app.utils.geometry_utils import (
    box_gap,
    box_in_polygon,
    centroid,
    centroid_distance,
    clamp_box,
    iou,
    point_in_polygon,
)
from app.services.pose_tracker import PersonDetection
from app.utils.image_utils import annotate_alert, annotate_people, crop_box


# ------------------------------------------------------------------- geometry
def test_centroid():
    assert centroid((0.0, 0.0, 10.0, 20.0)) == (5.0, 10.0)


def test_iou_identical_boxes_is_one():
    box = (0.0, 0.0, 10.0, 10.0)
    assert iou(box, box) == pytest.approx(1.0)


def test_iou_disjoint_boxes_is_zero():
    assert iou((0.0, 0.0, 10.0, 10.0), (50.0, 50.0, 60.0, 60.0)) == 0.0


def test_iou_half_overlap():
    assert iou((0.0, 0.0, 10.0, 10.0), (5.0, 0.0, 15.0, 10.0)) == pytest.approx(1 / 3)


def test_box_gap_is_zero_when_boxes_overlap():
    assert box_gap((0.0, 0.0, 10.0, 10.0), (5.0, 5.0, 15.0, 15.0)) == 0.0


def test_box_gap_measures_edge_distance():
    # A tall person next to a small bag: edges are 10 px apart even though the
    # centroids are much further, which is why owner association uses the gap.
    assert box_gap((0.0, 0.0, 10.0, 10.0), (20.0, 0.0, 30.0, 100.0)) == pytest.approx(10.0)
    assert centroid_distance((0.0, 0.0, 10.0, 10.0), (20.0, 0.0, 30.0, 100.0)) > 45.0


def test_point_in_polygon():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert point_in_polygon((5.0, 5.0), square)
    assert not point_in_polygon((15.0, 5.0), square)


def test_degenerate_polygon_accepts_everything():
    assert point_in_polygon((999.0, 999.0), [])
    assert point_in_polygon((999.0, 999.0), [(0.0, 0.0), (1.0, 1.0)])


def test_box_in_polygon_uses_the_centroid():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert box_in_polygon((4.0, 4.0, 6.0, 6.0), square)
    assert not box_in_polygon((40.0, 40.0, 60.0, 60.0), square)


def test_clamp_box_keeps_crops_inside_the_frame():
    clamped = clamp_box((-20.0, -30.0, 900.0, 900.0), 640, 480)
    x1, y1, x2, y2 = clamped
    assert (x1, y1) == (0.0, 0.0)
    assert x2 <= 640 and y2 <= 480


def test_clamp_box_never_returns_an_empty_box():
    x1, y1, x2, y2 = clamp_box((100.0, 100.0, 100.0, 100.0), 640, 480)
    assert x2 > x1 and y2 > y1


# -------------------------------------------------------------------- crops
def test_crop_context_ratio_widens_the_crop():
    frame = np.zeros((400, 400, 3), dtype=np.uint8)
    tight = crop_box(frame, (100.0, 100.0, 200.0, 180.0))
    wide = crop_box(frame, (100.0, 100.0, 200.0, 180.0), context_ratio=0.15)
    assert tight.shape[:2] == (96, 116)   # 8 px each side
    assert wide.shape[:2] == (110, 130)   # 15 px (0.15 x 100) each side


# ----------------------------------------------------------------- annotation
def _person(track_id=1):
    xy = np.array([[100 + 3 * i, 50 + 12 * i] for i in range(17)], dtype=np.float32)
    return PersonDetection(
        track_id=track_id,
        confidence=0.9,
        box=(90.0, 40.0, 180.0, 260.0),
        keypoints_xyn=xy / 320.0,
        keypoints_xy=xy,
        keypoint_conf=np.full(17, 0.9, dtype=np.float32),
    )


def test_annotate_people_colours_by_state_and_leaves_the_frame_alone():
    frame = np.zeros((320, 320, 3), dtype=np.uint8)
    normal = annotate_people(frame, [_person()], [{"track_id": 1, "status": "NORMAL", "probability": 0.1}])
    alert = annotate_people(frame, [_person()], [{"track_id": 1, "status": "ALERT", "probability": 0.9}])
    assert not frame.any()                              # drawn on a copy
    green, red = normal[..., 1].sum(), alert[..., 2].sum()
    assert green > normal[..., 2].sum()                 # normal is drawn in green
    assert red > alert[..., 1].sum()                    # an alert in red


def test_annotate_people_without_a_snapshot_row_still_draws_them():
    frame = np.zeros((320, 320, 3), dtype=np.uint8)
    assert annotate_people(frame, [_person(5)], [], header="cam").any()


def test_annotate_alert_without_a_box_writes_a_banner():
    frame = np.zeros((120, 320, 3), dtype=np.uint8)
    out = annotate_alert(frame, None, 0.99, "TEST ALERT")
    assert out[:30].any() and not out[60:].any()


# ------------------------------------------------------------ clip range header
@pytest.mark.parametrize(
    "header, expected",
    [
        (None, None),
        ("bytes=0-", (0, 999)),
        ("bytes=100-199", (100, 199)),
        ("bytes=900-5000", (900, 999)),  # end clamped to the file
        ("bytes=-100", (900, 999)),  # suffix: last 100 bytes
        ("bytes=0-1,5-9", None),  # multi-range: send the whole file
    ],
)
def test_clip_range_parsing(header, expected):
    from app.api.routes.event_router import parse_range

    assert parse_range(header, 1000) == expected


@pytest.mark.parametrize("header", ["bytes=1000-", "bytes=500-100", "bytes=-0"])
def test_unsatisfiable_clip_range(header):
    from app.api.routes.event_router import parse_range

    with pytest.raises(ValueError):
        parse_range(header, 1000)
