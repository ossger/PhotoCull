"""Unit tests for the pure face-scoring helpers.

These exercise the math in `scoring.faces` with hand-built landmark/blendshape
stand-ins — no MediaPipe model, OpenCV decode, or real face images needed. The
stand-ins only need the attributes the code reads: `.x`/`.y` on landmarks and
`.category_name`/`.score` on blendshapes.
"""
from __future__ import annotations

import json
from collections import namedtuple

import pytest

from photocull.scoring import faces

_LM = namedtuple("_LM", "x y")
_BS = namedtuple("_BS", "category_name score")


def _landmarks(n: int = 478) -> list:
    """A full-length landmark list; callers override the indices they care about."""
    return [_LM(0.5, 0.5) for _ in range(n)]


def test_clamp01() -> None:
    assert faces._clamp01(-0.2) == 0.0
    assert faces._clamp01(1.5) == 1.0
    assert faces._clamp01(0.3) == 0.3


def test_eyes_open_unit_defaults_open() -> None:
    # No blink blendshapes present → treated as fully open.
    assert faces._eyes_open_unit([]) == 1.0


def test_eyes_open_unit_uses_worst_eye() -> None:
    bs = [
        _BS("eyeBlinkLeft", 0.8),
        _BS("eyeBlinkRight", 0.2),
        _BS("jawOpen", 0.5),
    ]
    # 1 - max(0.8, 0.2) = 0.2
    assert faces._eyes_open_unit(bs) == pytest.approx(0.2)


def test_bbox_min_max() -> None:
    pts = [(0.2, 0.3), (0.5, 0.1), (0.4, 0.6)]
    assert faces._bbox(pts) == pytest.approx((0.2, 0.1, 0.3, 0.5))


def test_bbox_clamps_out_of_range() -> None:
    box = faces._bbox([(-0.1, 0.5), (1.2, 0.5)])
    assert box == pytest.approx((0.0, 0.5, 1.0, 0.0))


def test_eye_center_midpoint() -> None:
    lms = _landmarks(5)
    lms[1] = _LM(0.2, 0.4)
    lms[3] = _LM(0.6, 0.8)
    assert faces._eye_center(lms, (1, 3)) == pytest.approx((0.4, 0.6))


def test_eye_center_out_of_range_is_none() -> None:
    assert faces._eye_center([_LM(0.0, 0.0)], (5, 9)) is None


def test_build_faces_empty() -> None:
    result = faces._build_faces([], [])
    assert result.score is None
    assert result.n_faces == 0
    assert result.faces == []


def test_build_faces_single() -> None:
    lms = _landmarks()
    # Spread two points so the bbox is non-degenerate.
    lms[0] = _LM(0.1, 0.1)
    lms[1] = _LM(0.9, 0.9)
    # Eye corners (see module constants) → known centres.
    lms[33], lms[133] = _LM(0.3, 0.4), _LM(0.4, 0.4)   # right eye → (0.35, 0.4)
    lms[362], lms[263] = _LM(0.6, 0.4), _LM(0.7, 0.4)  # left eye  → (0.65, 0.4)
    bs = [_BS("eyeBlinkLeft", 0.1), _BS("eyeBlinkRight", 0.1)]

    result = faces._build_faces([lms], [bs])

    assert result.n_faces == 1
    assert result.score == pytest.approx(9.0)  # (1 - 0.1) * 10
    face = result.faces[0]
    assert face.box == pytest.approx((0.1, 0.1, 0.8, 0.8))
    assert face.right_eye == pytest.approx((0.35, 0.4))
    assert face.left_eye == pytest.approx((0.65, 0.4))


def test_build_faces_score_is_worst_face() -> None:
    open_eyes = [_BS("eyeBlinkLeft", 0.0), _BS("eyeBlinkRight", 0.0)]   # → 10.0
    shut_eyes = [_BS("eyeBlinkLeft", 0.9), _BS("eyeBlinkRight", 0.9)]   # → 1.0
    result = faces._build_faces([_landmarks(), _landmarks()], [open_eyes, shut_eyes])
    assert result.n_faces == 2
    assert result.score == pytest.approx(1.0)  # worst face drags the shot down


def test_serialize_faces_none_when_empty() -> None:
    assert faces.serialize_faces([]) is None


def test_serialize_faces_shape() -> None:
    fd = faces.FaceDetail(
        box=(0.1, 0.2, 0.3, 0.4),
        eyes_open=8.5,
        left_eye=(0.5, 0.5),
        right_eye=None,
    )
    data = json.loads(faces.serialize_faces([fd]))
    assert data == [
        {
            "box": [0.1, 0.2, 0.3, 0.4],
            "eyes_open": 8.5,
            "left_eye": [0.5, 0.5],
            "right_eye": None,
        }
    ]
