"""XMP export integration test. First run downloads exiftool (~5MB)."""
from __future__ import annotations

import re
from pathlib import Path

import piexif
import pytest
from PIL import Image

from photocull import server
from photocull.server import ExportBody
from photocull.shoot import Shoot


def _make_jpeg(path: Path) -> None:
    exif = {
        "0th": {piexif.ImageIFD.DateTime: b"2026:05:27 10:00:00"},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:05:27 10:00:00"},
    }
    Image.new("RGB", (320, 240), (40, 80, 120)).save(
        path, "JPEG", quality=85, exif=piexif.dump(exif)
    )


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def test_export_writes_picks_with_rating_and_label(tmp_path: Path) -> None:
    for n in ("pick.jpg", "reject.jpg", "ignored.jpg"):
        _make_jpeg(tmp_path / n)

    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        rows = {r["filename"]: r for r in shoot.list_images()}
        shoot.set_pick(rows["pick.jpg"]["id"], 1)
        shoot.set_stars(rows["pick.jpg"]["id"], 4)
        shoot.set_pick(rows["reject.jpg"]["id"], -1)
        # ignored.jpg left alone

        result = shoot.export_xmp(only_picked=False)
        assert result["written"] == 3, result

        pick_xmp = _read_text(tmp_path / "pick.jpg.xmp")
        reject_xmp = _read_text(tmp_path / "reject.jpg.xmp")
        ignored_xmp = _read_text(tmp_path / "ignored.jpg.xmp")

        # Pick = green label + 4 stars
        assert re.search(r"xmp:Rating>4<", pick_xmp), pick_xmp
        assert "xmp:Label>Pick<" in pick_xmp, pick_xmp
        # Reject = -1 rating (Adobe convention)
        assert re.search(r"xmp:Rating>-1<", reject_xmp), reject_xmp
        # Ignored = no rating/label tags written (or empty)
        assert "xmp:Rating>" not in ignored_xmp or "xmp:Rating></xmp:Rating>" in ignored_xmp
    finally:
        shoot.close()


def test_export_only_picked_filters(tmp_path: Path) -> None:
    for n in ("a.jpg", "b.jpg"):
        _make_jpeg(tmp_path / n)
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        rows = {r["filename"]: r for r in shoot.list_images()}
        shoot.set_pick(rows["a.jpg"]["id"], 1)
        result = shoot.export_xmp(only_picked=True)
        assert result["written"] == 1
        assert (tmp_path / "a.jpg.xmp").exists()
        assert not (tmp_path / "b.jpg.xmp").exists()
    finally:
        shoot.close()


def test_crop_round_trip_into_xmp(tmp_path: Path) -> None:
    _make_jpeg(tmp_path / "cropped.jpg")
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        row = shoot.list_images()[0]
        shoot.set_pick(row["id"], 1)
        shoot.set_crop(row["id"], 0.1, 0.2, 0.8, 0.9)

        # Crop persists to the row
        refreshed = shoot.get_image(row["id"])
        assert refreshed is not None
        assert refreshed["crop_left"] == 0.1
        assert refreshed["crop_top"] == 0.2
        assert refreshed["crop_right"] == 0.8
        assert refreshed["crop_bottom"] == 0.9

        shoot.export_xmp(only_picked=True)
        xmp = (tmp_path / "cropped.jpg.xmp").read_text(encoding="utf-8")
        assert "crs:HasCrop>True<" in xmp
        # exiftool may emit with full precision; check the leading digits
        assert "crs:CropLeft>0.1" in xmp
        assert "crs:CropTop>0.2" in xmp
        assert "crs:CropRight>0.8" in xmp
        assert "crs:CropBottom>0.9" in xmp

        # Clearing the crop removes it on next export
        shoot.set_crop(row["id"], None, None, None, None)
        shoot.export_xmp(only_picked=True)
        xmp2 = (tmp_path / "cropped.jpg.xmp").read_text(encoding="utf-8")
        assert "crs:HasCrop>True<" not in xmp2
    finally:
        shoot.close()


def test_crop_rejects_invalid_bounds(tmp_path: Path) -> None:
    _make_jpeg(tmp_path / "x.jpg")
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        row = shoot.list_images()[0]
        with pytest.raises(ValueError):
            shoot.set_crop(row["id"], 0.5, 0.0, 0.4, 1.0)  # left >= right
        with pytest.raises(ValueError):
            shoot.set_crop(row["id"], 0.0, 0.0, 1.0, 1.5)  # bottom > 1
        with pytest.raises(ValueError):
            shoot.set_crop(row["id"], 0.0, None, 1.0, 1.0)  # partial
    finally:
        shoot.close()


# ----- image_ids export (advanced-filter "Export matches") -----


def test_export_by_image_ids_filters(tmp_path: Path) -> None:
    for n in ("a.jpg", "b.jpg", "c.jpg"):
        _make_jpeg(tmp_path / n)
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        rows = {r["filename"]: r for r in shoot.list_images()}
        ids = [rows["a.jpg"]["id"], rows["c.jpg"]["id"]]

        # None of these are picked — image_ids alone must still select them,
        # independent of only_picked (the "export matches" path).
        result = shoot.export_xmp(only_picked=False, image_ids=ids)
        assert result["written"] == 2, result
        assert (tmp_path / "a.jpg.xmp").exists()
        assert (tmp_path / "c.jpg.xmp").exists()
        assert not (tmp_path / "b.jpg.xmp").exists()
    finally:
        shoot.close()


def test_export_by_image_ids_combines_with_only_picked(tmp_path: Path) -> None:
    for n in ("a.jpg", "b.jpg"):
        _make_jpeg(tmp_path / n)
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        rows = {r["filename"]: r for r in shoot.list_images()}
        # a.jpg is picked and in the id list; b.jpg is in the id list but not
        # picked — only_picked=True should still exclude it (AND, not OR).
        shoot.set_pick(rows["a.jpg"]["id"], 1)
        ids = [rows["a.jpg"]["id"], rows["b.jpg"]["id"]]

        result = shoot.export_xmp(only_picked=True, image_ids=ids)
        assert result["written"] == 1, result
        assert (tmp_path / "a.jpg.xmp").exists()
        assert not (tmp_path / "b.jpg.xmp").exists()
    finally:
        shoot.close()


def test_export_by_image_ids_empty_list_writes_nothing(tmp_path: Path) -> None:
    _make_jpeg(tmp_path / "a.jpg")
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        # An empty match set (e.g. an over-narrow filter) must short-circuit
        # rather than fall through to "no id filter at all".
        result = shoot.export_xmp(only_picked=False, image_ids=[])
        assert result == {"written": 0, "failed": 0, "sidecars": []}
        assert not (tmp_path / "a.jpg.xmp").exists()
    finally:
        shoot.close()


def test_export_route_with_image_ids(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for n in ("a.jpg", "b.jpg"):
        _make_jpeg(tmp_path / n)
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        monkeypatch.setattr(server, "_shoot", shoot)
        rows = {r["filename"]: r for r in shoot.list_images()}
        ids = [rows["b.jpg"]["id"]]

        result = server.export_xmp(ExportBody(only_picked=False, image_ids=ids))
        assert result["written"] == 1, result
        assert (tmp_path / "b.jpg.xmp").exists()
        assert not (tmp_path / "a.jpg.xmp").exists()
    finally:
        shoot.close()
