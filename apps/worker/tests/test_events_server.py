"""Route-layer tests for /events/* — validation, the background run, undo, thumbs.

Calls route functions directly, like test_organize_server.py. JPEGs carry no
EXIF here, so the worker dates them by mtime (exiftool finds nothing to read).
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from photocull import server
from photocull.server import EventGroup, EventsFolderBody, EventsPlanBody, EventsRunBody


def _jpeg(path: Path, when: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 12), (20, 30, 40)).save(path, "JPEG")
    ts = time.mktime(when.timetuple())
    os.utime(path, (ts, ts))


def _wait_for_events() -> dict:
    async def poll() -> dict:
        for _ in range(200):
            p = server.events_progress()
            if p["state"] in ("complete", "error"):
                return p
            await asyncio.sleep(0.02)
        raise AssertionError("events run never finished")
    return poll()


def test_plan_404_on_missing_folder(tmp_path: Path):
    with pytest.raises(HTTPException) as ei:
        server.events_plan(EventsPlanBody(folder=str(tmp_path / "nope")))
    assert ei.value.status_code == 404


def test_run_then_undo_round_trip(tmp_path: Path):
    _jpeg(tmp_path / "a.jpg", datetime(2026, 10, 3, 9))
    _jpeg(tmp_path / "b.jpg", datetime(2026, 10, 4, 9))
    plan = server.events_plan(EventsPlanBody(folder=str(tmp_path), gap_hours=3))
    ids = [e["id"] for e in plan["events"]]
    assert len(ids) == 2

    async def go() -> dict:
        await server.events_run(EventsRunBody(
            folder=str(tmp_path), gap_hours=3,
            groups=[EventGroup(event_ids=[ids[0]], name="Soccer"),
                    EventGroup(event_ids=[ids[1]], name="")],
        ))
        return await _wait_for_events()

    progress = asyncio.run(go())
    assert progress["state"] == "complete"
    assert progress["folders"] == ["2026-10-03 Soccer", "2026-10-04"]
    assert (tmp_path / "2026-10-03 Soccer" / "a.jpg").exists()

    assert server.events_undo(EventsFolderBody(folder=str(tmp_path)))["restored"] == 2
    assert (tmp_path / "a.jpg").exists() and (tmp_path / "b.jpg").exists()


def test_run_reports_stale_plan_as_error(tmp_path: Path):
    _jpeg(tmp_path / "a.jpg", datetime(2026, 10, 3, 9))

    async def go() -> dict:
        await server.events_run(EventsRunBody(
            folder=str(tmp_path), groups=[EventGroup(event_ids=["gone"], name="x")]))
        return await _wait_for_events()

    progress = asyncio.run(go())
    assert progress["state"] == "error"
    assert "Preview again" in progress["error"]


def test_thumb_serves_a_loose_jpeg(tmp_path: Path):
    _jpeg(tmp_path / "a.jpg", datetime(2026, 10, 3, 9))
    resp = server.events_thumb(folder=str(tmp_path), name="a.jpg")
    assert Path(resp.path).is_file()
    with pytest.raises(HTTPException):
        server.events_thumb(folder=str(tmp_path), name="../a.jpg")
