"""The /astro routes and the scene-kind patch, called as plain functions (like the rest of the suite)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from photocull import server
from photocull.server import AstroAnalyzeBody, AstroStackBody, UpdateSceneBody
from photocull.shoot import Shoot


@pytest.fixture
def served(star_shoot: Shoot):
    server._shoot = star_shoot
    server._astro_progress.update(
        state="idle", done=0, total=0, current=None, result=None, error=None
    )
    try:
        yield star_shoot
    finally:
        server._shoot = None


def _star_ids(s: Shoot) -> list[int]:
    return [i["id"] for i in s.list_images() if i["filename"].startswith("star")]


def test_analyze_route_returns_frames_and_summary(served: Shoot):
    out = server.astro_analyze(AstroAnalyzeBody(image_ids=_star_ids(served)))
    assert out["summary"]["frames"] == 10
    assert {"id", "filename", "stars", "fwhm", "elongation", "background", "include", "reasons"} <= set(
        out["frames"][0]
    )


def test_analyze_route_rejects_a_single_frame(served: Shoot):
    with pytest.raises(ValidationError):  # over HTTP this is a 422
        AstroAnalyzeBody(image_ids=[1])
    # unknown ids analyse nothing and say so
    with pytest.raises(HTTPException) as ei:
        server.astro_analyze(AstroAnalyzeBody(image_ids=[9998, 9999]))
    assert ei.value.status_code == 400


def test_stack_route_runs_in_the_background_and_reports(served: Shoot):
    async def go():
        assert (await server.astro_stack(AstroStackBody(image_ids=_star_ids(served))))["started"]
        for _ in range(200):
            await asyncio.sleep(0.1)
            if server.astro_progress()["state"] != "running":
                break
        return server.astro_progress()

    p = asyncio.run(go())
    assert p["state"] == "complete", p
    assert p["done"] == p["total"]
    assert Path(p["result"]["output"]).exists()
    assert p["result"]["used"] >= 3


def test_second_stack_while_running_is_refused(served: Shoot):
    server._astro_progress["state"] = "running"

    async def go():
        with pytest.raises(HTTPException) as ei:
            await server.astro_stack(AstroStackBody(image_ids=_star_ids(served)))
        return ei.value.status_code

    assert asyncio.run(go()) == 409


def test_stack_failure_is_reported_not_raised(served: Shoot):
    async def go():
        await server.astro_stack(AstroStackBody(image_ids=[9990, 9991, 9992]))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if server.astro_progress()["state"] != "running":
                break
        return server.astro_progress()

    p = asyncio.run(go())
    assert p["state"] == "error" and p["error"]


def test_scene_kind_patch(served: Shoot):
    day = next(s for s in served.list_scenes() if s["kind"] is None)
    server.update_scene(day["id"], UpdateSceneBody(kind="astro"))
    assert next(s for s in served.list_scenes() if s["id"] == day["id"])["kind"] == "astro"
    with pytest.raises(HTTPException) as ei:
        server.update_scene(day["id"], UpdateSceneBody(kind="bogus"))
    assert ei.value.status_code == 400
