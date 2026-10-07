"""Manual scene edits (merge/split/rename/cover/move) and their survival across regroup."""
from __future__ import annotations

from pathlib import Path

import piexif
import pytest
from PIL import Image

from photocull import scenes as scenes_mod
from photocull.shoot import Shoot


def _make_jpeg(path: Path, stamp: str, color: tuple[int, int, int]) -> None:
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: stamp.encode()}}
    Image.new("RGB", (320, 240), color).save(path, "JPEG", quality=85, exif=piexif.dump(exif))


@pytest.fixture
def shoot(tmp_path: Path):
    # Two bursts an hour apart -> two automatic scenes of three frames each.
    for i in range(3):
        _make_jpeg(tmp_path / f"a{i}.jpg", f"2026:05:27 10:00:0{i}", (40, 80, 120))
        _make_jpeg(tmp_path / f"b{i}.jpg", f"2026:05:27 11:00:0{i}", (200, 60, 20))
    s = Shoot(tmp_path)
    s.ingest()
    try:
        yield s
    finally:
        s.close()


def _scene_ids(s: Shoot) -> list[int]:
    return [sc["id"] for sc in s.list_scenes()]


def _images_in(s: Shoot, scene_id: int) -> list[int]:
    return [i["id"] for i in s.list_images() if i["scene_id"] == scene_id]


def test_baseline_two_scenes(shoot: Shoot):
    assert len(_scene_ids(shoot)) == 2


def test_merge_scenes(shoot: Shoot):
    a, b = _scene_ids(shoot)
    target = shoot.merge_scenes([b, a])
    assert target == a
    assert _scene_ids(shoot) == [a]
    assert len(_images_in(shoot, a)) == 6


def test_merge_needs_two(shoot: Shoot):
    with pytest.raises(ValueError):
        shoot.merge_scenes([_scene_ids(shoot)[0]])


def test_split_scene(shoot: Shoot):
    a, _ = _scene_ids(shoot)
    imgs = _images_in(shoot, a)
    new_id = shoot.split_scene(a, imgs[1])
    assert _images_in(shoot, a) == imgs[:1]
    assert _images_in(shoot, new_id) == imgs[1:]
    assert len(_scene_ids(shoot)) == 3


def test_split_at_first_frame_rejected(shoot: Shoot):
    a, _ = _scene_ids(shoot)
    with pytest.raises(ValueError):
        shoot.split_scene(a, _images_in(shoot, a)[0])


def test_rename_and_cover(shoot: Shoot):
    a, _ = _scene_ids(shoot)
    img = _images_in(shoot, a)[2]
    shoot.update_scene(a, label="Ceremony", cover_image_id=img)
    sc = next(s for s in shoot.list_scenes() if s["id"] == a)
    assert sc["label"] == "Ceremony" and sc["cover_image_id"] == img
    with pytest.raises(ValueError):
        shoot.update_scene(a, cover_image_id=_images_in(shoot, _scene_ids(shoot)[1])[0])


def test_move_images_deletes_emptied_scene(shoot: Shoot):
    a, b = _scene_ids(shoot)
    dest = shoot.move_images_to_scene(_images_in(shoot, a), b)
    assert dest == b
    assert _scene_ids(shoot) == [b]
    assert len(_images_in(shoot, b)) == 6


def test_move_to_new_scene(shoot: Shoot):
    a, _ = _scene_ids(shoot)
    one = _images_in(shoot, a)[0]
    new_id = shoot.move_images_to_scene([one], None)
    assert new_id not in (a,)
    assert _images_in(shoot, new_id) == [one]
    assert len(_scene_ids(shoot)) == 3


def test_manual_edits_survive_regroup_and_force_resets(shoot: Shoot):
    a, _ = _scene_ids(shoot)
    shoot.update_scene(a, label="Keep me")
    shoot.regroup_scenes()
    labels = [s["label"] for s in shoot.list_scenes()]
    assert "Keep me" in labels
    assert len(labels) == 2
    shoot.regroup_scenes(force=True)
    assert "Keep me" not in [s["label"] for s in shoot.list_scenes()]
    assert len(_scene_ids(shoot)) == 2


def test_merged_scene_survives_reingest(shoot: Shoot):
    a, b = _scene_ids(shoot)
    shoot.merge_scenes([a, b])
    shoot.ingest()
    assert len(_scene_ids(shoot)) == 1
    assert scenes_mod.regroup(shoot.conn) == 1
