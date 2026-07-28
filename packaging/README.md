# Packaging PhotoCull

Producing a double-clickable app (Windows `.exe` installer / macOS `.dmg`).

> **Status: validated on Windows through the worker freeze + Electron build;
> the mac `.dmg` itself still needs a run on an actual Mac.** `npm run dev` is
> still the supported way to run PhotoCull day to day. **Build on the target
> OS** — electron-builder does not cross-compile the native Python sidecar, so
> build the macOS app on a Mac and the Windows app on Windows.
>
> Bugs found and fixed while validating on Windows (all apply equally to a mac
> build, since they're in shared config, not OS-specific code):
> - `build-worker.sh`/`.ps1` pointed PyInstaller straight at `photocull/server.py`,
>   which fails with "attempted relative import with no known parent package"
>   because that file uses package-relative imports. Both scripts now build
>   `apps/worker/entry.py` instead (a thin `from photocull.server import cli`
>   wrapper) — point any future manual PyInstaller invocation at that file too.
> - `apps/shell/tsconfig.json` had `rootDir: "src/renderer"` but `include`d
>   `src/shared` too, and had no `paths` entry for the `@shared` alias Vite
>   resolves at bundle time — both broke `tsc -b` (only `vite`-driven `npm run
>   dev` ever exercised this path, so it went unnoticed). Fixed: `rootDir: "src"`
>   plus `paths: { "@shared/*": ["src/shared/*"] }`.
> - `apps/shell/package.json`'s `extraResources` entry used `filters` (electron-builder's
>   schema wants `filter`, singular).
> - electron-builder couldn't compute the electron version under npm workspaces
>   (electron is hoisted to the repo-root `node_modules`, not `apps/shell`'s) —
>   pinned `build.electronVersion` explicitly. **Re-pin this if `electron`'s
>   version in `apps/shell/package.json` is ever bumped**, or the pinned value
>   will silently drift from what's installed.

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
