# app/utils/geometry_utils.py
"""Pure-geometry helpers for boxes and regions of interest.

Boxes are ``(x1, y1, x2, y2)`` in pixel coordinates. Nothing here touches
OpenCV or torch, which keeps the detector unit-testable without a camera.
"""

import math
from typing import Sequence, Tuple

Box = Tuple[float, float, float, float]
Point = Tuple[float, float]


def centroid(box: Box) -> Point:
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def box_area(box: Box) -> float:
    x1, y1, x2, y2 = box
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def overlap_of_smaller(a: Box, b: Box) -> float:
    """Intersection over the smaller box's area: 1 when one box lies inside the other.

    IoU misses a partial view of the same object - a bag half hidden behind a
    passer-by gets a box well inside its usual one, with a low IoU.
    """
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = min(ax2, bx2) - max(ax1, bx1)
    inter_h = min(ay2, by2) - max(ay1, by1)
    if inter_w <= 0 or inter_h <= 0:
        return 0.0
    smaller = min(box_area(a), box_area(b))
    return (inter_w * inter_h) / smaller if smaller > 0 else 0.0


def iou(a: Box, b: Box) -> float:
    """Intersection over union of two boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    inter_w = min(ax2, bx2) - max(ax1, bx1)
    inter_h = min(ay2, by2) - max(ay1, by1)
    if inter_w <= 0 or inter_h <= 0:
        return 0.0

    intersection = inter_w * inter_h
    union = box_area(a) + box_area(b) - intersection
    return intersection / union if union > 0 else 0.0


def euclidean(p: Point, q: Point) -> float:
    return math.hypot(p[0] - q[0], p[1] - q[1])


def centroid_distance(a: Box, b: Box) -> float:
    """Distance between the centres of two boxes."""
    return euclidean(centroid(a), centroid(b))


def box_gap(a: Box, b: Box) -> float:
    """Shortest distance between two box edges; 0 when they overlap.

    Better than centroid distance for owner association: a person standing
    right next to a large suitcase has a big centroid distance but zero gap.
    """
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    dx = max(bx1 - ax2, ax1 - bx2, 0.0)
    dy = max(by1 - ay2, ay1 - by2, 0.0)
    return math.hypot(dx, dy)


def point_in_polygon(point: Point, polygon: Sequence[Point]) -> bool:
    """Ray-casting point-in-polygon test. Empty/degenerate polygon accepts everything."""
    if not polygon or len(polygon) < 3:
        return True

    x, y = point
    inside = False
    n = len(polygon)

    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_at_y = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < x_at_y:
                inside = not inside

    return inside


def box_in_polygon(box: Box, polygon: Sequence[Point]) -> bool:
    """A box counts as inside the ROI when its centroid is."""
    return point_in_polygon(centroid(box), polygon)


def clamp_box(box: Box, width: int, height: int) -> Box:
    """Clip a box to the frame so crops never index out of bounds."""
    x1, y1, x2, y2 = box
    x1 = max(0.0, min(float(width - 1), x1))
    y1 = max(0.0, min(float(height - 1), y1))
    x2 = max(0.0, min(float(width), x2))
    y2 = max(0.0, min(float(height), y2))
    if x2 <= x1:
        x2 = min(float(width), x1 + 1.0)
    if y2 <= y1:
        y2 = min(float(height), y1 + 1.0)
    return (x1, y1, x2, y2)
