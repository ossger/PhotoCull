"""Find stackable star-photo sequences from EXIF (plus a darkness check).

A sequence is a run of consecutive frames shot back to back with identical
settings and a long exposure. We deliberately use only cheap signals — EXIF and
the preview's median brightness — so this can run on every regroup. The star
metrics in `stars.py` are the expensive, per-sequence second opinion.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

# A frame this long (seconds) is a candidate star frame.
MIN_EXPOSURE_S = 2.0
# Preview median luminance (0..1) above this is not a night sky.
MAX_LUMA = 0.25
# Shutter gap tolerance: consecutive starts may be up to exposure + this apart.
MAX_DELAY_S = 30.0
MIN_SEQUENCE = 4


@dataclass(slots=True)
class Frame:
    id: int
    captured_at: datetime | None
    iso: int | None
    shutter: str | None
    aperture: float | None
    focal_length: float | None
    camera: str | None
    lens: str | None
    luma: float | None


def parse_shutter(value: str | None) -> float | None:
    """'20s' -> 20.0, '1/250' -> 0.004. None when unparseable."""
    if not value:
        return None
    try:
        if value.endswith("s"):
            return float(value[:-1])
        if "/" in value:
            num, den = value.split("/", 1)
            return float(num) / float(den)
        return float(value)
    except (ValueError, ZeroDivisionError):
        return None


def _settings(f: Frame) -> tuple:
    return (f.iso, f.shutter, f.aperture, f.focal_length, f.camera, f.lens)


def is_star_candidate(f: Frame) -> bool:
    """Long enough exposure and a known time. Darkness is judged per run, below:
    one cloudy, bright frame mid-sequence is a cull candidate, not a break."""
    exposure = parse_shutter(f.shutter)
    return exposure is not None and exposure >= MIN_EXPOSURE_S and f.captured_at is not None


def _is_night(run: list[Frame]) -> bool:
    lumas = sorted(f.luma for f in run if f.luma is not None)
    # luma is NULL for shoots ingested before it was recorded: don't veto.
    return not lumas or lumas[len(lumas) // 2] <= MAX_LUMA


def find_sequences(frames: list[Frame], min_len: int = MIN_SEQUENCE) -> list[list[int]]:
    """Group time-ordered frames into stackable runs. Returns lists of frame ids."""
    runs: list[list[Frame]] = []
    current: list[Frame] = []
    for f in frames:
        if not is_star_candidate(f):
            if current:
                runs.append(current)
                current = []
            continue
        if current:
            prev = current[-1]
            exposure = parse_shutter(f.shutter) or 0.0
            assert prev.captured_at is not None and f.captured_at is not None
            gap = (f.captured_at - prev.captured_at).total_seconds()
            if _settings(prev) != _settings(f) or gap < 0 or gap > exposure + MAX_DELAY_S:
                runs.append(current)
                current = []
        current.append(f)
    if current:
        runs.append(current)
    return [[f.id for f in run] for run in runs if len(run) >= min_len and _is_night(run)]
