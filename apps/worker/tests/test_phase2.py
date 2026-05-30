"""Phase 2: scoring + scene grouping smoke tests."""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import piexif
from PIL import Image, ImageDraw, ImageFilter

from photocull.scenes import regroup
from photocull.shoot import Shoot


def _exif_bytes(when: datetime) -> bytes:
    """Build a minimal EXIF block with DateTimeOriginal set."""
    s = when.strftime("%Y:%m:%d %H:%M:%S")
    exif = {
        "0th": {piexif.ImageIFD.DateTime: s.encode()},
        "Exif": {
            piexif.ExifIFD.DateTimeOriginal: s.encode(),
            piexif.ExifIFD.DateTimeDigitized: s.encode(),
        },
    }
    return piexif.dump(exif)


def _make_image(path: Path, when: datetime, *, sharp: bool, content_seed: int) -> None:
    """Create a JPEG with EXIF timestamp and a distinct image pattern."""
    im = Image.new("RGB", (640, 480), (32, 32, 32))
    draw = ImageDraw.Draw(im)
    # Use the seed to draw different shapes — distinct pHash per "scene"
    for i in range(10):
        x = (content_seed * 37 + i * 53) % 600
        y = (content_seed * 23 + i * 41) % 440
        draw.rectangle([x, y, x + 30, y + 30], fill=(200, 180, 80))
        draw.ellipse([x + 5, y + 5, x + 25, y + 25], fill=(80, 180, 200))
    if not sharp:
        im = im.filter(ImageFilter.GaussianBlur(radius=6))
    im.save(path, "JPEG", quality=90, exif=_exif_bytes(when))


def test_scores_populated_during_ingest(tmp_path: Path) -> None:
    base = datetime(2026, 5, 1, 12, 0, 0)
    _make_image(tmp_path / "sharp.jpg", base, sharp=True, content_seed=1)
    _make_image(tmp_path / "blurry.jpg", base + timedelta(seconds=1), sharp=False, content_seed=1)

    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        rows = {r["filename"]: r for r in shoot.list_images()}
        sharp = rows["sharp.jpg"]
        blurry = rows["blurry.jpg"]

        assert sharp["score_focus"] is not None
        assert blurry["score_focus"] is not None
        assert sharp["score_focus"] > blurry["score_focus"], (
            f"expected sharp > blurry, got {sharp['score_focus']:.2f} vs {blurry['score_focus']:.2f}"
        )
        assert sharp["score_exposure"] is not None
        assert sharp["score_overall"] is not None
        assert sharp["phash"] is not None and len(sharp["phash"]) >= 8
    finally:
        shoot.close()


def test_scene_grouping_splits_on_time_gap(tmp_path: Path) -> None:
    base = datetime(2026, 5, 1, 12, 0, 0)
    # Scene A: 3 frames within 2 seconds
    _make_image(tmp_path / "a1.jpg", base, sharp=True, content_seed=1)
    _make_image(tmp_path / "a2.jpg", base + timedelta(seconds=1), sharp=True, content_seed=1)
    _make_image(tmp_path / "a3.jpg", base + timedelta(seconds=2), sharp=True, content_seed=1)
    # Scene B: 5 minutes later (way past adaptive threshold)
    _make_image(tmp_path / "b1.jpg", base + timedelta(minutes=5), sharp=True, content_seed=99)
    _make_image(tmp_path / "b2.jpg", base + timedelta(minutes=5, seconds=1), sharp=True, content_seed=99)

    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        scenes = shoot.list_scenes()
        assert len(scenes) == 2, f"expected 2 scenes, got {len(scenes)}: {scenes}"
        counts = sorted(s["image_count"] for s in scenes)
        assert counts == [2, 3]
    finally:
        shoot.close()


def test_regroup_is_idempotent(tmp_path: Path) -> None:
    base = datetime(2026, 5, 1, 12, 0, 0)
    for i in range(3):
        _make_image(tmp_path / f"{i}.jpg", base + timedelta(seconds=i), sharp=True, content_seed=1)
    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        first = shoot.list_scenes()
        shoot.regroup_scenes()
        second = shoot.list_scenes()
        assert len(first) == len(second)
        assert sum(s["image_count"] for s in second) == 3
    finally:
        shoot.close()
