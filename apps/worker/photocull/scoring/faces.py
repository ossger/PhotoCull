"""Face detection + eyes-open scoring via MediaPipe Face Landmarker.

Returns a 0-10 score per image based on the worst-faring face in the frame.
Rationale: if there are three people and one has closed eyes, the whole shot
is a reject — averaging would mask that. Single-face shots fall back to that
face's score directly.

Images with **no detected faces** return `None` (not 0). That's deliberate:
landscapes, food shots, product photography etc. shouldn't be punished for
having no faces — the aggregate score code simply renormalises around the
sub-scores that are present.

The MediaPipe model is downloaded once via models.fetch() and cached under
the user's appdata dir. The landmarker is held as a module-global singleton
because warmup is the expensive part (~300ms); per-image inference is ~30ms.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .. import models

log = logging.getLogger(__name__)

# MediaPipe imports lazily — they're heavyweight and we don't want them to
# pay their startup cost in worker subprocesses that won't use them.
_landmarker = None
_landmarker_lock = threading.Lock()


@dataclass(slots=True)
class FaceFrameScore:
    eyes_open: float  # 0..10
    n_faces: int


def _get_landmarker():  # type: ignore[no-untyped-def]
    """Lazy singleton — first call downloads the model and warms it up."""
    global _landmarker
    if _landmarker is not None:
        return _landmarker
    with _landmarker_lock:
        if _landmarker is not None:
            return _landmarker
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        model_path = models.face_landmarker_model()
        base_opts = mp_python.BaseOptions(model_asset_path=str(model_path))
        opts = mp_vision.FaceLandmarkerOptions(
            base_options=base_opts,
            num_faces=5,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=False,
            running_mode=mp_vision.RunningMode.IMAGE,
        )
        _landmarker = mp_vision.FaceLandmarker.create_from_options(opts)
        log.info("MediaPipe FaceLandmarker ready")
        return _landmarker


def score_path(image_path: Path) -> tuple[float | None, int]:
    """Return (eyes_open_score_0_10_or_None, n_faces) for the given JPEG.

    Loads the image, runs face landmarker, derives a per-face eyes-open value
    from the eyeBlink blendshapes, and returns the minimum (worst face's eyes
    determine the shot's score).
    """
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        return None, 0
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return score_rgb(rgb)


def score_rgb(rgb: np.ndarray) -> tuple[float | None, int]:
    """Score an in-memory RGB image (uint8, HxWx3)."""
    import mediapipe as mp

    landmarker = _get_landmarker()
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_image)

    blendshapes_per_face = result.face_blendshapes or []
    if not blendshapes_per_face:
        return None, 0

    # Worst (lowest) eyes-open across all faces. Blendshapes are 0..1 where
    # eyeBlink* is 1 when the eye is fully closed, so eyes_open = 1 - max(L,R).
    eyes_open_per_face: list[float] = []
    for face in blendshapes_per_face:
        by_name = {b.category_name: b.score for b in face}
        blink_l = by_name.get("eyeBlinkLeft", 0.0)
        blink_r = by_name.get("eyeBlinkRight", 0.0)
        eyes_open = 1.0 - max(blink_l, blink_r)
        eyes_open_per_face.append(eyes_open)

    worst = min(eyes_open_per_face)
    score = max(0.0, min(10.0, worst * 10.0))
    return score, len(blendshapes_per_face)
