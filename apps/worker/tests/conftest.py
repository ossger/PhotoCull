from __future__ import annotations

from pathlib import Path

import pytest

from photocull.shoot import Shoot

from .astro_fixtures import render_frame, stamp_for, star_catalog, write_jpeg


@pytest.fixture
def star_shoot(tmp_path: Path):
    cat = star_catalog()
    for k in range(10):
        write_jpeg(
            tmp_path / f"star{k:02d}.jpg",
            render_frame(k, cat, noise_seed=100 + k, cloud=1.0 if k == 4 else 0.0,
                         smear=9 if k == 7 else 0.0),
            stamp_for(k),
        )
    # an unrelated daytime burst after the sequence
    for k in range(3):
        write_jpeg(tmp_path / f"day{k}.jpg",
                   render_frame(0, cat, noise_seed=k, cloud=0.0) // 1 + 120,
                   f"2026:09:21 09:00:0{k}", shutter=0)
    s = Shoot(tmp_path)
    s.ingest()
    try:
        yield s
    finally:
        s.close()
