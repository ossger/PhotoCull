# PhotoCull

A cross-platform desktop culling app for photographers. Inspired by Narrative Select: groups a shoot into **scenes**, scores each frame for **focus, eyes-open, exposure, and aesthetic**, then exports picks as **XMP sidecars** that Lightroom / Capture One pick up.

**Download:** signed macOS builds at **[photocull.infrarg.com](https://photocull.infrarg.com)**
(Windows build coming). Or build it from source — see [Dev setup](#dev-setup).

> Status: actively developed. RAW pipeline, scene grouping, local scoring
> (focus / eyes / exposure / aesthetic / faces), compare, crop, and XMP export
> all work. Runs on **Windows and macOS**. Everything runs **locally** — no
> account, no upload, your photos never leave your machine.

## Features

- **Scenes** — bursts and near-duplicates grouped automatically, so you pick the
  best of each moment instead of scrolling thousands of frames.
- **Scores** — focus, eyes-open, exposure, and an aesthetic heuristic per frame,
  plus a face/eye overlay and an eye-zoom loupe to judge sharpness fast.
- **Compare** — up to four frames side by side, each zoomable and pannable
  (or zoom-synced), seeded with the next four frames automatically.
- **Filmstrip** — resizable, or popped out into its own window.
- **Crop** — aspect presets, defaulting to the original ratio.
- **Export** — picks, stars, color labels, and crops written as **XMP sidecars**
  that Lightroom and Capture One read. Your originals are never modified.
- **Import / Sort into events** — tidy card dumps into dated folders before culling.

### Hotkeys

| Key | Action |
|---|---|
| ← / → · ↑ / ↓ | next/previous frame · next/previous scene |
| P · X · U | pick · reject · unset |
| 0–5 | star rating |
| G · C · R | grid · compare · crop |
| E · F | eye-zoom loupe · face/eye overlay |
| L | picks-only filter (in compare: sync zoom) |
| / · M | filter panel · shoot-wide matches |
| Space / double-click | fit ↔ 1:1 |
| Esc | leave crop → compare → selection |

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

Installers are published as GitHub Release assets on
[`ossger/photocull-releases`](https://github.com/ossger/photocull-releases)
(kept separate so multi-hundred-MB binaries stay out of this repo's history),
and linked from [photocull.infrarg.com](https://photocull.infrarg.com).
`CHANGELOG.md` lists what changed in each version.

Maintainers: before tagging, bump the version in all four places together
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

## Sorting a card dump into events (Sort into events…)

If you copy the whole card into one folder (say `~/Desktop/RAW`), **Sort into
events…** in the toolbar splits it into one subfolder per event, ready to open
and cull one at a time:

1. Choose the folder. PhotoCull reads every capture time (one batched exiftool
   pass; file mtime when there's no EXIF date) and proposes events. A new event
   starts wherever there's a gap longer than the slider value between shots
   (default 3 h).
2. Each event shows its time span, count, and a few thumbnails. Type a name and
   the folder is created as `YYYY-MM-DD Name`. Unnamed events get just the date,
   plus `a`/`b` when a day holds more than one. **Merge with next** joins events
   the gap rule split, the checkbox leaves an event unsorted, and moving the
   slider re-proposes.
3. **Sort** moves the files into subfolders *inside the same folder*. A RAW, its
   paired JPEG, and companions (`.xmp`, `.thm`, `.lrv`, `.srt`, `.aae`) travel
   together. Videos are sorted alongside photos. Nothing is overwritten: name
   clashes get a shared `_1` suffix so pairs stay paired.
4. **Undo last sort** puts everything back. A journal is kept in the folder's
   `.photocull/` until you undo it.

Only loose files at the top of the folder are considered. Subfolders, including
events you've already sorted, are left alone, so re-running after the next card
dump only picks up the new files. If the folder (or one inside it) is open as a
shoot, it is closed first.

## Roadmap

- **Phase 1 (done)** — walking skeleton: folder pick, JPEG ingest, virtualized grid, star/pick hotkeys
- **Phase 2 (done)** — scene grouping, sharpness + exposure scoring, compare view
- **Phase 3 (done)** — RAW pipeline, MediaPipe + YuNet face/eyes, XMP export
- **Phase 4 (in progress)** — local aesthetic scoring (contrast + colorfulness
  heuristic, done); optional Claude/Google Vision API scoring and CLIP smart
  scenes still to come
- **Post-cull pipeline (idea, not started)** — the steps after culling, currently
  done by hand. Hand picks to Lightroom / Photoshop for editing (the XMP sidecars
  already carry picks/stars/crop), then share the edited exports: an Instagram
  post, an Immich upload, and the family's TV screens (Google TV + Fire TV).
  A shared Immich or Google Photos album is the likely single source for those
  screens.

See [`BACKLOG.md`](BACKLOG.md) for the running list of what's next, and the
[issue tracker](https://github.com/ossger/PhotoCull/issues) to request a feature
or report a bug.

## Support PhotoCull

PhotoCull is free and open source. If it saves you time on a shoot, you can
support its development:

- **GitHub Sponsors** — the **Sponsor** button at the top of this repo
- **Buy Me a Coffee** — [buymeacoffee.com/ossger](https://buymeacoffee.com/ossger)

Bug reports, feature ideas, and pull requests are just as welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Ross Goeringer
