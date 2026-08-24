# PhotoCull

A cross-platform desktop culling app for photographers. Inspired by Narrative Select: groups a shoot into **scenes**, scores each frame for **focus, eyes-open, exposure, and aesthetic**, then exports picks as **XMP sidecars** that Lightroom / Capture One pick up.

> Status: Phase 3 baseline, Phase 4 underway — RAW pipeline, scene grouping,
> local scoring (focus / eyes / exposure / aesthetic / faces), crop, and XMP
> export all work. Runs on **Windows and macOS**. See `apps/` for the Electron
> shell and Python sidecar.

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
python -m venv .venv             # Windows
python3 -m venv .venv            # macOS
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

## Releases

Public installers are built here, tagged (`git tag vX.Y.Z`), and published as
assets on the separate `ossger/photocull-releases` repo — this repo stays private
and source-free downloads never live here. The public download page and install
instructions are at `photocull.infrarg.com`, sourced from that project.

Before tagging a public release, bump the version in all four places together
(`package.json`, `apps/shell/package.json`, `apps/worker/pyproject.toml`,
`apps/worker/photocull/__init__.py`) and add a `CHANGELOG.md` entry — never reuse
a version number for different bytes once it's been published.

## Project layout

```
apps/
  shell/      Electron + React frontend
  worker/     Python FastAPI sidecar (ML, RAW, XMP)
packaging/    Per-OS build scripts (worker freeze + electron-builder; see packaging/README.md)
```

## Organizing raw captures (Import / `organize`)

Tidy memory cards *before* culling — sort raw card dumps into a dated library
tree. Available two ways, both driving the same engine:

**In the app:** click **Import…** in the toolbar, choose the card/source and
your library folders, hit **Preview** to see what will move (grouped by the
dated folder it'll land in, with any duplicates flagged), then **Move**. The
library destination is remembered between imports.

**CLI** (no app needed). Drop your DJI / Canon dumps into `_RawIngest/`, then run:

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
- **Phase 4 (in progress)** — local aesthetic scoring (contrast + colorfulness
  heuristic, done); optional Claude/Google Vision API scoring and CLIP smart
  scenes still to come
