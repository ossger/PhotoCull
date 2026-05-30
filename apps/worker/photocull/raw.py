"""RAW decoding for Phase 3.

Two-tier strategy:

1. **Embedded JPEG preview** (fast): every modern camera embeds a full-quality
   JPEG inside the RAW. `rawpy.extract_thumb()` pulls it out in milliseconds.
   This is what Narrative Select (and Lightroom's import preview) uses too.

2. **Half-size demosaic** (fallback): for older RAW files without an embedded
   JPEG, or when the embedded preview is too small (some cameras only embed a
   tiny ~160px thumb), we render the RAW at half size via libraw. ~5-10× slower
   than the embedded path but only needed for edge cases.

The output is always a PIL `Image` that downstream code (ingest thumb/preview,
EXIF extraction, scoring) handles identically to a JPEG source.
"""
from __future__ import annotations

import io
import logging
from pathlib import Path

import rawpy
from PIL import Image

log = logging.getLogger(__name__)

# Embedded previews below this long-edge are treated as too small to use —
# many older bodies embed a ~160px thumbnail intended only for camera back UI.
MIN_EMBEDDED_LONG_EDGE = 1200


def open_raw_as_pil(path: Path) -> Image.Image:
    """Decode a RAW file into a full-colour PIL Image.

    Caller owns the returned image; closes nothing. Caller may want to call
    `.close()` on it once done if memory pressure matters.
    """
    with rawpy.imread(str(path)) as raw:
        # 1. Try the embedded preview.
        try:
            thumb = raw.extract_thumb()
        except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError):
            thumb = None
        except Exception as exc:  # noqa: BLE001 - libraw raises various subclasses
            log.debug("extract_thumb failed for %s: %s", path, exc)
            thumb = None

        if thumb is not None and thumb.format == rawpy.ThumbFormat.JPEG:
            img = Image.open(io.BytesIO(thumb.data))
            img.load()
            if max(img.size) >= MIN_EMBEDDED_LONG_EDGE:
                return img
            # Too small — fall through to full demosaic.
            img.close()

        # 2. Fall back to libraw demosaic.
        rgb = raw.postprocess(
            use_camera_wb=True,
            half_size=True,
            no_auto_bright=False,
            output_bps=8,
        )
        return Image.fromarray(rgb)


def write_embedded_jpeg(src: Path, target: Path) -> bool:
    """Copy the camera's embedded JPEG out of a RAW file, byte-for-byte.

    This is the highest-quality preview the camera knows how to make — usually
    a full-sensor-resolution JPEG. Used for the loupe's pixel-peeping zoom so
    we're not interpolating the 1600px Phase-2 preview.

    Returns True if a JPEG was written, False if the RAW has no embedded JPEG
    (very old or unsupported formats — caller falls back to a demosaic).
    """
    with rawpy.imread(str(src)) as raw:
        try:
            thumb = raw.extract_thumb()
        except Exception as exc:  # noqa: BLE001 - libraw raises various subclasses
            log.debug("extract_thumb (full) failed for %s: %s", src, exc)
            return False
        if thumb is None or thumb.format != rawpy.ThumbFormat.JPEG:
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(thumb.data)
        return True


def render_full_demosaic(src: Path, target: Path) -> None:
    """Last-resort full-res render via libraw. Only used when the RAW has no
    embedded JPEG. Significantly slower than the embedded-thumb path."""
    with rawpy.imread(str(src)) as raw:
        rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=False, output_bps=8)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(target, "JPEG", quality=92, optimize=True)
