"""Tests for the in-app organize endpoints (the GUI's card-import feature).

The move/label/collision logic itself is covered in test_organize.py. Here we
exercise the route layer — the grouped plan preview and its path validation —
plus the progress callback that drives the modal's progress bar. We call the
route functions directly (like the rest of the worker suite) rather than over
HTTP, so the tests need no TestClient/httpx.
"""
from __future__ import annotations

import os
import time
from datetime import date
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from photocull import server
from photocull.organize import organize
from photocull.server import OrganizeBody


def _jpeg(path: Path, when: date) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 12), (20, 30, 40)).save(path, "JPEG")
    ts = time.mktime(when.timetuple())
    os.utime(path, (ts, ts))


def test_plan_groups_by_day(tmp_path: Path):
    src = tmp_path / "card"
    _jpeg(src / "a.jpg", date(2026, 6, 24))
    _jpeg(src / "b.jpg", date(2026, 6, 25))
    lib = tmp_path / "lib"

    data = server.organize_plan(OrganizeBody(source=str(src), library=str(lib)))

    assert data["total"] == 2
    assert data["would_move"] == 2
    folders = {g["folder"] for g in data["groups"]}
    assert folders == {"2026/2026-06-24_Unknown", "2026/2026-06-25_Unknown"}
    assert (src / "a.jpg").exists()  # a plan touches nothing


def test_plan_404_on_missing_source(tmp_path: Path):
    with pytest.raises(HTTPException) as ei:
        server.organize_plan(
            OrganizeBody(source=str(tmp_path / "nope"), library=str(tmp_path / "lib"))
        )
    assert ei.value.status_code == 404


def test_organize_reports_progress(tmp_path: Path):
    src = tmp_path / "card"
    _jpeg(src / "a.jpg", date(2026, 6, 24))
    _jpeg(src / "b.jpg", date(2026, 6, 24))
    lib = tmp_path / "lib"

    seen: list[tuple[int, int, str]] = []
    res = organize(src, lib, progress=lambda d, t, c: seen.append((d, t, c)))

    assert res.moved == 2
    assert seen[0] == (0, 2, "reading metadata")  # metadata phase first
    assert seen[-1][0] == seen[-1][1] == 2  # ends fully done
