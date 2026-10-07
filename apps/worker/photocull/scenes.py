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


def regroup(conn: sqlite3.Connection, force: bool = False) -> int:
    """Recompute automatic scene groupings. Returns the total scene count.

    Hand-edited scenes (`scene.manual = 1`) and their images are left alone so
    a re-ingest doesn't undo a merge/split/rename; only unassigned images and
    images in automatic scenes are regrouped. `force=True` discards the manual
    edits too and rebuilds everything.
    """
    if force:
        conn.execute("DELETE FROM scene")
        conn.execute("UPDATE image SET scene_id = NULL")
    else:
        conn.execute("DELETE FROM scene WHERE manual = 0")
        conn.execute(
            "UPDATE image SET scene_id = NULL "
            "WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM scene)"
        )
    cur = conn.execute(
        "SELECT id, captured_at, phash, score_overall FROM image "
        "WHERE scene_id IS NULL "
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
    manual_count = int(conn.execute("SELECT COUNT(*) FROM scene").fetchone()[0])
    if not rows:
        return manual_count

    gap_threshold = _adaptive_gap(rows)
    log.info("scene grouping: %d images, gap=%.1fs", len(rows), gap_threshold)

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
                f"Scene {manual_count + idx}",
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
    return manual_count + len(scenes)


# ---- manual scene edits ----
#
# Every edit marks the scenes it touches `manual = 1` so regroup() preserves
# them. Callers hold Shoot's lock; each function is one logical transaction.

def _refresh_scene(conn: sqlite3.Connection, scene_id: int, new_cover: int | None = None) -> bool:
    """Recompute bounds + cover for a scene; delete it if it has no images.

    Returns True if the scene still exists.
    """
    rows = conn.execute(
        "SELECT id, captured_at, score_overall FROM image WHERE scene_id = ? "
        "ORDER BY captured_at IS NULL, captured_at, filename",
        (scene_id,),
    ).fetchall()
    if not rows:
        conn.execute("DELETE FROM scene WHERE id = ?", (scene_id,))
        return False
    times = [t for t in (_parse_iso(r["captured_at"]) for r in rows) if t]
    starts = min(times, default=None)
    ends = max(times, default=None)
    ids = {int(r["id"]) for r in rows}
    cover = conn.execute(
        "SELECT cover_image_id FROM scene WHERE id = ?", (scene_id,)
    ).fetchone()
    cover_id = new_cover if new_cover in ids else (
        cover["cover_image_id"] if cover and cover["cover_image_id"] in ids else None
    )
    if cover_id is None:
        scored = [r for r in rows if r["score_overall"] is not None]
        best = max(scored, key=lambda r: r["score_overall"]) if scored else rows[0]
        cover_id = int(best["id"])
    conn.execute(
        "UPDATE scene SET starts_at = ?, ends_at = ?, cover_image_id = ?, manual = 1 "
        "WHERE id = ?",
        (
            starts.isoformat() if starts else None,
            ends.isoformat() if ends else None,
            cover_id,
            scene_id,
        ),
    )
    return True


def _scene_order(conn: sqlite3.Connection, scene_ids: list[int]) -> list[int]:
    if not scene_ids:
        return []
    marks = ",".join("?" * len(scene_ids))
    rows = conn.execute(
        f"SELECT id FROM scene WHERE id IN ({marks}) "
        "ORDER BY COALESCE(starts_at, ''), id",
        scene_ids,
    ).fetchall()
    return [int(r["id"]) for r in rows]


def merge_scenes(conn: sqlite3.Connection, scene_ids: list[int]) -> int:
    """Merge scenes into the earliest of them. Returns the surviving scene id."""
    ordered = _scene_order(conn, list(dict.fromkeys(scene_ids)))
    if len(ordered) < 2:
        raise ValueError("need at least two existing scenes to merge")
    target, others = ordered[0], ordered[1:]
    marks = ",".join("?" * len(others))
    conn.execute(f"UPDATE image SET scene_id = ? WHERE scene_id IN ({marks})", [target, *others])
    conn.execute(f"DELETE FROM scene WHERE id IN ({marks})", others)
    _refresh_scene(conn, target)
    return target


def split_scene(conn: sqlite3.Connection, scene_id: int, at_image_id: int) -> int:
    """Split a scene: `at_image_id` and every later frame move to a new scene.

    Returns the new scene id.
    """
    rows = conn.execute(
        "SELECT id FROM image WHERE scene_id = ? "
        "ORDER BY captured_at IS NULL, captured_at, filename",
        (scene_id,),
    ).fetchall()
    ids = [int(r["id"]) for r in rows]
    if at_image_id not in ids:
        raise ValueError("image is not in that scene")
    idx = ids.index(at_image_id)
    if idx == 0:
        raise ValueError("cannot split at the first frame of a scene")
    label = conn.execute("SELECT label FROM scene WHERE id = ?", (scene_id,)).fetchone()["label"]
    cur = conn.execute(
        "INSERT INTO scene (label, manual) VALUES (?, 1)", (f"{label} (2)" if label else None,)
    )
    new_id = int(cur.lastrowid or 0)
    conn.executemany(
        "UPDATE image SET scene_id = ? WHERE id = ?", [(new_id, i) for i in ids[idx:]]
    )
    _refresh_scene(conn, scene_id)
    _refresh_scene(conn, new_id)
    return new_id


def rename_scene(conn: sqlite3.Connection, scene_id: int, label: str) -> None:
    label = label.strip()
    if not label:
        raise ValueError("label must not be empty")
    cur = conn.execute(
        "UPDATE scene SET label = ?, manual = 1 WHERE id = ?", (label, scene_id)
    )
    if cur.rowcount == 0:
        raise ValueError("no such scene")


def set_cover(conn: sqlite3.Connection, scene_id: int, image_id: int) -> None:
    row = conn.execute("SELECT 1 FROM image WHERE id = ? AND scene_id = ?", (image_id, scene_id)).fetchone()
    if row is None:
        raise ValueError("image is not in that scene")
    conn.execute(
        "UPDATE scene SET cover_image_id = ?, manual = 1 WHERE id = ?", (image_id, scene_id)
    )


def move_images_to_scene(
    conn: sqlite3.Connection, image_ids: list[int], scene_id: int | None
) -> int:
    """Move images into an existing scene, or into a new one when `scene_id` is None.

    Source scenes left empty are deleted. Returns the destination scene id.
    """
    if not image_ids:
        raise ValueError("no images to move")
    marks = ",".join("?" * len(image_ids))
    sources = {
        int(r["scene_id"])
        for r in conn.execute(
            f"SELECT DISTINCT scene_id FROM image WHERE id IN ({marks}) AND scene_id IS NOT NULL",
            image_ids,
        ).fetchall()
    }
    if scene_id is None:
        cur = conn.execute("INSERT INTO scene (label, manual) VALUES (?, 1)", ("New scene",))
        scene_id = int(cur.lastrowid or 0)
    elif conn.execute("SELECT 1 FROM scene WHERE id = ?", (scene_id,)).fetchone() is None:
        raise ValueError("no such scene")
    conn.execute(f"UPDATE image SET scene_id = ? WHERE id IN ({marks})", [scene_id, *image_ids])
    _refresh_scene(conn, scene_id)
    for src in sources - {scene_id}:
        _refresh_scene(conn, src)
    return scene_id
