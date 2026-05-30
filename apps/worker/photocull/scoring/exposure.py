"""Exposure score: penalise blown highlights / crushed shadows.

A correctly exposed image has most of its pixels in the middle of the
luminance range. We sum pixels in the top 1% and bottom 1% of intensity and
subtract that from a perfect score.

This is intentionally simple — it catches obvious wrecks (heavy overexposure,
silhouettes meant for the bin) without judging artistic exposure choices.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

LOW_BIN = 2     # pixels with intensity <= 2 (out of 255)
HIGH_BIN = 253  # pixels with intensity >= 253


def score_path(image_path: Path) -> float | None:
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    return score_from_gray(img)


def score_from_gray(gray: np.ndarray) -> float:
    total = int(gray.size)
    if total == 0:
        return 0.0
    clipped_low = int(np.count_nonzero(gray <= LOW_BIN))
    clipped_high = int(np.count_nonzero(gray >= HIGH_BIN))
    clipped_ratio = (clipped_low + clipped_high) / total
    # 0% clipped -> 10; 25% clipped -> 5; 50%+ clipped -> 0
    score = 10.0 - clipped_ratio * 20.0
    return max(0.0, min(10.0, score))
