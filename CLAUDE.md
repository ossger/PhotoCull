# PhotoCull — Operating Instructions

A cross-platform desktop **photo-culling** app. It ingests a shoot, groups it
into **scenes**, scores each frame (focus / eyes-open / exposure / aesthetic),
and exports the picks as **XMP sidecars** that Lightroom / Capture One read.

`README.md` has the user-facing setup. This file is for agents working in the
code. **Note:** the README's "Phase 1 (walking skeleton)" status line is stale —
the code is at the **Phase 3 baseline** (RAW pipeline, scenes, scoring incl.
faces, crop, XMP export). Trust the code, not that line.

> Native runtime: Windows, git bash + PowerShell 7. Node ≥ 20, Python 3.11+.

---

## Architecture

A monorepo (npm workspaces) with two halves:

- **`apps/shell`** — Electron + React + Vite + TypeScript. `src/main` (main
  process), `src/preload` (context bridge), `src/renderer` (React UI),
  `src/shared/types.ts` (types shared across processes).
- **`apps/worker`** — a Python package `photocull` (FastAPI). The brains: RAW
  decode (`raw.py`), ingest (`ingest.py`), scene detection (`scenes.py`),
  scoring (`scoring/{sharpness,exposure,faces,aggregate}.py`), focus metadata
  (`focus_meta.py`), per-shoot SQLite (`db.py`, `models.py`), and XMP export
  (`export/xmp.py`). Entry point: `photocull.server`.

### How the two halves talk (the contract)

The Electron main process **spawns the worker as a sidecar** (`src/main/sidecar.ts`):

- Dev: `python -m photocull.server --host 127.0.0.1 --port 0 --print-handshake`.
  Packaged: a PyInstaller one-folder `photocull-worker` under `resources/worker`
  (same flags). Python is resolved via `$PYTHON` → a `.venv`/`venv` near the
  repo root → PATH.
- `--port 0` lets the OS pick a free port. The worker prints **exactly one JSON
  line** on stdout — the handshake `{ port, token }` — then serves on
  `127.0.0.1:<port>`. Everything after is localhost-only.

Two paths reach the worker from the renderer:

1. **RPC** — the renderer calls `window.photocull.*` (exposed by
   `preload.ts` via `contextBridge`, an **allow-list**), which is
   `ipcRenderer.invoke` → handled in main → worker. API today: `pickFolder`,
   `openShoot`, `shootProgress`, `listImages`, `listScenes`, `regroupScenes`,
   `exportXmp`, `organizePlan`, `organizeRun`, `organizeProgress`, `setPick`,
   `setStars`, `setColor`, `setCrop`, and the `thumbUrl`/`previewUrl`/`fullUrl`
   URL builders.
2. **Image bytes** — `<img>` loads directly from the worker:
   `http://127.0.0.1:<port>/files/{thumb|preview|full|original}?rel=…&token=…`.
   The token goes in the query string (you can't set headers on `<img>`); leak
   risk is bounded to localhost.

**When you add a worker capability, change all three layers together:** the
FastAPI route in the worker, the IPC handler in main, and the allow-listed
method in `preload.ts` (plus `src/shared/types.ts`). The renderer must never
talk to anything outside `window.photocull` + the `/files` URLs.

---

## Dev workflow

```bash
npm install                       # JS deps (workspaces)
python -m venv .venv              # at repo root; sidecar.ts looks for it here
# activate it, then:
npm run worker:install            # pip install -e apps/worker
npm run dev                       # Electron + Vite; main spawns the sidecar

npm run worker:dev                # run the worker standalone (debugging)
cd apps/worker && pytest          # worker tests (test_ingest, test_phase2, test_xmp, …)
npm run build / npm run dist      # build / package
```

The data model is a **per-shoot SQLite DB**. Image state includes pick
(`-1` reject / `0` unset / `1` pick), star rating, color label, and an optional
crop rect — these are what XMP export writes out.

---

## Conventions & scope guard

- **Keep the cross-process contract in sync** — `src/shared/types.ts` (TS) and
  the worker's `models.py` describe the same shapes; change them together.
- **Local-first.** Scoring runs offline by default. Cloud vision / API scoring
  (roadmap Phase 4) must stay **optional and opt-in** — never a hard dependency
  for the core cull.
- **Cross-platform.** Windows is the current target; keep macOS in mind (path
  handling, the `resolvePython` / packaged-sidecar paths). Don't break the
  packaged PyInstaller path in `sidecar.ts`.
- **Worker stays a clean package** (`photocull`) with tests; keep heavy
  ML/RAW work in the worker, not the renderer.
- Internal roadmap (separate from the repo-wide restructure phases): Phase 4 =
  aesthetic model, optional Claude/Google Vision API, CLIP smart scenes.
