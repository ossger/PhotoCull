"""Face detection + eyes-open scoring via MediaPipe Face Landmarker.

Returns a 0-10 score per image based on the worst-faring face in the frame.
Rationale: if there are three people and one has closed eyes, the whole shot
is a reject — averaging would mask that. Single-face shots fall back to that
face's score directly.

Alongside the score, detection also returns per-face localization — a
normalized bounding box and left/right eye centres — so the UI can show how
many faces were found and where (and, later, cross-check the camera's
in-focus AF point against an eye). Coordinates are normalized 0..1 of the
scored image.

Images with **no detected faces** return `None` (not 0). That's deliberate:
landscapes, food shots, product photography etc. shouldn't be punished for
having no faces — the aggregate score code simply renormalises around the
sub-scores that are present.

The MediaPipe model is downloaded once via models.fetch() and cached under
the user's appdata dir. The landmarker is held as a module-global singleton
because warmup is the expensive part (~300ms); per-image inference is ~30ms.
"""
from __future__ import annotations

import json
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
class FaceDetail:
    """One detected face, all coordinates normalized 0..1 of the scored image."""
    box: tuple[float, float, float, float]   # x, y, w, h
    eyes_open: float                         # 0..10 for this face
    left_eye: tuple[float, float] | None     # subject's left eye centre (image right)
    right_eye: tuple[float, float] | None    # subject's right eye centre (image left)


@dataclass(slots=True)
class FacesResult:
    score: float | None        # worst-face eyes-open 0..10, or None if no faces
    n_faces: int
    faces: list[FaceDetail]


# MediaPipe Face Mesh eye-corner landmark indices. Each eye's centre is the
# midpoint of its outer/inner corners — corners are the most stable, least
# ambiguous landmarks, so the centre is robust without tracing the full lid.
_RIGHT_EYE_CORNERS = (33, 133)    # person's right eye (image left)
_LEFT_EYE_CORNERS = (362, 263)    # person's left eye (image right)


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def _eyes_open_unit(blendshapes_for_face) -> float:  # type: ignore[no-untyped-def]
    """Eyes-open in 0..1 from the eyeBlink blendshapes (1 = fully open).

    Blendshapes are 0..1 where eyeBlink* is 1 when the eye is fully closed,
    so eyes_open = 1 - max(left, right). Missing blendshapes default to open.
    """
    by_name = {b.category_name: b.score for b in blendshapes_for_face}
    blink_l = by_name.get("eyeBlinkLeft", 0.0)
    blink_r = by_name.get("eyeBlinkRight", 0.0)
    return 1.0 - max(blink_l, blink_r)


def _bbox(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box (x, y, w, h) over normalized points, clamped 0..1."""
    xs = [_clamp01(x) for x, _ in points]
    ys = [_clamp01(y) for _, y in points]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return (x0, y0, x1 - x0, y1 - y0)


def _eye_center(landmarks, corners: tuple[int, int]) -> tuple[float, float] | None:  # type: ignore[no-untyped-def]
    a, b = corners
    if a >= len(landmarks) or b >= len(landmarks):
        return None
    pa, pb = landmarks[a], landmarks[b]
    return (_clamp01((pa.x + pb.x) / 2.0), _clamp01((pa.y + pb.y) / 2.0))


def _build_faces(landmarks_per_face, blendshapes_per_face) -> FacesResult:  # type: ignore[no-untyped-def]
    """Assemble a FacesResult from MediaPipe's per-face landmark + blendshape
    lists. Pure (no model / no I/O) so it's unit-testable with stand-ins."""
    if not landmarks_per_face:
        return FacesResult(score=None, n_faces=0, faces=[])
    faces: list[FaceDetail] = []
    for i, lms in enumerate(landmarks_per_face):
        bs = blendshapes_per_face[i] if i < len(blendshapes_per_face) else []
        eyes_open = round(min(10.0, max(0.0, _eyes_open_unit(bs) * 10.0)), 2)
        faces.append(
            FaceDetail(
                box=_bbox([(lm.x, lm.y) for lm in lms]),
                eyes_open=eyes_open,
                left_eye=_eye_center(lms, _LEFT_EYE_CORNERS),
                right_eye=_eye_center(lms, _RIGHT_EYE_CORNERS),
            )
        )
    score = min(f.eyes_open for f in faces)  # worst face determines the shot
    return FacesResult(score=score, n_faces=len(faces), faces=faces)


def serialize_faces(faces: list[FaceDetail]) -> str | None:
    """Compact JSON for the DB's faces_json column, or None when no faces."""
    if not faces:
        return None

    def _pt(p: tuple[float, float] | None) -> list[float] | None:
        return [round(p[0], 4), round(p[1], 4)] if p is not None else None

    return json.dumps(
        [
            {
                "box": [round(v, 4) for v in f.box],
                "eyes_open": f.eyes_open,
                "left_eye": _pt(f.left_eye),
                "right_eye": _pt(f.right_eye),
            }
            for f in faces
        ],
        separators=(",", ":"),
    )


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


def detect_path(image_path: Path) -> FacesResult:
    """Detect + score faces in the given JPEG.

    Loads the image, runs the face landmarker, and returns the worst-face
    eyes-open score plus per-face localization (box + eye centres).
    """
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        return FacesResult(score=None, n_faces=0, faces=[])
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return detect_rgb(rgb)


def detect_rgb(rgb: np.ndarray) -> FacesResult:
    """Detect + score faces in an in-memory RGB image (uint8, HxWx3)."""
    import mediapipe as mp

    landmarker = _get_landmarker()
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_image)
    return _build_faces(result.face_landmarks or [], result.face_blendshapes or [])
