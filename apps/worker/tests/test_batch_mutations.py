"""Batch pick/stars/color mutations — the multi-select culling backend.

Covers the Shoot-level executemany methods and the route layer that wraps
them. Route functions are called directly (like test_organize_server.py) by
pointing photocull.server._shoot at a real Shoot rather than spinning up a
TestClient/httpx server.
"""
from __future__ import annotations

from pathlib import Path

import piexif
import pytest
from PIL import Image
from pydantic import ValidationError

from photocull import server
from photocull.server import BatchColorBody, BatchPickBody, BatchStarsBody
from photocull.shoot import Shoot


def _make_jpeg(path: Path) -> None:
    exif = {
        "0th": {piexif.ImageIFD.DateTime: b"2026:05:27 10:00:00"},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:05:27 10:00:00"},
    }
    Image.new("RGB", (320, 240), (40, 80, 120)).save(
        path, "JPEG", quality=85, exif=piexif.dump(exif)
    )


@pytest.fixture
def shoot(tmp_path: Path):
    for n in ("a.jpg", "b.jpg", "c.jpg"):
        _make_jpeg(tmp_path / n)
    s = Shoot(tmp_path)
    s.ingest()
    try:
        yield s
    finally:
        s.close()


def _ids(shoot: Shoot) -> list[int]:
    return [r["id"] for r in shoot.list_images()]


# ----- Shoot-level executemany methods -----

def test_set_pick_many_applies_to_every_id(shoot: Shoot):
    ids = _ids(shoot)
    shoot.set_pick_many(ids, 1)
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["pick"] == 1 for i in ids)


def test_set_pick_many_rejects_out_of_range(shoot: Shoot):
    with pytest.raises(ValueError):
        shoot.set_pick_many(_ids(shoot), 2)


def test_set_pick_many_empty_list_is_noop(shoot: Shoot):
    before = {r["id"]: r["pick"] for r in shoot.list_images()}
    shoot.set_pick_many([], 1)
    after = {r["id"]: r["pick"] for r in shoot.list_images()}
    assert before == after


def test_set_stars_many_applies_to_every_id(shoot: Shoot):
    ids = _ids(shoot)
    shoot.set_stars_many(ids, 3)
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["stars"] == 3 for i in ids)


def test_set_stars_many_rejects_out_of_range(shoot: Shoot):
    with pytest.raises(ValueError):
        shoot.set_stars_many(_ids(shoot), 6)


def test_set_stars_many_empty_list_is_noop(shoot: Shoot):
    before = {r["id"]: r["stars"] for r in shoot.list_images()}
    shoot.set_stars_many([], 3)
    after = {r["id"]: r["stars"] for r in shoot.list_images()}
    assert before == after


def test_set_color_label_many_applies_to_every_id(shoot: Shoot):
    ids = _ids(shoot)
    shoot.set_color_label_many(ids, "red")
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["color_label"] == "red" for i in ids)


def test_set_pick_many_only_touches_listed_ids(shoot: Shoot):
    ids = _ids(shoot)
    shoot.set_pick_many(ids[:1], 1)
    rows = {r["id"]: r for r in shoot.list_images()}
    assert rows[ids[0]]["pick"] == 1
    assert all(rows[i]["pick"] == 0 for i in ids[1:])


# ----- route layer -----

def test_batch_pick_route(shoot: Shoot, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(server, "_shoot", shoot)
    ids = _ids(shoot)
    result = server.set_pick_batch(BatchPickBody(image_ids=ids, pick=-1))
    assert result == {"image_ids": ids, "pick": -1}
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["pick"] == -1 for i in ids)


def test_batch_stars_route(shoot: Shoot, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(server, "_shoot", shoot)
    ids = _ids(shoot)
    result = server.set_stars_batch(BatchStarsBody(image_ids=ids, stars=5))
    assert result == {"image_ids": ids, "stars": 5}
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["stars"] == 5 for i in ids)


def test_batch_color_route(shoot: Shoot, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(server, "_shoot", shoot)
    ids = _ids(shoot)
    result = server.set_color_batch(BatchColorBody(image_ids=ids, color="blue"))
    assert result == {"image_ids": ids, "color": "blue"}
    rows = {r["id"]: r for r in shoot.list_images()}
    assert all(rows[i]["color_label"] == "blue" for i in ids)


def test_batch_pick_route_rejects_out_of_range_at_the_model():
    with pytest.raises(ValidationError):
        BatchPickBody(image_ids=[1], pick=7)
