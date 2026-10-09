"""Write XMP sidecar files alongside originals so Lightroom / Capture One
pick up our picks, rejects, star ratings, and colour labels.

We never modify the original RAW or JPEG — exiftool writes a `<filename>.xmp`
next to the image. Standard tags used (all recognised by LR and C1):

  - xmp:Rating       -2..5   ( -1 = rejected per Adobe convention )
  - xmp:Label        "Pick" / a colour name / ""
  - photoshop:Urgency 1..8   (Capture One Color Label) — set redundantly so
                              C1 doesn't ignore the Adobe label
  - lr:hierarchicalSubject   "Scored|Overall|7" so the AI overall score
                              survives as a keyword in LR's library

Batch writes via a single `exiftool -@ argfile` invocation — ~10× faster than
one process per file for big shoots, and exiftool supports it natively.
"""
from __future__ import annotations

import logging
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .. import models

log = logging.getLogger(__name__)


@dataclass(slots=True)
class CropRect:
    left: float
    top: float
    right: float
    bottom: float


@dataclass(slots=True)
class XmpFields:
    source_path: Path        # original image
    pick: int                # -1 reject, 0 unset, 1 pick
    stars: int               # 0..5
    color_label: str | None  # Lightroom colour: Red/Yellow/Green/Blue/Purple
    score_overall: float | None
    crop: CropRect | None    # normalised 0..1, exported as Adobe crs:Crop* tags


# Lightroom and Adobe Bridge map colour labels to photoshop:Urgency 1..8.
_URGENCY_FOR_COLOR: dict[str, int] = {
    "Red": 1,
    "Yellow": 2,
    "Green": 3,
    "Blue": 4,
    "Purple": 5,
}


def _label_value(field: XmpFields) -> str:
    # Picks win over a colour label so a "Pick + Red" frame shows up correctly.
    if field.pick == 1:
        return "Pick"
    if field.color_label:
        return field.color_label
    return ""


def _rating(field: XmpFields) -> int:
    if field.pick == -1:
        return -1  # Adobe convention: -1 means rejected
    return field.stars


def _write_argfile(fields: list[XmpFields], argfile: Path) -> None:
    """Build a single exiftool argument file describing all sidecars to write.

    exiftool's `-@ argfile` mode reads newline-separated args, so we get all
    edits applied in one process invocation.
    """
    lines: list[str] = []
    for f in fields:
        sidecar = f.source_path.with_suffix(f.source_path.suffix + ".xmp")
        # Always start with a clean slate — strip our managed tags then re-add.
        lines += [
            "-XMP-xmp:Rating=",
            "-XMP-xmp:Label=",
            "-XMP-photoshop:Urgency=",
            "-XMP-lr:HierarchicalSubject-=",  # remove any previous score keyword
            # Crop tags get cleared too so toggling crop off in the app
            # actually removes the crop on the next export.
            "-XMP-crs:HasCrop=",
            "-XMP-crs:CropLeft=",
            "-XMP-crs:CropTop=",
            "-XMP-crs:CropRight=",
            "-XMP-crs:CropBottom=",
            "-XMP-crs:CropAngle=",
            "-XMP-crs:CropConstrainToWarp=",
        ]
        rating = _rating(f)
        if rating != 0:
            lines.append(f"-XMP-xmp:Rating={rating}")
        label = _label_value(f)
        if label:
            lines.append(f"-XMP-xmp:Label={label}")
            urgency = _URGENCY_FOR_COLOR.get(label)
            if urgency is not None:
                lines.append(f"-XMP-photoshop:Urgency={urgency}")
        if f.score_overall is not None:
            tier = round(f.score_overall)
            lines.append(f"-XMP-lr:HierarchicalSubject+=Scored|Overall|{tier}")
        if f.crop is not None:
            # Adobe crop tags. Values are 0..1 of the un-rotated source image.
            lines += [
                "-XMP-crs:HasCrop=True",
                f"-XMP-crs:CropLeft={f.crop.left:.6f}",
                f"-XMP-crs:CropTop={f.crop.top:.6f}",
                f"-XMP-crs:CropRight={f.crop.right:.6f}",
                f"-XMP-crs:CropBottom={f.crop.bottom:.6f}",
                "-XMP-crs:CropAngle=0",
                "-XMP-crs:CropConstrainToWarp=0",
            ]
        # Tell exiftool which file these args apply to. -o targets the sidecar
        # specifically (without -o it would try to embed in the source file).
        lines.append("-o")
        lines.append(str(sidecar))
        lines.append(str(f.source_path))
        lines.append("-execute")
    argfile.write_text("\n".join(lines) + "\n", encoding="utf-8")


@dataclass(slots=True)
class ExportResult:
    written: int
    failed: int
    sidecars: list[Path]


def write_sidecars(fields: list[XmpFields]) -> ExportResult:
    if not fields:
        return ExportResult(written=0, failed=0, sidecars=[])

    exiftool = models.ensure_exiftool()

    # exiftool's -o refuses to overwrite an existing sidecar, but re-export
    # needs to be the common case (mark some picks, export, change picks,
    # export again). Predelete any sidecars we're about to rewrite so the
    # batch always succeeds.
    for f in fields:
        sidecar = f.source_path.with_suffix(f.source_path.suffix + ".xmp")
        if sidecar.exists():
            sidecar.unlink()

    with tempfile.TemporaryDirectory(prefix="photocull-xmp-") as td:
        argfile = Path(td) / "exiftool.args"
        _write_argfile(fields, argfile)
        # -overwrite_original_in_place: we own the sidecar so this is safe.
        # -P preserves the source file mtime.
        # -common_args is required when using -execute batches.
        cmd = [
            str(exiftool),
            "-charset", "filename=UTF8",
            "-@", str(argfile),
            "-common_args",
            "-overwrite_original",
            "-P",
            "-q", "-q",
        ]
        log.info("exiftool: writing %d sidecars", len(fields))
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", check=False
        )

    sidecars: list[Path] = []
    written = 0
    failed = 0
    for f in fields:
        sidecar = f.source_path.with_suffix(f.source_path.suffix + ".xmp")
        if sidecar.exists():
            sidecars.append(sidecar)
            written += 1
        else:
            failed += 1

    if proc.returncode != 0:
        log.warning("exiftool exit %d: %s", proc.returncode, proc.stderr.strip())
    return ExportResult(written=written, failed=failed, sidecars=sidecars)
