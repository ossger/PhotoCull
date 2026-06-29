"""Sort raw camera/drone captures into a dated library.

This is the engine behind both the in-app **Import** panel (via the
``/organize/*`` routes in ``server.py``) and the ``photocull-organize`` CLI
below — you run it to tidy memory cards *before* culling. It only sorts (moves)
files; it never scores, edits, or deletes them.

It pulls every supported image out of an ingest inbox (default:
``<repo>/_RawIngest``), reads each file's capture date + camera in one batched
exiftool pass, and **moves** it into a date-plus-source folder tree::

    <library>/<YYYY>/<YYYY-MM-DD>_<Source>/<filename>

e.g.::

    PhotoLibrary/2026/2026-06-24_DJI-Drone/DJI_0001.DNG
    PhotoLibrary/2026/2026-06-25_Canon-R6mkii/R6_3920.CR3

The source token comes from EXIF Make/Model (DJI drone vs Canon body), so a
day's drone flight and a day's camera work land in separate, self-describing
folders. Pass ``--label`` to override it for a one-off shoot
("2026-06-24_Beach"), and ``--dry-run`` to preview the plan before moving a
single byte.

Run ``python -m photocull.organize --help``.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Callable

from . import models

# Called after each file is processed: (done, total, current_filename).
ProgressFn = Callable[[int, int, str], None]

log = logging.getLogger(__name__)

# Source-of-truth for these lives in ingest.py; kept as a local copy so the
# organizer stays dependency-light (no rawpy/mediapipe just to move files).
JPEG_EXTS = {".jpg", ".jpeg", ".jpe", ".jfif"}
HEIC_EXTS = {".heic", ".heif"}
RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2",
    ".dng", ".raf", ".orf", ".rw2", ".pef", ".rwl", ".x3f", ".3fr",
}
SUPPORTED_EXTS = JPEG_EXTS | HEIC_EXTS | RAW_EXTS

# Repo root: organize.py is at apps/worker/photocull/organize.py
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SOURCE = REPO_ROOT / "_RawIngest"
DEFAULT_LIBRARY = REPO_ROOT / "PhotoLibrary"


@dataclass(slots=True)
class CaptureMeta:
    """What we need to file one photo: when it was taken and what shot it."""
    taken_on: date | None
    make: str | None
    model: str | None


@dataclass(slots=True)
class Move:
    src: Path
    dest: Path


# ---- pure helpers (unit-testable, no I/O) ----


def _slug(text: str) -> str:
    """Folder-safe token: keep alnum, collapse everything else to single dashes."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", text.strip()).strip("-")
    return s or "Unknown"


def source_label(make: str | None, model: str | None) -> str:
    """Map camera Make/Model to a stable, human-readable folder token.

    Special-cases the two bodies in use (DJI drone, Canon R6 Mark II); any other
    camera degrades to a slug of its model so future gear still sorts cleanly.
    """
    mk = (make or "").strip()
    mod = (model or "").strip()
    if "dji" in mk.lower() or "dji" in mod.lower():
        return "DJI-Drone"
    compact = mod.lower().replace(" ", "")
    if "r6m2" in compact or "r6markii" in compact:
        return "Canon-R6mkii"
    if mod:
        return _slug(mod)
    if mk:
        return _slug(mk)
    return "Unknown"


def _dest_dir(library: Path, taken_on: date, label: str) -> Path:
    return library / f"{taken_on.year:04d}" / f"{taken_on.isoformat()}_{label}"


def plan_moves(
    files: list[Path],
    meta_by_path: dict[Path, CaptureMeta],
    library: Path,
    label_override: str | None = None,
) -> list[Move]:
    """Decide a destination for each file. Falls back to file mtime when EXIF has
    no capture date, and to "Unknown" source when the camera can't be read.
    """
    moves: list[Move] = []
    for src in files:
        meta = meta_by_path.get(src)
        taken_on = meta.taken_on if meta else None
        if taken_on is None:
            taken_on = datetime.fromtimestamp(src.stat().st_mtime).date()
        label = label_override or source_label(
            meta.make if meta else None, meta.model if meta else None
        )
        moves.append(Move(src=src, dest=_dest_dir(library, taken_on, label) / src.name))
    return moves


# ---- filesystem I/O ----


def walk_inbox(root: Path) -> list[Path]:
    """Every supported image under root (recursive), skipping dot-dirs. Sorted."""
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix.lower() in SUPPORTED_EXTS:
                found.append(Path(dirpath) / name)
    return sorted(found)


def _parse_exif_date(value: object) -> date | None:
    """exiftool dates look like 'YYYY:MM:DD HH:MM:SS' (sometimes with tz)."""
    if not value:
        return None
    s = str(value).strip()
    if len(s) < 10:
        return None
    try:
        return date(int(s[0:4]), int(s[5:7]), int(s[8:10]))
    except ValueError:
        return None


def read_capture_meta(paths: list[Path]) -> dict[Path, CaptureMeta]:
    """Batch-read capture date + camera for many files in one exiftool call.

    A file that errors (or has no tags) simply won't appear in the result; the
    caller treats that as "no metadata" and falls back to file mtime. Never
    raises — failing to read a tag must not abort an import.
    """
    if not paths:
        return {}

    exiftool = models.find_exiftool()
    if exiftool is None:
        try:
            exiftool = models.ensure_exiftool()
        except Exception as exc:  # noqa: BLE001 - degrade to mtime-only sorting
            log.warning("exiftool unavailable — sorting by file date only: %s", exc)
            return {}

    by_key = {_key(p): p for p in paths}
    # -@ argfile keeps us clear of command-line length limits on big card dumps.
    import tempfile

    with tempfile.TemporaryDirectory(prefix="photocull-org-") as td:
        argfile = Path(td) / "files.args"
        argfile.write_text("\n".join(str(p) for p in paths) + "\n", encoding="utf-8")
        cmd = [
            str(exiftool),
            "-j",
            "-fast2",
            "-charset", "filename=UTF8",
            "-DateTimeOriginal", "-CreateDate", "-Make", "-Model",
            "-@", str(argfile),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, encoding="utf-8", timeout=600
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("exiftool read failed to run — sorting by file date only: %s", exc)
            return {}

    if proc.returncode != 0 and not proc.stdout.strip():
        log.warning("exiftool exit %d — sorting by file date only: %s",
                    proc.returncode, proc.stderr.strip())
        return {}

    try:
        records = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        log.warning("exiftool returned bad JSON — sorting by file date only: %s", exc)
        return {}

    out: dict[Path, CaptureMeta] = {}
    for rec in records:
        src = rec.get("SourceFile")
        if not src:
            continue
        p = by_key.get(_key(Path(src)))
        if p is None:
            continue
        taken = _parse_exif_date(rec.get("DateTimeOriginal")) or _parse_exif_date(
            rec.get("CreateDate")
        )
        out[p] = CaptureMeta(
            taken_on=taken,
            make=(str(rec["Make"]).strip() or None) if rec.get("Make") else None,
            model=(str(rec["Model"]).strip() or None) if rec.get("Model") else None,
        )
    return out


def _key(p: Path) -> str:
    """Case-insensitive absolute key to match exiftool's SourceFile back to ours."""
    return os.path.normcase(os.path.abspath(str(p)))


@dataclass(slots=True)
class Result:
    moved: int = 0
    skipped: int = 0
    renamed: int = 0


def execute_moves(
    moves: list[Move], dry_run: bool, progress: ProgressFn | None = None
) -> Result:
    """Carry out (or, with dry_run, just print) the planned moves.

    Collision policy is conservative: identical-size files are treated as
    already-imported and skipped (source left in place for you to confirm);
    differing files get a numeric suffix. Nothing is ever overwritten, so a
    re-run after a partial import is safe.

    ``progress`` (if given) is called once per file with (done, total, name) so
    the GUI can show a moving bar; it fires for skipped files too.
    """
    result = Result()
    total = len(moves)
    for idx, mv in enumerate(moves):
        dest = mv.dest
        action = "move"
        if dest.exists():
            try:
                same = dest.stat().st_size == mv.src.stat().st_size
            except OSError:
                same = False
            if same:
                action = "skip"
            else:
                dest = _unique_name(dest)
                action = "rename"

        rel = dest.relative_to(dest.parents[2]) if len(dest.parents) >= 3 else dest.name
        if action == "skip":
            result.skipped += 1
            log.info("skip (already present): %s", mv.src.name)
        else:
            if dry_run:
                log.info("would move: %s -> %s", mv.src.name, rel)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(mv.src), str(dest))
                log.info("moved: %s -> %s", mv.src.name, rel)
            if action == "rename":
                result.renamed += 1
            result.moved += 1

        if progress is not None:
            progress(idx + 1, total, mv.src.name)
    return result


def _unique_name(dest: Path) -> Path:
    """Append _1, _2, ... before the extension until the name is free."""
    stem, suffix = dest.stem, dest.suffix
    i = 1
    while True:
        candidate = dest.with_name(f"{stem}_{i}{suffix}")
        if not candidate.exists():
            return candidate
        i += 1


def _prune_empty_dirs(root: Path) -> None:
    """Remove now-empty subdirectories under root (keeps the inbox tidy). Leaves
    root itself, and ignores anything that won't delete."""
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        d = Path(dirpath)
        if d == root:
            continue
        if not any(d.iterdir()):
            try:
                d.rmdir()
            except OSError:
                pass


def plan_preview(
    source: Path,
    library: Path,
    label_override: str | None = None,
) -> dict[str, object]:
    """Dry scan for the GUI: what *would* move, grouped by destination folder.

    Touches no files — it walks the inbox, reads capture metadata, and runs the
    collision check in dry-run mode so the caller can show "N files into these
    folders, M skipped as duplicates" before committing.
    """
    files = walk_inbox(source)
    meta = read_capture_meta(files)
    moves = plan_moves(files, meta, library, label_override=label_override)
    dry = execute_moves(moves, dry_run=True)

    counts: dict[str, int] = {}
    for mv in moves:
        folder = mv.dest.parent
        try:
            key = folder.relative_to(library).as_posix()
        except ValueError:
            key = str(folder)
        counts[key] = counts.get(key, 0) + 1
    groups = [{"folder": k, "count": v} for k, v in sorted(counts.items())]

    return {
        "total": len(files),
        "groups": groups,
        "would_move": dry.moved,
        "would_skip": dry.skipped,
        "would_rename": dry.renamed,
    }


def organize(
    source: Path,
    library: Path,
    label_override: str | None = None,
    dry_run: bool = False,
    progress: ProgressFn | None = None,
) -> Result:
    """Top-level entry: scan source, plan, and move into library."""
    files = walk_inbox(source)
    if not files:
        log.info("nothing to do — no supported images under %s", source)
        return Result()
    log.info("found %d image(s) under %s", len(files), source)

    if progress is not None:
        progress(0, len(files), "reading metadata")
    meta = read_capture_meta(files)
    moves = plan_moves(files, meta, library, label_override=label_override)
    result = execute_moves(moves, dry_run=dry_run, progress=progress)

    if not dry_run:
        _prune_empty_dirs(source)
    return result


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="photocull-organize",
        description="Sort raw camera/drone captures from an inbox into a dated library.",
    )
    parser.add_argument(
        "--source", type=Path, default=DEFAULT_SOURCE,
        help=f"Inbox folder to pull from (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--library", type=Path, default=DEFAULT_LIBRARY,
        help=f"Library root to sort into (default: {DEFAULT_LIBRARY})",
    )
    parser.add_argument(
        "--label", default=None,
        help="Override the per-folder source token (e.g. 'Beach'); default is the camera.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show the plan without moving any files.",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Log every file, not just the summary.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose or args.dry_run else logging.WARNING,
        format="%(message)s",
    )

    source: Path = args.source
    if not source.is_dir():
        print(f"error: source folder does not exist: {source}", file=sys.stderr)
        return 2

    result = organize(source, args.library, label_override=args.label, dry_run=args.dry_run)

    verb = "Would move" if args.dry_run else "Moved"
    print(
        f"{verb} {result.moved} file(s) into {args.library} "
        f"({result.renamed} renamed to avoid collisions, {result.skipped} skipped as duplicates)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
