"""Combine the individual sub-scores into a single 0-10 'overall' number.

Weights match the plan defaults; Phase 3+ adds eyes and aesthetic. Missing
sub-scores are ignored and the remaining weights are renormalised so we never
penalise an image just because (say) face detection didn't run.
"""
from __future__ import annotations

from dataclasses import dataclass

# Default weights — see plan file. Must sum to 1.0.
DEFAULT_WEIGHTS = {
    "focus": 0.30,
    "eyes": 0.25,
    "aesthetic": 0.25,
    "exposure": 0.20,
}


@dataclass(slots=True)
class Scores:
    focus: float | None = None
    exposure: float | None = None
    eyes: float | None = None
    aesthetic: float | None = None


def overall(scores: Scores, weights: dict[str, float] | None = None) -> float | None:
    w = weights or DEFAULT_WEIGHTS
    present = [
        (s, w[k])
        for k, s in (
            ("focus", scores.focus),
            ("exposure", scores.exposure),
            ("eyes", scores.eyes),
            ("aesthetic", scores.aesthetic),
        )
        if s is not None
    ]
    if not present:
        return None
    total_weight = sum(weight for _, weight in present)
    if total_weight <= 0:
        return None
    return sum(score * weight for score, weight in present) / total_weight
