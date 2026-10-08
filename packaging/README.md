# Packaging PhotoCull

Producing a double-clickable app (Windows `.exe` installer / macOS `.dmg`).

> **Status: validated end-to-end on Windows and on macOS.** macOS arm64
> `v0.4.0` shipped 2026-10-08, signed + notarized, rebuilt on
> python-build-standalone (see "the minimum-OS trap"): measured floor **macOS
> 13.0**, `mac.minimumSystemVersion` pinned to match. The older `v0.3.1` arm64
> (2026-08-28) needs macOS 26. macOS **x64 (Intel)** `v0.3.1` is built and
> signed but not yet notarized or published (SD-0101).
> `npm run dist` finds the notary credential through the `photocull-notary`
> keychain profile; if the hook's probe misses it, set
> `APPLE_NOTARY_KEYCHAIN_PROFILE=photocull-notary`. `npm run dev` is still the
> supported way to run PhotoCull day to day.
>
> **Build on the target OS — with one exception.** electron-builder does not
> cross-compile the native Python sidecar, so the Windows app must be built on
> Windows. The **Intel macOS** app, however, *is* built on an Apple Silicon Mac,
> via an x86_64 interpreter under Rosetta — see "macOS: which architecture, and
> the minimum-OS trap" below. Read that section before building either macOS
> artifact: it also documents why the published arm64 `v0.3.1` silently
> requires macOS 26.
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
>   none, and silently skips signing. (Historical note: `identity: null` plus a
>   manual ad-hoc-signing hook was the original fix here. As of 2026-08-25 that's
>   been superseded by real Developer ID signing — see "macOS: Developer ID
>   signing + notarization" below — but the same ad-hoc fallback still runs
>   automatically on a Mac without the paid cert installed.)
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

## macOS: which architecture, and the minimum-OS trap

Two separate macOS artifacts ship: `-macOS-arm64` (Apple Silicon) and
`-macOS-x64` (Intel). Both are built **on the Mac** — Intel does not need an
Intel machine, but it does need care, because PyInstaller cannot cross-compile.

### Building the Intel (x64) artifact from an Apple Silicon Mac

The Electron half cross-builds fine; the **Python sidecar** is the whole
problem. It must be frozen by an actual x86_64 interpreter, run under Rosetta.

```bash
# 1. An x86_64 CPython, kept out of the machine's own toolchain.
#    python-build-standalone rather than Homebrew -- see "the minimum-OS trap".
curl -fsSLO https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14+20260901-x86_64-apple-darwin-install_only.tar.gz
tar -xzf cpython-3.12.14+20260901-x86_64-apple-darwin-install_only.tar.gz   # -> ./python

# 2. An x86_64 venv, driven under Rosetta throughout.
arch -x86_64 ./python/bin/python3.12 -m venv venv-x64

# 3. Dependencies. --only-binary is not optional: several packages have DROPPED
#    Intel macOS wheels (rawpy 0.26+ has none), and pip's fallback is a source
#    build that fails under Rosetta with "fatal error: 'fstream' file not
#    found". Forcing wheels makes pip backtrack to a version that still has one.
#    The pins are minimum-OS floors, explained below.
arch -x86_64 venv-x64/bin/python -m pip install \
    --only-binary=rawpy,mediapipe,onnxruntime,opencv-python-headless,opencv-contrib-python,numpy,pillow,scipy,jaxlib \
    "mediapipe==0.10.14" "opencv-python-headless==4.9.0.80" "opencv-contrib-python==4.9.0.80" \
    "onnxruntime<1.20" "scipy<1.14" "numpy<2" "rawpy>=0.20" \
    fastapi "uvicorn[standard]" pydantic Pillow piexif imagehash pyinstaller
arch -x86_64 venv-x64/bin/python -m pip install --no-deps -e apps/worker

# 4. Freeze with that venv on PATH, then package for x64.
arch -x86_64 env PATH="$PWD/venv-x64/bin:$PATH" bash packaging/build-worker.sh
cd apps/shell && npx electron-builder --mac --x64
```

> **`npm run dist -- --mac --x64` does not work.** The root `dist` script is
> `npm --workspace apps/shell run dist`, so npm consumes the extra arguments at
> the outer invocation and they never reach electron-builder, which then
> silently builds for the **host** architecture. The failure mode is nasty: an
> arm64 app wrapped around an x86_64 worker, which only breaks at sidecar
> spawn. Call `npx electron-builder --mac --x64` directly from `apps/shell`.

### Building the arm64 artifact

Use the same recipe with the `aarch64-apple-darwin` python-build-standalone
tarball, no Rosetta and no `arch -x86_64`, and the same pins. Do not freeze
with Homebrew's Python: that is what put `minos 26.0` into the published
`v0.3.1` arm64 build. After `npm run dist`, run the `minos` measurement above
and the sidecar `/health` check from inside the `.app`.

Building the two architectures back to back overwrites
`apps/worker/dist-bin/` — it is a single path with no arch suffix. Freeze,
package, then re-freeze for the other arch; never assume what is sitting there.

### The minimum-OS trap

**`LSMinimumSystemVersion` in the Info.plist is not the app's real minimum.**
The real minimum is the **highest `minos` load command across every bundled
Mach-O**, because dyld refuses to load a binary built for a newer OS than the
one running. Electron sets the plist to 10.15 and nothing validates it against
what the sidecar dragged in. A wrong value is invisible on the build machine —
which is always new enough — and shows up only as a broken sidecar on a user's
older Mac.

Measure it, don't assume it:

```bash
# highest minos anywhere in the bundle == the true floor
find PhotoCull.app -type f -perm +111 -exec sh -c \
  'otool -l "$1" 2>/dev/null | awk "/minos/{print \$2}"' _ {} \; | sort -V | tail -1
```

This caught a live bug on **2026-09-03**: `v0.3.1` arm64 — the published
download — measures **`minos 26.0`**. It was frozen with the Homebrew arm64
Python, whose dylibs are compiled against the host SDK, so 59 binaries
(`libmpdec`, `libpython`, …) demand macOS 26. That build effectively runs on
macOS 26 Tahoe and nothing older. **This is why the Intel recipe above uses
python-build-standalone**: its interpreter targets `minos 10.15`, leaving the
floor to the wheels, where it can be managed. Rebuild arm64 the same way.

With the pins above, the Intel floor is **macOS 13.0 Ventura**, set by:

| Package | Floor | Note |
|---|---|---|
| `mediapipe` 0.10.14 | **13.0** | the binding constraint; 0.10.13 is identical, 0.10.18+ is 14.6 |
| `opencv` 4.9.0.80 | 12.0 | 4.11 is 13.0 |
| `onnxruntime` 1.19.2 | 11.0 | 1.20+ jumps to 13.3 |
| `scipy` 1.13.1 | ≤12.0 | 1.17 is 14.0 |
| the interpreter | 10.15 | python-build-standalone |

**Monterey (12.x) is not reachable** while face scoring ships: every cp312
mediapipe wheel floors at 13.0. Dropping below it means dropping mediapipe, and
with it eyes-open and face scoring — a product decision, not a packaging one.

## macOS: Developer ID signing + notarization

**Status (2026-08-25): staged, not yet run.** Ross enrolled in the Apple
Developer Program and is awaiting approval. Everything below is ready to go —
the pipeline runs automatically as part of `npm run dist` once the
prerequisites exist on the build Mac. Until then (or on any Mac without the
cert), builds silently fall back to the ad-hoc-signed posture described in
"macOS: Gatekeeper" below — nothing breaks in the meantime.

**Prerequisites, once Apple approves (one-time, on the Mac):**

1. Install a **Developer ID Application** certificate into the login keychain:
   Xcode → Settings → Accounts → Manage Certificates → **+ → Developer ID
   Application** (or create it in the developer portal and download it).
2. Note the **Team ID** (developer portal → Membership).
3. Create an **app-specific password** at account.apple.com → Sign-In and
   Security → App-Specific Passwords, and store it as a **notarytool keychain
   profile**. The command prompts for the password, so it never touches an
   argv or a shell history:
   ```bash
   xcrun notarytool store-credentials photocull-notary \
       --apple-id "<your-apple-id>" --team-id "<team-id>"
   ```

**Then just build** — `./packaging/build-worker.sh && npm run dist`. No
credentials to export: `packaging/notary-auth.js` finds the `photocull-notary`
profile and both hooks use `--keychain-profile`. Override the profile name with
`APPLE_NOTARY_KEYCHAIN_PROFILE` if you keep more than one.

> **Never pass the password as `--password` on a command line.** The
> `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` env vars are
> still honoured as a fallback for CI, where there is no keychain, but on a
> real machine an argv leaks twice: it is visible in any process listing while
> the submission runs (this happened 2026-08-28), and Node reprints the entire
> failing command line — password included — when `notarytool` exits non-zero
> (this happened 2026-09-03, on an expired credential). `runNotary()` in
> `notary-auth.js` now scrubs that second path, but the profile avoids both.

Four hooks run automatically:

1. **`packaging/sign-worker.js`** (`afterPack`) — signs every Mach-O in the
   PyInstaller worker (`Contents/Resources/worker/`) inside-out with the
   Developer ID identity, since electron-builder's own signing walk doesn't
   reach `extraResources` content. Framework bundles (PyInstaller's own frozen
   `Python.framework`) sign as a bundle at their top-level `.framework` path,
   not as the bare Mach-O inside — signing the inner binary alone leaves
   `Info.plist`/`Resources` unsealed, which both `codesign --verify --deep
   --strict` and Apple's notary service reject. Verifies every signature it
   produces before returning, so a gap in the walk fails the build instead of
   surfacing later in a notary rejection log.
2. **electron-builder's own mac signing step** — signs the outer `.app` with
   the same identity, `hardenedRuntime: true`, and the entitlements in
   `packaging/entitlements.mac.plist` / `.inherit.plist` (see those files for
   what's granted and why — kept minimal).
3. **`packaging/notarize.js`** (`afterSign`) — zips the signed `.app`, submits
   it to Apple via `xcrun notarytool submit --wait`, and staples the ticket to
   the `.app` once accepted. (`mac.notarize` is explicitly `false` in
   `apps/shell/package.json` — this hook owns notarization directly rather
   than relying on electron-builder's built-in config, whose shape is
   version-sensitive and moved between electron-builder releases.)
4. **`packaging/notarize-dmg.js`** (`afterAllArtifactBuild`) — the `.app`
   notarized in step 3 is what runs once installed, but electron-builder
   builds the `.dmg` from it *after* that step, so the disk image itself —
   what a user actually downloads and double-clicks — is signed but never
   submitted to Apple on its own. This hook submits each built `.dmg` via
   `notarytool submit --wait` and staples the ticket directly to the disk
   image. Same env-var contract and skip-with-a-warning fallback as step 3.

**First attempt will likely reject** — several hundred nested binaries make it
easy to miss one. Read the rejection with:

```bash
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

It names the exact unsigned path; the fix is almost always in
`sign-worker.js`'s walk, not the entitlements.

**Verify the result** (on the built `.app`, and again on the `.dmg`):

```bash
codesign -dv --verbose=4 PhotoCull.app        # Authority=Developer ID Application: ...
codesign --verify --deep --strict --verbose=2 PhotoCull.app
xcrun stapler validate PhotoCull.app
spctl -a -vvv -t install PhotoCull.app        # accepted, source=Notarized Developer ID
```

Then the real gate: download the `.dmg` through a browser (so it actually
carries the quarantine bit), drag to Applications, **double-click**, and
confirm the app *and* the Python worker sidecar both come up — see
`vault\Pulse\_manual-steps.md` for why this can't be skipped.

**Version:** `v0.3.0` is already tagged and published — never reuse a version
number for different bytes. The first notarized build ships as `v0.3.1`, bumped
in the usual four places (see the root `README.md` "Releases" section) with a
`CHANGELOG.md` entry, before tagging.

## macOS: Gatekeeper

The mac build shipped through `v0.3.0` is **ad-hoc signed**, not signed with a
Developer ID. (Ross enrolled in the Apple Developer Program 2026-08-25; a
Developer ID + notarization pipeline is staged, see "macOS: Developer ID
signing + notarization" above — once it ships as `v0.3.1` this section stops
applying.) The ad-hoc signing itself is now the fallback branch of
`packaging/sign-worker.js` (an `afterPack` hook — it used to be a separate
`afterSign.js`, retired 2026-08-25): it applies a real signature
(`codesign --sign -`) over the whole assembled bundle; without that step the
app has no signature at all over its assembled contents, and macOS shows an
unfixable "app is damaged" dialog for a quarantined download rather than the
normal bypassable one.

Ad-hoc signing gets you the normal one, but "normal" changed on **macOS 15
Sequoia and later: the right-click → Open bypass no longer exists.** A
quarantined, ad-hoc-signed app now shows *"Apple could not verify ... is free
of malware"* with only **Move to Trash** and **Done** — no Open button at all.
The working path on Sequoia+ is:

1. Double-click the app. It will refuse to open — click **Done** (not Move to
   Trash).
2. Open **System Settings → Privacy & Security**, scroll to the **Security**
   section. You'll see *"PhotoCull.app was blocked..."* — click **Open
   Anyway**, then confirm with Touch ID/password.
3. **The "Open Anyway" button only appears for a limited time** (roughly an
   hour) after step 1. If it's not there, double-click the app again first,
   then go straight to System Settings.

Last resort, if that still doesn't work:

```bash
xattr -dr com.apple.quarantine "/Applications/PhotoCull.app"
```

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
