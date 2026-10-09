"""Camera AF / focus-detection metadata, read from MakerNotes via exiftool.

Pillow's EXIF parser (used in ingest.py) only sees standard EXIF tags — the
*focus* story (which AF points fired, One-Shot vs Servo, face/eye-detect AF)
lives in vendor MakerNotes, which Pillow doesn't decode. exiftool does, and
it's already bundled for XMP export, so we reuse it here in read mode.

One batched exiftool call covers a whole shoot: process startup dwarfs the
per-file parse, so batching is far faster than spawning per image — the same
reason export/xmp.py batches its writes.

Vendor differences are mostly absorbed by exiftool itself, which exposes
human-readable ``FocusMode`` / ``AFAreaMode`` for Canon, Nikon and Sony alike.
The only real divergence is the in-focus-point tag name, so we fall back
across the known spellings.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import models

log = logging.getLogger(__name__)

# Tags requested from exiftool, by bare name (no -G) so the JSON keys come back
# as these exact strings. Superset across vendors; absent tags don't appear.
_TAGS = (
    "FocusMode",          # Canon/Nikon/Sony: One-Shot AF / AF-C / AF-S / Manual ...
    "AFAreaMode",         # Canon/Nikon/Sony: Single / Zone / Auto / Face+Tracking ...
    "AFAreaModeSetting",  # Sony's spelling of the area mode on some bodies
    "AFPointsInFocus",    # Canon: points that reported in-focus
    "AFPointsUsed",       # Nikon/Sony equivalent
    "PrimaryAFPoint",     # Nikon: single primary point, last-ditch fallback
)


@dataclass(slots=True)
class FocusMeta:
    focus_mode: str | None = None
    af_area_mode: str | None = None
    af_points_in_focus: str | None = None


def _coerce(value: object) -> str | None:
    """Render an exiftool JSON value as a compact display string.

    exiftool ``-j`` returns scalars, or lists for genuinely multi-valued tags.
    Blank / whitespace-only values are treated as absent.
    """
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        parts = [str(v).strip() for v in value if str(v).strip()]
        return ", ".join(parts) or None
    s = str(value).strip()
    return s or None


def normalize_tags(obj: dict[str, object]) -> FocusMeta:
    """Map one exiftool JSON record to our normalized focus fields.

    Pure (no I/O) so it's unit-testable with hand-written sample dicts.
    """
    return FocusMeta(
        focus_mode=_coerce(obj.get("FocusMode")),
        af_area_mode=_coerce(obj.get("AFAreaMode")) or _coerce(obj.get("AFAreaModeSetting")),
        af_points_in_focus=(
            _coerce(obj.get("AFPointsInFocus"))
            or _coerce(obj.get("AFPointsUsed"))
            or _coerce(obj.get("PrimaryAFPoint"))
        ),
    )


def _key(p: Path) -> str:
    """Case-insensitive absolute key for matching exiftool's ``SourceFile`` back
    to the Path we asked about (Windows paths are case-insensitive and exiftool
    emits forward slashes)."""
    return os.path.normcase(os.path.abspath(str(p)))


def read_focus_batch(paths: list[Path]) -> dict[Path, FocusMeta]:
    """Extract focus metadata for many files in a single exiftool invocation.

    Returns a dict keyed by the exact Path objects passed in. Files with no
    usable focus tags (or any error) are simply absent — callers treat a miss
    as "no metadata", never as a failure. This never raises: focus metadata is
    enrichment and must not break ingest.
    """
    if not paths:
        return {}

    exiftool = models.find_exiftool()
    if exiftool is None:
        try:
            exiftool = models.ensure_exiftool()
        except Exception as exc:  # noqa: BLE001 - missing exiftool just means no AF data
            log.info("focus metadata skipped — exiftool unavailable: %s", exc)
            return {}

    by_key = {_key(p): p for p in paths}

    with tempfile.TemporaryDirectory(prefix="photocull-af-") as td:
        argfile = Path(td) / "files.args"
        argfile.write_text("\n".join(str(p) for p in paths) + "\n", encoding="utf-8")
        # -fast (level 1) skips the trailer scan but still reads MakerNotes.
        cmd = [
            str(exiftool),
            "-j",
            "-fast",
            "-charset", "filename=UTF8",
            *(f"-{t}" for t in _TAGS),
            "-@", str(argfile),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, encoding="utf-8", timeout=300, check=False
            )
        except Exception as exc:  # noqa: BLE001 - subprocess/timeout failures degrade gracefully
            log.warning("exiftool focus read failed to run: %s", exc)
            return {}

    # Non-zero exit with no output = real failure. Non-zero with partial JSON
    # (some files errored) is fine — parse whatever we got.
    if proc.returncode != 0 and not proc.stdout.strip():
        log.warning("exiftool focus read exit %d: %s", proc.returncode, proc.stderr.strip())
        return {}

    try:
        records = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        log.warning("exiftool focus read: bad JSON: %s", exc)
        return {}

    out: dict[Path, FocusMeta] = {}
    for rec in records:
        src = rec.get("SourceFile")
        if not src:
            continue
        p = by_key.get(_key(Path(src)))
        if p is None:
            continue
        meta = normalize_tags(rec)
        if meta.focus_mode or meta.af_area_mode or meta.af_points_in_focus:
            out[p] = meta
    return out
