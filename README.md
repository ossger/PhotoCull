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

## Roadmap

- **Phase 1** — walking skeleton: folder pick, JPEG ingest, virtualized grid, star/pick hotkeys
- **Phase 2** — scene grouping, sharpness + exposure scoring, compare view
- **Phase 3** — RAW pipeline, MediaPipe face/eyes, XMP export
- **Phase 4** — aesthetic model, optional Claude/Google Vision API, CLIP smart scenes
