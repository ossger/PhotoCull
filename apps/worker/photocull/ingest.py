"""Folder scan + EXIF extraction + thumbnail generation.

Supports JPEG/HEIC and RAW (CR2/CR3/NEF/ARW/DNG/etc.) via Pillow + rawpy.
RAW files use the embedded JPEG preview for speed, falling back to a
half-size libraw demosaic when no usable preview is present — see `raw.py`.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Iterable

import cv2
import imagehash
import numpy as np
import rawpy
from PIL import Image, ExifTags, ImageOps

from .scoring import sharpness as sharpness_score
from .scoring import exposure as exposure_score
from .scoring import faces as faces_score
from .scoring import aesthetic as aesthetic_score
from .scoring.aggregate import Scores, overall as overall_score
from . import raw as raw_decode
from . import focus_meta

log = logging.getLogger(__name__)

JPEG_EXTS = {".jpg", ".jpeg", ".jpe", ".jfif"}
HEIC_EXTS = {".heic", ".heif"}
RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2",
    ".dng", ".raf", ".orf", ".rw2", ".pef", ".rwl", ".x3f", ".3fr",
}
SUPPORTED_EXTS = JPEG_EXTS | HEIC_EXTS | RAW_EXTS

THUMB_SIZE = 512   # long edge
PREVIEW_SIZE = 1600


@dataclass(slots=True)
class IngestedImage:
    rel_path: str
    filename: str
    bytes: int
    mtime: float
    captured_at: str | None
    camera_make: str | None
    camera_model: str | None
    lens: str | None
    iso: int | None
    shutter: str | None
    aperture: float | None
    focal_length: float | None
    width: int | None
    height: int | None
    orientation: int | None
    focus_mode: str | None
    af_area_mode: str | None
    af_points_in_focus: str | None
    thumb_path: str | None
    preview_path: str | None
    full_path: str | None
    phash: str | None
    score_focus: float | None
    score_exposure: float | None
    score_eyes: float | None
    n_faces: int | None
    faces_json: str | None
    score_aesthetic: float | None
    score_overall: float | None
    luma: float | None = None


def walk_folder(root: Path) -> Iterable[Path]:
    """Yield supported image files under root, recursively, sorted for stability."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in sorted(filenames):
            ext = Path(name).suffix.lower()
            if ext in SUPPORTED_EXTS:
                yield Path(dirpath) / name


def group_sources(
    files: Iterable[Path],
) -> tuple[list[Path], list[Path], dict[Path, Path]]:
    """Collapse RAW+JPEG/HEIC pairs into one canonical file per capture.

    Two files pair when they share a folder and a filename stem
    (case-insensitive) — the standard RAW+JPEG naming a camera produces
    (``IMG_1234.CR3`` + ``IMG_1234.JPG``). The RAW wins as the canonical file
    (it's what we cull and write the XMP sidecar next to); with no RAW present
    the JPEG/HEIC is canonical. Singletons pass through as canonical.

    Returns ``(canonical_files, shadowed_files, shadow_map)`` — canonicals in
    the order they first appear; shadowed = the siblings we drop; shadow_map
    maps each shadowed file to the canonical file it was paired with, so the
    caller can carry the shadowed row's pick/star/etc. over before deleting it.
    """
    groups: dict[tuple[Path, str], list[Path]] = {}
    order: list[tuple[Path, str]] = []
    for f in files:
        key = (f.parent, f.stem.lower())
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(f)

    canonical: list[Path] = []
    shadowed: list[Path] = []
    shadow_map: dict[Path, Path] = {}
    for key in order:
        members = groups[key]
        raws = sorted((m for m in members if m.suffix.lower() in RAW_EXTS), key=str)
        chosen = raws[0] if raws else members[0]
        canonical.append(chosen)
        for m in members:
            if m != chosen:
                shadowed.append(m)
                shadow_map[m] = chosen
    return canonical, shadowed, shadow_map


def _exif_dict(img: Image.Image) -> dict[str, object]:
    """Return a tag-name-keyed copy of the image's EXIF, or an empty dict."""
    raw = img.getexif()
    if not raw:
        return {}
    out: dict[str, object] = {ExifTags.TAGS.get(k, str(k)): v for k, v in raw.items()}
    # IFD pointer values that hold the camera-detail EXIF block
    for ifd_id, ifd_name in (
        (ExifTags.IFD.Exif, "Exif"),
        (ExifTags.IFD.GPSInfo, "GPSInfo"),
    ):
        try:
            ifd = raw.get_ifd(ifd_id)
        except Exception:
            ifd = None
        if ifd:
            for k, v in ifd.items():
                out[ExifTags.TAGS.get(k, f"{ifd_name}:{k}")] = v
    return out


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        if isinstance(value, tuple) and len(value) == 2:
            return float(Fraction(value[0], value[1]))
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _as_int(value: object) -> int | None:
    f = _as_float(value)
    return int(f) if f is not None else None


def _format_shutter(value: object) -> str | None:
    f = _as_float(value)
    if f is None:
        return None
    if f >= 1:
        return f"{f:g}s"
    denom = round(1 / f) if f > 0 else 0
    return f"1/{denom}" if denom else None


def _iso_string(dt: str | None) -> str | None:
    """EXIF DateTimeOriginal is 'YYYY:MM:DD HH:MM:SS'; convert to ISO 8601."""
    if not dt or len(dt) < 19:
        return None
    return f"{dt[0:4]}-{dt[5:7]}-{dt[8:10]}T{dt[11:19]}"


def _decode_source(src: Path) -> tuple[Image.Image, dict[str, object], tuple[int, int]]:
    """Decode a source file (JPEG/HEIC or RAW). Returns (image, exif, (width, height)).

    For RAW: pulls the embedded JPEG (with full EXIF) via rawpy, and reads true
    RAW image dimensions from libraw — so the DB shows the camera's native
    resolution, not the preview size.
    """
    ext = src.suffix.lower()
    if ext in RAW_EXTS:
        # True dimensions come from libraw; image content comes from raw.open_raw_as_pil
        # which prefers the embedded JPEG (fast, full EXIF) and falls back to
        # half-size demosaic only when needed.
        with rawpy.imread(str(src)) as r:
            sizes = r.sizes
            width = int(sizes.width)
            height = int(sizes.height)
        im = raw_decode.open_raw_as_pil(src)
        exif = _exif_dict(im) if im.format == "JPEG" else {}
        return im, exif, (width, height)

    # JPEG / HEIC
    im = Image.open(src)
    im.load()
    exif = _exif_dict(im)
    return im, exif, im.size


def _median_luma(preview_path: Path) -> float | None:
    gray = cv2.imread(str(preview_path), cv2.IMREAD_GRAYSCALE)
    if gray is None or gray.size == 0:
        return None
    return float(np.median(gray)) / 255.0


def ingest_one(
    src: Path,
    root: Path,
    cache_dir: Path,
    focus: focus_meta.FocusMeta | None = None,
) -> IngestedImage:
    """Open one image, extract EXIF, write thumb + preview JPEGs to the cache.

    All paths stored in the DB are relative — `rel_path` to the shoot root,
    `thumb_path` / `preview_path` to the cache dir — so a shoot folder can be
    moved without invalidating the DB.
    """
    stat = src.stat()
    rel = src.relative_to(root).as_posix()

    im, exif, (width, height) = _decode_source(src)
    try:
        orientation = _as_int(exif.get("Orientation"))
        ingested = IngestedImage(
            rel_path=rel,
            filename=src.name,
            bytes=stat.st_size,
            mtime=stat.st_mtime,
            captured_at=_iso_string(exif.get("DateTimeOriginal") or exif.get("DateTime")),  # type: ignore[arg-type]
            camera_make=(exif.get("Make") or "").strip() or None if isinstance(exif.get("Make"), str) else None,
            camera_model=(exif.get("Model") or "").strip() or None if isinstance(exif.get("Model"), str) else None,
            lens=(exif.get("LensModel") or "").strip() or None if isinstance(exif.get("LensModel"), str) else None,
            iso=_as_int(exif.get("ISOSpeedRatings") or exif.get("PhotographicSensitivity")),
            shutter=_format_shutter(exif.get("ExposureTime")),
            aperture=_as_float(exif.get("FNumber")),
            focal_length=_as_float(exif.get("FocalLength")),
            width=width,
            height=height,
            orientation=orientation,
            focus_mode=focus.focus_mode if focus else None,
            af_area_mode=focus.af_area_mode if focus else None,
            af_points_in_focus=focus.af_points_in_focus if focus else None,
            thumb_path=None,
            preview_path=None,
            full_path=None,
            phash=None,
            score_focus=None,
            score_exposure=None,
            score_eyes=None,
            n_faces=None,
            faces_json=None,
            score_aesthetic=None,
            score_overall=None,
        )

        oriented = ImageOps.exif_transpose(im) or im

        thumb_dir = cache_dir / "thumb"
        preview_dir = cache_dir / "preview"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        preview_dir.mkdir(parents=True, exist_ok=True)

        stem = f"{src.stem}_{int(stat.st_mtime)}_{stat.st_size}"
        thumb_path = thumb_dir / f"{stem}.jpg"
        preview_path = preview_dir / f"{stem}.jpg"

        if not thumb_path.exists():
            t = oriented.copy()
            t.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
            t.convert("RGB").save(thumb_path, "JPEG", quality=82, optimize=True)
        if not preview_path.exists():
            p = oriented.copy()
            p.thumbnail((PREVIEW_SIZE, PREVIEW_SIZE), Image.Resampling.LANCZOS)
            p.convert("RGB").save(preview_path, "JPEG", quality=88)

        ingested.thumb_path = thumb_path.relative_to(cache_dir).as_posix()
        ingested.preview_path = preview_path.relative_to(cache_dir).as_posix()

        # Full-resolution image for pixel-peeping zoom.
        # RAW: extract the camera's embedded JPEG byte-for-byte (highest quality
        # preview the camera can produce). HEIC: re-encode as JPEG. JPEG: leave
        # `full_path` NULL — the server will stream the original from the
        # shoot root.
        ext = src.suffix.lower()
        if ext in RAW_EXTS:
            full_dir = cache_dir / "full"
            full_path = full_dir / f"{stem}.jpg"
            if not full_path.exists():
                if not raw_decode.write_embedded_jpeg(src, full_path):
                    raw_decode.render_full_demosaic(src, full_path)
            ingested.full_path = full_path.relative_to(cache_dir).as_posix()
        elif ext in HEIC_EXTS:
            full_dir = cache_dir / "full"
            full_path = full_dir / f"{stem}.jpg"
            if not full_path.exists():
                oriented.convert("RGB").save(full_path, "JPEG", quality=92, optimize=True)
            ingested.full_path = full_path.relative_to(cache_dir).as_posix()
        # JPEG: full_path stays None; server serves original
    finally:
        im.close()

    # pHash + local scoring on the cached thumb/preview (cheap, one extra read each)
    try:
        with Image.open(thumb_path) as thumb:
            ingested.phash = str(imagehash.phash(thumb))
    except Exception as exc:  # noqa: BLE001
        log.debug("phash failed for %s: %s", src, exc)

    ingested.score_focus = sharpness_score.score_path(preview_path)
    ingested.score_exposure = exposure_score.score_path(preview_path)
    ingested.score_aesthetic = aesthetic_score.score_path(preview_path)
    try:
        faces_result = faces_score.detect_path(preview_path)
        ingested.score_eyes = faces_result.score
        ingested.n_faces = faces_result.n_faces
        ingested.faces_json = faces_score.serialize_faces(faces_result.faces)
    except Exception as exc:  # noqa: BLE001 - face model failures shouldn't kill ingest
        log.warning("faces detection failed for %s: %s", src, exc)

    ingested.luma = _median_luma(preview_path)

    ingested.score_overall = overall_score(
        Scores(
            focus=ingested.score_focus,
            exposure=ingested.score_exposure,
            eyes=ingested.score_eyes,
            aesthetic=ingested.score_aesthetic,
        )
    )

    return ingested
