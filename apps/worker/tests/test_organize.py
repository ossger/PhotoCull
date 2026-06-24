"""Tests for the standalone organize command. Run with `pytest apps/worker`.

The exiftool read is the only part that touches real camera files, so it's kept
out of these tests; everything else (labelling, planning, moving, collisions) is
exercised by feeding hand-built CaptureMeta and plain files.
"""
from __future__ import annotations

import os
import time
from datetime import date
from pathlib import Path

from PIL import Image

from photocull import organize
from photocull.organize import CaptureMeta, Move


def _touch(path: Path, content: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


# ---- labelling ----


def test_source_label_dji_drone():
    assert organize.source_label("DJI", "FC3411") == "DJI-Drone"
    assert organize.source_label("Hasselblad", "DJI Mavic 3") == "DJI-Drone"


def test_source_label_canon_r6m2():
    assert organize.source_label("Canon", "Canon EOS R6m2") == "Canon-R6mkii"
    assert organize.source_label("Canon", "Canon EOS R6 Mark II") == "Canon-R6mkii"


def test_source_label_generic_and_unknown():
    assert organize.source_label("Nikon", "NIKON Z 9") == "NIKON-Z-9"
    assert organize.source_label(None, None) == "Unknown"


# ---- planning ----


def test_plan_uses_exif_date_and_source(tmp_path: Path):
    f = _touch(tmp_path / "DJI_0001.DNG")
    meta = {f: CaptureMeta(taken_on=date(2026, 6, 24), make="DJI", model="FC3411")}
    lib = tmp_path / "lib"
    (mv,) = organize.plan_moves([f], meta, lib)
    assert mv.dest == lib / "2026" / "2026-06-24_DJI-Drone" / "DJI_0001.DNG"


def test_plan_falls_back_to_mtime_when_no_exif(tmp_path: Path):
    f = _touch(tmp_path / "shot.jpg")
    when = time.mktime(date(2025, 1, 2).timetuple())
    os.utime(f, (when, when))
    lib = tmp_path / "lib"
    (mv,) = organize.plan_moves([f], {}, lib)  # no meta at all
    assert mv.dest == lib / "2025" / "2025-01-02_Unknown" / "shot.jpg"


def test_plan_label_override(tmp_path: Path):
    f = _touch(tmp_path / "a.cr3")
    meta = {f: CaptureMeta(taken_on=date(2026, 6, 24), make="Canon", model="Canon EOS R6m2")}
    (mv,) = organize.plan_moves([f], meta, tmp_path / "lib", label_override="Beach")
    assert mv.dest.parent.name == "2026-06-24_Beach"


# ---- moving ----


def test_execute_moves_real_move(tmp_path: Path):
    src = _touch(tmp_path / "in" / "a.jpg", b"hello")
    dest = tmp_path / "lib" / "2026" / "2026-06-24_X" / "a.jpg"
    res = organize.execute_moves([Move(src=src, dest=dest)], dry_run=False)
    assert res.moved == 1 and res.skipped == 0 and res.renamed == 0
    assert dest.is_file() and not src.exists()


def test_execute_moves_dry_run_touches_nothing(tmp_path: Path):
    src = _touch(tmp_path / "in" / "a.jpg")
    dest = tmp_path / "lib" / "a.jpg"
    res = organize.execute_moves([Move(src=src, dest=dest)], dry_run=True)
    assert res.moved == 1
    assert src.exists() and not dest.exists()


def test_collision_same_size_skips(tmp_path: Path):
    src = _touch(tmp_path / "in" / "a.jpg", b"same")
    dest = _touch(tmp_path / "lib" / "a.jpg", b"same")
    res = organize.execute_moves([Move(src=src, dest=dest)], dry_run=False)
    assert res.skipped == 1 and res.moved == 0
    assert src.exists()  # left in place for the user to confirm


def test_collision_diff_size_renames(tmp_path: Path):
    src = _touch(tmp_path / "in" / "a.jpg", b"different-content")
    _touch(tmp_path / "lib" / "a.jpg", b"orig")
    dest = tmp_path / "lib" / "a.jpg"
    res = organize.execute_moves([Move(src=src, dest=dest)], dry_run=False)
    assert res.renamed == 1 and res.moved == 1
    assert (tmp_path / "lib" / "a_1.jpg").is_file()
    assert (tmp_path / "lib" / "a.jpg").read_bytes() == b"orig"  # original untouched


# ---- walk + end-to-end (no exiftool needed; mtime fallback) ----


def test_organize_end_to_end(tmp_path: Path):
    src_root = tmp_path / "_RawIngest"
    sub = src_root / "DCIM"
    sub.mkdir(parents=True)
    img = sub / "p.jpg"
    Image.new("RGB", (32, 24), (10, 20, 30)).save(img, "JPEG")
    when = time.mktime(date(2026, 6, 24).timetuple())
    os.utime(img, (when, when))
    (sub / "notes.txt").write_text("ignore me")  # unsupported ext

    lib = tmp_path / "PhotoLibrary"
    res = organize.organize(src_root, lib, dry_run=False)

    assert res.moved == 1
    moved = lib / "2026" / "2026-06-24_Unknown" / "p.jpg"
    assert moved.is_file()
    assert not img.exists()
    assert (sub / "notes.txt").exists()  # non-images left behind
    assert sub.exists()  # DCIM kept because notes.txt still lives there
