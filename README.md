# PhotoCull

A cross-platform desktop culling app for photographers. Inspired by Narrative Select: groups a shoot into **scenes**, scores each frame for **focus, eyes-open, exposure, and aesthetic**, then exports picks as **XMP sidecars** that Lightroom / Capture One pick up.

> Status: Phase 1 (walking skeleton). See `apps/` for the Electron shell and Python sidecar.

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

Prereqs: **Node 20+**, **Python 3.11+**, and (later) **exiftool** on PATH.

```powershell
# Install JS deps
npm install

# Set up the Python sidecar in a venv
python -m venv .venv
.\.venv\Scripts\Activate.ps1   # or source .venv/bin/activate on macOS
pip install -e apps/worker

# Run both (the shell will spawn the sidecar)
npm run dev
```

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

- **Phase 1** — walking skeleton: folder pick, JPEG ingest, virtualized grid, star/pick hotkeys
- **Phase 2** — scene grouping, sharpness + exposure scoring, compare view
- **Phase 3** — RAW pipeline, MediaPipe face/eyes, XMP export
- **Phase 4** — aesthetic model, optional Claude/Google Vision API, CLIP smart scenes
