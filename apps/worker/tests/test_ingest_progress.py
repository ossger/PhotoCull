"""Ingest progress: "complete" only after scene grouping; failures surfaced; stale ingests ignored."""
from __future__ import annotations

import asyncio
from pathlib import Path

from PIL import Image

from photocull import scenes as scenes_mod
from photocull import server
from photocull.server import OpenShootBody


def _make_folder(tmp_path: Path, good: int = 3, bad: int = 1) -> Path:
    for i in range(good):
        Image.new("RGB", (64, 48), (i * 40, 90, 120)).save(tmp_path / f"ok{i}.jpg")
    for i in range(bad):
        (tmp_path / f"bad{i}.jpg").write_bytes(b"not a jpeg")
    return tmp_path


def _reset():
    server._shoot = None
    server._ingest_task = None
    server._progress.update(
        state="idle", phase="ingest", done=0, total=0, current=None,
        failed=0, failed_files=[], error=None,
    )


def test_complete_waits_for_scene_grouping_and_reports_failures(tmp_path, monkeypatch):
    folder = _make_folder(tmp_path)
    _reset()
    states_at_regroup: list[str] = []
    real_regroup = scenes_mod.regroup

    def spy(conn, *a, **kw):
        states_at_regroup.append(server._progress["state"])
        return real_regroup(conn, *a, **kw)

    monkeypatch.setattr(scenes_mod, "regroup", spy)

    async def go():
        await server.open_shoot(OpenShootBody(path=str(folder)))
        for _ in range(300):
            await asyncio.sleep(0.05)
            if server._progress["state"] != "running":
                break
        return dict(server._progress)

    p = asyncio.run(go())
    try:
        assert states_at_regroup and set(states_at_regroup) == {"running"}
        assert p["state"] == "complete", p
        assert p["failed"] == 1 and p["failed_files"] == ["bad0.jpg"]
        # the count is of images actually ingested, not files attempted
        assert p["done"] == p["total"] == 3
        # every readable image got a scene
        assert all(i["scene_id"] is not None for i in server._shoot.list_images())
    finally:
        server._shoot.close()
        _reset()


def test_superseded_ingest_does_not_touch_progress(tmp_path):
    folder = _make_folder(tmp_path, good=1, bad=0)
    _reset()

    async def go():
        await server.open_shoot(OpenShootBody(path=str(folder)))
        task = server._ingest_task
        # A newer open takes over before the old ingest reports completion.
        with server._progress_lock:
            server._ingest_generation += 1
            server._progress["state"] = "running"
        await task  # deterministic: the stale ingest has fully finished
        return server._progress["state"]

    try:
        assert asyncio.run(go()) == "running"
    finally:
        server._shoot.close()
        _reset()


def test_reopen_cancels_old_ingest_before_closing(tmp_path):
    (tmp_path / "a").mkdir()
    first = _make_folder(tmp_path / "a", good=6, bad=0)
    second = tmp_path / "b"
    second.mkdir()
    Image.new("RGB", (64, 48), (5, 5, 5)).save(second / "only.jpg")
    _reset()

    async def go():
        await server.open_shoot(OpenShootBody(path=str(first)))
        old = server._shoot
        old_task = server._ingest_task
        await server.open_shoot(OpenShootBody(path=str(second)))
        assert old_task.done()  # drained, not left decoding in the background
        assert old._cancel.is_set()
        for _ in range(300):
            await asyncio.sleep(0.05)
            if server._progress["state"] != "running":
                break
        return dict(server._progress)

    p = asyncio.run(go())
    try:
        assert p["state"] == "complete" and p["total"] == 1, p
    finally:
        server._shoot.close()
        _reset()


def test_failures_report_relative_paths_and_all_failed_folder(tmp_path):
    (tmp_path / "x").mkdir()
    (tmp_path / "y").mkdir()
    (tmp_path / "x" / "IMG_1.jpg").write_bytes(b"bad")
    (tmp_path / "y" / "IMG_1.jpg").write_bytes(b"bad")
    _reset()

    async def go():
        await server.open_shoot(OpenShootBody(path=str(tmp_path)))
        for _ in range(300):
            await asyncio.sleep(0.05)
            if server._progress["state"] != "running":
                break
        return dict(server._progress)

    p = asyncio.run(go())
    try:
        assert p["state"] == "complete"
        assert p["done"] == p["total"] == 0 and p["failed"] == 2
        assert sorted(p["failed_files"]) == ["x/IMG_1.jpg", "y/IMG_1.jpg"]
    finally:
        server._shoot.close()
        _reset()


def test_grouping_phase_never_regresses_done(tmp_path):
    from photocull.shoot import GROUPING_LABEL, Shoot

    folder = _make_folder(tmp_path, good=3, bad=0)
    seen: list[tuple[int, int, str]] = []
    shoot = Shoot(folder)
    try:
        shoot.ingest(progress=lambda d, t, c: seen.append((d, t, c)))
    finally:
        shoot.close()
    dones = [d for d, _, _ in seen]
    assert dones == sorted(dones)
    assert seen[-1] == (3, 3, GROUPING_LABEL)
