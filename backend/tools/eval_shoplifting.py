"""Run a video through the shoplifting pipeline offline and report what it sees.

The same code the camera workers run - PoseTracker, ShopliftingDetector and the
classifier - fed from a file instead of RTSP, at one or more sample rates. Use
it before changing SAMPLE_FPS or SHOPLIFTING_THRESHOLD: the classifier was
trained on windows of a fixed length in samples, so the rate decides how many
seconds of behaviour a window holds, and it separates shoplifting from normal
shopping well only near the rate it was trained at (3 fps, InsightEye's).

    docker compose run --rm --no-deps -v ./backend/videos:/videos:ro api \\
        python tools/eval_shoplifting.py /videos/shop_lifter_0.mp4 --fps 2 3 5

Short clips are looped (--loops) so a 120-sample window can fill: at 3 fps it
spans 40 s. Prints, per sample rate, each person's peak probability and how many
of their judged windows were at or above the threshold, and the alerts the
detector would have raised.
"""

import argparse
import sys
from typing import Dict, List

import cv2
import numpy as np

from app.core.config import config
from app.services.behavior_service import DetectorParams, ShopliftingDetector
from app.services.model_registry import model_registry
from app.services.pose_tracker import PoseTracker
from app.services.shoplifting_model import predict


def evaluate(path: str, sample_fps: float, loops: int, threshold: float) -> Dict[str, object]:
    capture = cv2.VideoCapture(path)
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    capture.release()

    tracker = PoseTracker()
    classifier = model_registry.create_classifier()
    device = model_registry.device
    judged: Dict[int, List[float]] = {}

    def classify(windows: np.ndarray) -> np.ndarray:
        return predict(classifier, windows, device)

    params = DetectorParams.from_settings({"sample_fps": sample_fps, "threshold": threshold})
    # Offline there is no reason to hold alerts back: count every crossing.
    params.track_cooldown_seconds = 0
    params.camera_cooldown_seconds = 0
    detector = ShopliftingDetector(classify=classify, params=params)

    stride = max(1, round(source_fps / sample_fps))
    alerts = 0
    frame_index = 0
    for _ in range(loops):
        capture = cv2.VideoCapture(path)
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1
            if frame_index % stride:
                continue
            # Video time, not wall time: the detector samples by timestamp.
            ts = frame_index / source_fps
            people = tracker.track(frame)
            update = detector.update(people, ts)
            alerts += len(update.alerts)
            for snap in detector.snapshot():
                if snap["probability"] is not None:
                    judged.setdefault(snap["track_id"], []).append(snap["probability"])
        capture.release()

    people = {
        track_id: {
            "judged": len(probs),
            "peak": round(max(probs), 3),
            "mean": round(float(np.mean(probs)), 3),
            "above": round(float(np.mean([p >= threshold for p in probs])), 2),
        }
        for track_id, probs in judged.items()
    }
    return {"stride": stride, "alerts": alerts, "people": people}


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("videos", nargs="+")
    parser.add_argument("--fps", nargs="+", type=float, default=[config.sample_fps])
    parser.add_argument("--loops", type=int, default=4)
    parser.add_argument("--threshold", type=float, default=config.shoplifting_threshold)
    args = parser.parse_args(argv)

    for path in args.videos:
        for fps in args.fps:
            result = evaluate(path, fps, args.loops, args.threshold)
            print(f"{path}  sample_fps={fps:g} (every {result['stride']} frames)  alerts={result['alerts']}")
            if not result["people"]:
                print("    nobody was in view long enough to judge")
            for track_id, stats in sorted(result["people"].items()):
                print(
                    f"    person #{track_id}: judged {stats['judged']:4d}  peak {stats['peak']:.3f}  "
                    f"mean {stats['mean']:.3f}  >= threshold {stats['above']:.0%}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
