# Phase 1 quickstart

The walking skeleton is wired up. Here's how to get it running.

## One-time setup

### 1. Install Python 3.11+

Python isn't on the machine yet — install one of these:

- **Recommended**: download from <https://www.python.org/downloads/> (any 3.11, 3.12, or 3.13 build works). During install, tick **"Add python.exe to PATH"**.
- Or via `winget`:
  ```powershell
  winget install --id Python.Python.3.12 -e
  ```

Verify in a **new** PowerShell window:
```powershell
python --version
```

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
> If it keeps recurring, add `C:\projects\Photography` to Defender exclusions
> (Settings → Virus & threat protection → Manage settings → Exclusions).

### 3. Install the Python sidecar

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e apps/worker
```

(Optional: `pip install -e "apps/worker[dev]"` adds pytest + ruff for tests.)

## Run it

In an **activated** venv (so `python` finds `photocull`):
```powershell
npm run dev
```

This launches Vite + Electron. The Electron main process automatically spawns
the Python sidecar via `python -m photocull.server` and waits for `/health` to
return before opening the window.

## Try it out

1. Click **Open folder…** in the top-left and pick any folder of JPEGs (your
   own shoot, or sample images). RAW support lands in Phase 3 — Phase 1
   ingests `.jpg`, `.jpeg`, `.heic`, `.heif`.
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

## What's next (Phase 2)

- Scene grouping by EXIF time gap + pHash similarity
- Sharpness (Laplacian variance) and exposure (histogram) scores
- Scene strip column in the UI
- Compare view (2–4 frames synced)
