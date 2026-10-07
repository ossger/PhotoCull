"""Stack a tripod star sequence: align the sky, keep the foreground still.

Untracked frames drift: the stars rotate a little each frame while the landscape
stays put. Stacking them naively either smears the stars (no alignment) or the
foreground (aligned to the stars), so we build two stacks and blend them:

* **Sky** — frames warped onto the middle frame by matching stars, then
  sigma-clipped (so satellites, planes, and hot pixels drop out).
* **Foreground** — the same frames, unaligned, simply averaged.

A mask where the unaligned average is *sharper* than the aligned one (static
detail) picks the foreground; where the aligned one is sharper (stars) it picks
the sky. Everything runs in linear light and streams frame by frame, so memory
is a handful of full-frame float32 buffers regardless of how many frames.
Source files are never modified; the result is a 16-bit TIFF.
"""
from __future__ import annotations

import gc
import logging
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from .. import models
from .stars import StarField, detect_stars

log = logging.getLogger(__name__)

RAW_EXTS = {
    ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".dng", ".raf", ".orf", ".rw2",
    ".pef", ".srw", ".3fr", ".iiq", ".rwl", ".erf", ".mef", ".mos",
}

# Anchors per frame used for matching (brightest first).
MAX_ANCHORS = 300
# A cell (px) must hold detections from this share of the frames to be "static".
STATIC_CELL = 3
STATIC_FRACTION = 0.35
STATIC_MIN_FRAMES = 4
STATIC_SPAN = 0.6          # ...and span at least this share of the sequence
MIN_SKY_ANCHORS = 25       # distrust the foreground filter if it leaves fewer than this per frame
# Alignment: coarse search radius and the minimum matched stars to trust a fit.
SEARCH_RADIUS = 120.0
MIN_MATCHES = 8
KAPPA = 2.5


@dataclass
class StackOptions:
    half_size: bool = False        # decode RAW at half resolution (4x less memory, faster)
    foreground: str = "auto"       # "auto" = blend an unaligned foreground; "none" = sky only
    kappa: float = KAPPA


@dataclass
class StackResult:
    output: Path
    preview: Path
    used: int
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (filename, reason)
    width: int = 0
    height: int = 0
    rms: float = 0.0               # mean alignment residual of the matched stars, px


Progress = Callable[[int, int, str], None]


# ---- decoding ----

def _srgb_to_linear(v: np.ndarray) -> np.ndarray:
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4).astype(np.float32)


def _linear_to_srgb(v: np.ndarray) -> np.ndarray:
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def decode_linear(path: Path, half_size: bool = False) -> np.ndarray:
    """Decode a frame to linear-light float32 RGB in 0..1, shape HxWx3.

    RAW goes through libraw with no tone curve (true linear sensor data, camera
    white balance). Other formats are sRGB-encoded, so they are linearised.
    """
    if path.suffix.lower() in RAW_EXTS:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            rgb = raw.postprocess(
                gamma=(1, 1),
                no_auto_bright=True,
                use_camera_wb=True,
                output_bps=16,
                half_size=half_size,
            )
        return rgb.astype(np.float32) / 65535.0
    from ..ingest import _decode_source

    im, _exif, _size = _decode_source(path)
    try:
        im = (ImageOps.exif_transpose(im) or im).convert("RGB")
        arr = np.asarray(im, dtype=np.float32) / 255.0
    finally:
        im.close()
    if half_size:
        arr = cv2.resize(arr, (arr.shape[1] // 2, arr.shape[0] // 2), interpolation=cv2.INTER_AREA)
    return _srgb_to_linear(arr)


def _detection_gray(lin: np.ndarray) -> np.ndarray:
    """uint8 luminance for star detection, gamma-lifted so dim stars have contrast."""
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    return (np.sqrt(np.clip(lum, 0.0, 1.0)) * 255.0).astype(np.uint8)


# ---- alignment ----

def _apply(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply a 2x3 affine to Nx2 points."""
    return pts @ M[:, :2].T + M[:, 2]


def _static_cells(fields: list[StarField]) -> set[tuple[int, int]]:
    """Grid cells with detections in many frames spread across the whole sequence.

    A star drifts, so it only shows in a short run of consecutive frames at any one
    place; foreground detail shows in (nearly) all of them. Requiring both a high
    count and a long span keeps slow-moving stars from being mistaken for it.
    """
    n = len(fields)
    if n < 2 * STATIC_MIN_FRAMES:
        return set()
    seen: dict[tuple[int, int], set[int]] = {}
    total = 0
    for k, f in enumerate(fields):
        total += f.count
        for x, y in (f.points[:, :2] // STATIC_CELL).astype(int):
            seen.setdefault((int(x), int(y)), set()).add(k)
    need = max(STATIC_MIN_FRAMES, STATIC_FRACTION * n)
    static: set[tuple[int, int]] = set()
    for cx, cy in seen:
        near: set[int] = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                near |= seen.get((cx + dx, cy + dy), set())
        if len(near) >= need and max(near) - min(near) >= STATIC_SPAN * (n - 1):
            static.add((cx, cy))
    return static


def _anchors(f: StarField, static: set[tuple[int, int]]) -> np.ndarray:
    """Sky star positions (Nx2), brightest first, foreground cells removed."""
    pts = f.points[:, :2]
    if static and len(pts):
        cells = (pts // STATIC_CELL).astype(int)
        pts = pts[[(int(cx), int(cy)) not in static for cx, cy in cells]]
    return pts[:MAX_ANCHORS].astype(np.float64)


def _nearest(A: np.ndarray, B: np.ndarray, tol: float) -> tuple[np.ndarray, np.ndarray]:
    """Mutual nearest neighbours between point sets within `tol`; returns index arrays."""
    d = np.hypot(*(A[:, None, :] - B[None, :, :]).transpose(2, 0, 1))
    ia = d.argmin(axis=1)           # best B for each A
    ib = d.argmin(axis=0)           # best A for each B
    ok = [i for i in range(len(A)) if ib[ia[i]] == i and d[i, ia[i]] <= tol]
    return np.array(ok, dtype=int), ia[ok] if ok else np.array([], dtype=int)


def estimate_similarity(ref: np.ndarray, pts: np.ndarray) -> np.ndarray | None:
    """2x3 similarity mapping `pts` onto `ref` (both Nx2 star lists), or None.

    Votes for the dominant translation first (robust to a few spurious stars and
    to frames far apart), then refines with RANSAC at tightening tolerances.
    """
    if len(ref) < MIN_MATCHES or len(pts) < MIN_MATCHES:
        return None
    d = (ref[:, None, :] - pts[None, :, :]).reshape(-1, 2)
    d = d[np.hypot(d[:, 0], d[:, 1]) <= SEARCH_RADIUS]
    if len(d) < MIN_MATCHES:
        return None
    bins = np.arange(-SEARCH_RADIUS, SEARCH_RADIUS + 3, 3.0)
    hist, xe, ye = np.histogram2d(d[:, 0], d[:, 1], bins=[bins, bins])
    # Smooth over neighbouring bins so a peak split across a bin edge still wins.
    hist = cv2.GaussianBlur(hist.astype(np.float32), (0, 0), 1.0)
    ix, iy = np.unravel_index(int(hist.argmax()), hist.shape)
    M = np.array([[1, 0, (xe[ix] + xe[ix + 1]) / 2], [0, 1, (ye[iy] + ye[iy + 1]) / 2]], np.float64)
    for tol in (8.0, 4.0, 2.5):
        ia, ib = _nearest(ref, _apply(M, pts), tol)
        if len(ia) < MIN_MATCHES:
            return None
        fit, _inl = cv2.estimateAffinePartial2D(
            pts[ib], ref[ia], method=cv2.RANSAC, ransacReprojThreshold=2.0
        )
        if fit is None:
            return None
        M = fit
    return M


def _to3(M: np.ndarray) -> np.ndarray:
    return np.vstack([M, [0, 0, 1]])


def align_frames(
    anchors: list[np.ndarray], ref_idx: int
) -> tuple[list[np.ndarray | None], float]:
    """Homographies (3x3, frame -> reference) for each frame; None where alignment failed.

    Frames are chained outward from the reference so neighbours always match
    closely; a frame that fails is skipped and the next one tries the last good
    frame instead. Each result is then refined directly against the reference.
    Returns (homographies, mean residual in px over the matched stars).
    """
    n = len(anchors)
    H: list[np.ndarray | None] = [None] * n
    H[ref_idx] = np.eye(3)
    for step in (1, -1):
        good = ref_idx
        k = ref_idx + step
        while 0 <= k < n:
            # similarity mapping frame k onto the last good frame, then onto the reference
            M = estimate_similarity(anchors[good], anchors[k])
            if M is not None and H[good] is not None:
                H[k] = H[good] @ _to3(M)
                good = k
            k += step

    ref = anchors[ref_idx]
    residuals: list[float] = []
    for k in range(n):
        if H[k] is None or k == ref_idx:
            continue
        mapped = cv2.perspectiveTransform(anchors[k][None].astype(np.float32), H[k])[0]
        ia, ib = _nearest(ref, mapped.astype(np.float64), 2.0)
        if len(ia) >= 12:
            Hn, _inl = cv2.findHomography(anchors[k][ib], ref[ia], cv2.RANSAC, 1.5)
            if Hn is not None:
                H[k] = Hn
                mapped = cv2.perspectiveTransform(anchors[k][None].astype(np.float32), Hn)[0]
                ia, ib = _nearest(ref, mapped.astype(np.float64), 2.0)
        if len(ia):
            residuals.append(float(np.hypot(*(ref[ia] - mapped[ib]).T).mean()))
    return H, float(np.mean(residuals)) if residuals else 0.0


# ---- masking ----

def _energy(small: np.ndarray) -> np.ndarray:
    g = cv2.GaussianBlur(small, (0, 0), 1.2)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)
    return cv2.GaussianBlur(gx * gx + gy * gy, (0, 0), 6.0)


MASK_MAX_SIDE = 1500


def small_luminance(lin: np.ndarray) -> np.ndarray:
    """Gamma-lifted luminance, downscaled so its long side is at most MASK_MAX_SIDE."""
    h, w = lin.shape[:2]
    f = max(1, max(h, w) // MASK_MAX_SIDE)
    lum = np.sqrt(np.clip(lin @ np.array([0.2126, 0.7152, 0.0722], np.float32), 0, 1))
    return lum if f == 1 else cv2.resize(lum, (w // f, h // f), interpolation=cv2.INTER_AREA)


def foreground_mask(
    unaligned: np.ndarray, aligned: np.ndarray, out_hw: tuple[int, int], fill_below: bool = True
) -> np.ndarray:
    """Soft 0..1 mask at `out_hw`, 1 = foreground, from two `small_luminance` images.

    Static landscape detail is sharp in the unaligned stack and smeared in the
    aligned one; stars are the reverse. Comparing local edge energy separates them.
    `unaligned` should be a temporal *median*, so a one-frame transient (a satellite
    is static at one sensor position too) can't pass for landscape.
    """
    h, w = out_hw
    size = (unaligned.shape[1], unaligned.shape[0])
    f = max(1, w // size[0])

    eu, ea = _energy(unaligned), _energy(aligned)
    noise = float(np.median(ea)) + 1e-12
    fg = ((eu > 3.0 * ea) & (eu > 4.0 * noise)).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    # A landscape foreground is one big connected thing, attached to the bottom of
    # the frame. Specks and isolated blobs in the sky (a satellite streak is static
    # at one sensor position too) are not foreground — and must never get the
    # fill-below step below, which would drag them to the bottom edge.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    h_s, w_s = fg.shape
    keep = np.zeros(n, np.uint8)
    for i in range(1, n):
        y, bh, area = (int(stats[i, c]) for c in (cv2.CC_STAT_TOP, cv2.CC_STAT_HEIGHT, cv2.CC_STAT_AREA))
        touches_bottom = y + bh >= h_s - 1
        if (touches_bottom and area >= 0.002 * h_s * w_s) or area >= 0.02 * h_s * w_s:
            keep[i] = 1
    fg = keep[labels]
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    if fill_below:
        # Landscape: anything below foreground is foreground too.
        fg = np.maximum.accumulate(fg, axis=0)
    fg = cv2.dilate(fg, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    full = cv2.resize(fg.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    return np.clip(cv2.GaussianBlur(full, (0, 0), 3.0 * f), 0.0, 1.0)


# ---- the stack ----

def _warp(img: np.ndarray, H: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Warp a frame and return (image, valid) where valid marks real (non-border) pixels."""
    h, w = img.shape[:2]
    out = cv2.warpPerspective(img, H, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT)
    ones = cv2.warpPerspective(
        np.ones((h, w), np.float32), H, (w, h), flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )
    return out, (ones > 0.999).astype(np.float32)


def _copy_exif(reference: Path, target: Path) -> None:
    """Carry the reference frame's EXIF onto the TIFF (best effort)."""
    try:
        exiftool = models.find_exiftool()
        if exiftool is None:
            return
        subprocess.run(
            [str(exiftool), "-overwrite_original", "-q", "-TagsFromFile", str(reference),
             "-exif:all", "-Orientation#=1", str(target)],
            check=False, capture_output=True, timeout=120,
        )
    except Exception as exc:  # noqa: BLE001 - metadata is a nicety, never fatal
        log.warning("could not copy EXIF to %s: %s", target, exc)


def _write_preview(lin: np.ndarray, path: Path) -> None:
    """A stretched 8-bit JPEG so the stack is visible in the UI (not the saved result)."""
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    lo, hi = np.percentile(lum, [1.0, 99.8])
    scaled = np.clip((lin - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    img = (_linear_to_srgb(scaled) * 255.0).astype(np.uint8)
    scale = 1600.0 / max(img.shape[:2])
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(path, "JPEG", quality=88)


def stack_sequence(
    sources: list[Path],
    output: Path,
    preview: Path,
    options: StackOptions | None = None,
    progress: Progress | None = None,
) -> StackResult:
    """Stack the frames at `sources` (in time order) into a 16-bit TIFF at `output`."""
    opt = options or StackOptions()
    if len(sources) < 3:
        raise ValueError("need at least three frames to stack")
    total = 3 * len(sources) + 2
    done = 0

    def tick(label: str) -> None:
        nonlocal done
        done += 1
        if progress:
            progress(done, total, label)

    # -- pass 1: find stars in every frame --
    fields: list[StarField | None] = []
    shape: tuple[int, int] | None = None
    skipped: list[tuple[str, str]] = []
    usable: list[int] = []
    for i, src in enumerate(sources):
        try:
            lin = decode_linear(src, opt.half_size)
        except Exception as exc:  # noqa: BLE001 - one bad file must not sink the stack
            skipped.append((src.name, f"unreadable ({exc})"))
            fields.append(None)
            tick(src.name)
            continue
        if shape is None:
            shape = lin.shape[:2]
        if lin.shape[:2] != shape:
            skipped.append((src.name, "different size"))
            fields.append(None)
        else:
            fields.append(detect_stars(_detection_gray(lin)))
            usable.append(i)
        del lin
        tick(src.name)
    if len(usable) < 3 or shape is None:
        raise ValueError("fewer than three readable frames")

    static = _static_cells([fields[i] for i in usable])  # type: ignore[misc]
    anchors_all = [_anchors(fields[i], static) for i in usable]  # type: ignore[arg-type]
    if static and float(np.median([len(a) for a in anchors_all])) < MIN_SKY_ANCHORS:
        # "Foreground" ate the stars too: the sky barely moved, so the two can't be
        # told apart. Keep every detection rather than starve the alignment.
        anchors_all = [_anchors(fields[i], set()) for i in usable]  # type: ignore[arg-type]
    ref_local = len(usable) // 2
    Hs, rms = align_frames(anchors_all, ref_local)

    good: list[tuple[int, np.ndarray]] = []
    for local, i in enumerate(usable):
        if Hs[local] is None:
            skipped.append((sources[i].name, "could not align (too few stars)"))
        else:
            good.append((i, Hs[local]))
    if len(good) < 3:
        raise ValueError("could not align at least three frames")
    ref_path = sources[usable[ref_local]]

    # -- pass 2: mean and spread of the aligned stack (and the unaligned foreground sum) --
    h, w = shape
    s1 = np.zeros((h, w, 3), np.float32)
    s2 = np.zeros((h, w, 3), np.float32)
    cnt = np.zeros((h, w), np.float32)
    ufg = np.zeros((h, w, 3), np.float32) if opt.foreground != "none" else None
    small_frames: list[np.ndarray] = []
    for i, H in good:
        lin = decode_linear(sources[i], opt.half_size)
        if ufg is not None:
            ufg += lin
            small_frames.append(small_luminance(lin).astype(np.float16))
        warped, valid = _warp(lin, H)
        del lin
        s1 += warped * valid[..., None]
        s2 += warped * warped * valid[..., None]
        cnt += valid
        del warped, valid
        tick(sources[i].name)

    safe = np.maximum(cnt, 1.0)[..., None]
    mean = s1 / safe
    std = np.sqrt(np.maximum(s2 / safe - mean * mean, 0.0))
    del s1, s2
    gc.collect()

    # -- pass 3: sigma-clipped integration --
    acc = np.zeros((h, w, 3), np.float32)
    acc_n = np.zeros((h, w, 3), np.float32)
    limit = opt.kappa * np.maximum(std, 1e-4)
    for i, H in good:
        lin = decode_linear(sources[i], opt.half_size)
        warped, valid = _warp(lin, H)
        del lin
        keep = (np.abs(warped - mean) <= limit) & (valid[..., None] > 0)
        acc += np.where(keep, warped, 0.0)
        acc_n += keep
        del warped, valid, keep
        tick(sources[i].name)
    sky = np.where(acc_n > 0, acc / np.maximum(acc_n, 1.0), mean)
    del acc, acc_n, mean, std, limit
    gc.collect()

    # -- blend sky and foreground --
    result = sky
    if ufg is not None:
        ufg /= len(good)
        unaligned_small = np.median(np.stack(small_frames), axis=0).astype(np.float32)
        mask = foreground_mask(unaligned_small, small_luminance(sky), (h, w))
        del small_frames, unaligned_small
        result = sky * (1.0 - mask[..., None]) + ufg * mask[..., None]
    del ufg
    tick("blending")

    # -- write --
    output.parent.mkdir(parents=True, exist_ok=True)
    enc = (_linear_to_srgb(result) * 65535.0 + 0.5).astype(np.uint16)
    if not cv2.imwrite(str(output), cv2.cvtColor(enc, cv2.COLOR_RGB2BGR)):
        raise OSError(f"could not write {output}")
    _copy_exif(ref_path, output)
    _write_preview(result, preview)
    tick("done")
    return StackResult(
        output=output, preview=preview, used=len(good), skipped=skipped,
        width=w, height=h, rms=rms,
    )
