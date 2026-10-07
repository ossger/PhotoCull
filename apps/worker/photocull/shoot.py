"""Per-shoot orchestration: holds the open DB connection and cache dir for a folder.

A "shoot" = one folder the user opened. We store its SQLite DB and thumbnail cache
inside the folder under `.photocull/` so the shoot is fully self-contained and
moves with the folder.
"""
from __future__ import annotations

import dataclasses
import logging
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from .db import connect, initialise_shoot, upsert_image
from .ingest import group_sources, ingest_one, walk_folder
from . import focus_meta
from . import scenes as scenes_mod
from .export import xmp as xmp_export

log = logging.getLogger(__name__)

CACHE_DIRNAME = ".photocull"
DB_FILENAME = "shoot.db"


class Shoot:
    """Open a folder as a culling 'shoot' — index its images, expose query/update API."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.cache_dir = self.root / CACHE_DIRNAME
        self.cache_dir.mkdir(exist_ok=True)
        self.db_path = self.cache_dir / DB_FILENAME
        self.conn: sqlite3.Connection = connect(self.db_path)
        initialise_shoot(self.conn, self.root)
        self._lock = threading.Lock()  # SQLite is fine but our writes assume serial

    # ---- ingest ----

    def ingest(
        self,
        progress: Callable[[int, int, str], None] | None = None,
        max_workers: int = 4,
    ) -> int:
        """Walk the folder, ingest every supported image, return the count.

        RAW+JPEG siblings (same folder, same stem) collapse to a single
        canonical file — the RAW — so each capture is culled once. Any
        shadowed sibling rows from a previous ingest are pruned below.
        """
        files, shadowed, shadow_map = group_sources(walk_folder(self.root))
        total = len(files)
        log.info("ingest: %d files under %s", total, self.root)
        if total == 0:
            return 0

        # Camera AF / focus-detection metadata for the whole shoot in one
        # batched exiftool pass (far faster than spawning per file). A miss
        # just means that file gets no AF fields — never fatal.
        focus_map = focus_meta.read_focus_batch(files)

        def _do(p: Path):
            try:
                return ingest_one(p, self.root, self.cache_dir, focus=focus_map.get(p))
            except Exception as exc:  # noqa: BLE001 - log and keep going
                log.warning("ingest failed for %s: %s", p, exc)
                return None

        done = 0
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = {ex.submit(_do, p): p for p in files}
            for fut in as_completed(futures):
                ingested = fut.result()
                done += 1
                if ingested is not None:
                    with self._lock:
                        upsert_image(self.conn, dataclasses.asdict(ingested))
                if progress is not None:
                    progress(done, total, str(futures[fut]))
        # Drop rows for siblings a previous ingest had inserted before pairing
        # existed (e.g. the JPEG next to a RAW). Before dropping each one, carry
        # its pick/star/color/crop over to the canonical RAW row if the RAW
        # doesn't already have a decision of its own — otherwise a JPEG picked
        # before its RAW sibling existed in the DB would silently lose that
        # pick (see the 2026-07 RAW+JPEG collapse incident).
        if shadowed:
            with self._lock:
                for shadow_path, canon_path in shadow_map.items():
                    shadow_rel = shadow_path.relative_to(self.root).as_posix()
                    canon_rel = canon_path.relative_to(self.root).as_posix()
                    shadow_row = self.conn.execute(
                        "SELECT pick, stars, color_label, crop_left, crop_top, "
                        "crop_right, crop_bottom FROM image WHERE rel_path = ?",
                        (shadow_rel,),
                    ).fetchone()
                    if shadow_row is None:
                        continue
                    canon_row = self.conn.execute(
                        "SELECT pick, stars, color_label, crop_left "
                        "FROM image WHERE rel_path = ?",
                        (canon_rel,),
                    ).fetchone()
                    canon_undecided = (
                        canon_row is not None
                        and canon_row["pick"] == 0
                        and canon_row["stars"] == 0
                        and canon_row["color_label"] is None
                        and canon_row["crop_left"] is None
                    )
                    has_decision = (
                        shadow_row["pick"] != 0
                        or shadow_row["stars"] != 0
                        or shadow_row["color_label"] is not None
                        or shadow_row["crop_left"] is not None
                    )
                    if canon_undecided and has_decision:
                        self.conn.execute(
                            "UPDATE image SET pick=?, stars=?, color_label=?, "
                            "crop_left=?, crop_top=?, crop_right=?, crop_bottom=? "
                            "WHERE rel_path = ?",
                            (
                                shadow_row["pick"],
                                shadow_row["stars"],
                                shadow_row["color_label"],
                                shadow_row["crop_left"],
                                shadow_row["crop_top"],
                                shadow_row["crop_right"],
                                shadow_row["crop_bottom"],
                                canon_rel,
                            ),
                        )
                shadow_rels = [(p.relative_to(self.root).as_posix(),) for p in shadowed]
                # scene.cover_image_id is a FK into image; a stale scene may
                # point at a shadowed row. regroup() rebuilds scenes just below,
                # so clear the table first to avoid a FK-constraint failure.
                self.conn.execute("DELETE FROM scene")
                self.conn.executemany(
                    "DELETE FROM image WHERE rel_path = ?", shadow_rels
                )
        # Now that every row has captured_at + phash, group into scenes.
        with self._lock:
            scenes_mod.regroup(self.conn)
        return done

    # ---- queries ----

    def list_images(self) -> list[dict[str, Any]]:
        cur = self.conn.execute(
            """
            SELECT id, rel_path, filename, captured_at, camera_make, camera_model, lens,
                   iso, shutter, aperture, focal_length, width, height, orientation,
                   focus_mode, af_area_mode, af_points_in_focus,
                   pick, stars, color_label, scene_id, phash,
                   score_focus, score_exposure, score_eyes, n_faces, faces_json,
                   score_aesthetic, score_overall,
                   thumb_path, preview_path, full_path,
                   crop_left, crop_top, crop_right, crop_bottom
            FROM image
            ORDER BY captured_at IS NULL, captured_at, filename
            """
        )
        return [dict(r) for r in cur.fetchall()]

    def get_image(self, image_id: int) -> dict[str, Any] | None:
        cur = self.conn.execute("SELECT * FROM image WHERE id = ?", (image_id,))
        row = cur.fetchone()
        return dict(row) if row else None

    def list_scenes(self) -> list[dict[str, Any]]:
        cur = self.conn.execute(
            """
            SELECT s.id, s.label, s.starts_at, s.ends_at, s.cover_image_id, s.manual,
                   (SELECT COUNT(*) FROM image i WHERE i.scene_id = s.id) AS image_count,
                   (SELECT thumb_path FROM image WHERE id = s.cover_image_id) AS cover_thumb,
                   (SELECT AVG(score_overall) FROM image WHERE scene_id = s.id) AS avg_score
            FROM scene s
            ORDER BY COALESCE(s.starts_at, ''), s.id
            """
        )
        return [dict(r) for r in cur.fetchall()]

    def regroup_scenes(self, force: bool = False) -> int:
        with self._lock:
            return scenes_mod.regroup(self.conn, force=force)

    # ---- manual scene edits ----

    def merge_scenes(self, scene_ids: list[int]) -> int:
        with self._lock:
            return scenes_mod.merge_scenes(self.conn, scene_ids)

    def split_scene(self, scene_id: int, at_image_id: int) -> int:
        with self._lock:
            return scenes_mod.split_scene(self.conn, scene_id, at_image_id)

    def update_scene(
        self, scene_id: int, label: str | None = None, cover_image_id: int | None = None
    ) -> None:
        with self._lock:
            if label is not None:
                scenes_mod.rename_scene(self.conn, scene_id, label)
            if cover_image_id is not None:
                scenes_mod.set_cover(self.conn, scene_id, cover_image_id)

    def move_images_to_scene(self, image_ids: list[int], scene_id: int | None) -> int:
        with self._lock:
            return scenes_mod.move_images_to_scene(self.conn, image_ids, scene_id)

    # ---- export ----

    def export_xmp(
        self, only_picked: bool = False, image_ids: list[int] | None = None
    ) -> dict[str, Any]:
        """Write XMP sidecars for images. With only_picked=True, skip everything
        not marked as a pick (pick != 1). With image_ids given, restrict to just
        those rows — e.g. the renderer's current advanced-filter matches —
        combinable with only_picked (both apply, AND'd together)."""
        clauses: list[str] = []
        params: list[Any] = []
        if only_picked:
            clauses.append("pick = 1")
        if image_ids is not None:
            if not image_ids:
                return {"written": 0, "failed": 0, "sidecars": []}
            placeholders = ",".join("?" for _ in image_ids)
            clauses.append(f"id IN ({placeholders})")
            params.extend(image_ids)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur = self.conn.execute(
            f"""
            SELECT rel_path, pick, stars, color_label, score_overall,
                   crop_left, crop_top, crop_right, crop_bottom
            FROM image
            {where}
            """,
            params,
        )
        fields: list[xmp_export.XmpFields] = []
        for r in cur.fetchall():
            crop = None
            if r["crop_left"] is not None:
                crop = xmp_export.CropRect(
                    left=float(r["crop_left"]),
                    top=float(r["crop_top"]),
                    right=float(r["crop_right"]),
                    bottom=float(r["crop_bottom"]),
                )
            fields.append(
                xmp_export.XmpFields(
                    source_path=self.root / r["rel_path"],
                    pick=int(r["pick"]),
                    stars=int(r["stars"]),
                    color_label=r["color_label"],
                    score_overall=r["score_overall"],
                    crop=crop,
                )
            )
        result = xmp_export.write_sidecars(fields)
        return {
            "written": result.written,
            "failed": result.failed,
            "sidecars": [str(p) for p in result.sidecars],
        }

    # ---- mutations ----

    def set_pick(self, image_id: int, pick: int) -> None:
        if pick not in (-1, 0, 1):
            raise ValueError("pick must be -1, 0, or 1")
        with self._lock:
            self.conn.execute("UPDATE image SET pick = ? WHERE id = ?", (pick, image_id))

    def set_stars(self, image_id: int, stars: int) -> None:
        if not 0 <= stars <= 5:
            raise ValueError("stars must be 0..5")
        with self._lock:
            self.conn.execute("UPDATE image SET stars = ? WHERE id = ?", (stars, image_id))

    def set_color_label(self, image_id: int, label: str | None) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE image SET color_label = ? WHERE id = ?", (label, image_id)
            )

    # ---- batch mutations (multi-select culling) ----
    #
    # Same validation as the singular setters above, applied to a list of ids
    # in one executemany — so selecting a burst of frames and pressing a
    # hotkey is one DB round-trip, not one per frame. An empty id list is a
    # deliberate no-op rather than an error.

    def set_pick_many(self, image_ids: list[int], pick: int) -> None:
        if pick not in (-1, 0, 1):
            raise ValueError("pick must be -1, 0, or 1")
        if not image_ids:
            return
        with self._lock:
            self.conn.executemany(
                "UPDATE image SET pick = ? WHERE id = ?",
                [(pick, image_id) for image_id in image_ids],
            )

    def set_stars_many(self, image_ids: list[int], stars: int) -> None:
        if not 0 <= stars <= 5:
            raise ValueError("stars must be 0..5")
        if not image_ids:
            return
        with self._lock:
            self.conn.executemany(
                "UPDATE image SET stars = ? WHERE id = ?",
                [(stars, image_id) for image_id in image_ids],
            )

    def set_color_label_many(self, image_ids: list[int], label: str | None) -> None:
        if not image_ids:
            return
        with self._lock:
            self.conn.executemany(
                "UPDATE image SET color_label = ? WHERE id = ?",
                [(label, image_id) for image_id in image_ids],
            )

    def set_crop(
        self,
        image_id: int,
        left: float | None,
        top: float | None,
        right: float | None,
        bottom: float | None,
    ) -> None:
        """Set a normalised crop rect, or clear it by passing all-None.

        Validates 0 <= left < right <= 1 and 0 <= top < bottom <= 1 so we never
        write a nonsensical crop into XMP downstream.
        """
        any_set = any(v is not None for v in (left, top, right, bottom))
        if not any_set:
            with self._lock:
                self.conn.execute(
                    "UPDATE image SET crop_left=NULL, crop_top=NULL, "
                    "crop_right=NULL, crop_bottom=NULL WHERE id = ?",
                    (image_id,),
                )
            return
        if None in (left, top, right, bottom):
            raise ValueError("crop requires all four bounds (or all None to clear)")
        if not (0.0 <= left < right <= 1.0):  # type: ignore[operator]
            raise ValueError(f"crop horizontal bounds invalid: {left}..{right}")
        if not (0.0 <= top < bottom <= 1.0):  # type: ignore[operator]
            raise ValueError(f"crop vertical bounds invalid: {top}..{bottom}")
        with self._lock:
            self.conn.execute(
                "UPDATE image SET crop_left=?, crop_top=?, crop_right=?, crop_bottom=? "
                "WHERE id = ?",
                (left, top, right, bottom, image_id),
            )

    # ---- file access ----

    def thumb_file(self, rel: str) -> Path:
        return self.cache_dir / rel

    def original_file(self, rel: str) -> Path:
        return self.root / rel

    def close(self) -> None:
        with self._lock:
            self.conn.close()
