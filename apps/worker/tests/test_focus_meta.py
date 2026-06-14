"""Unit tests for AF / focus-detection metadata normalization.

These exercise the pure `normalize_tags` mapping with hand-written exiftool
records for each vendor — no exiftool binary or real camera files needed.
"""
from __future__ import annotations

from photocull import focus_meta


def test_canon_record() -> None:
    meta = focus_meta.normalize_tags(
        {
            "SourceFile": "IMG_0001.CR3",
            "FocusMode": "One-shot AF",
            "AFAreaMode": "Single-point AF",
            "AFPointsInFocus": "Center",
        }
    )
    assert meta.focus_mode == "One-shot AF"
    assert meta.af_area_mode == "Single-point AF"
    assert meta.af_points_in_focus == "Center"


def test_nikon_falls_back_to_af_points_used() -> None:
    # Nikon has no AFPointsInFocus; the in-focus point comes from AFPointsUsed.
    meta = focus_meta.normalize_tags(
        {
            "FocusMode": "AF-C",
            "AFAreaMode": "Dynamic-area AF (9 points)",
            "AFPointsUsed": "C6",
        }
    )
    assert meta.focus_mode == "AF-C"
    assert meta.af_area_mode == "Dynamic-area AF (9 points)"
    assert meta.af_points_in_focus == "C6"


def test_nikon_primary_af_point_last_resort() -> None:
    meta = focus_meta.normalize_tags({"PrimaryAFPoint": "C1"})
    assert meta.af_points_in_focus == "C1"


def test_sony_area_mode_setting_alias() -> None:
    # Some Sony bodies report the area mode under AFAreaModeSetting instead.
    meta = focus_meta.normalize_tags(
        {
            "FocusMode": "AF-C",
            "AFAreaModeSetting": "Wide",
            "AFPointsUsed": ["Center", "Center-right"],
        }
    )
    assert meta.af_area_mode == "Wide"
    # Multi-valued tags are joined into a compact display string.
    assert meta.af_points_in_focus == "Center, Center-right"


def test_area_mode_prefers_canonical_over_alias() -> None:
    meta = focus_meta.normalize_tags(
        {"AFAreaMode": "Zone AF", "AFAreaModeSetting": "Wide"}
    )
    assert meta.af_area_mode == "Zone AF"


def test_empty_and_blank_values_are_none() -> None:
    assert focus_meta.normalize_tags({}) == focus_meta.FocusMeta()
    blank = focus_meta.normalize_tags(
        {"FocusMode": "   ", "AFAreaMode": "", "AFPointsInFocus": None}
    )
    assert blank == focus_meta.FocusMeta()


def test_read_batch_empty_input_short_circuits() -> None:
    # Must not spawn exiftool for an empty file list.
    assert focus_meta.read_focus_batch([]) == {}
