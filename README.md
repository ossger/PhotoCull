# PhotoCull

A cross-platform desktop culling app for photographers. Inspired by Narrative Select: groups a shoot into **scenes**, scores each frame for **focus, eyes-open, exposure, and aesthetic**, then exports picks as **XMP sidecars** that Lightroom / Capture One pick up.

> Status: Phase 3 baseline — RAW pipeline, scene grouping, local scoring
> (focus / eyes / exposure / faces), crop, and XMP export all work. Runs on
> **Windows and macOS**. See `apps/` for the Electron shell and Python sidecar.

## Architecture

```
+----------------------------+        FastAPI/HTTP        +-------------------------+
|  Electron + React shell    |  <----------------------> |  Python sidecar         |
|  apps/shell (TypeScript)   |   localhost:<random>      |  apps/worker            |
|  - UI, hotkeys, loupe      |                            |  - RAW decode (rawpy)   |
|  - SQLite (per-shoot DB)   |                            |  - EXIF, thumbs         |
|                            |                            |  - Scene detection      |
|                            |                            |  - Local AI scoring     |
|                            |                            |  - XMP export (exiftool)|
+----------------------------+                            +-------------------------+
```

## Dev setup

Prereqs: **Node 20+** and **Python 3.11+** on both Windows and macOS.

```bash
# 1. JS deps
npm install

# 2. Python sidecar in a venv AT THE REPO ROOT (sidecar.ts looks for .venv here)
python -m venv .venv
.\.venv\Scripts\Activate.ps1     # Windows (PowerShell)
source .venv/bin/activate        # macOS

# 3. Install the worker WITH the raw + ml extras. rawpy is imported at sidecar
#    startup, so a base-only install won't boot the worker at this baseline.
npm run worker:install           # = pip install -e "apps/worker[raw,ml]"

# 4. Verify the environment (deps + exiftool) before launching:
npm run doctor

# 5. Run the app — Electron spawns the Python sidecar automatically:
npm run dev
```

**macOS:** install exiftool once — `brew install exiftool` — so capture-date
sorting and camera AF metadata work. (On Windows a portable copy is downloaded
automatically on first use.) The face/RAW model files also download on first
run, so the first launch needs an internet connection.

## Project layout

```
apps/
  shell/      Electron + React frontend
  worker/     Python FastAPI sidecar (ML, RAW, XMP)
packaging/    Per-OS build scripts (later)
```

## Organizing raw captures (`organize`)

A standalone CLI — separate from the desktop app — that tidies memory cards
*before* culling. Drop your DJI / Canon dumps into `_RawIngest/`, then run:

```bash
# from the repo root, with the venv active:
python -m photocull.organize              # move everything into PhotoLibrary/
python -m photocull.organize --dry-run    # preview the plan, move nothing
python -m photocull.organize --label Beach   # override the per-folder source token
```

It reads each file's capture date + camera (EXIF, one batched exiftool pass) and
**moves** it into a date-plus-source tree:

```
PhotoLibrary/2026/2026-06-24_DJI-Drone/DJI_0001.DNG
PhotoLibrary/2026/2026-06-25_Canon-R6mkii/R6_3920.CR3
```

The source token comes from the camera (DJI drone vs Canon body); files with no
EXIF date fall back to file modification time. Collisions are never overwritten
— identical files are skipped, differing ones get a numeric suffix. `_RawIngest/`
and `PhotoLibrary/` are git-ignored. (Google/iCloud import is a future source.)

## Roadmap

- **Phase 1 (done)** — walking skeleton: folder pick, JPEG ingest, virtualized grid, star/pick hotkeys
- **Phase 2 (done)** — scene grouping, sharpness + exposure scoring, compare view
- **Phase 3 (done)** — RAW pipeline, MediaPipe + YuNet face/eyes, XMP export
- **Phase 4 (next)** — aesthetic model, optional Claude/Google Vision API, CLIP smart scenes
