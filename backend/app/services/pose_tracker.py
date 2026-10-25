# app/services/pose_tracker.py
"""People, their keypoints and a stable id per person, from one frame.

Wraps the YOLO pose model and ByteTrack into plain ``PersonDetection`` records,
so the shoplifting detector can be exercised with synthetic keypoints and no
model at all. Detection and tracking are separate steps, as in lost-found's
tracker: ``reset()`` then clears the tracker alone after a reconnect, without
reaching into ultralytics' predictor state.
"""

import logging
from dataclasses import dataclass
from typing import Any, List, Optional

import numpy as np

from app.core.config import config
from app.services.model_registry import model_registry
from app.utils.geometry_utils import Box

logger = logging.getLogger(__name__)

PERSON_CLASS_ID = 0


@dataclass
class PersonDetection:
    track_id: int
    confidence: float
    box: Box
    # (17, 2) keypoints normalised to the frame (YOLO's ``xyn``), the
    # classifier's input; and the same in pixels with their scores, for drawing.
    keypoints_xyn: np.ndarray
    keypoints_xy: Optional[np.ndarray] = None
    keypoint_conf: Optional[np.ndarray] = None

    @property
    def height(self) -> float:
        return self.box[3] - self.box[1]


class PoseTracker:
    """Per-camera pose model + ByteTrack. Not thread-safe by design: one per worker."""

    def __init__(self, model: Optional[Any] = None) -> None:
        self.model = model if model is not None else model_registry.create_yolo()
        self._tracker = self._new_tracker()

    @staticmethod
    def _new_tracker() -> Any:
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import YAML, IterableSimpleNamespace
        from ultralytics.utils.checks import check_yaml

        cfg = IterableSimpleNamespace(**YAML.load(check_yaml(config.pose_tracker)))
        return BYTETracker(args=cfg)

    def track(self, frame: np.ndarray) -> List[PersonDetection]:
        """Detect and track every person in the frame."""
        if frame is None or frame.size == 0:
            return []

        device = model_registry.device
        results = self.model.predict(
            frame,
            classes=[PERSON_CLASS_ID],
            conf=config.pose_confidence,
            imgsz=config.pose_input_size,
            quantize=16 if config.pose_half and device.startswith("cuda") else None,
            device=device,
            verbose=False,
        )
        if not results:
            return []

        result = results[0]
        try:
            boxes = result.boxes.cpu().numpy()
            tracks = self._tracker.update(boxes, frame)
            if result.keypoints is None or len(tracks) == 0:
                return []
            xyn = result.keypoints.xyn.cpu().numpy()
            xy = result.keypoints.xy.cpu().numpy()
            kconf = result.keypoints.conf.cpu().numpy() if result.keypoints.conf is not None else None
        except Exception as e:
            logger.error("Failed to track people: %s", e, exc_info=True)
            return []

        people: List[PersonDetection] = []
        for row in tracks:
            # BYTETracker rows: x1, y1, x2, y2, track_id, score, cls, det_index
            idx = int(row[-1])
            if idx >= len(xyn):
                continue
            people.append(
                PersonDetection(
                    track_id=int(row[4]),
                    confidence=float(row[5]),
                    box=(float(row[0]), float(row[1]), float(row[2]), float(row[3])),
                    keypoints_xyn=xyn[idx],
                    keypoints_xy=xy[idx],
                    keypoint_conf=kconf[idx] if kconf is not None else None,
                )
            )
        return people

    def reset(self) -> None:
        """Drop tracker state, e.g. after a stream reconnect where ids are meaningless."""
        self._tracker.reset()
