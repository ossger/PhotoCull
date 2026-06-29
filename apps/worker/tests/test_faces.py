"""Unit tests for the pure face-scoring helpers.

These exercise the math in `scoring.faces` with hand-built landmark/blendshape
stand-ins and small arrays — no YuNet/MediaPipe model, OpenCV decode, or real
face images needed. The two-stage detect-then-landmark pipeline itself
(`detect_rgb`) needs both models and is covered by manual/integration checks.
"""
from __future__ import annotations

import json
from collections import namedtuple

import numpy as np
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


def test_eye_center_midpoint() -> None:
    lms = _landmarks(5)
    lms[1] = _LM(0.2, 0.4)
    lms[3] = _LM(0.6, 0.8)
    assert faces._eye_center(lms, (1, 3)) == pytest.approx((0.4, 0.6))


def test_eye_center_out_of_range_is_none() -> None:
    assert faces._eye_center([_LM(0.0, 0.0)], (5, 9)) is None


def test_norm_box_basic() -> None:
    assert faces._norm_box(10, 20, 30, 40, 100, 100) == pytest.approx((0.1, 0.2, 0.3, 0.4))


def test_norm_box_clamps_overflow() -> None:
    # A box running past the right edge has its width clamped, not its origin.
    assert faces._norm_box(90, 0, 30, 10, 100, 100) == pytest.approx((0.9, 0.0, 0.1, 0.1))


def test_yunet_eyes_labels_by_image_position() -> None:
    # e0 is image-left, e1 is image-right → right=person's right (image-left).
    lm = np.array([20.0, 30.0, 60.0, 30.0, 0, 0, 0, 0, 0, 0])
    left, right = faces._yunet_eyes(lm, 100, 100)
    assert right == pytest.approx((0.2, 0.3))
    assert left == pytest.approx((0.6, 0.3))


def test_yunet_eyes_order_independent() -> None:
    # Same eyes, swapped input order → same labelling.
    lm = np.array([60.0, 30.0, 20.0, 30.0, 0, 0, 0, 0, 0, 0])
    left, right = faces._yunet_eyes(lm, 100, 100)
    assert right == pytest.approx((0.2, 0.3))
    assert left == pytest.approx((0.6, 0.3))


def test_worst_eyes_open_ignores_none() -> None:
    assert faces._worst_eyes_open([None, 8.0, 3.0]) == 3.0


def test_worst_eyes_open_all_none() -> None:
    assert faces._worst_eyes_open([None, None]) is None
    assert faces._worst_eyes_open([]) is None


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


def test_serialize_faces_unscored_eyes_open_is_null() -> None:
    fd = faces.FaceDetail(box=(0.0, 0.0, 0.1, 0.1), eyes_open=None, left_eye=None, right_eye=None)
    data = json.loads(faces.serialize_faces([fd]))
    assert data[0]["eyes_open"] is None
