"""Aesthetic score: a technical proxy for "visual interest," not learned taste.

Like sharpness/exposure, this is a cheap statistical signal meant to help
triage a shoot, not a verdict — a deliberately B&W or low-contrast/muted-grade
frame will score lower on this axis specifically, the same way an intentional
motion-blur shot scores low on focus. The user's pick/star/color call always
wins; `score_overall` is only ever an assist.

Two signals, blended 70/30 so a desaturated-but-punchy frame isn't punished
much harder than a genuinely flat one:

- **Contrast** (dominant) — std-dev of luminance in a centered 80% crop
  (mirrors sharpness.py's crop, so a busy border doesn't skew it). Flat, hazy,
  or washed-out frames read low regardless of color grading.
- **Colorfulness** (minor) — the Hasler & Süsstrunk (2003) metric: combined
  spread + magnitude of the two opponent color channels (red-green,
  yellow-blue). Vivid frames score higher; true grayscale reads near zero.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

CROP_FRAC = 0.8

# Calibration references (not hard limits — values above these still clamp to 10).
_CONTRAST_REF = 55.0     # std-dev of luma considered "punchy"
_COLORFULNESS_REF = 60.0  # Hasler-Süsstrunk M considered "vivid"
_CONTRAST_WEIGHT = 0.7
_COLORFULNESS_WEIGHT = 0.3


def _center_crop(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    crop_h = int(h * CROP_FRAC)
    crop_w = int(w * CROP_FRAC)
    y0 = (h - crop_h) // 2
    x0 = (w - crop_w) // 2
    return img[y0 : y0 + crop_h, x0 : x0 + crop_w]


def contrast(gray: np.ndarray) -> float:
    """Std-dev of luminance — the classic global-contrast proxy."""
    return float(gray.std())


def colorfulness(bgr: np.ndarray) -> float:
    """Hasler & Süsstrunk colorfulness metric M, computed on BGR uint8 input."""
    b = bgr[:, :, 0].astype(np.float32)
    g = bgr[:, :, 1].astype(np.float32)
    r = bgr[:, :, 2].astype(np.float32)
    rg = r - g
    yb = 0.5 * (r + g) - b
    std_rg, std_yb = float(rg.std()), float(yb.std())
    mean_rg, mean_yb = float(rg.mean()), float(yb.mean())
    return float(np.hypot(std_rg, std_yb) + 0.3 * np.hypot(mean_rg, mean_yb))


def score_path(image_path: Path) -> float | None:
    """Open a JPEG (e.g. the preview cached by ingest) and return a 0-10 score."""
    bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    h, w = bgr.shape[:2]
    if h < 16 or w < 16:
        return None
    crop = _center_crop(bgr)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)

    contrast_score = min(10.0, contrast(gray) / _CONTRAST_REF * 10.0)
    color_score = min(10.0, colorfulness(crop) / _COLORFULNESS_REF * 10.0)
    score = _CONTRAST_WEIGHT * contrast_score + _COLORFULNESS_WEIGHT * color_score
    return max(0.0, min(10.0, score))
