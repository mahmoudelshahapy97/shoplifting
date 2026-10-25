# app/services/shoplifting_model.py
"""The shoplifting classifier and the per-frame pose features it reads.

Ported unchanged from InsightEye (app/services/shoplifting_inference.py): the
network must match the one ``models/shoplifting.pt`` was trained as, and the
features must be computed the same way or the weights mean nothing. What
changed is the unit of work: InsightEye kept one window per camera and fed it
whichever person YOLO listed first; here every tracked person has their own
window (see behavior_service), so ``extract_features`` takes one person's
keypoints rather than a frame.
"""

import logging
import os
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

logger = logging.getLogger(__name__)

# Fixed by training.
NUM_FRAMES = 120       # T: samples per window
NUM_KEYPOINTS = 17     # V: COCO keypoints
NUM_FEATURES = 12      # C: features per keypoint (7 used, zero-padded)
CLASS_NAMES = ("Normal", "Shoplifting")

# COCO keypoint indices used by the hand features.
_L_WRIST, _R_WRIST, _L_HIP, _R_HIP = 9, 10, 11, 12


class ShopliftingClassifier(nn.Module):
    """Conv1d over time -> BiGRU -> self-attention -> mean pool -> 2 logits."""

    def __init__(self, T: int = NUM_FRAMES, V: int = NUM_KEYPOINTS, C: int = NUM_FEATURES,
                 num_classes: int = len(CLASS_NAMES)):
        super().__init__()
        self.T = T
        self.V = V
        self.C = C

        self.conv1 = nn.Conv1d(V * C, 128, kernel_size=3, padding=2)
        self.bn1 = nn.BatchNorm1d(128)
        self.gru = nn.GRU(128, 128, batch_first=True, bidirectional=True)
        self.attention = nn.MultiheadAttention(embed_dim=256, num_heads=4, batch_first=True)
        self.layernorm = nn.LayerNorm(256)
        self.fc1 = nn.Linear(256, 128)
        self.dropout = nn.Dropout(0.3)
        self.fc2 = nn.Linear(128, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B = x.size(0)
        T, V, C = self.T, self.V, self.C

        x = x.view(B, T, V * C).transpose(1, 2)   # (B, V*C, T)
        x = F.pad(x, (2, 0))
        x = F.relu(self.conv1(x))
        x = self.bn1(x)
        x = x.transpose(1, 2)                      # (B, T, 128)
        x, _ = self.gru(x)                         # (B, T, 256)
        attn_out, _ = self.attention(x, x, x)
        x = self.layernorm(x + attn_out)
        x = x.mean(dim=1)
        x = F.relu(self.fc1(x))
        x = self.dropout(x)
        return self.fc2(x)


def load_classifier(path: str, device: str = "cpu") -> ShopliftingClassifier:
    """The trained network, in eval mode on ``device``.

    Unlike InsightEye, missing or unreadable weights are an error: an
    uninitialised network outputs noise, and noise above the threshold is a
    false alarm on every camera.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(f"Shoplifting classifier weights not found at {path}")
    model = ShopliftingClassifier()
    state = torch.load(path, map_location=device)
    if isinstance(state, dict) and "model_state_dict" in state:
        state = state["model_state_dict"]
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    logger.info("Shoplifting classifier loaded from %s on %s", path, device)
    return model


def extract_features(kpts: np.ndarray, prev_kpts: Optional[np.ndarray]) -> np.ndarray:
    """(17, 12) features for one person from normalised (17, 2) keypoints.

    Columns: x, y, velocity since the previous sample (dx, dy), then the
    left-wrist->mid-hip, right-wrist->mid-hip and wrist->wrist distances
    repeated on every row, zero-padded to 12 - InsightEye's layout exactly.
    """
    kpts = np.asarray(kpts, dtype=np.float32)
    vel = kpts - prev_kpts if prev_kpts is not None else np.zeros_like(kpts)

    l_hand = kpts[_L_WRIST]
    r_hand = kpts[_R_WRIST]
    mid_hip = (kpts[_L_HIP] + kpts[_R_HIP]) / 2.0

    dist_l = np.linalg.norm(l_hand - mid_hip)
    dist_r = np.linalg.norm(r_hand - mid_hip)
    dist_hh = np.linalg.norm(l_hand - r_hand)
    scalars = np.tile([dist_l, dist_r, dist_hh], (NUM_KEYPOINTS, 1))

    feat = np.concatenate([kpts, vel, scalars], axis=1)                  # (17, 7)
    pad = np.zeros((NUM_KEYPOINTS, NUM_FEATURES - feat.shape[1]), dtype=np.float32)
    return np.concatenate([feat, pad], axis=1).astype(np.float32)       # (17, 12)


def normalise(seq: np.ndarray) -> np.ndarray:
    """Z-score over the whole window, as in training."""
    return (seq - seq.mean()) / (seq.std() + 1e-7)


@torch.no_grad()
def predict(model: ShopliftingClassifier, windows: np.ndarray, device: str = "cpu") -> np.ndarray:
    """Shoplifting-class probability for each (T, 17, 12) window in ``windows``.

    One batched forward pass for every full window on a camera.
    """
    if len(windows) == 0:
        return np.zeros(0, dtype=np.float32)
    batch = np.stack([normalise(w) for w in windows]).astype(np.float32)
    x = torch.from_numpy(batch).to(device)
    probs = F.softmax(model(x), dim=1)[:, 1]
    return probs.float().cpu().numpy()
