"""Tests for sorting a card dump into event folders (photocull.events).

Capture times are injected through the ``reader`` hook rather than real EXIF,
so these never need exiftool; the files themselves are a few bytes each.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from photocull import events
from photocull.events import Unit


def _touch(path: Path, content: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _reader(times: dict[str, datetime]):
    """A fake exiftool: dates by filename; anything unlisted has no EXIF date."""
    def read(paths: list[Path]) -> dict[Path, datetime]:
        return {p: times[p.name] for p in paths if p.name in times}
    return read


T0 = datetime(2026, 10, 3, 9, 0, 0)


def _dump(folder: Path, spec: dict[str, datetime]) -> None:
    for name in spec:
        _touch(folder / name)


# ---- grouping files into units ----


def test_units_keep_raw_jpeg_and_sidecars_together(tmp_path: Path):
    for n in ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.CR3.xmp", "img_1.xmp", "IMG_2.JPG", "lost.xmp"]:
        _touch(tmp_path / n)
    units, orphans = events.build_units(events.list_top_level(tmp_path))

    by_stem = {u.stem.lower(): sorted(f.name for f in u.files) for u in units}
    assert by_stem["img_1"] == ["IMG_1.CR3", "IMG_1.CR3.xmp", "IMG_1.JPG", "img_1.xmp"]
    assert by_stem["img_2"] == ["IMG_2.JPG"]
    assert [o.name for o in orphans] == ["lost.xmp"]
    unit1 = next(u for u in units if u.stem.lower() == "img_1")
    assert unit1.primary.name == "IMG_1.CR3"
    assert unit1.preview.name == "IMG_1.JPG"


def test_only_top_level_loose_files_are_considered(tmp_path: Path):
    _touch(tmp_path / "a.jpg")
    _touch(tmp_path / "2026-10-01 Soccer" / "b.jpg")
    _touch(tmp_path / ".photocull" / "c.jpg")
    _touch(tmp_path / ".hidden.jpg")
    _touch(tmp_path / "notes.txt")
    assert [p.name for p in events.list_top_level(tmp_path)] == ["a.jpg", "notes.txt"]
    units, _ = events.build_units(events.list_top_level(tmp_path))
    assert [u.stem for u in units] == ["a"]


# ---- clustering ----


def _unit(name: str, taken: datetime) -> Unit:
    return Unit(stem=Path(name).stem, files=[Path(name)], taken=taken)


def test_cluster_splits_only_when_gap_exceeds_threshold():
    units = [
        _unit("a.jpg", T0),
        _unit("b.jpg", T0 + timedelta(hours=3)),            # exactly 3h: same event
        _unit("c.jpg", T0 + timedelta(hours=6, seconds=1)),  # just over: new event
    ]
    got = events.cluster(units, gap_hours=3)
    assert [[u.stem for u in e.units] for e in got] == [["a", "b"], ["c"]]


def test_cluster_orders_by_time_not_filename():
    units = [_unit("z.jpg", T0), _unit("a.jpg", T0 + timedelta(days=1))]
    got = events.cluster(units, gap_hours=3)
    assert [e.units[0].stem for e in got] == ["z", "a"]


def test_cluster_ids_are_stable():
    units = [_unit("a.jpg", T0), _unit("b.jpg", T0 + timedelta(days=1))]
    assert [e.id for e in events.cluster(units, 3)] == [e.id for e in events.cluster(units, 3)]


# ---- naming ----


def test_folder_names_date_prefix_and_same_day_letters():
    day = datetime(2026, 10, 3, 9)
    names = events.folder_names([(day, ""), (day.replace(hour=18), ""), (day, "Soccer")])
    assert names == ["2026-10-03a", "2026-10-03b", "2026-10-03 Soccer"]


def test_clean_name_strips_path_separators():
    assert events.clean_name("  Mom/Dad: B-day  ") == "Mom Dad B-day"
    assert events.clean_name("..") == ""


# ---- plan + run + undo ----


def _three_events(folder: Path) -> dict[str, datetime]:
    spec = {
        "IMG_1.CR3": T0, "IMG_1.JPG": T0, "IMG_2.CR3": T0 + timedelta(minutes=30),
        "IMG_3.CR3": T0 + timedelta(hours=8),
        "IMG_4.CR3": T0 + timedelta(days=1), "MVI_5.MP4": T0 + timedelta(days=1, minutes=5),
    }
    _dump(folder, spec)
    _touch(folder / "IMG_1.CR3.xmp")
    return spec


def test_plan_proposes_events_without_touching_files(tmp_path: Path):
    spec = _three_events(tmp_path)
    data = events.plan(tmp_path, 3, reader=_reader(spec))

    assert [e["count"] for e in data["events"]] == [2, 1, 2]
    assert [e["default_name"] for e in data["events"]] == ["2026-10-03a", "2026-10-03b",
                                                          "2026-10-04"]
    assert data["events"][0]["files"] == 4  # CR3 + JPG + xmp + IMG_2
    assert data["events"][0]["samples"][0] == "IMG_1.JPG"
    assert data["can_undo"] is False
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([*spec, "IMG_1.CR3.xmp"])


def test_wider_gap_merges_events(tmp_path: Path):
    spec = _three_events(tmp_path)
    assert len(events.plan(tmp_path, 12, reader=_reader(spec))["events"]) == 2


def test_run_moves_units_into_named_folders(tmp_path: Path):
    spec = _three_events(tmp_path)
    evs = events.plan(tmp_path, 3, reader=_reader(spec))["events"]
    groups = [([evs[0]["id"]], "Soccer"), ([evs[2]["id"]], "Hike")]  # evs[1] left loose

    result = events.run(tmp_path, 3, groups, reader=_reader(spec))

    assert result.folders == ["2026-10-03 Soccer", "2026-10-04 Hike"]
    soccer = tmp_path / "2026-10-03 Soccer"
    assert sorted(p.name for p in soccer.iterdir()) == [
        "IMG_1.CR3", "IMG_1.CR3.xmp", "IMG_1.JPG", "IMG_2.CR3"]
    assert sorted(p.name for p in (tmp_path / "2026-10-04 Hike").iterdir()) == [
        "IMG_4.CR3", "MVI_5.MP4"]
    assert (tmp_path / "IMG_3.CR3").exists()


def test_run_merged_group_lands_in_one_folder(tmp_path: Path):
    spec = _three_events(tmp_path)
    evs = events.plan(tmp_path, 3, reader=_reader(spec))["events"]
    events.run(tmp_path, 3, [([evs[0]["id"], evs[1]["id"]], "Fair")], reader=_reader(spec))
    assert len(list((tmp_path / "2026-10-03 Fair").iterdir())) == 5


def test_run_rejects_stale_plan(tmp_path: Path):
    spec = _three_events(tmp_path)
    with pytest.raises(events.PlanChanged):
        events.run(tmp_path, 3, [(["nope"], "x")], reader=_reader(spec))


def test_collisions_rename_whole_unit_never_overwrite(tmp_path: Path):
    spec = {"IMG_1.CR3": T0, "IMG_1.JPG": T0}
    _dump(tmp_path, spec)
    existing = _touch(tmp_path / "2026-10-03 Soccer" / "IMG_1.JPG", b"older")
    ev = events.plan(tmp_path, 3, reader=_reader(spec))["events"][0]

    result = events.run(tmp_path, 3, [([ev["id"]], "Soccer")], reader=_reader(spec))

    names = sorted(p.name for p in existing.parent.iterdir())
    assert names == ["IMG_1.JPG", "IMG_1_1.CR3", "IMG_1_1.JPG"]
    assert existing.read_bytes() == b"older"
    assert result.renamed == 2


def test_undo_restores_flat_folder(tmp_path: Path):
    spec = _three_events(tmp_path)
    before = sorted(p.name for p in tmp_path.iterdir())
    evs = events.plan(tmp_path, 3, reader=_reader(spec))["events"]
    events.run(tmp_path, 3, [([e["id"]], "") for e in evs], reader=_reader(spec))
    _touch(tmp_path / "2026-10-04" / ".DS_Store")
    assert events.plan(tmp_path, 3, reader=_reader(spec))["can_undo"] is True

    assert events.undo(tmp_path) == {"restored": 7, "missing": 0}
    after = sorted(p.name for p in tmp_path.iterdir() if p.name != ".photocull")
    assert after == before
    assert events.latest_journal(tmp_path) is None


def test_undo_leaves_folders_that_existed_before(tmp_path: Path):
    spec = {"a.jpg": T0}
    _dump(tmp_path, spec)
    keep = _touch(tmp_path / "2026-10-03 Soccer" / "old.jpg")
    ev = events.plan(tmp_path, 3, reader=_reader(spec))["events"][0]
    events.run(tmp_path, 3, [([ev["id"]], "Soccer")], reader=_reader(spec))
    events.undo(tmp_path)
    assert keep.exists() and (tmp_path / "a.jpg").exists()


def test_mtime_fallback_when_no_exif(tmp_path: Path):
    f = _touch(tmp_path / "a.jpg")
    ts = time.mktime(datetime(2026, 1, 2, 12).timetuple())
    os.utime(f, (ts, ts))
    data = events.plan(tmp_path, 3, reader=_reader({}))
    assert data["events"][0]["undated"] == 1
    assert data["events"][0]["default_name"] == "2026-01-02"


def test_exif_datetime_parser_keeps_time_and_drops_offset():
    assert events._parse_exif_datetime("2026:10:03 14:05:09-06:00") == datetime(
        2026, 10, 3, 14, 5, 9)
    assert events._parse_exif_datetime("0000:00:00 00:00:00") is None
    assert events._parse_exif_datetime("2026:10") is None


def test_thumbnail_refuses_paths_outside_folder(tmp_path: Path):
    assert events.thumbnail(tmp_path, "../x.jpg") is None
    assert events.thumbnail(tmp_path, ".photocull") is None
