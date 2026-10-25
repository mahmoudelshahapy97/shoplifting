"""The classifier and its features are InsightEye's, unchanged.

The golden numbers below were produced by InsightEye's own
app/services/shoplifting_inference.py (StreamAwareInferenceEngine and
FrameFeatureExtractor) on the same inputs, so a drift in the architecture, the
weights, the normalisation or the feature layout fails here. Needs the real
weights in models/ (they are in the repo); skipped without them.
"""

import os

import numpy as np
import pytest
import torch

from app.core.config import config
from app.services.shoplifting_model import (
    NUM_FEATURES,
    NUM_FRAMES,
    NUM_KEYPOINTS,
    extract_features,
    load_classifier,
    normalise,
    predict,
)

pytestmark = pytest.mark.skipif(
    not os.path.exists(config.classifier_model_path),
    reason=f"classifier weights not found at {config.classifier_model_path}",
)


@pytest.fixture(scope="module")
def classifier():
    return load_classifier(config.classifier_model_path, "cpu")


def _golden_window() -> np.ndarray:
    return np.random.default_rng(0).random((NUM_FRAMES, NUM_KEYPOINTS, NUM_FEATURES), dtype=np.float32)


def test_logits_match_insighteye(classifier):
    x = torch.from_numpy(normalise(_golden_window())).unsqueeze(0)
    with torch.no_grad():
        logits = classifier(x)[0].numpy()
    assert logits == pytest.approx([3.48487, -4.60355], abs=1e-3)


def test_probability_matches_insighteye(classifier):
    (probability,) = predict(classifier, _golden_window()[None])
    assert probability == pytest.approx(0.0003069791418965906, rel=1e-3)


def test_a_batch_scores_each_window_as_if_alone(classifier):
    rng = np.random.default_rng(7)
    windows = rng.random((4, NUM_FRAMES, NUM_KEYPOINTS, NUM_FEATURES), dtype=np.float32)
    together = predict(classifier, windows)
    alone = np.concatenate([predict(classifier, w[None]) for w in windows])
    assert together == pytest.approx(alone, abs=1e-6)
    assert ((together >= 0) & (together <= 1)).all()


def test_no_windows_no_forward_pass(classifier):
    assert predict(classifier, np.zeros((0, NUM_FRAMES, NUM_KEYPOINTS, NUM_FEATURES))).shape == (0,)


def test_missing_weights_are_an_error_not_noise(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_classifier(str(tmp_path / "missing.pt"))


# ------------------------------------------------------------------ features
def test_features_match_insighteye():
    kpts = np.linspace(0.1, 0.9, 34, dtype=np.float32).reshape(17, 2)
    feat = extract_features(kpts, kpts - 0.01)
    assert feat.shape == (NUM_KEYPOINTS, NUM_FEATURES) and feat.dtype == np.float32
    # FrameFeatureExtractor.extract() on the same keypoints.
    assert float(feat.sum()) == pytest.approx(23.168270111083984, abs=1e-4)
    assert float(feat[0, 4]) == pytest.approx(0.17141978442668915, abs=1e-6)
    assert float(feat[3, 6]) == pytest.approx(0.0685679018497467, abs=1e-6)


def test_feature_layout():
    kpts = np.zeros((17, 2), dtype=np.float32)
    kpts[9] = (0.2, 0.5)     # left wrist
    kpts[10] = (0.8, 0.5)    # right wrist
    kpts[11] = (0.4, 0.5)    # hips
    kpts[12] = (0.6, 0.5)
    feat = extract_features(kpts, None)
    assert (feat[:, :2] == kpts).all()               # x, y
    assert not feat[:, 2:4].any()                     # no velocity without a previous sample
    assert feat[0, 4:7] == pytest.approx([0.3, 0.3, 0.6])  # wrist->hip x2, wrist->wrist
    assert (feat[:, 4:7] == feat[0, 4:7]).all()      # repeated on every row
    assert not feat[:, 7:].any()                      # zero padding to 12


def test_normalise_is_a_window_wide_z_score():
    window = _golden_window()
    out = normalise(window)
    assert float(out.mean()) == pytest.approx(0.0, abs=1e-5)
    assert float(out.std()) == pytest.approx(1.0, abs=1e-4)
