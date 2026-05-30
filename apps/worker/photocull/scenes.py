"""Group a shoot's images into scenes.

Two-signal algorithm — closely mirrors what Narrative Select does:

1. **Time gap clustering.** Sort by EXIF DateTimeOriginal; whenever the gap
   between adjacent frames exceeds a threshold, start a new scene. The
   threshold is *adaptive*: derived from the shoot's median inter-frame gap,
   so a wedding ceremony (constant 1-2s bursts) and a portrait session
   (variable 10-60s gaps) both group reasonably without manual tuning.

2. **Visual similarity refinement.** Within a tentative time cluster, we also
   look at perceptual-hash (pHash) Hamming distance between adjacent frames.
   If a pair suddenly jumps in visual content despite small time delta
   (photographer pivoted between two subjects), we split the cluster there.

Frames without timestamps are appended to a trailing "untimed" scene rather
than dropped — keeps the UI predictable.
"""
from __future__ import annotations

import logging
import sqlite3
import statistics
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

import imagehash
from PIL import Image

log = logging.getLogger(__name__)

# Fallback / floor / ceiling time thresholds (seconds)
DEFAULT_GAP_S = 8.0
MIN_GAP_S = 3.0
MAX_GAP_S = 60.0
# pHash hamming distance (out of 64) — adjacent frames above this start a new scene
PHASH_SPLIT_THRESHOLD = 18


@dataclass(slots=True)
class _Row:
    id: int
    captured_at: datetime | None
    phash: imagehash.ImageHash | None
    score: float | None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_phash(value: str | None) -> imagehash.ImageHash | None:
    if not value:
        return None
    try:
        return imagehash.hex_to_hash(value)
    except (ValueError, TypeError):
        return None


def _adaptive_gap(rows: list[_Row]) -> float:
    deltas: list[float] = []
    prev: datetime | None = None
    for r in rows:
        if r.captured_at is None:
            continue
        if prev is not None:
            deltas.append((r.captured_at - prev).total_seconds())
        prev = r.captured_at
    if not deltas:
        return DEFAULT_GAP_S
    med = statistics.median(deltas)
    # 4x the typical inter-frame gap, with sane floor/ceiling.
    return max(MIN_GAP_S, min(MAX_GAP_S, med * 4.0))


def compute_phash_for_thumb(thumb_path: str) -> str:
    """Compute a 64-bit pHash hex string for a thumbnail file."""
    with Image.open(thumb_path) as im:
        return str(imagehash.phash(im))


def regroup(conn: sqlite3.Connection) -> int:
    """Recompute scene groupings from the current image rows. Returns scene count."""
    cur = conn.execute(
        "SELECT id, captured_at, phash, score_overall FROM image "
        "ORDER BY captured_at IS NULL, captured_at, filename"
    )
    rows = [
        _Row(
            id=int(r["id"]),
            captured_at=_parse_iso(r["captured_at"]),
            phash=_parse_phash(r["phash"]),
            score=r["score_overall"],
        )
        for r in cur.fetchall()
    ]
    if not rows:
        return 0

    gap_threshold = _adaptive_gap(rows)
    log.info("scene grouping: %d images, gap=%.1fs", len(rows), gap_threshold)

    # Wipe and rebuild scenes table — cheap for shoot-scale data (<10k images).
    conn.execute("DELETE FROM scene")
    conn.execute("UPDATE image SET scene_id = NULL")

    scenes: list[list[_Row]] = []
    current: list[_Row] = []
    prev: _Row | None = None
    for row in rows:
        if not current:
            current = [row]
            prev = row
            continue
        split = False
        # Time-based split
        if prev and prev.captured_at and row.captured_at:
            if (row.captured_at - prev.captured_at).total_seconds() > gap_threshold:
                split = True
        elif prev and (prev.captured_at is None) != (row.captured_at is None):
            # Boundary between timed and untimed images
            split = True
        # pHash refinement: only when both sides have hashes and we haven't already split
        if not split and prev and prev.phash and row.phash:
            if (prev.phash - row.phash) > PHASH_SPLIT_THRESHOLD:
                split = True
        if split:
            scenes.append(current)
            current = [row]
        else:
            current.append(row)
        prev = row
    if current:
        scenes.append(current)

    for idx, group in enumerate(scenes, start=1):
        timed = [r for r in group if r.captured_at]
        starts = min((r.captured_at for r in timed), default=None)
        ends = max((r.captured_at for r in timed), default=None)
        # Cover = highest-scoring image in the group; falls back to first if
        # no scores yet (e.g. ingest before scoring landed).
        scored = [r for r in group if r.score is not None]
        cover = max(scored, key=lambda r: r.score or 0.0) if scored else group[0]
        cur = conn.execute(
            "INSERT INTO scene (label, starts_at, ends_at, cover_image_id) VALUES (?, ?, ?, ?)",
            (
                f"Scene {idx}",
                starts.isoformat() if starts else None,
                ends.isoformat() if ends else None,
                cover.id,
            ),
        )
        scene_id = int(cur.lastrowid or 0)
        conn.executemany(
            "UPDATE image SET scene_id = ? WHERE id = ?",
            [(scene_id, r.id) for r in group],
        )
    log.info("scene grouping: %d scenes", len(scenes))
    return len(scenes)
