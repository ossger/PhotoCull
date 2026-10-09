"""Split a flat card dump into per-event subfolders.

The workflow this serves: pull every file off the SD card into one folder
(``~/Desktop/RAW``), then sort it into one folder per event before culling each
event as its own shoot. This module proposes the events and carries out the
sort. It is the engine behind the ``/events/*`` routes in ``server.py``.

How it decides:

* Only the **top level** of the chosen folder is considered. Existing
  subfolders (events already sorted) and dot-folders are left alone, so a
  re-run after a partial sort only picks up what's still loose.
* Files that share a stem travel as one **unit**: the RAW, its paired JPEG,
  and companions such as ``.xmp`` (both ``IMG_1.CR3.xmp`` and ``IMG_1.xmp``),
  ``.thm``, ``.lrv``, ``.srt``, ``.aae``. Videos are sorted alongside photos.
* Units are ordered by capture time (one batched exiftool read, full datetime;
  file mtime when EXIF has none). A new event starts wherever the gap to the
  previous unit exceeds ``gap_hours``.

Destination folders sit inside the chosen folder and are named
``YYYY-MM-DD <name>``. Nothing is ever overwritten: a unit whose names collide
in the destination gets a shared ``_1``/``_2`` suffix so RAW+JPEG pairs stay
paired. Every run writes a journal to ``<folder>/.photocull/`` first, so the
newest sort can be undone.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import models
from .organize import HEIC_EXTS, JPEG_EXTS, RAW_EXTS

log = logging.getLogger(__name__)

ProgressFn = Callable[[int, int, str], None]

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mts", ".m2ts", ".3gp"}
PHOTO_EXTS = JPEG_EXTS | HEIC_EXTS | RAW_EXTS
PRIMARY_EXTS = PHOTO_EXTS | VIDEO_EXTS
COMPANION_EXTS = {".xmp", ".thm", ".lrv", ".srt", ".aae"}

DEFAULT_GAP_HOURS = 3.0
SAMPLES_PER_EVENT = 4
JOURNAL_DIR = ".photocull"
JOURNAL_PREFIX = "events-undo-"
THUMB_DIR = "event-thumbs"
THUMB_SIZE = 320


@dataclass(slots=True)
class Unit:
    """One capture: the files that share a stem and must move together."""
    stem: str                      # original-case stem shared by every member
    files: list[Path] = field(default_factory=list)
    taken: datetime | None = None
    from_mtime: bool = False

    @property
    def primary(self) -> Path:
        """The file the capture is identified by: RAW over JPEG/HEIC over video."""
        def rank(p: Path) -> tuple[int, str]:
            ext = p.suffix.lower()
            order = 0 if ext in RAW_EXTS else 1 if ext in PHOTO_EXTS else 2
            return (order, p.name)
        return min((f for f in self.files if f.suffix.lower() in PRIMARY_EXTS), key=rank)

    @property
    def preview(self) -> Path:
        """The cheapest member to thumbnail: a JPEG/HEIC when there is one."""
        for f in sorted(self.files, key=lambda p: p.name):
            if f.suffix.lower() in JPEG_EXTS | HEIC_EXTS:
                return f
        return self.primary


@dataclass(slots=True)
class Event:
    id: str
    units: list[Unit]

    @property
    def start(self) -> datetime:
        return self.units[0].taken or datetime.min

    @property
    def end(self) -> datetime:
        return self.units[-1].taken or datetime.min


# ---- pure helpers (unit-testable, no I/O) ----


def _companion_key(name: str) -> str:
    """Stem a companion file pairs on: ``IMG_1.CR3.xmp`` and ``IMG_1.xmp`` -> ``IMG_1``."""
    stem = Path(name).stem
    if Path(stem).suffix.lower() in PRIMARY_EXTS:
        stem = Path(stem).stem
    return stem


def build_units(files: list[Path]) -> tuple[list[Unit], list[Path]]:
    """Group top-level files into units. Returns (units, orphans).

    Orphans are companion files with no matching photo/video; they stay put.
    Files that are neither primary nor companion are ignored entirely.
    """
    units: dict[str, Unit] = {}
    companions: list[Path] = []
    for f in sorted(files, key=lambda p: p.name):
        ext = f.suffix.lower()
        if ext in PRIMARY_EXTS:
            key = f.stem.lower()
            unit = units.setdefault(key, Unit(stem=f.stem))
            unit.files.append(f)
        elif ext in COMPANION_EXTS:
            companions.append(f)

    orphans: list[Path] = []
    for c in companions:
        unit = units.get(_companion_key(c.name).lower())
        if unit is None:
            orphans.append(c)
        else:
            unit.files.append(c)
    return list(units.values()), orphans


def cluster(units: list[Unit], gap_hours: float) -> list[Event]:
    """Sort units by capture time and split wherever the gap exceeds gap_hours.

    Units with no timestamp at all (shouldn't happen once the mtime fallback
    has run) collect into a trailing event of their own.
    """
    gap = timedelta(hours=gap_hours)
    timed = sorted((u for u in units if u.taken is not None),
                   key=lambda u: (u.taken, u.primary.name))
    untimed = [u for u in units if u.taken is None]

    groups: list[list[Unit]] = []
    for u in timed:
        if groups and u.taken - groups[-1][-1].taken <= gap:  # type: ignore[operator]
            groups[-1].append(u)
        else:
            groups.append([u])
    if untimed:
        groups.append(untimed)

    return [Event(id=_event_id(g), units=g) for g in groups]


def _event_id(units: list[Unit]) -> str:
    """Stable for a given folder + gap, so the renderer can key names on it."""
    first = units[0]
    when = first.taken.strftime("%Y%m%dT%H%M%S") if first.taken else "undated"
    return f"{when}-{first.primary.name}"


_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def clean_name(name: str) -> str:
    """A user-typed event name made safe for a folder on macOS and Windows."""
    s = _UNSAFE.sub(" ", name)
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    return s[:80]


def folder_names(groups: list[tuple[datetime, str]]) -> list[str]:
    """``YYYY-MM-DD <name>`` per group, given (start, typed name).

    Unnamed groups that would share a date get ``a``/``b``/… suffixes so two
    unnamed events on one day don't merge into a single folder.
    """
    bases = []
    for start, name in groups:
        date_part = start.strftime("%Y-%m-%d") if start != datetime.min else "Undated"
        cleaned = clean_name(name)
        bases.append(f"{date_part} {cleaned}" if cleaned else date_part)

    counts: dict[str, int] = {}
    for b in bases:
        counts[b] = counts.get(b, 0) + 1
    seen: dict[str, int] = {}
    out = []
    for b in bases:
        if counts[b] > 1:
            idx = seen.get(b, 0)
            seen[b] = idx + 1
            out.append(f"{b}{chr(ord('a') + idx)}" if idx < 26 else f"{b}-{idx + 1}")
        else:
            out.append(b)
    return out


# ---- filesystem I/O ----


def list_top_level(folder: Path) -> list[Path]:
    """Regular, non-hidden files directly inside folder."""
    out = []
    for entry in os.scandir(folder):
        if entry.name.startswith(".") or not entry.is_file(follow_symlinks=False):
            continue
        out.append(Path(entry.path))
    return sorted(out)


def _parse_exif_datetime(value: object) -> datetime | None:
    """exiftool gives 'YYYY:MM:DD HH:MM:SS[.ss][+hh:mm]'; keep local wall time."""
    if not value:
        return None
    s = str(value).strip()
    if len(s) < 19 or s.startswith("0000"):
        return None
    try:
        return datetime(int(s[0:4]), int(s[5:7]), int(s[8:10]),
                        int(s[11:13]), int(s[14:16]), int(s[17:19]))
    except ValueError:
        return None


def read_capture_times(paths: list[Path]) -> dict[Path, datetime]:
    """Batch-read capture datetimes in one exiftool call. Never raises.

    Files exiftool can't date are simply absent; the caller falls back to
    mtime. ``-api QuickTimeUTC`` converts video timestamps (stored as UTC) to
    local time so clips land in the same event as the stills around them.
    """
    if not paths:
        return {}
    exiftool = models.find_exiftool()
    if exiftool is None:
        try:
            exiftool = models.ensure_exiftool()
        except Exception as exc:  # noqa: BLE001 - degrade to mtime-only
            log.warning("exiftool unavailable — using file dates only: %s", exc)
            return {}

    by_key = {_key(p): p for p in paths}
    with tempfile.TemporaryDirectory(prefix="photocull-evt-") as td:
        argfile = Path(td) / "files.args"
        argfile.write_text("\n".join(str(p) for p in paths) + "\n", encoding="utf-8")
        cmd = [
            str(exiftool), "-j", "-fast2", "-api", "QuickTimeUTC",
            "-charset", "filename=UTF8",
            "-DateTimeOriginal", "-CreateDate",
            "-@", str(argfile),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, encoding="utf-8", timeout=900, check=False
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("exiftool failed to run — using file dates only: %s", exc)
            return {}

    try:
        records = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        log.warning("exiftool returned bad JSON — using file dates only: %s", exc)
        return {}

    out: dict[Path, datetime] = {}
    for rec in records:
        p = by_key.get(_key(Path(rec.get("SourceFile", ""))))
        if p is None:
            continue
        taken = _parse_exif_datetime(rec.get("DateTimeOriginal")) or _parse_exif_datetime(
            rec.get("CreateDate")
        )
        if taken is not None:
            out[p] = taken
    return out


def _key(p: Path) -> str:
    return os.path.normcase(os.path.abspath(str(p)))


def scan(folder: Path, reader: Callable[[list[Path]], dict[Path, datetime]] | None = None,
         ) -> tuple[list[Unit], list[Path]]:
    """List, group and date the loose files in folder. ``reader`` is injectable for tests."""
    units, orphans = build_units(list_top_level(folder))
    reader = reader or read_capture_times
    times = reader([f for u in units for f in u.files if f.suffix.lower() in PRIMARY_EXTS])
    for u in units:
        found = [times[f] for f in u.files if f in times]
        if found:
            u.taken = min(found)
        else:
            u.taken = datetime.fromtimestamp(min(f.stat().st_mtime for f in u.files))
            u.from_mtime = True
    return units, orphans


def plan(folder: Path, gap_hours: float = DEFAULT_GAP_HOURS,
         reader: Callable[[list[Path]], dict[Path, datetime]] | None = None,
         ) -> dict[str, object]:
    """Dry preview for the GUI. Touches no files."""
    units, orphans = scan(folder, reader)
    events = cluster(units, gap_hours)
    defaults = folder_names([(e.start, "") for e in events])
    out_events = []
    for e, default in zip(events, defaults):
        step = max(1, len(e.units) // SAMPLES_PER_EVENT)
        samples = [u.preview.name for u in e.units[::step]][:SAMPLES_PER_EVENT]
        out_events.append({
            "id": e.id,
            "start": e.start.isoformat(),
            "end": e.end.isoformat(),
            "count": len(e.units),
            "files": sum(len(u.files) for u in e.units),
            "undated": sum(1 for u in e.units if u.from_mtime),
            "default_name": default,
            "samples": samples,
        })
    return {
        "folder": str(folder),
        "gap_hours": gap_hours,
        "total_units": len(units),
        "total_files": sum(len(u.files) for u in units),
        "orphans": [o.name for o in orphans],
        "events": out_events,
        "can_undo": latest_journal(folder) is not None,
    }


class PlanChanged(Exception):
    """The folder no longer matches the preview the user named events against."""


@dataclass(slots=True)
class Result:
    moved: int = 0
    renamed: int = 0
    folders: list[str] = field(default_factory=list)


def _unit_suffix(unit: Unit, dest_dir: Path) -> int:
    """Smallest n (0 = none) such that every member's name is free in dest_dir."""
    n = 0
    while any((dest_dir / _suffixed(f.name, unit.stem, n)).exists() for f in unit.files):
        n += 1
    return n


def _suffixed(name: str, stem: str, n: int) -> str:
    if n == 0:
        return name
    cut = len(stem) if name.lower().startswith(stem.lower()) else len(Path(name).stem)
    return f"{name[:cut]}_{n}{name[cut:]}"


def run(folder: Path, gap_hours: float, groups: list[tuple[list[str], str]],
        progress: ProgressFn | None = None,
        reader: Callable[[list[Path]], dict[Path, datetime]] | None = None,
        ) -> Result:
    """Sort the loose files in folder into event subfolders.

    ``groups`` is ``[(event_ids, typed_name), ...]`` — usually one id per group;
    several when the user merged neighbouring events. Planned events left out
    of every group stay loose. Raises PlanChanged if an id no longer exists.
    """
    units, _ = scan(folder, reader)
    by_id = {e.id: e for e in cluster(units, gap_hours)}

    resolved: list[tuple[datetime, str, list[Unit]]] = []
    for ids, name in groups:
        members: list[Unit] = []
        for eid in ids:
            if eid not in by_id:
                raise PlanChanged(eid)
            members.extend(by_id[eid].units)
        if members:
            resolved.append((min(u.taken or datetime.min for u in members), name, members))

    names = folder_names([(start, name) for start, name, _ in resolved])

    moves: list[tuple[Path, Path]] = []
    created: list[str] = []
    result = Result()
    for (_, _, members), dir_name in zip(resolved, names):
        dest_dir = folder / dir_name
        if not dest_dir.exists():
            created.append(dir_name)
        result.folders.append(dir_name)
        for u in members:
            n = _unit_suffix(u, dest_dir)
            if n:
                result.renamed += len(u.files)
            for f in u.files:
                moves.append((f, dest_dir / _suffixed(f.name, u.stem, n)))

    if not moves:
        return result

    journal = _write_journal(folder, moves, created)
    total = len(moves)
    for idx, (src, dest) in enumerate(moves):
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        result.moved += 1
        if progress is not None:
            progress(idx + 1, total, src.name)
    log.info("events: moved %d file(s) into %d folder(s); journal %s",
             result.moved, len(result.folders), journal.name)
    return result


# ---- undo journal ----


def _journal_dir(folder: Path) -> Path:
    return folder / JOURNAL_DIR


def _write_journal(folder: Path, moves: list[tuple[Path, Path]], created: list[str]) -> Path:
    d = _journal_dir(folder)
    d.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
    path = d / f"{JOURNAL_PREFIX}{stamp}.json"
    path.write_text(json.dumps({
        "created_dirs": created,
        "moves": [{"src": s.relative_to(folder).as_posix(),
                   "dest": t.relative_to(folder).as_posix()} for s, t in moves],
    }, indent=1), encoding="utf-8")
    return path


def latest_journal(folder: Path) -> Path | None:
    d = _journal_dir(folder)
    if not d.is_dir():
        return None
    journals = sorted(d.glob(f"{JOURNAL_PREFIX}*.json"))
    return journals[-1] if journals else None


def undo(folder: Path) -> dict[str, int]:
    """Reverse the newest sort. Files moved or renamed since are left where they are."""
    journal = latest_journal(folder)
    if journal is None:
        return {"restored": 0, "missing": 0}
    data = json.loads(journal.read_text(encoding="utf-8"))
    restored = missing = 0
    for mv in reversed(data.get("moves", [])):
        src, dest = folder / mv["src"], folder / mv["dest"]
        if dest.exists() and not src.exists():
            shutil.move(str(dest), str(src))
            restored += 1
        else:
            missing += 1
    for name in data.get("created_dirs", []):
        d = folder / name
        if not d.is_dir():
            continue
        leftovers = [p for p in d.iterdir() if p.name != ".DS_Store"]
        if not leftovers:
            shutil.rmtree(d, ignore_errors=True)
    journal.unlink()
    return {"restored": restored, "missing": missing}


# ---- preview thumbnails ----


def thumbnail(folder: Path, name: str) -> Path | None:
    """A small cached JPEG for one loose file in folder, or None if it can't be made."""
    if Path(name).name != name or name.startswith("."):
        return None
    src = folder / name
    if not src.is_file():
        return None
    ext = src.suffix.lower()
    if ext not in PHOTO_EXTS:
        return None

    out = _journal_dir(folder) / THUMB_DIR / f"{name}.jpg"
    if out.is_file() and out.stat().st_mtime >= src.stat().st_mtime:
        return out

    from PIL import Image, ImageOps

    try:
        if ext in RAW_EXTS:
            from . import raw as raw_decode
            img = raw_decode.open_raw_as_pil(src)
        else:
            img = Image.open(src)
        img = ImageOps.exif_transpose(img)
        img.thumbnail((THUMB_SIZE, THUMB_SIZE))
        out.parent.mkdir(parents=True, exist_ok=True)
        img.convert("RGB").save(out, "JPEG", quality=80)
    except Exception as exc:  # noqa: BLE001 - a bad file just shows no preview
        log.debug("event thumbnail failed for %s: %s", src, exc)
        return None
    return out
