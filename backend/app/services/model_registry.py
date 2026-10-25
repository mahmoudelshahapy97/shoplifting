# app/services/model_registry.py
"""Thread-safe loading of the pose model and classifier, and the model device.

Each camera worker gets its own instances: YOLO keeps per-call state and is not
safe to share across threads, and the classifier is small (2 MB), so one per
worker costs little and needs no lock around inference.
"""

import logging
import os
import threading
from typing import Any, Optional

from app.core.config import config

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self) -> None:
        self._yolo_lock = threading.Lock()
        self._device: Optional[str] = None

    # ------------------------------------------------------------------ device
    @property
    def device(self) -> str:
        """Resolve the configured device once, falling back to CPU when CUDA is absent."""
        if self._device is not None:
            return self._device

        requested = (config.model_device or "cpu").lower()
        if requested.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning("MODEL_DEVICE=%s but CUDA is unavailable; using cpu.", requested)
                    requested = "cpu"
            except Exception as e:
                logger.warning("Could not probe CUDA (%s); using cpu.", e)
                requested = "cpu"

        self._device = requested
        return self._device

    # -------------------------------------------------------------------- yolo
    def create_yolo(self, weights: Optional[str] = None) -> Any:
        """Build a fresh YOLO instance (the pose model by default). One per camera worker."""
        from ultralytics import YOLO

        weights = weights or config.pose_model_path

        with self._yolo_lock:  # serialise the first download across workers
            # Fetch a missing pretrained checkpoint to the configured path, so it
            # lands in the mounted models/ dir instead of the working directory.
            if not os.path.exists(weights):
                from ultralytics.utils.downloads import attempt_download_asset

                logger.info("Weights %s not present; downloading.", weights)
                os.makedirs(os.path.dirname(weights) or ".", exist_ok=True)
                weights = str(attempt_download_asset(weights))
            model = YOLO(weights)

        logger.info("YOLO loaded (%s) on %s", weights, self.device)
        return model

    # -------------------------------------------------------------- classifier
    def create_classifier(self) -> Any:
        """The shoplifting classifier on the model device. One per camera worker."""
        from app.services.shoplifting_model import load_classifier

        return load_classifier(config.classifier_model_path, self.device)


model_registry = ModelRegistry()
