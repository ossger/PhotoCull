# Packaging PhotoCull

Producing a double-clickable app (Windows `.exe` installer / macOS `.dmg`).

> **Status: validated end-to-end on Windows; macOS validated through `v0.3.0`
> (ad-hoc signing), pipeline changed 2026-08-25 for Developer ID + notarization
> and not yet re-run on a Mac** — see "macOS: Developer ID signing +
> notarization" below; the ad-hoc fallback it also implements (for a Mac
> without the cert) is a straight port of the old behaviour but likewise
> unverified since the change. `npm run dev` is still the supported way to run
> PhotoCull day to day. **Build on the target OS** — electron-builder does not
> cross-compile the native Python sidecar, so build the macOS app on a Mac and
> the Windows app on Windows.
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
   Security → App-Specific Passwords, and store it in the keychain rather than
   typing it each time:
   ```bash
   security add-generic-password -s photocull-notary -a "<your-apple-id>" -w
   ```

**Before building**, export the three credentials `packaging/notarize.js`
reads (pulling the password back out of the keychain item above, never typed
or committed in plaintext):

```bash
export APPLE_ID="<your-apple-id>"
export APPLE_TEAM_ID="<team-id>"
export APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -s photocull-notary -a "$APPLE_ID" -w)"
```

Then build exactly as in "Build steps" above (`./packaging/build-worker.sh &&
npm run dist`) — no separate command. Three hooks now run automatically:

1. **`packaging/sign-worker.js`** (`afterPack`) — signs every Mach-O in the
   PyInstaller worker (`Contents/Resources/worker/`) inside-out with the
   Developer ID identity, since electron-builder's own signing walk doesn't
   reach `extraResources` content.
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
