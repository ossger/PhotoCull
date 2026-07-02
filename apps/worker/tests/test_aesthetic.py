"""Unit tests for the aesthetic (contrast + colorfulness) heuristic scorer."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from photocull.scoring import aesthetic


def _save(path: Path, arr: np.ndarray) -> None:
    Image.fromarray(arr, "RGB").save(path, "JPEG", quality=95)


def test_flat_gray_scores_low(tmp_path: Path) -> None:
    flat = np.full((200, 200, 3), 128, dtype=np.uint8)
    path = tmp_path / "flat.jpg"
    _save(path, flat)
    score = aesthetic.score_path(path)
    assert score is not None
    assert score < 2.0


def test_high_contrast_colorful_scores_higher_than_flat(tmp_path: Path) -> None:
    flat = np.full((200, 200, 3), 128, dtype=np.uint8)
    flat_path = tmp_path / "flat.jpg"
    _save(flat_path, flat)

    rng = np.random.default_rng(0)
    vivid = rng.integers(0, 256, size=(200, 200, 3), dtype=np.uint8)
    vivid_path = tmp_path / "vivid.jpg"
    _save(vivid_path, vivid)

    flat_score = aesthetic.score_path(flat_path)
    vivid_score = aesthetic.score_path(vivid_path)
    assert flat_score is not None and vivid_score is not None
    assert vivid_score > flat_score


def test_colorfulness_zero_for_grayscale() -> None:
    gray = np.full((100, 100, 3), 100, dtype=np.uint8)
    assert aesthetic.colorfulness(gray) == 0.0


def test_score_path_missing_file_returns_none(tmp_path: Path) -> None:
    assert aesthetic.score_path(tmp_path / "nope.jpg") is None


def test_ingest_populates_score_aesthetic(tmp_path: Path) -> None:
    from photocull.shoot import Shoot

    rng = np.random.default_rng(1)
    vivid = rng.integers(0, 256, size=(160, 120, 3), dtype=np.uint8)
    _save(tmp_path / "a.jpg", vivid)

    shoot = Shoot(tmp_path)
    try:
        shoot.ingest()
        row = shoot.list_images()[0]
        assert row["score_aesthetic"] is not None
        assert 0.0 <= row["score_aesthetic"] <= 10.0
    finally:
        shoot.close()
