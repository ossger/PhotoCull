"""Model file management — download once, cache locally.

MediaPipe's Tasks API needs a model `.task` file on disk. We cache them under
the OS-appropriate user data directory so multiple shoots share one copy.
"""
from __future__ import annotations

import logging
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

log = logging.getLogger(__name__)

MEDIAPIPE_FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)

# YuNet face detector (OpenCV Zoo). Runs on the cv2 we already ship, detects
# small/distant faces the Landmarker's short-range detector misses, and returns
# a box + 5 landmarks. Loaded via cv2.FaceDetectorYN.
YUNET_FACE_DETECTOR_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)

# Pin a known-good ExifTool version. Bump as needed.
EXIFTOOL_VERSION = "13.59"
EXIFTOOL_WIN_URL = f"https://exiftool.org/exiftool-{EXIFTOOL_VERSION}_64.zip"


def cache_dir() -> Path:
    """Per-user cache directory: %LOCALAPPDATA%\\photocull on Windows, ~/.cache/photocull elsewhere."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        path = Path(base) / "photocull"
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        path = Path(base) / "photocull"
    path.mkdir(parents=True, exist_ok=True)
    return path


def fetch(url: str, filename: str) -> Path:
    """Download `url` to the cache dir under `filename` if not already present."""
    target = cache_dir() / "models" / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target
    log.info("downloading model: %s -> %s", url, target)
    # Stream to a .partial file so a crashed download doesn't poison the cache.
    partial = target.with_suffix(target.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=60) as resp, open(partial, "wb") as f:
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
    partial.replace(target)
    return target


def face_landmarker_model() -> Path:
    return fetch(MEDIAPIPE_FACE_LANDMARKER_URL, "face_landmarker.task")


def yunet_face_detector_model() -> Path:
    return fetch(YUNET_FACE_DETECTOR_URL, "face_detection_yunet_2023mar.onnx")


def find_exiftool() -> Path | None:
    """Locate an exiftool executable. PATH first, then our cache dir."""
    on_path = shutil.which("exiftool")
    if on_path:
        return Path(on_path)
    cached = cache_dir() / "bin" / ("exiftool.exe" if os.name == "nt" else "exiftool")
    return cached if cached.exists() else None


def ensure_exiftool() -> Path:
    """Return a path to exiftool, downloading the Windows portable build if needed.

    macOS/Linux users are expected to install via `brew install exiftool` /
    `apt install exiftool` — auto-installing on those platforms is out of scope.
    """
    found = find_exiftool()
    if found is not None:
        return found
    if os.name != "nt":
        raise FileNotFoundError(
            "exiftool not found on PATH. Install it with `brew install exiftool` "
            "(macOS) or your package manager (Linux), then restart the app."
        )
    return _download_exiftool_windows()


def _download_exiftool_windows() -> Path:
    """Download and extract a portable ExifTool build.

    The zip layout has changed across versions: older releases put
    `exiftool(-k).exe` and `exiftool_files/` at the root, while 13.x nests them
    inside a `exiftool-<ver>_64/` folder. We extract, then locate the launcher
    wherever it landed and flatten it into our bin dir as `exiftool.exe`.
    """
    bin_dir = cache_dir() / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    target = bin_dir / "exiftool.exe"
    if target.exists():
        return target

    log.info("downloading exiftool %s for Windows", EXIFTOOL_VERSION)
    zip_partial = bin_dir / f"exiftool-{EXIFTOOL_VERSION}.zip.partial"
    with urllib.request.urlopen(EXIFTOOL_WIN_URL, timeout=120) as resp, open(zip_partial, "wb") as f:
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
    with zipfile.ZipFile(zip_partial) as zf:
        zf.extractall(bin_dir)
    zip_partial.unlink(missing_ok=True)

    # Find the launcher wherever it landed (top-level or one folder deep).
    launcher: Path | None = None
    for candidate in [bin_dir, *bin_dir.iterdir()]:
        if not candidate.is_dir():
            continue
        for name in ("exiftool(-k).exe", "exiftool.exe"):
            p = candidate / name
            if p.exists():
                launcher = p
                break
        if launcher:
            break

    if launcher is None:
        raise RuntimeError(
            f"exiftool zip extracted but no executable found under {bin_dir}"
        )

    # Move launcher + its sibling `exiftool_files` directory up so paths are stable.
    src_dir = launcher.parent
    if src_dir != bin_dir:
        # Move every sibling into bin_dir, then remove the now-empty container.
        for item in list(src_dir.iterdir()):
            dest = bin_dir / item.name
            if dest.exists():
                if dest.is_dir():
                    shutil.rmtree(dest)
                else:
                    dest.unlink()
            item.replace(dest)
        src_dir.rmdir()
        launcher = bin_dir / launcher.name

    if launcher.name != "exiftool.exe":
        launcher.replace(target)
    else:
        # Already named exiftool.exe (unlikely for portable build, but be defensive)
        if launcher != target:
            launcher.replace(target)

    if not target.exists():
        raise RuntimeError(
            f"exiftool launcher rename failed; expected {target}"
        )
    return target
