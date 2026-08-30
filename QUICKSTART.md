# Quickstart

How to get PhotoCull running on **Windows or macOS**. (For the short version,
see "Dev setup" in `README.md`.)

## One-time setup

### 1. Install Python 3.11+

- **Windows**: download from <https://www.python.org/downloads/> (any 3.11–3.13
  build). During install, tick **"Add python.exe to PATH"**. Or
  `winget install --id Python.Python.3.12 -e`.
- **macOS**: `brew install python@3.12` (or download from python.org).

Verify in a **new** terminal — `python --version` (Windows) /
`python3 --version` (macOS).

### 2. Install Node dependencies (shell)

From the repo root:
```powershell
npm install
```

> **Heads-up (Windows):** Electron's postinstall downloads a ~110 MB zip and
> extracts it into `node_modules/electron/dist/`. Windows Defender sometimes
> quarantines `electron.exe` mid-extraction, leaving a half-installed dist with
> only `locales/` and no `path.txt`. If `npm run dev` later errors with
> *"Electron failed to install correctly"*, recover with:
>
> ```powershell
> $dist = "node_modules/electron/dist"
> $zip  = (Get-ChildItem "$env:LOCALAPPDATA/electron/Cache" -Recurse -Filter "electron-*-win32-x64.zip").FullName
> Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
> New-Item -ItemType Directory -Path $dist | Out-Null
> Expand-Archive -Path $zip -DestinationPath $dist -Force
> "electron.exe" | Set-Content node_modules/electron/path.txt
> ```
>
> If it keeps recurring, add `~/Projects/Photography` to Defender exclusions
> (Settings → Virus & threat protection → Manage settings → Exclusions).

### 3. Install the Python sidecar

Create a venv **at the repo root** (the Electron side looks for `.venv` here),
then install the worker with the `raw` + `ml` extras — `rawpy` is imported at
sidecar startup, so a base-only install won't boot the worker.

```powershell
# Windows
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e "apps/worker[raw,ml]"
```

```bash
# macOS
python3 -m venv .venv
source .venv/bin/activate
pip install -e "apps/worker[raw,ml]"
brew install exiftool      # capture-date + AF metadata; Windows auto-downloads it
```

(Use `[raw,ml,dev]` to also get pytest + ruff.) Then sanity-check the
environment before launching:

```bash
npm run doctor
```

## Run it

In an **activated** venv (so `python` finds `photocull`):
```powershell
npm run dev
```

This launches Vite + Electron. The Electron main process automatically spawns
the Python sidecar via `python -m photocull.server` and waits for `/health` to
return before opening the window.

## Try it out

1. Click **Open folder…** in the top-left and pick a shoot folder. PhotoCull
   ingests RAW (CR3 / NEF / ARW / DNG / …), JPEG, and HEIC.
2. Watch the progress indicator: thumbnails appear in the left grid as the
   sidecar generates them. ≈200 photos should index in well under a minute.
3. **Click** a thumbnail (or use **←/→**) to load it in the loupe pane.
4. Press **P** to pick, **X** to reject, **U** to unset, **0–5** for stars.
   Decisions persist to a per-shoot SQLite DB at
   `<folder>/.photocull/shoot.db` and survive app restarts.

## What lives where

```
apps/shell/                Electron + React + Tailwind
  src/main/main.ts          window, IPC, sidecar supervisor
  src/main/sidecar.ts       spawn Python / handshake
  src/preload/preload.ts    contextBridge — typed API for the renderer
  src/renderer/             React UI (App, Grid, Loupe, store, hotkeys)
apps/worker/                Python sidecar (FastAPI)
  photocull/server.py       HTTP API the shell calls
  photocull/shoot.py        per-shoot orchestration
  photocull/ingest.py       walk + EXIF + thumb/preview generation
  photocull/db.py           SQLite schema
  tests/test_ingest.py      pytest smoke test
```

## Run the Python tests

```powershell
pip install -e "apps/worker[dev]"
pytest apps/worker
```

## What's next

Phases 1–3 are done (RAW pipeline, scenes, scoring, crop, XMP export). Phase 4
is the aesthetic model, optional cloud vision, and CLIP smart scenes — see the
roadmap in `README.md`.
