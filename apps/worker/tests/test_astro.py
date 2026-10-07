"""Star-sequence detection, per-frame star metrics, and the cull rule."""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest

from photocull.astro import detect
from photocull.astro.analyze import measure_stars
from photocull.astro.cull import FrameMetrics, judge
from photocull.astro.stars import detect_stars, to_gray8
from photocull.shoot import Shoot

from .astro_fixtures import render_frame, stamp_for, star_catalog, write_jpeg

# ---- detect.py (pure) ----

def _frame(i: int, **kw) -> detect.Frame:
    base = datetime(2026, 9, 20, 23, 0, 0)
    d = dict(
        id=i, captured_at=base + timedelta(seconds=25 * i), iso=3200, shutter="20s",
        aperture=2.8, focal_length=24.0, camera="Cam", lens="L", luma=0.05,
    )
    d.update(kw)
    return detect.Frame(**d)


def test_parse_shutter():
    assert detect.parse_shutter("20s") == 20.0
    assert detect.parse_shutter("1/250") == pytest.approx(0.004)
    assert detect.parse_shutter("2.5s") == 2.5
    assert detect.parse_shutter(None) is None
    assert detect.parse_shutter("junk") is None


def test_sequence_found():
    frames = [_frame(i) for i in range(8)]
    assert detect.find_sequences(frames) == [list(range(8))]


def test_short_runs_ignored():
    assert detect.find_sequences([_frame(i) for i in range(3)]) == []


def test_daylight_long_exposure_is_not_stars():
    frames = [_frame(i, luma=0.6) for i in range(8)]
    assert detect.find_sequences(frames) == []


def test_one_bright_frame_does_not_break_the_run():
    frames = [_frame(i, luma=0.5 if i == 3 else 0.05) for i in range(8)]
    assert detect.find_sequences(frames) == [list(range(8))]


def test_unknown_luma_is_not_a_veto():
    assert len(detect.find_sequences([_frame(i, luma=None) for i in range(5)])) == 1


def test_fast_shutter_is_not_stars():
    assert detect.find_sequences([_frame(i, shutter="1/250") for i in range(8)]) == []


def test_settings_change_splits_runs():
    frames = [_frame(i) for i in range(5)] + [_frame(5 + i, iso=6400) for i in range(5)]
    assert detect.find_sequences(frames) == [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]


def test_long_gap_splits_runs():
    frames = [_frame(i) for i in range(5)]
    late = [_frame(5 + i, captured_at=datetime(2026, 9, 21, 1, 0, 0) + timedelta(seconds=25 * i))
            for i in range(5)]
    assert detect.find_sequences(frames + late) == [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]


# ---- stars.py ----

def _sky(k=0, **kw):
    return detect_stars(to_gray8(render_frame(k, star_catalog(), foreground=False, **kw)))


def test_star_metrics_clean_vs_degraded():
    clean = _sky(noise_seed=1)
    cloudy = _sky(noise_seed=2, cloud=1.0)
    smeared = _sky(noise_seed=3, smear=9)
    assert 100 < clean.count < 180
    assert cloudy.count < 0.5 * clean.count
    assert cloudy.background > clean.background + 0.1
    assert smeared.elongation > clean.elongation + 0.3
    assert 2.0 < clean.fwhm < 6.0


def test_static_foreground_is_not_counted_as_stars():
    cat = star_catalog()
    grays = [to_gray8(render_frame(k, cat, noise_seed=k + 1)) for k in range(0, 24, 2)]
    sky_only = _sky(k=10, noise_seed=11)
    got = measure_stars(grays)[5]  # k=10
    raw = detect_stars(grays[5])
    assert raw.count > 1.5 * sky_only.count      # ridge texture inflates the raw count
    assert abs(got.count - sky_only.count) < 0.25 * sky_only.count


def test_short_sequence_still_measures():
    cat = star_catalog()
    grays = [to_gray8(render_frame(k, cat, noise_seed=k + 1, foreground=False)) for k in range(4)]
    assert all(f.count > 100 for f in measure_stars(grays))


def test_stars_that_barely_move_fall_back_to_raw_frames():
    cat = star_catalog()
    # every frame identical apart from noise: the median would erase the stars
    grays = [to_gray8(render_frame(0, cat, noise_seed=k + 1, foreground=False)) for k in range(8)]
    assert all(f.count > 100 for f in measure_stars(grays))


def test_streak_is_flagged_not_counted_as_a_star():
    base = _sky(noise_seed=1)
    streaked = _sky(noise_seed=1, streak=True)
    assert streaked.trails >= 1
    assert abs(streaked.count - base.count) <= 8


# ---- cull.py ----

def _metrics(i, stars=100, fwhm=3.0, elong=1.1, bg=0.05):
    return FrameMetrics(i, stars, fwhm, elong, bg)


def test_clean_sequence_keeps_everything():
    frames = [_metrics(i, stars=100 + (i % 3), fwhm=3.0 + 0.02 * (i % 4)) for i in range(12)]
    assert all(v.include for v in judge(frames))


def test_cull_flags_each_failure_with_a_reason():
    frames = [_metrics(i) for i in range(12)]
    frames[2] = _metrics(2, stars=30, bg=0.06)          # cloud
    frames[5] = _metrics(5, elong=2.0)                  # trailed
    frames[7] = _metrics(7, fwhm=5.0)                   # soft
    frames[9] = _metrics(9, bg=0.2)                     # bright sky
    frames[10] = FrameMetrics(10, None, None, None, None)
    verdicts = {v.id: v for v in judge(frames)}
    assert [i for i, v in verdicts.items() if not v.include] == [2, 5, 7, 9, 10]
    assert "few stars" in verdicts[2].reasons[0]
    assert "trailed" in verdicts[5].reasons[0]
    assert "soft" in verdicts[7].reasons[0]
    assert "bright" in verdicts[9].reasons[0]
    assert verdicts[10].reasons == ["unreadable"]


def test_sparse_sky_does_not_judge_by_count():
    frames = [_metrics(i, stars=4) for i in range(8)]
    frames[3] = _metrics(3, stars=1)
    assert judge(frames)[3].include


# ---- end to end through ingest ----

def test_sequence_becomes_one_astro_scene(star_shoot: Shoot):
    scenes = star_shoot.list_scenes()
    astro = [s for s in scenes if s["kind"] == "astro"]
    assert len(astro) == 1
    assert astro[0]["image_count"] == 10
    assert all(s["kind"] is None for s in scenes if s is not astro[0])


def test_analyze_recommends_dropping_the_bad_frames(star_shoot: Shoot):
    ids = {i["filename"]: i["id"] for i in star_shoot.list_images()}
    seq = [ids[f"star{k:02d}.jpg"] for k in range(10)]
    result = star_shoot.analyze_astro(seq)
    by_name = {f["filename"]: f for f in result["frames"]}
    assert not by_name["star04.jpg"]["include"]
    assert not by_name["star07.jpg"]["include"]
    kept = [n for n, f in by_name.items() if f["include"]]
    assert len(kept) == 8
    row = star_shoot.get_image(seq[0])
    assert row["astro_stars"] and row["astro_stars"] > 40


def test_tagging_a_scene_by_hand(star_shoot: Shoot):
    day = next(s for s in star_shoot.list_scenes() if s["kind"] is None)
    star_shoot.update_scene(day["id"], kind="astro")
    assert next(s for s in star_shoot.list_scenes() if s["id"] == day["id"])["kind"] == "astro"
    star_shoot.update_scene(day["id"], kind="")
    assert next(s for s in star_shoot.list_scenes() if s["id"] == day["id"])["kind"] is None


# ---- stacking through the shoot + server ----

def test_shoot_stacks_the_sequence_into_a_stacks_folder(star_shoot: Shoot):
    ids = [i["id"] for i in star_shoot.list_images() if i["filename"].startswith("star")]
    seen = []
    result = star_shoot.stack_astro(ids, progress=lambda d, t, _l: seen.append(d))
    out = Path(result["output"])
    assert out.parent == star_shoot.root / "Stacks" and out.exists()
    assert result["used"] + len(result["skipped"]) == len(ids)
    assert (star_shoot.cache_dir / result["preview_path"]).exists()
    # a second stack never overwrites the first
    again = star_shoot.stack_astro(ids)
    assert Path(again["output"]) != out and out.exists()
    # and a stack doesn't disturb the cull
    assert all(i["pick"] == 0 for i in star_shoot.list_images())


def test_stacking_needs_three_frames(star_shoot: Shoot):
    ids = [i["id"] for i in star_shoot.list_images()][:2]
    with pytest.raises(ValueError):
        star_shoot.stack_astro(ids)
