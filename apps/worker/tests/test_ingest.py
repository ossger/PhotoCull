"""Smoke tests for ingest + shoot DB. Run with `pytest apps/worker`."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from photocull.ingest import group_sources
from photocull.shoot import Shoot


def _make_jpeg(path: Path, size: tuple[int, int] = (160, 120), colour: tuple[int, int, int] = (128, 64, 200)) -> None:
    Image.new("RGB", size, colour).save(path, "JPEG", quality=85)


def test_ingest_creates_rows_and_thumbs(tmp_path: Path) -> None:
    for i in range(3):
        _make_jpeg(tmp_path / f"shot_{i}.jpg")
    shoot = Shoot(tmp_path)
    try:
        count = shoot.ingest()
        assert count == 3
        rows = shoot.list_images()
        assert len(rows) == 3
        for r in rows:
            assert r["filename"].endswith(".jpg")
            assert r["thumb_path"] is not None
            assert (shoot.cache_dir / r["thumb_path"]).is_file()
            assert r["preview_path"] is not None
            assert (shoot.cache_dir / r["preview_path"]).is_file()
            assert r["pick"] == 0
            assert r["stars"] == 0
    finally:
        shoot.close()


def test_group_sources_prefers_raw_over_jpeg() -> None:
    files = [Path("/shoot/IMG_1234.CR3"), Path("/shoot/IMG_1234.JPG")]
    canonical, shadowed, shadow_map = group_sources(files)
    assert canonical == [Path("/shoot/IMG_1234.CR3")]
    assert shadowed == [Path("/shoot/IMG_1234.JPG")]
    assert shadow_map == {Path("/shoot/IMG_1234.JPG"): Path("/shoot/IMG_1234.CR3")}


def test_group_sources_passes_singletons_through() -> None:
    files = [Path("/shoot/raw_only.NEF"), Path("/shoot/jpeg_only.jpg")]
    canonical, shadowed, _ = group_sources(files)
    assert canonical == files
    assert shadowed == []


def test_group_sources_does_not_pair_across_folders() -> None:
    files = [Path("/shoot/a/IMG_1.CR3"), Path("/shoot/b/IMG_1.JPG")]
    canonical, shadowed, _ = group_sources(files)
    assert canonical == files
    assert shadowed == []


def test_group_sources_stem_match_is_case_insensitive() -> None:
    files = [Path("/shoot/IMG_1.CR3"), Path("/shoot/img_1.JPG")]
    canonical, shadowed, _ = group_sources(files)
    assert canonical == [Path("/shoot/IMG_1.CR3")]
    assert shadowed == [Path("/shoot/img_1.JPG")]


def test_group_sources_partitions_mixed_set_preserving_order() -> None:
    files = [
        Path("/shoot/A.CR3"),
        Path("/shoot/A.JPG"),   # shadowed by A.CR3
        Path("/shoot/B.JPG"),   # jpeg-only, canonical
        Path("/shoot/C.NEF"),   # raw-only, canonical
    ]
    canonical, shadowed, _ = group_sources(files)
    assert canonical == [Path("/shoot/A.CR3"), Path("/shoot/B.JPG"), Path("/shoot/C.NEF")]
    assert shadowed == [Path("/shoot/A.JPG")]


def test_reingest_prunes_shadowed_row_that_was_a_scene_cover(tmp_path: Path) -> None:
    """A pre-pairing DB may hold a sibling row that a scene uses as its cover.
    Re-ingest must prune it without tripping the scene->image FK constraint."""
    from photocull.db import upsert_image
    from photocull.ingest import group_sources, walk_folder

    # Same-stem siblings (both JPEG so one shadows the other) + an unrelated shot.
    _make_jpeg(tmp_path / "img.jpeg")
    _make_jpeg(tmp_path / "img.jpg")
    _make_jpeg(tmp_path / "other.jpg")

    shoot = Shoot(tmp_path)
    try:
        _, shadowed, _ = group_sources(walk_folder(tmp_path))
        assert shadowed, "expected one sibling to be shadowed"
        shadow_rel = shadowed[0].relative_to(tmp_path).as_posix()

        # Seed the state the old (pre-pairing) code would have left: the shadowed
        # sibling as a real row, referenced as a scene's cover image.
        rid = upsert_image(
            shoot.conn, {"rel_path": shadow_rel, "filename": shadowed[0].name}
        )
        shoot.conn.execute(
            "INSERT INTO scene (label, cover_image_id) VALUES ('stale', ?)", (rid,)
        )

        shoot.ingest()  # must not raise

        rels = {r["rel_path"] for r in shoot.list_images()}
        assert shadow_rel not in rels
        assert len(rels) == 2  # canonical sibling + the unrelated shot
    finally:
        shoot.close()


def test_transfer_decision_from_shadowed_jpeg_to_canonical(tmp_path: Path) -> None:
    """A JPEG picked before its RAW sibling had its own DB row (the pre-pairing
    era) must have that pick/star/color carried over to the canonical row, not
    silently dropped when the shadowed row is pruned."""
    from photocull.db import upsert_image
    from photocull.ingest import group_sources, walk_folder

    _make_jpeg(tmp_path / "img.jpeg")
    _make_jpeg(tmp_path / "img.jpg")

    shoot = Shoot(tmp_path)
    try:
        _, shadowed, shadow_map = group_sources(walk_folder(tmp_path))
        assert shadowed, "expected one sibling to be shadowed"
        shadow_path = shadowed[0]
        canon_path = shadow_map[shadow_path]
        shadow_rel = shadow_path.relative_to(tmp_path).as_posix()
        canon_rel = canon_path.relative_to(tmp_path).as_posix()

        # Seed the shadowed row as a real, previously-picked row.
        upsert_image(shoot.conn, {"rel_path": shadow_rel, "filename": shadow_path.name})
        shoot.conn.execute(
            "UPDATE image SET pick=1, stars=4, color_label='Red' WHERE rel_path=?",
            (shadow_rel,),
        )

        shoot.ingest()

        rels = {r["rel_path"] for r in shoot.list_images()}
        assert shadow_rel not in rels
        canon = next(r for r in shoot.list_images() if r["rel_path"] == canon_rel)
        assert canon["pick"] == 1
        assert canon["stars"] == 4
        assert canon["color_label"] == "Red"
    finally:
        shoot.close()


def test_transfer_does_not_overwrite_canonicals_existing_decision(tmp_path: Path) -> None:
    """If the RAW already has its own decision, a shadowed sibling's old
    pick/stars must not clobber it."""
    from photocull.db import upsert_image
    from photocull.ingest import group_sources, walk_folder

    _make_jpeg(tmp_path / "img.jpeg")
    _make_jpeg(tmp_path / "img.jpg")

    shoot = Shoot(tmp_path)
    try:
        _, shadowed, shadow_map = group_sources(walk_folder(tmp_path))
        shadow_path = shadowed[0]
        canon_path = shadow_map[shadow_path]
        shadow_rel = shadow_path.relative_to(tmp_path).as_posix()
        canon_rel = canon_path.relative_to(tmp_path).as_posix()

        # Seed both rows already decided: canonical pick=1/2 stars, shadow reject/4 stars.
        upsert_image(shoot.conn, {"rel_path": canon_rel, "filename": canon_path.name})
        upsert_image(shoot.conn, {"rel_path": shadow_rel, "filename": shadow_path.name})
        shoot.conn.execute("UPDATE image SET pick=1, stars=2 WHERE rel_path=?", (canon_rel,))
        shoot.conn.execute("UPDATE image SET pick=-1, stars=4 WHERE rel_path=?", (shadow_rel,))

        shoot.ingest()

        rels = {r["rel_path"] for r in shoot.list_images()}
        assert shadow_rel not in rels
        canon = next(r for r in shoot.list_images() if r["rel_path"] == canon_rel)
        assert canon["pick"] == 1  # unchanged, not overwritten by the shadow's -1
        assert canon["stars"] == 2
    finally:
        shoot.close()


def test_pick_and_stars_round_trip(tmp_path: Path) -> None:
    _make_jpeg(tmp_path / "a.jpg")
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        img = shoot.list_images()[0]
        shoot.set_pick(img["id"], 1)
        shoot.set_stars(img["id"], 4)
        refreshed = shoot.get_image(img["id"])
        assert refreshed is not None
        assert refreshed["pick"] == 1
        assert refreshed["stars"] == 4
    finally:
        shoot.close()
