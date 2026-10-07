"""Synthetic star-field frames shared by the astro tests."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import piexif
from PIL import Image

W, H = 960, 640
SKY_ROWS = 440  # rows below this are a static dark "foreground" band


def star_catalog(n: int = 140, seed: int = 7) -> np.ndarray:
    """Fixed star positions (x, y, brightness) above the foreground band."""
    rng = np.random.default_rng(seed)
    xs = rng.uniform(30, W - 30, n)
    ys = rng.uniform(30, SKY_ROWS - 30, n)
    amp = rng.uniform(90, 230, n)
    return np.stack([xs, ys, amp], axis=1)


def sky_transform(k: int, center=(W * 0.6, -400.0)) -> np.ndarray:
    """2x3 matrix: rotation about a distant 'pole', ~5 px of star motion per frame (what a
    full-resolution wide-field shot does between 20-30 s exposures)."""
    ang = np.deg2rad(0.4 * k)
    return cv2.getRotationMatrix2D(center, -np.rad2deg(ang), 1.0)


def ridge_pattern() -> np.ndarray:
    """The static foreground texture (rows below the sky), noise-free, 0..255 floats."""
    ridge = np.random.default_rng(99).normal(0, 1, (H - SKY_ROWS, W))
    return cv2.GaussianBlur(ridge.astype(np.float32), (0, 0), 2.0) * 60 + 25


def render_frame(
    k: int,
    cat: np.ndarray,
    *,
    noise_seed: int,
    cloud: float = 0.0,
    smear: float = 0.0,
    streak: bool = False,
    foreground: bool = True,
) -> np.ndarray:
    """One 8-bit RGB frame. `cloud` fades stars and lifts the sky; `smear` trails them."""
    rng = np.random.default_rng(noise_seed)
    M = sky_transform(k)
    pts = cat[:, :2] @ M[:, :2].T + M[:, 2]
    layer = np.zeros((H, W), np.float32)
    sigma = 1.7
    for (x, y), a in zip(pts, cat[:, 2]):
        if not (4 < x < W - 4 and 4 < y < H - 4):
            continue
        n = max(1, int(smear))
        for i in range(n):
            xx = x + (i - (n - 1) / 2.0) * (smear / max(n - 1, 1)) if smear else x
            r = int(sigma * 4)
            x0, y0 = int(round(xx)), int(round(y))
            ys_, xs_ = np.mgrid[max(0, y0 - r): y0 + r + 1, max(0, x0 - r): x0 + r + 1]
            g = np.exp(-(((xs_ - xx) ** 2 + (ys_ - y) ** 2) / (2 * sigma**2)))
            layer[ys_.min(): ys_.max() + 1, xs_.min(): xs_.max() + 1] += (a / n) * g
    layer *= 1.0 - 0.95 * cloud
    if streak:
        cv2.line(layer, (0, 90 + 2 * k), (W - 1, 150 + 2 * k), 160.0, 2)
    sky = 10.0 + 70.0 * cloud + layer + rng.normal(0, 3.0, (H, W))
    img = np.repeat(sky[:, :, None], 3, axis=2)
    if foreground:
        # static ridge with hard texture: identical in every frame
        ridge = ridge_pattern()
        img[SKY_ROWS:] = ridge[:, :, None] + rng.normal(0, 2.0, (H - SKY_ROWS, W, 1))
    return np.clip(img, 0, 255).astype(np.uint8)


def write_jpeg(path: Path, rgb: np.ndarray, stamp: str, shutter: int = 20) -> None:
    exif = {
        "0th": {piexif.ImageIFD.Model: b"TestCam"},
        "Exif": {
            piexif.ExifIFD.DateTimeOriginal: stamp.encode(),
            piexif.ExifIFD.ExposureTime: (shutter, 1),
            piexif.ExifIFD.FNumber: (28, 10),
            piexif.ExifIFD.ISOSpeedRatings: 3200,
            piexif.ExifIFD.FocalLength: (24, 1),
        },
    }
    Image.fromarray(rgb).save(path, "JPEG", quality=95, exif=piexif.dump(exif))


def stamp_for(k: int, base_minute: int = 0, step_s: int = 25) -> str:
    total = base_minute * 60 + k * step_s
    return f"2026:09:20 23:{total // 60:02d}:{total % 60:02d}"
