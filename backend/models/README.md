# Models

The two models the detector runs, both copied unchanged from InsightEye's `models/` folder. This
folder is mounted at `/app/models` by docker-compose and tracked in git in full (see the root
`.gitignore`).

| File | Model | Role | Config |
|---|---|---|---|
| `yolo26m-pose.pt` | Ultralytics YOLO26-M pose, COCO keypoints (17), not fine-tuned | People, their boxes and keypoints; ByteTrack adds the ids | `POSE_MODEL_PATH` |
| `shoplifting.pt` | InsightEye's `ShopliftingClassifier`: Conv1d → BiGRU → self-attention → 2 classes | Judges one person's last 120 pose samples: Normal vs Shoplifting | `CLASSIFIER_MODEL_PATH` |

## yolo26m-pose.pt

- **Source:** the official Ultralytics asset, the same file InsightEye ships.
- **Size:** 49,036,866 bytes.
- **SHA-256:** `2fbf16367022256a226035695c5c389384c6706e8bb8ab8fcd0e7976f05443c4`
- **Checkpoint:** dated 2026-01-13 and saved by Ultralytics 8.3.222. The api image runs
  Ultralytics 8.4.187 with torch 2.11.0+cu128.
- **License:** AGPL-3.0, from Ultralytics. Check this before any commercial or closed-source
  deployment.
- **Inference:** 640 px input, FP16 on CUDA, person class only, confidence 0.25. Tracks are started
  per [`trackers/shoplifting_bytetrack.yaml`](../trackers/shoplifting_bytetrack.yaml), with a
  buffer of 30 frames (10 s at 3 fps).
- InsightEye also has an `.onnx` and a TensorRT `.engine` export of this model. Neither was used
  for shoplifting there, and neither is used here.

## shoplifting.pt

- **Source:** `insighteye/models/shoplifting.pt`. The checkpoint's internal archive name is
  `best_model_2/`. No training code was found on this machine.
- **Size:** 2,303,077 bytes; 573,955 parameters. It is a plain `state_dict`; a
  `{"model_state_dict": …}` wrapper is also accepted.
- **SHA-256:** `edc6871202e38401e9c1d6ba66d17f6b0080f80a838d247753966d670eaeab22`
- **Input:** `(batch, T=120, V=17, C=12)`, z-scored over the whole window. Each row is one
  person's normalised keypoints (x, y), their velocity since the previous sample, and the
  left-wrist→mid-hip, right-wrist→mid-hip and wrist→wrist distances, zero-padded to 12. An all-zero
  row means "nobody there", as in InsightEye's buffer.
- **Output:** logits for `("Normal", "Shoplifting")`. The detector uses the softmax probability
  of Shoplifting, averaged over the last 3 judgements.
- **Parity:** [`tests/test_model.py`](../tests/test_model.py) checks logits, probabilities and
  features against numbers produced by InsightEye's own `shoplifting_inference.py`.
- **Sample rate:** 3 fps, i.e. a 40 s window. That is InsightEye's effective rate (every 10th frame
  of 30 fps), and on the test clip it separates best: see `tools/eval_shoplifting.py` and the
  backend README.
- No ONNX, OpenVINO or TensorRT version exists. InsightEye's settings named them, but always
  loaded this `.pt`.
