"""Per-frame star measurements from a grayscale image.

Used twice: on the cached preview to judge frames (focus / trailing / cloud /
haze), and at full working resolution to align frames for stacking. OpenCV and
numpy only.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# Blob limits in pixels at the analysed resolution.
MIN_AREA = 2
MAX_STAR_AREA = 150
# Anything with a longer, thinner footprint than this is a streak, not a star.
TRAIL_MIN_AREA = 40
TRAIL_ASPECT = 4.0
MAX_STARS = 1500
MAX_BLOBS = 4000
THRESHOLD_SIGMA = 5.0


@dataclass
class StarField:
    """Detections for one frame, brightest first.

    `points` is Nx3 (x, y, flux); `fwhm_each` / `elong_each` are per point, so a
    caller can drop points (the static foreground) and the summary follows.
    """

    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), np.float32))
    fwhm_each: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    elong_each: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    background: float = 0.0  # median luminance, 0..1
    trails: int = 0

    @property
    def count(self) -> int:
        return len(self.points)

    @property
    def fwhm(self) -> float | None:
        return float(np.median(self.fwhm_each)) if len(self.fwhm_each) else None

    @property
    def elongation(self) -> float | None:
        return float(np.median(self.elong_each)) if len(self.elong_each) else None


def coincident_fraction(a: StarField, b: StarField, tol: float = 1.5) -> float:
    """Fraction of `a`'s points that have a point of `b` within `tol` pixels.

    Near 1.0 means the two frames show the same sky (it didn't move); stars that
    drifted between them leave only static foreground detail coincident.
    """
    if a.count == 0 or b.count == 0:
        return 1.0
    d = a.points[:, None, :2] - b.points[None, :, :2]
    return float((np.hypot(d[..., 0], d[..., 1]) <= tol).any(axis=1).mean())


def to_gray8(img: np.ndarray) -> np.ndarray:
    """Float (0..1) or uint8/uint16 image, gray or colour, -> uint8 gray."""
    if img.ndim == 3:
        img = img.mean(axis=2) if img.dtype != np.uint8 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if img.dtype == np.uint8:
        return img
    if img.dtype == np.uint16:
        return (img >> 8).astype(np.uint8)
    return np.clip(img * 255.0, 0, 255).astype(np.uint8)


def detect_stars(gray: np.ndarray, max_stars: int = MAX_STARS) -> StarField:
    """Find stars in a uint8 gray image and summarise their quality."""
    g = to_gray8(gray)
    background_level = float(np.median(g)) / 255.0
    # Background (sky glow + gradients) from a downscaled copy: a wide median blur
    # at full sensor resolution is far too slow, and stars are far too sparse to
    # move a median over this window anyway.
    f = max(1, min(g.shape) // 500)
    small = g if f == 1 else cv2.resize(g, (g.shape[1] // f, g.shape[0] // f), interpolation=cv2.INTER_AREA)
    bg_small = cv2.medianBlur(small, 21)
    bg = bg_small if f == 1 else cv2.resize(bg_small, (g.shape[1], g.shape[0]), interpolation=cv2.INTER_LINEAR)
    resid = g.astype(np.float32) - bg.astype(np.float32)
    # Robust noise from a subsample (MAD of the residual).
    sample = resid[:: max(1, g.shape[0] // 200), :: max(1, g.shape[1] // 200)]
    sigma = 1.4826 * float(np.median(np.abs(sample - np.median(sample)))) or 1.0
    thresh = max(THRESHOLD_SIGMA * sigma, 8.0)
    mask = (resid > thresh).astype(np.uint8)
    _n, _labels, stats, _cents = cv2.connectedComponentsWithStats(mask, connectivity=8)

    # Foreground texture at full resolution can yield thousands of blobs; only
    # the largest few thousand (streaks included) are worth the per-blob work below.
    sized = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] >= MIN_AREA)
    sized = sized[sized > 0]
    if len(sized) > MAX_BLOBS:
        sized = sized[np.argsort(-stats[sized, cv2.CC_STAT_AREA])[:MAX_BLOBS]]

    pts: list[tuple[float, float, float]] = []
    fwhms: list[float] = []
    elongs: list[float] = []
    trails = 0
    h, w = g.shape
    for i in sized:
        x0, y0, bw, bh, area = (int(v) for v in stats[i])
        if area < MIN_AREA:
            continue
        pad = 2
        xa, ya = max(0, x0 - pad), max(0, y0 - pad)
        xb, yb = min(w, x0 + bw + pad), min(h, y0 + bh + pad)
        win = np.clip(resid[ya:yb, xa:xb], 0, None)
        flux = float(win.sum())
        if flux <= 0:
            continue
        ys, xs = np.mgrid[ya:yb, xa:xb]
        cx = float((win * xs).sum() / flux)
        cy = float((win * ys).sum() / flux)
        vx = float((win * (xs - cx) ** 2).sum() / flux)
        vy = float((win * (ys - cy) ** 2).sum() / flux)
        vxy = float((win * (xs - cx) * (ys - cy)).sum() / flux)
        # Principal axes of the intensity distribution.
        tr, det = vx + vy, vx * vy - vxy * vxy
        disc = max(tr * tr / 4 - det, 0.0) ** 0.5
        major, minor = max(tr / 2 + disc, 1e-3), max(tr / 2 - disc, 1e-3)
        elong = (major / minor) ** 0.5
        if area >= TRAIL_MIN_AREA and elong >= TRAIL_ASPECT:
            trails += 1
            continue
        if area > MAX_STAR_AREA:
            continue
        pts.append((cx, cy, flux))
        fwhms.append(2.355 * ((major + minor) / 2) ** 0.5)
        elongs.append(elong)

    if not pts:
        return StarField(background=background_level, trails=trails)
    arr = np.array(pts, np.float32)
    order = np.argsort(-arr[:, 2])[:max_stars]
    return StarField(
        points=arr[order],
        fwhm_each=np.array(fwhms, np.float32)[order],
        elong_each=np.array(elongs, np.float32)[order],
        background=background_level,
        trails=trails,
    )
