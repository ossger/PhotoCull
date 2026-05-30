"""Focus / sharpness score via Laplacian variance.

The Laplacian operator highlights second-derivative changes (edges). A sharp,
in-focus image has high-variance Laplacian output; a soft / out-of-focus image
has low variance. We compute it on a centered 80% crop so frames with a big
out-of-focus background don't drag the score down.

Tunable: the log-mapping constants below were calibrated against a small mix
of typical mirrorless JPEGs — sharp wide-aperture portraits land 7-9, mildly
soft frames land 4-6, badly out-of-focus frames land 0-2.
"""
from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

CROP_FRAC = 0.8


def laplacian_variance(gray: np.ndarray) -> float:
    """Variance of the Laplacian — the classic blur metric."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def score_path(image_path: Path) -> float | None:
    """Open a JPEG (e.g. the preview cached by ingest) and return a 0-10 score."""
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    h, w = img.shape[:2]
    if h < 16 or w < 16:
        return None
    crop_h = int(h * CROP_FRAC)
    crop_w = int(w * CROP_FRAC)
    y0 = (h - crop_h) // 2
    x0 = (w - crop_w) // 2
    crop = img[y0 : y0 + crop_h, x0 : x0 + crop_w]
    var = laplacian_variance(crop)
    return _normalise(var)


def _normalise(var: float) -> float:
    """Map raw Laplacian variance to a 0-10 score on a log scale.

    var ~ 10   -> 0
    var ~ 100  -> ~3
    var ~ 1000 -> ~6.5
    var ~ 5000 -> ~10
    """
    if var <= 0:
        return 0.0
    # 10 * (log10(var) - 1) / 2.7 ~= mapping above
    score = 10.0 * (math.log10(var) - 1.0) / 2.7
    return max(0.0, min(10.0, score))
