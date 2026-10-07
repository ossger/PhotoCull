"""Aligning and stacking a synthetic tripod star sequence."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from photocull.astro import stack as stack_mod
from photocull.astro.stack import StackOptions, stack_sequence
from photocull.astro.stars import detect_stars

from .astro_fixtures import (
    SKY_ROWS,
    W,
    render_frame,
    ridge_pattern,
    sky_transform,
    stamp_for,
    star_catalog,
    write_jpeg,
)

N = 15
CLOUD_FRAME = 4
STREAK_FRAME = 9


@pytest.fixture(scope="module")
def sequence(tmp_path_factory) -> list[Path]:
    d = tmp_path_factory.mktemp("stars")
    cat = star_catalog()
    paths = []
    for k in range(N):
        p = d / f"IMG_{k:03d}.jpg"
        write_jpeg(
            p,
            render_frame(k, cat, noise_seed=500 + k, streak=(k == STREAK_FRAME)),
            stamp_for(k),
        )
        paths.append(p)
    return paths


@pytest.fixture(scope="module")
def stacked(sequence, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    seen = []
    result = stack_sequence(
        sequence, out / "stack.tif", out / "preview.jpg",
        progress=lambda d, t, label: seen.append((d, t)),
    )
    tif = cv2.imread(str(result.output), cv2.IMREAD_UNCHANGED)
    return result, tif, seen


def test_writes_a_16_bit_tiff_the_size_of_the_frames(stacked):
    result, tif, _ = stacked
    assert tif.dtype == np.uint16
    assert tif.shape[:2] == (result.height, result.width) == (640, 960)
    assert result.used == N and result.skipped == []
    assert result.preview.exists()


def test_progress_reaches_the_total(stacked):
    *_, seen = stacked
    done, total = seen[-1]
    assert done == total
    assert [d for d, _ in seen] == sorted(d for d, _ in seen)


def test_stars_are_aligned_to_the_reference_frame(stacked):
    result, tif, _ = stacked
    assert result.rms < 0.5
    ref_k = N // 2
    M = sky_transform(ref_k)
    cat = star_catalog()
    truth = cat[:, :2] @ M[:, :2].T + M[:, 2]
    # only the bright, in-frame stars: dim ones legitimately fall under the noise floor
    truth = truth[(cat[:, 2] > 150) & (truth[:, 0] > 10) & (truth[:, 0] < W - 10) & (truth[:, 1] < SKY_ROWS - 10) & (truth[:, 1] > 10)]
    gray = (tif[..., 0] >> 8).astype(np.uint8)
    found = detect_stars(gray).points[:, :2]
    dist = np.hypot(*(truth[:, None, :] - found[None, :, :]).transpose(2, 0, 1)).min(axis=1)
    assert (dist < 1.0).mean() > 0.9


def test_stars_are_crisp_where_an_unaligned_average_smears_them(sequence, stacked):
    _, tif, _ = stacked
    M = sky_transform(N // 2)
    cat = star_catalog()
    pos = cat[:, :2] @ M[:, :2].T + M[:, 2]
    bright = (cat[:, 2] > 180) & (pos[:, 0] > 10) & (pos[:, 0] < W - 10) & (pos[:, 1] > 10) & (pos[:, 1] < SKY_ROWS - 10)
    xy = np.round(pos[bright]).astype(int)

    def peak(img):  # level at each star centre above the local sky
        return np.array([img[y - 1: y + 2, x - 1: x + 2].max() - np.median(img[y - 12: y + 12, x - 12: x + 12]) for x, y in xy])

    stacked_gray = (tif[..., 0].astype(np.float32)) / 257.0
    plain = np.mean([cv2.imread(str(p), cv2.IMREAD_GRAYSCALE).astype(np.float32) for p in sequence], axis=0)
    assert np.median(peak(stacked_gray)) > 0.7 * np.median(cat[bright, 2])
    assert np.median(peak(plain)) < 0.4 * np.median(cat[bright, 2])


def test_a_satellite_streak_in_one_frame_is_clipped_out(stacked):
    _, tif, _ = stacked
    gray = (tif[..., 0].astype(np.float32)) / 257.0
    # the streak crosses the sensor from (0, 90+2k) to (959, 150+2k); sample its path
    k = STREAK_FRAME
    xs = np.arange(250, 700)
    ys = (90 + 2 * k + (60 / 959) * xs).astype(int)
    on_path = np.mean([gray[y - 1: y + 2, x].mean() for x, y in zip(xs, ys)])
    # same path shifted well off it, for the local sky level
    off_path = np.mean([gray[y + 25: y + 28, x].mean() for x, y in zip(xs, ys)])
    # unclipped it would add ~160/15 ≈ 10 grey levels
    assert on_path - off_path < 3.0


def test_foreground_stays_sharp(stacked):
    _, tif, _ = stacked
    fg = tif[SKY_ROWS + 10:, :, 1].astype(np.float32) / 257.0
    truth = ridge_pattern()[10:]
    corr = np.corrcoef(fg.ravel(), truth.ravel())[0, 1]
    assert corr > 0.97


def test_sky_only_mode_skips_the_foreground_blend(sequence, tmp_path):
    result = stack_sequence(
        sequence, tmp_path / "s.tif", tmp_path / "p.jpg", StackOptions(foreground="none")
    )
    tif = cv2.imread(str(result.output), cv2.IMREAD_UNCHANGED)
    fg = tif[SKY_ROWS + 10:, :, 1].astype(np.float32) / 257.0
    corr = np.corrcoef(fg.ravel(), ridge_pattern()[10:].ravel())[0, 1]
    assert corr < 0.9  # aligned to the stars, the ridge is smeared


def test_a_frame_with_no_stars_is_skipped_not_fatal(tmp_path):
    cat = star_catalog()
    paths = []
    for k in range(8):
        p = tmp_path / f"f{k}.jpg"
        # frame 3 is solid cloud: nothing to align on
        write_jpeg(p, render_frame(k, cat, noise_seed=k, cloud=1.0 if k == 3 else 0.0), stamp_for(k))
        paths.append(p)
    result = stack_sequence(paths, tmp_path / "o.tif", tmp_path / "o.jpg")
    assert [name for name, _ in result.skipped] == ["f3.jpg"]
    assert result.used == 7


def test_too_few_frames_is_an_error(tmp_path):
    with pytest.raises(ValueError):
        stack_sequence([tmp_path / "a.jpg", tmp_path / "b.jpg"], tmp_path / "o.tif", tmp_path / "o.jpg")


def test_similarity_estimate_recovers_a_known_motion():
    rng = np.random.default_rng(3)
    ref = rng.uniform(0, 900, (120, 2))
    M_true = cv2.getRotationMatrix2D((450, -300), 0.4, 1.0)
    moved = (ref - M_true[:, 2]) @ np.linalg.inv(M_true[:, :2]).T  # inverse of M_true
    moved += rng.normal(0, 0.1, moved.shape)
    M = stack_mod.estimate_similarity(ref, moved)
    assert M is not None
    back = stack_mod._apply(M, moved)
    assert np.hypot(*(back - ref).T).mean() < 0.5
