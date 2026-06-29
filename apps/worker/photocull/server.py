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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .shoot import Shoot

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
# Per-shoot ingest progress; replaced when a new shoot starts.
_progress: dict[str, Any] = {"state": "idle", "done": 0, "total": 0, "current": None}


def _set_progress(done: int, total: int, current: str) -> None:
    _progress["state"] = "running" if done < total else "complete"
    _progress["done"] = done
    _progress["total"] = total
    _progress["current"] = current


# ----- models -----

class OpenShootBody(BaseModel):
    path: str = Field(..., description="Absolute path to the folder to open as a shoot")


class PickBody(BaseModel):
    pick: int = Field(..., ge=-1, le=1)


class StarsBody(BaseModel):
    stars: int = Field(..., ge=0, le=5)


class ColorBody(BaseModel):
    color: str | None = None


class CropBody(BaseModel):
    """All four bounds are normalised 0..1 of the image. Send all-null to clear."""
    left: float | None = None
    top: float | None = None
    right: float | None = None
    bottom: float | None = None


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
    global _shoot
    root = Path(body.path).expanduser()
    if not root.is_dir():
        raise HTTPException(404, f"not a directory: {root}")

    if _shoot is not None:
        _shoot.close()
        _shoot = None

    _shoot = Shoot(root)
    _set_progress(0, 1, "starting")

    async def _run_ingest() -> None:
        loop = asyncio.get_running_loop()
        assert _shoot is not None
        count = await loop.run_in_executor(
            None, lambda: _shoot.ingest(progress=_set_progress)
        )
        _progress["state"] = "complete"
        _progress["done"] = count
        _progress["total"] = count
        _progress["current"] = None

    asyncio.create_task(_run_ingest())

    return {"root": str(_shoot.root), "cache": str(_shoot.cache_dir)}


@app.get("/shoot/progress", dependencies=[Depends(require_token)])
def shoot_progress() -> dict[str, Any]:
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


@app.post("/scenes/regroup", dependencies=[Depends(require_token)])
def regroup_scenes() -> dict[str, int]:
    return {"scene_count": _require_shoot().regroup_scenes()}


class ExportBody(BaseModel):
    only_picked: bool = True


@app.post("/export/xmp", dependencies=[Depends(require_token)])
def export_xmp(body: ExportBody) -> dict[str, Any]:
    return _require_shoot().export_xmp(only_picked=body.only_picked)


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
