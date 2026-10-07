"""Decide which frames of a star sequence to leave out of the stack.

Everything is judged against the sequence's own median, so it adapts to the
lens, the sky, and the night. The thresholds are robust (MAD-based) with a
floor, because a clean sequence can have almost no spread and we mustn't reject
frames for being 1% off.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from statistics import median

# Fewer stars than this fraction of the median means cloud or haze.
MIN_STAR_FRACTION = 0.6
# Need at least this many stars in the median frame before count is meaningful.
MIN_MEDIAN_STARS = 8
MAD_K = 3.0
FWHM_FLOOR = 0.15       # relative: always allow +15% on FWHM
ELONG_FLOOR = 0.15      # absolute: elongation is a ratio >= 1
BACKGROUND_FLOOR = 0.03  # absolute: median luminance, 0..1


@dataclass
class FrameMetrics:
    id: int
    stars: int | None
    fwhm: float | None
    elongation: float | None
    background: float | None


@dataclass
class Verdict:
    id: int
    include: bool
    reasons: list[str] = field(default_factory=list)


def _mad(values: Sequence[float], mid: float) -> float:
    return 1.4826 * median(abs(v - mid) for v in values)


def judge(frames: Sequence[FrameMetrics]) -> list[Verdict]:
    stars = [f.stars for f in frames if f.stars is not None]
    fwhm = [f.fwhm for f in frames if f.fwhm is not None]
    elong = [f.elongation for f in frames if f.elongation is not None]
    bgs = [f.background for f in frames if f.background is not None]
    med_stars = median(stars) if stars else 0
    med_fwhm = median(fwhm) if fwhm else None
    med_elong = median(elong) if elong else None
    med_bg = median(bgs) if bgs else None
    fwhm_limit = (
        med_fwhm + max(MAD_K * _mad(fwhm, med_fwhm), FWHM_FLOOR * med_fwhm)
        if med_fwhm is not None
        else None
    )
    elong_limit = (
        med_elong + max(MAD_K * _mad(elong, med_elong), ELONG_FLOOR)
        if med_elong is not None
        else None
    )
    bg_limit = (
        med_bg + max(MAD_K * _mad(bgs, med_bg), BACKGROUND_FLOOR) if med_bg is not None else None
    )

    out: list[Verdict] = []
    for f in frames:
        reasons: list[str] = []
        if f.stars is None:
            reasons.append("unreadable")
        else:
            if med_stars >= MIN_MEDIAN_STARS and f.stars < MIN_STAR_FRACTION * med_stars:
                reasons.append("few stars (cloud or haze)")
            if fwhm_limit is not None and f.fwhm is not None and f.fwhm > fwhm_limit:
                reasons.append("soft stars")
            if elong_limit is not None and f.elongation is not None and f.elongation > elong_limit:
                reasons.append("trailed or shaken")
            if bg_limit is not None and f.background is not None and f.background > bg_limit:
                reasons.append("bright sky (light or cloud)")
        out.append(Verdict(f.id, not reasons, reasons))
    return out
