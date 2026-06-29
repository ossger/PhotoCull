# Packaging PhotoCull

Producing a double-clickable app (Windows `.exe` installer / macOS `.dmg`).

> **Status: prepared, not yet validated end-to-end.** The dev stack
> (`npm run dev`) is the supported way to run PhotoCull today. These scripts are
> a starting point for packaging; expect to tune the PyInstaller flags on the
> first real build. **Build on the target OS** — electron-builder does not
> cross-compile the native Python sidecar, so build the macOS app on a Mac and
> the Windows app on Windows.

## How it fits together

The Python worker is frozen into a self-contained one-folder bundle with
PyInstaller, then electron-builder copies it into the app under
`resources/worker/` and ships it alongside the Electron binary. At runtime
`src/main/sidecar.ts` runs `resources/worker/photocull-worker(.exe)` instead of
a system Python — so the end user needs **no** Python install.

## Build steps

From the repo root, in an **activated venv** that has the worker + extras
installed (`npm run worker:install`):

```bash
# 1. Add PyInstaller to the venv (one-time)
pip install pyinstaller

# 2. Freeze the worker -> apps/worker/dist-bin/photocull-worker/
./packaging/build-worker.sh        # macOS
./packaging/build-worker.ps1       # Windows (PowerShell)

# 3. Build + package the Electron app (runs electron-builder)
npm run dist
```

The installer/dmg lands in `apps/shell/release/` (or `dist/` per
electron-builder defaults).

## macOS: Gatekeeper

The mac build is **unsigned** (`mac.identity: null` in `apps/shell/package.json`)
— code signing + notarization needs a paid Apple Developer ID and is out of
scope for a personal build. macOS will refuse to open an unsigned, quarantined
app. After installing, clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/PhotoCull.app"
```

(Or right-click the app → Open the first time and confirm the dialog.)

## Known sharp edges to expect on the first build

- **mediapipe** is the usual PyInstaller troublemaker — it ships graph data
  (`.binarypb` / `.tflite`) that must be collected. We pass `--collect-all
  mediapipe`; if face scoring fails in the packaged app with a missing-data
  error, that's the place to look.
- **rawpy** bundles the native libraw binary; `--collect-all rawpy` should pull
  it in, but verify RAW decode works in the packaged build.
- **exiftool** is not bundled. On macOS the app still expects
  `brew install exiftool`; on Windows it auto-downloads a portable copy to the
  user cache on first use.
- Face/RAW **model files** download to the user cache on first run — the
  packaged app needs internet the first time, same as the dev stack.
