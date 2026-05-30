"""Smoke tests for ingest + shoot DB. Run with `pytest apps/worker`."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

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
