"""Face detection (YuNet) + eyes-open scoring (MediaPipe Face Landmarker).

A two-stage pipeline, because a single full-frame Landmarker pass is blind to
faces that don't fill much of the frame (its bundled short-range detector
downscales the whole image to ~192px first, so a face that's a small slice of a
1600px preview vanishes — the common case in lifestyle/event/sports shots):

  1. **Detect** — YuNet (`cv2.FaceDetectorYN`, riding on the cv2 we already
     ship) finds faces across the full frame, including small/distant ones, and
     returns a box + 5 landmarks (both eyes, nose, mouth corners).
  2. **Landmark** — for each detected face we crop around its box and run the
     MediaPipe Face Landmarker on that crop. A tight crop is the high-resolution
     regime where the Landmarker actually works, and its eyeBlink blendshapes
     give a reliable eyes-open score plus precise eye centres.

Alongside the score, detection returns per-face localization — a normalized
bounding box and left/right eye centres — so the UI can show how many faces
were found and where. Coordinates are normalized 0..1 of the scored image.

`eyes_open` is `None` for a face the Landmarker couldn't analyse (e.g. a heavy
profile, or eyes hidden such that no landmarks resolve); that face still counts
and still draws, it just doesn't contribute an eyes-open number. The shot-level
score is the **worst** eyes_open among faces that *could* be scored, or `None`
when none could / there are no faces. (A caveat the score can't escape: dark
sunglasses defeat eyeBlink, so those eyes read as "open" regardless.)

Images with **no detected faces** return `score=None, n_faces=0` — deliberately
not 0, so landscapes/food/product shots aren't punished for being faceless; the
aggregate renormalises around the sub-scores that are present.

Both models are downloaded once via models.fetch() and cached under the user's
appdata dir, and held as module-global singletons (warmup is the expensive
part). A single lock serialises inference so the ingest threadpool can share the
singletons safely.
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

_landmarker = None
_yunet = None
_model_lock = threading.Lock()    # guards lazy singleton construction
_infer_lock = threading.Lock()    # serialises inference (models aren't reentrant)

# YuNet detections below this confidence are dropped — keeps waves/rocks/specular
# glints from registering as faces. Tuned on real shoots; faces that matter for
# culling clear it comfortably.
_YUNET_SCORE_THRESHOLD = 0.6
# How much context (as a fraction of the box) to include around a face when
# cropping for the Landmarker. It wants some head/neck/background to lock on.
_CROP_MARGIN = 0.4
# Crops smaller than this (px, short edge) are too small for the Landmarker to
# resolve eye landmarks — skip the landmark pass and fall back to YuNet's eyes.
_MIN_CROP_EDGE = 48

# MediaPipe Face Mesh eye-corner landmark indices. Each eye's centre is the
# midpoint of its outer/inner corners — corners are the most stable, least
# ambiguous landmarks, so the centre is robust without tracing the full lid.
_RIGHT_EYE_CORNERS = (33, 133)    # person's right eye (image left)
_LEFT_EYE_CORNERS = (362, 263)    # person's left eye (image right)


@dataclass(slots=True)
class FaceDetail:
    """One detected face, all coordinates normalized 0..1 of the scored image."""
    box: tuple[float, float, float, float]   # x, y, w, h
    eyes_open: float | None                  # 0..10 for this face, or None if unscored
    left_eye: tuple[float, float] | None     # subject's left eye centre (image right)
    right_eye: tuple[float, float] | None    # subject's right eye centre (image left)


@dataclass(slots=True)
class FacesResult:
    score: float | None        # worst-face eyes-open 0..10, or None if no scorable face
    n_faces: int
    faces: list[FaceDetail]


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


def _eye_center(landmarks, corners: tuple[int, int]) -> tuple[float, float] | None:  # type: ignore[no-untyped-def]
    a, b = corners
    if a >= len(landmarks) or b >= len(landmarks):
        return None
    pa, pb = landmarks[a], landmarks[b]
    return (_clamp01((pa.x + pb.x) / 2.0), _clamp01((pa.y + pb.y) / 2.0))


def _norm_box(x: float, y: float, bw: float, bh: float, w: int, h: int) -> tuple[float, float, float, float]:
    """Pixel box -> normalized (x, y, w, h) of a w*h image, clamped to 0..1."""
    x0 = _clamp01(x / w)
    y0 = _clamp01(y / h)
    return (x0, y0, _clamp01((x + bw) / w) - x0, _clamp01((y + bh) / h) - y0)


def _worst_eyes_open(values: list[float | None]) -> float | None:
    """Worst (lowest) eyes-open among the faces that have a score, else None."""
    scored = [v for v in values if v is not None]
    return min(scored) if scored else None


def serialize_faces(faces: list[FaceDetail]) -> str | None:
    """Compact JSON for the DB's faces_json column, or None when no faces."""
    if not faces:
        return None

    # Coerce to plain float throughout — numpy scalars from cv2 aren't
    # JSON-serializable, and one leak shouldn't drop a whole frame's faces.
    def _pt(p: tuple[float, float] | None) -> list[float] | None:
        return [round(float(p[0]), 4), round(float(p[1]), 4)] if p is not None else None

    return json.dumps(
        [
            {
                "box": [round(float(v), 4) for v in f.box],
                "eyes_open": None if f.eyes_open is None else round(float(f.eyes_open), 4),
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
    with _model_lock:
        if _landmarker is not None:
            return _landmarker
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        model_path = models.face_landmarker_model()
        base_opts = mp_python.BaseOptions(model_asset_path=str(model_path))
        opts = mp_vision.FaceLandmarkerOptions(
            base_options=base_opts,
            num_faces=1,  # runs on a single-face crop now
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=False,
            running_mode=mp_vision.RunningMode.IMAGE,
        )
        _landmarker = mp_vision.FaceLandmarker.create_from_options(opts)
        log.info("MediaPipe FaceLandmarker ready")
        return _landmarker


def _get_yunet():  # type: ignore[no-untyped-def]
    """Lazy singleton YuNet detector. Input size is set per-image before detect."""
    global _yunet
    if _yunet is not None:
        return _yunet
    with _model_lock:
        if _yunet is not None:
            return _yunet
        model_path = models.yunet_face_detector_model()
        _yunet = cv2.FaceDetectorYN.create(
            str(model_path), "", (320, 320),
            score_threshold=_YUNET_SCORE_THRESHOLD,
        )
        log.info("YuNet FaceDetectorYN ready")
        return _yunet


def _detect_boxes(bgr: np.ndarray) -> list[tuple[float, float, float, float, np.ndarray]]:
    """Run YuNet, returning (x, y, w, h, landmarks) per face in pixel coords.

    `landmarks` is YuNet's 5-point array (right eye, left eye, nose, mouth
    corners) flattened — used only as an eye-localization fallback.
    """
    h, w = bgr.shape[:2]
    detector = _get_yunet()
    with _infer_lock:
        detector.setInputSize((w, h))
        _, faces = detector.detect(bgr)
    if faces is None:
        return []
    out = []
    for f in faces:
        x, y, bw, bh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
        out.append((x, y, bw, bh, f[4:14]))
    return out


def _yunet_eyes(landmarks: np.ndarray, w: int, h: int) -> tuple[
    tuple[float, float] | None, tuple[float, float] | None
]:
    """Map YuNet's two eye points to (left_eye, right_eye) by image position.

    Subject's right eye sits on the image-left (smaller x), matching the
    Landmarker convention. Returns normalized coords.
    """
    # cv2 hands back numpy float32; cast to plain float so the coords stay
    # JSON-serializable all the way to faces_json.
    e0 = (float(landmarks[0]) / w, float(landmarks[1]) / h)
    e1 = (float(landmarks[2]) / w, float(landmarks[3]) / h)
    img_left, img_right = (e0, e1) if e0[0] <= e1[0] else (e1, e0)
    right = (_clamp01(img_left[0]), _clamp01(img_left[1]))      # person's right
    left = (_clamp01(img_right[0]), _clamp01(img_right[1]))     # person's left
    return left, right


def _landmark_crop(
    rgb: np.ndarray, x: float, y: float, bw: float, bh: float
) -> tuple[float | None, tuple[float, float] | None, tuple[float, float] | None]:
    """Run the Landmarker on a padded crop around one face box.

    Returns (eyes_open 0..10 or None, left_eye, right_eye) in coords normalized
    to the *full* image. Returns all-None when the crop is too small or the
    Landmarker resolves no face.
    """
    import mediapipe as mp

    H, W = rgb.shape[:2]
    mx, my = bw * _CROP_MARGIN, bh * _CROP_MARGIN
    x0 = max(0, int(round(x - mx)))
    y0 = max(0, int(round(y - my)))
    x1 = min(W, int(round(x + bw + mx)))
    y1 = min(H, int(round(y + bh + my)))
    cw, ch = x1 - x0, y1 - y0
    if min(cw, ch) < _MIN_CROP_EDGE:
        return None, None, None

    crop = np.ascontiguousarray(rgb[y0:y1, x0:x1])
    landmarker = _get_landmarker()
    with _infer_lock:
        result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
    if not result.face_landmarks:
        return None, None, None

    lms = result.face_landmarks[0]
    bs = result.face_blendshapes[0] if result.face_blendshapes else []
    eyes_open = round(min(10.0, max(0.0, _eyes_open_unit(bs) * 10.0)), 2)

    def _to_full(pt: tuple[float, float] | None) -> tuple[float, float] | None:
        if pt is None:
            return None
        return (_clamp01((x0 + pt[0] * cw) / W), _clamp01((y0 + pt[1] * ch) / H))

    left = _to_full(_eye_center(lms, _LEFT_EYE_CORNERS))
    right = _to_full(_eye_center(lms, _RIGHT_EYE_CORNERS))
    return eyes_open, left, right


def detect_path(image_path: Path) -> FacesResult:
    """Detect + score faces in the given JPEG.

    Loads the image, detects faces (YuNet), scores eyes-open per face
    (Landmarker on each face crop), and returns the worst-face eyes-open score
    plus per-face localization.
    """
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        return FacesResult(score=None, n_faces=0, faces=[])
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return detect_rgb(rgb)


def detect_rgb(rgb: np.ndarray) -> FacesResult:
    """Detect + score faces in an in-memory RGB image (uint8, HxWx3)."""
    h, w = rgb.shape[:2]
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    boxes = _detect_boxes(bgr)
    if not boxes:
        return FacesResult(score=None, n_faces=0, faces=[])

    faces: list[FaceDetail] = []
    for x, y, bw, bh, yn_landmarks in boxes:
        eyes_open, left, right = _landmark_crop(rgb, x, y, bw, bh)
        if left is None and right is None:
            left, right = _yunet_eyes(yn_landmarks, w, h)
        faces.append(
            FaceDetail(
                box=_norm_box(x, y, bw, bh, w, h),
                eyes_open=eyes_open,
                left_eye=left,
                right_eye=right,
            )
        )

    score = _worst_eyes_open([f.eyes_open for f in faces])
    return FacesResult(score=score, n_faces=len(faces), faces=faces)
