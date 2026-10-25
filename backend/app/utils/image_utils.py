# app/utils/image_utils.py
"""Image processing utilities for frame conversion, cropping and annotation."""

import base64
import logging
from typing import Any, Optional, Sequence, Tuple

import cv2
import numpy as np

from app.core.config import config
from app.utils.geometry_utils import Box, clamp_box

logger = logging.getLogger(__name__)


def encode_jpeg(frame: np.ndarray, quality: Optional[int] = None) -> Optional[bytes]:
    """Encode a BGR frame as JPEG bytes."""
    if frame is None or frame.size == 0:
        return None
    success, buffer = cv2.imencode(
        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality or config.jpeg_quality]
    )
    if not success:
        logger.error("cv2.imencode failed during JPEG encoding.")
        return None
    return buffer.tobytes()


def decode_jpeg(data: bytes) -> Optional[np.ndarray]:
    """Decode JPEG/PNG bytes into a BGR frame."""
    if not data:
        return None
    try:
        nparr = np.frombuffer(data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error("Error decoding image bytes: %s", e, exc_info=True)
        return None


def frame_to_base64(frame: np.ndarray) -> str:
    """Converts an OpenCV frame (numpy array) to a base64 encoded string."""
    data = encode_jpeg(frame)
    return base64.b64encode(data).decode("utf-8") if data else ""


def base64_to_frame(base64_string: str) -> Optional[np.ndarray]:
    """Converts a base64 encoded string back to an OpenCV frame."""
    if not base64_string:
        return None
    try:
        return decode_jpeg(base64.b64decode(base64_string))
    except Exception as e:
        logger.error("Error decoding base64 string to frame: %s", e, exc_info=True)
        return None


def bytes_to_base64(data: Optional[bytes]) -> Optional[str]:
    """Postgres BYTEA -> base64 string for JSON responses."""
    if not data:
        return None
    return base64.b64encode(bytes(data)).decode("utf-8")


def crop_box(
    frame: np.ndarray, box: Box, padding: int = 8, context_ratio: float = 0.0
) -> Optional[np.ndarray]:
    """Crop a padded region of the frame; returns None when the crop is empty.

    ``context_ratio`` widens the pad to a fraction of the box's longer side:
    a tight 80 px crop gives an embedder little to work with, a little
    surrounding context gives it shape and scale.
    """
    if frame is None or frame.size == 0:
        return None

    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    if context_ratio > 0:
        padding = max(padding, int(round(max(x2 - x1, y2 - y1) * context_ratio)))
    padded = (x1 - padding, y1 - padding, x2 + padding, y2 + padding)
    x1, y1, x2, y2 = clamp_box(padded, width, height)

    crop = frame[int(y1) : int(y2), int(x1) : int(x2)]
    return crop if crop.size else None


# BGR colours
_COLOR_PERSON = (0, 200, 0)        # green - normal / buffering
_COLOR_SUSPICIOUS = (0, 215, 255)  # yellow - probability above half the threshold
_COLOR_ALERT = (0, 0, 255)         # red - raised an alert
_COLOR_ROI = (255, 200, 0)         # cyan-ish - region of interest
_COLOR_HEADER = (32, 32, 32)

# behavior_service live-view states -> box colour
_STATUS_COLORS = {
    "BUFFERING": (160, 160, 160),
    "NORMAL": _COLOR_PERSON,
    "SUSPICIOUS": _COLOR_SUSPICIOUS,
    "ALERT": _COLOR_ALERT,
}

# COCO-17 skeleton: pairs of keypoint indices joined by a bone.
SKELETON = (
    (5, 7), (7, 9), (6, 8), (8, 10),          # arms
    (5, 6), (5, 11), (6, 12), (11, 12),       # torso
    (11, 13), (13, 15), (12, 14), (14, 16),   # legs
    (0, 1), (0, 2), (1, 3), (2, 4),           # head
)
_MIN_KEYPOINT_CONF = 0.3


def draw_box(
    frame: np.ndarray,
    box: Box,
    label: str = "",
    color: Tuple[int, int, int] = _COLOR_PERSON,
    thickness: int = 2,
) -> np.ndarray:
    """Draw a labelled rectangle in place and return the frame."""
    x1, y1, x2, y2 = (int(v) for v in box)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)

    if label:
        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        top = max(0, y1 - th - baseline - 4)
        cv2.rectangle(frame, (x1, top), (x1 + tw + 6, top + th + baseline + 4), color, -1)
        cv2.putText(
            frame,
            label,
            (x1 + 3, top + th + 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255) if color != _COLOR_SUSPICIOUS else (0, 0, 0),
            1,
            cv2.LINE_AA,
        )
    return frame


def draw_skeleton(
    frame: np.ndarray,
    keypoints: Optional[np.ndarray],
    scores: Optional[np.ndarray] = None,
    color: Tuple[int, int, int] = _COLOR_PERSON,
) -> np.ndarray:
    """Bones and joints of one person, in pixel coordinates; low-confidence joints skipped."""
    if keypoints is None or len(keypoints) < 17:
        return frame

    def visible(i: int) -> bool:
        x, y = keypoints[i][0], keypoints[i][1]
        if x <= 0 and y <= 0:
            return False
        return scores is None or scores[i] >= _MIN_KEYPOINT_CONF

    for a, b in SKELETON:
        if visible(a) and visible(b):
            pa = (int(keypoints[a][0]), int(keypoints[a][1]))
            pb = (int(keypoints[b][0]), int(keypoints[b][1]))
            cv2.line(frame, pa, pb, color, 2, cv2.LINE_AA)
    for i in range(17):
        if visible(i):
            cv2.circle(frame, (int(keypoints[i][0]), int(keypoints[i][1])), 3, color, -1, cv2.LINE_AA)
    return frame


def draw_roi(frame: np.ndarray, polygon: Sequence[Sequence[float]]) -> np.ndarray:
    """Outline the configured region of interest."""
    if not polygon or len(polygon) < 3:
        return frame
    points = np.array([[int(p[0]), int(p[1])] for p in polygon], dtype=np.int32)
    cv2.polylines(frame, [points], isClosed=True, color=_COLOR_ROI, thickness=2)
    return frame


def _person_label(track: dict) -> str:
    probability = track.get("probability")
    if probability is None:
        return f"#{track.get('track_id')} {int(100 * track.get('window_fill', 0))}%"
    return f"#{track.get('track_id')} {probability:.0%}"


def _header(frame: np.ndarray, text: str) -> None:
    (_, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
    bar = th + baseline + 10
    cv2.rectangle(frame, (0, 0), (frame.shape[1], bar), _COLOR_HEADER, -1)
    cv2.putText(frame, text, (8, th + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)


def annotate_people(
    frame: np.ndarray,
    people: Sequence[Any],
    tracks: Sequence[dict],
    roi: Optional[Sequence[Sequence[float]]] = None,
    header: str = "",
) -> np.ndarray:
    """The live view: each person's skeleton and box, coloured by their state.

    ``people`` are this frame's ``PersonDetection``s, ``tracks`` the detector's
    ``snapshot()``. The label is the shoplifting probability, or how full the
    person's window is while it is still filling. Draws on a copy.
    """
    annotated = frame.copy()
    if roi:
        draw_roi(annotated, roi)

    by_id = {t["track_id"]: t for t in tracks}
    for person in people:
        track = by_id.get(person.track_id, {"track_id": person.track_id, "status": "BUFFERING"})
        status = track.get("status", "BUFFERING")
        color = _STATUS_COLORS.get(status, _COLOR_PERSON)
        draw_skeleton(annotated, person.keypoints_xy, person.keypoint_conf, color)
        draw_box(annotated, person.box, _person_label(track), color, thickness=3 if status == "ALERT" else 2)

    if header:
        _header(annotated, header)
    return annotated


def annotate_alert(frame: np.ndarray, box: Optional[Box], probability: float, label: str = "SHOPLIFTING") -> np.ndarray:
    """The frame stored with an incident: the person in a thick red box."""
    annotated = frame.copy()
    if box is not None:
        draw_box(annotated, box, f"{label} {probability:.0%}", _COLOR_ALERT, thickness=3)
    else:
        _header(annotated, f"{label} {probability:.0%}")
    return annotated


def placeholder_frame(message: str, width: int = 960, height: int = 540) -> np.ndarray:
    """A dark frame with a message, for live viewers before the first frame."""
    frame = np.full((height, width, 3), 24, dtype=np.uint8)
    (tw, th), _ = cv2.getTextSize(message, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
    cv2.putText(
        frame,
        message,
        ((width - tw) // 2, (height + th) // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (200, 200, 200),
        2,
        cv2.LINE_AA,
    )
    return frame
