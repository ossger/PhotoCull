"""Measure and judge the frames of a star sequence (reads cached previews)."""
from __future__ import annotations

import logging
import sqlite3
from dataclasses import asdict
from pathlib import Path
from statistics import median
from typing import Any

import cv2
import numpy as np

from .cull import FrameMetrics, judge
from .stars import StarField, coincident_fraction, detect_stars

log = logging.getLogger(__name__)


# Median-image estimate uses at most this many frames (evenly spaced).
MEDIAN_FRAMES = 40
# Below this many frames a "typical" image isn't reliable.
MIN_FOR_MEDIAN = 5
# If at least this share of the first frame's stars sit unmoved in the last frame, the
# sky barely drifted and the median image would contain the stars themselves.
SKY_STILL = 0.8


def _read_gray(preview: Path | None) -> np.ndarray | None:
    return None if preview is None else cv2.imread(str(preview), cv2.IMREAD_GRAYSCALE)


def measure_stars(grays: list[np.ndarray | None]) -> list[StarField | None]:
    """Star detections for each frame of one sequence.

    On a tripod the foreground is identical in every frame while stars drift, so
    subtracting the sequence's per-pixel median leaves (almost) only stars and
    noise. Without it, tree and ridge texture is counted as "stars" and washes
    out every metric. If the sky barely moved (a short sequence), the median would
    contain the stars themselves, so the raw frames are used instead.
    """
    ok = [g for g in grays if g is not None]
    if not ok:
        return [None] * len(grays)
    shape = max({g.shape for g in ok}, key=lambda sh: sum(g.shape == sh for g in ok))
    same = [g for g in ok if g.shape == shape]

    def detect(g: np.ndarray, base: np.ndarray | None) -> StarField:
        f = detect_stars(g if base is None else cv2.subtract(g, base))
        f.background = float(np.median(g)) / 255.0  # judge the sky, not the residual
        return f

    base: np.ndarray | None = None
    if len(same) >= MIN_FOR_MEDIAN:
        first, last = detect_stars(same[0]), detect_stars(same[-1])
        if coincident_fraction(first, last) < SKY_STILL:
            step = max(1, len(same) // MEDIAN_FRAMES)
            base = np.median(np.stack(same[::step]), axis=0).astype(np.uint8)
    return [detect(g, base) if g is not None and g.shape == shape else None for g in grays]


def analyze_frames(
    conn: sqlite3.Connection, cache_dir: Path, image_ids: list[int]
) -> dict[str, Any]:
    """Measure stars in each frame, store the metrics, and recommend a cull.

    Returns {"frames": [...], "summary": {...}} with frames in capture order.
    Nothing about picks or rejects changes here — the caller decides.
    """
    if not image_ids:
        raise ValueError("no frames to analyse")
    marks = ",".join("?" * len(image_ids))
    rows = conn.execute(
        f"SELECT id, filename, captured_at, preview_path, thumb_path FROM image "
        f"WHERE id IN ({marks}) ORDER BY captured_at IS NULL, captured_at, filename",
        image_ids,
    ).fetchall()
    if not rows:
        raise ValueError("none of those frames are in this shoot")

    fields = measure_stars(
        [_read_gray(cache_dir / r["preview_path"] if r["preview_path"] else None) for r in rows]
    )
    metrics: list[FrameMetrics] = []
    for r, f in zip(rows, fields):
        image_id = int(r["id"])
        if f is None:
            fm, n_trails = FrameMetrics(image_id, None, None, None, None), 0
        else:
            fm, n_trails = FrameMetrics(image_id, f.count, f.fwhm, f.elongation, f.background), f.trails
        metrics.append(fm)
        conn.execute(
            "UPDATE image SET astro_stars=?, astro_fwhm=?, astro_elong=?, astro_bg=?, "
            "astro_trail=? WHERE id=?",
            (fm.stars, fm.fwhm, fm.elongation, fm.background, n_trails, image_id),
        )
    trails = {m.id: (f.trails if f else 0) for m, f in zip(metrics, fields)}

    verdicts = {v.id: v for v in judge(metrics)}
    star_counts = [m.stars for m in metrics if m.stars is not None]
    frames = []
    for r, m in zip(rows, metrics):
        v = verdicts[m.id]
        frames.append(
            {
                "id": m.id,
                "filename": r["filename"],
                "thumb_path": r["thumb_path"],
                **{k: val for k, val in asdict(m).items() if k != "id"},
                "trails": trails[m.id],
                "include": v.include,
                "reasons": v.reasons,
            }
        )
    return {
        "frames": frames,
        "summary": {
            "frames": len(frames),
            "median_stars": median(star_counts) if star_counts else 0,
            "recommended_include": sum(1 for f in frames if f["include"]),
        },
    }
