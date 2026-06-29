"""Environment self-check — verify the deps and tools PhotoCull needs.

Run this right after setting up the venv (especially on a new machine like the
Mac) to confirm the worker can actually start and score, before launching the
app:

    python -m photocull.doctor      # or:  npm run doctor

It checks the Python version, that each dependency imports, and that exiftool is
reachable. "Required" deps must be present or the sidecar won't start at all
(rawpy is imported at startup); "recommended" deps and exiftool only affect face
scoring and capture-date/AF metadata.
"""
from __future__ import annotations

import importlib
import sys
from importlib import metadata

from . import models

# (import name, pip/distribution name)
REQUIRED = [
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("pydantic", "pydantic"),
    ("PIL", "Pillow"),
    ("piexif", "piexif"),
    ("imagehash", "imagehash"),
    ("numpy", "numpy"),
    ("cv2", "opencv-python-headless"),
    ("rawpy", "rawpy"),
]
RECOMMENDED = [
    ("mediapipe", "mediapipe"),
    ("onnxruntime", "onnxruntime"),
]

# What to tell the user when something in each tier is missing.
REQUIRED_HINT = 'pip install -e "apps/worker[raw,ml]"'
RECOMMENDED_HINT = 'pip install -e "apps/worker[raw,ml]"'
EXIFTOOL_HINT = (
    "brew install exiftool  (macOS)  /  auto-downloaded on Windows"
)


def _probe(import_name: str, dist_name: str) -> tuple[bool, str]:
    """Return (ok, detail). detail is a version on success, else the error."""
    try:
        mod = importlib.import_module(import_name)
    except Exception as exc:  # noqa: BLE001 - any import failure is a "missing"
        return False, str(exc).splitlines()[0]
    version = getattr(mod, "__version__", None)
    if version is None:
        try:
            version = metadata.version(dist_name)
        except Exception:  # noqa: BLE001
            version = "?"
    return True, str(version)


def _row(label: str, ok: bool, detail: str, hint: str) -> str:
    status = "OK" if ok else "MISSING"
    line = f"  {label:<24} {status:<8} {detail}"
    if not ok and hint:
        line += f"\n  {'':<24} {'':<8} -> {hint}"
    return line


def main() -> int:
    print("PhotoCull environment check\n")

    py_ok = sys.version_info >= (3, 11)
    pyv = ".".join(str(n) for n in sys.version_info[:3])
    print(_row("Python (>= 3.11)", py_ok, pyv, "install Python 3.11+ and recreate the venv"))

    print("\nRequired (sidecar won't start without these):")
    required_missing = 0
    for import_name, dist_name in REQUIRED:
        ok, detail = _probe(import_name, dist_name)
        required_missing += 0 if ok else 1
        print(_row(import_name, ok, detail, REQUIRED_HINT))

    print("\nRecommended (face scoring):")
    recommended_missing = 0
    for import_name, dist_name in RECOMMENDED:
        ok, detail = _probe(import_name, dist_name)
        recommended_missing += 0 if ok else 1
        print(_row(import_name, ok, detail, RECOMMENDED_HINT))

    exiftool = models.find_exiftool()
    print("\nTooling (capture date + AF metadata, organize):")
    print(_row("exiftool", exiftool is not None, str(exiftool or ""), EXIFTOOL_HINT))

    blocking = required_missing + (0 if py_ok else 1)
    print("\nSummary:")
    if blocking:
        print(f"  {blocking} blocking problem(s) — the app will not run until fixed.")
    else:
        print("  All required deps present - the app can start.")
    if recommended_missing or exiftool is None:
        print("  Some optional pieces are missing (see above); core culling still works.")

    return 1 if blocking else 0


if __name__ == "__main__":
    raise SystemExit(main())
