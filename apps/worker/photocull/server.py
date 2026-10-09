"""FastAPI server — the IPC surface the Electron shell talks to.

Lifecycle: Electron spawns this on launch, picks a free port, and waits for
`GET /health` to return 200 before connecting. On quit it sends SIGTERM and we
exit cleanly.

A simple shared-secret token guards every request so nothing else on localhost
can poke the API.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import secrets
import sys
import threading
from collections.abc import Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__
from . import events as events_mod
from . import organize as organize_mod
from .astro.stack import StackOptions
from .shoot import GROUPING_LABEL, Shoot

log = logging.getLogger("photocull.server")


# ----- auth -----

AUTH_TOKEN = os.environ.get("PHOTOCULL_TOKEN") or secrets.token_urlsafe(24)


def require_token(x_photocull_token: str = Header(default="")) -> None:
    if not secrets.compare_digest(x_photocull_token, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="bad token")


def require_token_or_query(
    x_photocull_token: str = Header(default=""),
    token: str = Query(default=""),
) -> None:
    """For routes hit by <img src> where we can't set headers."""
    supplied = x_photocull_token or token
    if not secrets.compare_digest(supplied, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="bad token")


# ----- shoot registry (one open shoot for Phase 1) -----

_shoot: Shoot | None = None
# Per-shoot ingest progress; replaced when a new shoot starts. `phase` is
# "ingest" while files decode, "grouping" for the pruning/scene pass after.
_progress: dict[str, Any] = {
    "state": "idle", "phase": "ingest", "done": 0, "total": 0, "current": None,
    "failed": 0, "failed_files": [], "error": None,
}

# Bumped on every shoot open. An ingest from an earlier open can still be
# winding down when the next one starts; it must not write into the new shoot's
# progress (a stray "complete" would stop the UI polling mid-ingest). All
# progress writes and the generation bump share `_progress_lock`, so the
# check-and-write is atomic against `open_shoot`.
_ingest_generation = 0
_progress_lock = threading.Lock()
# Serialises open_shoot (it awaits the superseded ingest) and tracks that ingest.
_open_lock = asyncio.Lock()
_ingest_task: asyncio.Task[None] | None = None


_background_tasks: set[asyncio.Task[None]] = set()


def _spawn(coro: Coroutine[Any, Any, None]) -> None:
    """Run a fire-and-forget job; the loop only weakly references tasks, so
    hold one until it finishes or it can be garbage-collected mid-run."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _set_progress(
    done: int, total: int, current: str, generation: int | None = None
) -> None:
    # Never "complete" here: the last file finishing is not the end of ingest
    # (sibling pruning + scene grouping still follow). _run_ingest owns that.
    with _progress_lock:
        if generation is not None and generation != _ingest_generation:
            return
        _progress["state"] = "running"
        _progress["phase"] = "grouping" if current == GROUPING_LABEL else "ingest"
        _progress["done"] = done
        _progress["total"] = total
        _progress["current"] = current


# Sort-into-events progress; same shape and lifecycle as organize's.
_events_progress: dict[str, Any] = {
    "state": "idle", "done": 0, "total": 0, "current": None,
    "moved": 0, "renamed": 0, "folders": [], "error": None,
}


def _set_events_progress(done: int, total: int, current: str) -> None:
    _events_progress["state"] = "running"
    _events_progress["done"] = done
    _events_progress["total"] = total
    _events_progress["current"] = current


# Card-import (organize) progress; independent of the ingest progress above so a
# user can organize a card without a shoot open. Replaced on each run.
_organize_progress: dict[str, Any] = {
    "state": "idle", "done": 0, "total": 0, "current": None,
    "moved": 0, "skipped": 0, "renamed": 0,
}


def _set_organize_progress(done: int, total: int, current: str) -> None:
    _organize_progress["state"] = "running"
    _organize_progress["done"] = done
    _organize_progress["total"] = total
    _organize_progress["current"] = current


# Star-stack progress; one stack at a time. `result` holds the finished stack's
# summary (see Shoot.stack_astro), `error` a failure message.
_astro_progress: dict[str, Any] = {
    "state": "idle", "done": 0, "total": 0, "current": None, "result": None, "error": None,
}


def _set_astro_progress(done: int, total: int, current: str) -> None:
    _astro_progress["done"] = done
    _astro_progress["total"] = total
    _astro_progress["current"] = current


# ----- models -----

class OpenShootBody(BaseModel):
    path: str = Field(..., description="Absolute path to the folder to open as a shoot")


class PickBody(BaseModel):
    pick: int = Field(..., ge=-1, le=1)


class StarsBody(BaseModel):
    stars: int = Field(..., ge=0, le=5)


class ColorBody(BaseModel):
    color: str | None = None


class BatchPickBody(BaseModel):
    image_ids: list[int]
    pick: int = Field(..., ge=-1, le=1)


class BatchStarsBody(BaseModel):
    image_ids: list[int]
    stars: int = Field(..., ge=0, le=5)


class BatchColorBody(BaseModel):
    image_ids: list[int]
    color: str | None = None


class CropBody(BaseModel):
    """All four bounds are normalised 0..1 of the image. Send all-null to clear."""
    left: float | None = None
    top: float | None = None
    right: float | None = None
    bottom: float | None = None


class OrganizeBody(BaseModel):
    """Sort a card/inbox folder into a dated library tree. Paths are explicit —
    the CLI's repo-relative defaults are meaningless in a packaged app."""
    source: str = Field(..., description="Inbox/card folder to pull images from")
    library: str = Field(..., description="Library root to sort the dated folders into")
    label: str | None = Field(None, description="Override the per-folder source token")


class EventsPlanBody(BaseModel):
    """Propose events for the loose files at the top level of a folder."""
    folder: str = Field(..., description="Folder holding the card dump")
    gap_hours: float = Field(events_mod.DEFAULT_GAP_HOURS, gt=0, le=168)


class EventGroup(BaseModel):
    event_ids: list[str] = Field(..., min_length=1)
    name: str = ""


class EventsRunBody(BaseModel):
    folder: str
    gap_hours: float = Field(events_mod.DEFAULT_GAP_HOURS, gt=0, le=168)
    groups: list[EventGroup]


class EventsFolderBody(BaseModel):
    folder: str


# ----- app -----

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("photocull-worker %s starting", __version__)
    yield
    global _shoot
    if _shoot is not None:
        _shoot.close()
        _shoot = None
    log.info("photocull-worker stopping")


app = FastAPI(title="photocull-worker", version=__version__, lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.post("/shoot/open", dependencies=[Depends(require_token)])
async def open_shoot(body: OpenShootBody) -> dict[str, Any]:
    global _shoot, _ingest_generation, _ingest_task
    root = Path(body.path).expanduser()
    if not root.is_dir():
        raise HTTPException(404, f"not a directory: {root}")

    async with _open_lock:
        with _progress_lock:
            # Supersede any running ingest first: its progress writes stop here.
            _ingest_generation += 1
            generation = _ingest_generation
            _progress.update(
                state="running", phase="ingest", done=0, total=1, current="starting",
                failed=0, failed_files=[], error=None,
            )

        if _shoot is not None:
            # Stop the old ingest and let it drain before closing its DB, so it
            # never decodes into a closed (or, on a re-open, shared) database.
            _shoot.cancel()
            if _ingest_task is not None:
                await _ingest_task
            _shoot.close()
            _shoot = None

        shoot = _shoot = Shoot(root)

        def _progress_if_current(done: int, total: int, current: str) -> None:
            _set_progress(done, total, current, generation)

        async def _run_ingest() -> None:
            loop = asyncio.get_running_loop()
            try:
                count = await loop.run_in_executor(
                    None, lambda: shoot.ingest(progress=_progress_if_current)
                )
            except Exception as exc:
                with _progress_lock:
                    if generation == _ingest_generation:
                        log.exception("ingest failed")
                        _progress.update(
                            failed=len(shoot.last_failures),
                            failed_files=shoot.last_failures[:20],
                            error=f"Ingest failed: {exc}",
                        )
                        _progress["state"] = "error"
                    else:
                        log.debug("superseded ingest ended: %s", exc)
                return
            with _progress_lock:
                if generation != _ingest_generation:
                    return
                # `state` last: a poller seeing "complete" must see the rest.
                _progress.update(
                    done=count, total=count, current=None,
                    failed=len(shoot.last_failures),
                    failed_files=shoot.last_failures[:20],
                )
                _progress["state"] = "complete"

        _ingest_task = asyncio.create_task(_run_ingest())

        return {"root": str(shoot.root), "cache": str(shoot.cache_dir)}


@app.get("/shoot/progress", dependencies=[Depends(require_token)])
def shoot_progress() -> dict[str, Any]:
    with _progress_lock:
        return dict(_progress)


def _require_shoot() -> Shoot:
    if _shoot is None:
        raise HTTPException(409, "no shoot open")
    return _shoot


@app.get("/images", dependencies=[Depends(require_token)])
def list_images() -> list[dict[str, Any]]:
    return _require_shoot().list_images()


@app.get("/scenes", dependencies=[Depends(require_token)])
def list_scenes() -> list[dict[str, Any]]:
    return _require_shoot().list_scenes()


class RegroupBody(BaseModel):
    # force=True also discards hand-edited scenes ("reset to automatic").
    force: bool = False


class MergeScenesBody(BaseModel):
    scene_ids: list[int]


class SplitSceneBody(BaseModel):
    at_image_id: int


class UpdateSceneBody(BaseModel):
    label: str | None = None
    cover_image_id: int | None = None
    # 'astro' tags a star sequence; '' clears the tag.
    kind: str | None = None


class MoveImagesBody(BaseModel):
    image_ids: list[int]
    # None = move into a brand-new scene.
    scene_id: int | None = None


@app.post("/scenes/regroup", dependencies=[Depends(require_token)])
def regroup_scenes(body: RegroupBody | None = None) -> dict[str, int]:
    force = body.force if body else False
    return {"scene_count": _require_shoot().regroup_scenes(force=force)}


def _scene_edit(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


# NB: /scenes/merge and /scenes/move-images are fixed paths registered before
# the {scene_id} routes, same ordering concern as the /images/batch routes.

@app.post("/scenes/merge", dependencies=[Depends(require_token)])
def merge_scenes(body: MergeScenesBody) -> dict[str, int]:
    return {"scene_id": _scene_edit(_require_shoot().merge_scenes, body.scene_ids)}


@app.post("/scenes/move-images", dependencies=[Depends(require_token)])
def move_images(body: MoveImagesBody) -> dict[str, int]:
    return {
        "scene_id": _scene_edit(
            _require_shoot().move_images_to_scene, body.image_ids, body.scene_id
        )
    }


@app.post("/scenes/{scene_id}/split", dependencies=[Depends(require_token)])
def split_scene(scene_id: int, body: SplitSceneBody) -> dict[str, int]:
    return {"scene_id": _scene_edit(_require_shoot().split_scene, scene_id, body.at_image_id)}


@app.patch("/scenes/{scene_id}", dependencies=[Depends(require_token)])
def update_scene(scene_id: int, body: UpdateSceneBody) -> dict[str, int]:
    _scene_edit(
        _require_shoot().update_scene, scene_id, body.label, body.cover_image_id, body.kind
    )
    return {"scene_id": scene_id}


class AstroAnalyzeBody(BaseModel):
    image_ids: list[int] = Field(..., min_length=2)


@app.post("/astro/analyze", dependencies=[Depends(require_token)])
def astro_analyze(body: AstroAnalyzeBody) -> dict[str, Any]:
    """Star metrics + a recommended include/exclude for each frame of a sequence."""
    try:
        return _require_shoot().analyze_astro(body.image_ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class AstroStackBody(BaseModel):
    image_ids: list[int] = Field(..., min_length=3)
    half_size: bool = False
    # "auto" blends an unaligned foreground back in; "none" stacks the whole frame on the stars.
    foreground: str = Field("auto", pattern="^(auto|none)$")


@app.post("/astro/stack", dependencies=[Depends(require_token)])
async def astro_stack(body: AstroStackBody) -> dict[str, Any]:
    """Stack the frames in the background; poll /astro/progress."""
    shoot = _require_shoot()
    if _astro_progress["state"] == "running":
        raise HTTPException(409, "a stack is already running")
    _astro_progress.update(
        state="running", done=0, total=3 * len(body.image_ids) + 2,
        current=None, result=None, error=None,
    )
    options = StackOptions(half_size=body.half_size, foreground=body.foreground)

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None,
                lambda: shoot.stack_astro(body.image_ids, options, _set_astro_progress),
            )
            _astro_progress.update(state="complete", result=result, current=None)
        except Exception as exc:
            log.exception("star stack failed")
            _astro_progress.update(state="error", error=str(exc), current=None)

    _spawn(_run())
    return {"started": True}


@app.get("/astro/progress", dependencies=[Depends(require_token)])
def astro_progress() -> dict[str, Any]:
    return dict(_astro_progress)


class ExportBody(BaseModel):
    only_picked: bool = True
    # The renderer's current advanced-filter matches, when exporting those
    # rather than picks. Plain default (not Query(...)) — routes here are
    # also called directly as plain Python in tests, where FastAPI query/body
    # defaults don't apply.
    image_ids: list[int] | None = None


@app.post("/export/xmp", dependencies=[Depends(require_token)])
def export_xmp(body: ExportBody) -> dict[str, Any]:
    return _require_shoot().export_xmp(only_picked=body.only_picked, image_ids=body.image_ids)


# ----- card import / organize (independent of an open shoot) -----

def _organize_paths(body: OrganizeBody) -> tuple[Path, Path, str | None]:
    source = Path(body.source).expanduser()
    library = Path(body.library).expanduser()
    if not source.is_dir():
        raise HTTPException(404, f"source folder not found: {source}")
    if not body.library.strip():
        raise HTTPException(400, "library path is required")
    label = (body.label or "").strip() or None
    return source, library, label


@app.post("/organize/plan", dependencies=[Depends(require_token)])
def organize_plan(body: OrganizeBody) -> dict[str, Any]:
    """Dry preview: how many images, grouped by the dated folder they'd land in."""
    source, library, label = _organize_paths(body)
    return organize_mod.plan_preview(source, library, label_override=label)


@app.post("/organize/run", dependencies=[Depends(require_token)])
async def organize_run(body: OrganizeBody) -> dict[str, Any]:
    """Move the card into the library in the background; poll /organize/progress."""
    source, library, label = _organize_paths(body)
    total = len(organize_mod.walk_inbox(source))
    _organize_progress.update(
        state="complete" if total == 0 else "running",
        done=0, total=total, current=None, moved=0, skipped=0, renamed=0,
    )
    if total == 0:
        return {"started": False, "total": 0}

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: organize_mod.organize(
                source, library, label_override=label, dry_run=False,
                progress=_set_organize_progress,
            ),
        )
        _organize_progress.update(
            state="complete", done=result.moved + result.skipped, total=total,
            current=None, moved=result.moved, skipped=result.skipped, renamed=result.renamed,
        )

    _spawn(_run())
    return {"started": True, "total": total}


@app.get("/organize/progress", dependencies=[Depends(require_token)])
def organize_progress() -> dict[str, Any]:
    return dict(_organize_progress)


# ----- sort a card dump into event folders (independent of an open shoot) -----

def _events_folder(folder: str) -> Path:
    root = Path(folder).expanduser()
    if not root.is_dir():
        raise HTTPException(404, f"folder not found: {root}")
    return root.resolve()


def _release_shoot_under(root: Path) -> None:
    """Close the open shoot if it lives in (or contains) the folder being sorted —
    moving its files would leave shoot.db pointing at paths that no longer exist."""
    global _shoot
    if _shoot is None:
        return
    shoot_root = _shoot.root
    if shoot_root == root or root in shoot_root.parents or shoot_root in root.parents:
        _shoot.close()
        _shoot = None


@app.post("/events/plan", dependencies=[Depends(require_token)])
def events_plan(body: EventsPlanBody) -> dict[str, Any]:
    """Dry preview: loose files grouped into events by capture-time gaps."""
    return events_mod.plan(_events_folder(body.folder), body.gap_hours)


@app.post("/events/run", dependencies=[Depends(require_token)])
async def events_run(body: EventsRunBody) -> dict[str, Any]:
    """Move each group into its folder in the background; poll /events/progress."""
    root = _events_folder(body.folder)
    groups = [(g.event_ids, g.name) for g in body.groups]
    _release_shoot_under(root)
    _events_progress.update(
        state="running", done=0, total=0, current="reading metadata",
        moved=0, renamed=0, folders=[], error=None,
    )

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(
                None,
                lambda: events_mod.run(root, body.gap_hours, groups,
                                       progress=_set_events_progress),
            )
        except events_mod.PlanChanged:
            _events_progress.update(
                state="error", current=None,
                error="The folder changed since the preview. Preview again and retry.",
            )
            return
        except Exception as exc:
            log.exception("events run failed")
            _events_progress.update(state="error", current=None, error=str(exc))
            return
        _events_progress.update(
            state="complete", current=None, moved=result.moved,
            renamed=result.renamed, folders=result.folders,
        )

    _spawn(_run())
    return {"started": True}


@app.get("/events/progress", dependencies=[Depends(require_token)])
def events_progress() -> dict[str, Any]:
    return dict(_events_progress)


@app.post("/events/undo", dependencies=[Depends(require_token)])
def events_undo(body: EventsFolderBody) -> dict[str, int]:
    """Put the newest sort's files back at the top level of the folder."""
    root = _events_folder(body.folder)
    _release_shoot_under(root)
    return events_mod.undo(root)


@app.get("/events/thumb", dependencies=[Depends(require_token_or_query)])
def events_thumb(folder: str = Query(...), name: str = Query(...)) -> FileResponse:
    p = events_mod.thumbnail(_events_folder(folder), name)
    if p is None:
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


# ----- batch mutations (multi-select culling) -----
#
# NB: registered *before* the /images/{image_id}/... routes below. The
# {image_id} path param has no type constraint at the Starlette routing
# layer (only FastAPI's later parameter validation knows it's an int), so a
# request to POST /images/batch/pick would otherwise match
# /images/{image_id}/pick first (binding image_id="batch") and 422 rather
# than falling through to these routes.

@app.post("/images/batch/pick", dependencies=[Depends(require_token)])
def set_pick_batch(body: BatchPickBody) -> dict[str, Any]:
    _require_shoot().set_pick_many(body.image_ids, body.pick)
    return {"image_ids": body.image_ids, "pick": body.pick}


@app.post("/images/batch/stars", dependencies=[Depends(require_token)])
def set_stars_batch(body: BatchStarsBody) -> dict[str, Any]:
    _require_shoot().set_stars_many(body.image_ids, body.stars)
    return {"image_ids": body.image_ids, "stars": body.stars}


@app.post("/images/batch/color", dependencies=[Depends(require_token)])
def set_color_batch(body: BatchColorBody) -> dict[str, Any]:
    _require_shoot().set_color_label_many(body.image_ids, body.color)
    return {"image_ids": body.image_ids, "color": body.color}


@app.get("/images/{image_id}", dependencies=[Depends(require_token)])
def get_image(image_id: int) -> dict[str, Any]:
    img = _require_shoot().get_image(image_id)
    if img is None:
        raise HTTPException(404, "no such image")
    return img


@app.post("/images/{image_id}/pick", dependencies=[Depends(require_token)])
def set_pick(image_id: int, body: PickBody) -> dict[str, int]:
    _require_shoot().set_pick(image_id, body.pick)
    return {"image_id": image_id, "pick": body.pick}


@app.post("/images/{image_id}/stars", dependencies=[Depends(require_token)])
def set_stars(image_id: int, body: StarsBody) -> dict[str, int]:
    _require_shoot().set_stars(image_id, body.stars)
    return {"image_id": image_id, "stars": body.stars}


@app.post("/images/{image_id}/color", dependencies=[Depends(require_token)])
def set_color(image_id: int, body: ColorBody) -> dict[str, Any]:
    _require_shoot().set_color_label(image_id, body.color)
    return {"image_id": image_id, "color": body.color}


@app.post("/images/{image_id}/crop", dependencies=[Depends(require_token)])
def set_crop(image_id: int, body: CropBody) -> dict[str, Any]:
    _require_shoot().set_crop(image_id, body.left, body.top, body.right, body.bottom)
    return {"image_id": image_id, **body.model_dump()}


# ----- file serving (thumb / preview / original) -----

def _safe_join(base: Path, rel: str) -> Path:
    """Reject path traversal. Returns resolved path inside base."""
    candidate = (base / rel).resolve()
    base_resolved = base.resolve()
    if base_resolved not in candidate.parents and candidate != base_resolved:
        raise HTTPException(400, "path escapes base")
    return candidate


@app.get("/files/thumb", dependencies=[Depends(require_token_or_query)])
def serve_thumb(rel: str = Query(...)) -> FileResponse:
    shoot = _require_shoot()
    p = _safe_join(shoot.cache_dir, rel)
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


@app.get("/files/preview", dependencies=[Depends(require_token_or_query)])
def serve_preview(rel: str = Query(...)) -> FileResponse:
    shoot = _require_shoot()
    p = _safe_join(shoot.cache_dir, rel)
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


@app.get("/files/full", dependencies=[Depends(require_token_or_query)])
def serve_full(rel: str = Query(...)) -> FileResponse:
    """Serve the cached full-resolution JPEG (used for RAW/HEIC sources)."""
    shoot = _require_shoot()
    p = _safe_join(shoot.cache_dir, rel)
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


@app.get("/files/original", dependencies=[Depends(require_token_or_query)])
def serve_original(rel: str = Query(...)) -> FileResponse:
    """Serve the original image from the shoot root (used for JPEG sources)."""
    shoot = _require_shoot()
    p = _safe_join(shoot.root, rel)
    if not p.is_file():
        raise HTTPException(404)
    # Let FileResponse infer media type — could be JPEG/HEIC/etc.
    return FileResponse(p)


# ----- CLI -----

def cli() -> None:
    parser = argparse.ArgumentParser(prog="photocull-worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    parser.add_argument("--print-handshake", action="store_true",
                        help="Print JSON {port, token} on stdout once bound, for the parent process")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    import uvicorn

    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        access_log=False,
    )
    server = uvicorn.Server(config)

    # Patch startup to print our handshake once the socket is bound.
    original_startup = server.startup

    async def startup_with_handshake(sockets=None):  # type: ignore[override]
        await original_startup(sockets=sockets)
        if args.print_handshake:
            port = server.servers[0].sockets[0].getsockname()[1]
            import json as _json
            print(_json.dumps({"port": port, "token": AUTH_TOKEN}), flush=True)

    server.startup = startup_with_handshake  # type: ignore[assignment]
    server.run()


if __name__ == "__main__":
    cli()
