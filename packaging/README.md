# Packaging PhotoCull

Producing a double-clickable app (Windows `.exe` installer / macOS `.dmg`).

> **Status: validated end-to-end on both Windows and macOS** (mac: signed
> bundle launches from `/Applications`, sidecar boots, exiftool resolves, all
> after clearing quarantine — see the Gatekeeper section below). `npm run dev`
> is still the supported way to run PhotoCull day to day. **Build on the
> target OS** — electron-builder does not cross-compile the native Python
> sidecar, so build the macOS app on a Mac and the Windows app on Windows.
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
>
> Bugs found and fixed validating on macOS specifically:
> - `directories.output` was unset, defaulting to `apps/shell/dist` — the same
>   directory Vite's `build.outDir` writes to. Combined with `files: ["dist/**"]`,
>   every rebuild swept the *previous* build's output into the next `app.asar`
>   (confirmed: a 251 MB asar containing a nested `dist/mac-arm64/Electron.app`).
>   Fixed by setting `directories.output: "release"`.
> - `mac.identity: "-"` does **not** mean "ad-hoc sign" to electron-builder
>   24.13.3 — it searches the keychain for a literal identity named `-`, finds
>   none, and silently skips signing. `identity: null` plus a `packaging/afterSign.js`
>   hook (documented inline) that ad-hoc signs the assembled bundle after
>   packaging is what actually produces a signed, sealed `.app`.
> - exiftool was not bundled at all; macOS has no auto-download path (unlike
>   Windows), so XMP export hard-failed for anyone without Homebrew. Fixed —
>   see the exiftool section below.

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

The installer/dmg lands in `apps/shell/release/`.

## macOS: Gatekeeper

The mac build is **ad-hoc signed**, not signed with a Developer ID — real code
signing + notarization needs a paid Apple Developer ID, out of scope for a
personal build. `packaging/afterSign.js` runs after electron-builder assembles
the app and applies a real signature (`codesign --sign -`) over the whole
bundle; without this step the app has no signature at all over its assembled
contents, and macOS shows an unfixable "app is damaged" dialog for a
quarantined download rather than the normal bypassable one. Ad-hoc signing
gets you the normal one: a friend downloading the dmg needs to clear the
quarantine flag once —

```bash
xattr -dr com.apple.quarantine "/Applications/PhotoCull.app"
```

— or right-click the app → Open the first time and confirm the dialog.
Verify signing worked with `codesign -dv --verbose=4` (expect
`Identifier=com.photocull.app`, not `Identifier=Electron`, and
`Sealed Resources` populated, not `none`).

## Known sharp edges to expect on the first build

- **mediapipe** is the usual PyInstaller troublemaker — it ships graph data
  (`.binarypb` / `.tflite`) that must be collected. We pass `--collect-all
  mediapipe`; if face scoring fails in the packaged app with a missing-data
  error, that's the place to look.
- **rawpy** bundles the native libraw binary; `--collect-all rawpy` should pull
  it in, but verify RAW decode works in the packaged build.
- **exiftool** is bundled. `build-worker.sh`/`.ps1` stage a portable copy into
  `apps/worker/vendor/exiftool/` (downloaded from the exiftool.org release, or
  copied from a local Homebrew install as a fallback) and PyInstaller ships it
  under `resources/worker/_internal/exiftool/`. `photocull/models.py::find_exiftool()`
  checks PATH first (so a dev machine's own exiftool stays authoritative), then
  this bundled copy, so a packaged app needs no separate install on either OS.
- Face/RAW **model files** download to the user cache on first run — the
  packaged app needs internet the first time, same as the dev stack.
