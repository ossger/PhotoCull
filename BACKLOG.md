# PhotoCull backlog

The running list of what's next for PhotoCull. New ideas go to the bottom of
**Next** or **Ideas**. Each open item has a matching GitHub issue. When an item
ships, move it to **Done** with the date and add a line to `CHANGELOG.md`.

## Now

- **Notarize and publish the Intel (x64) macOS build.** It's signed but blocked
  on moving the notarization credential into a keychain profile.
- **Rebuild arm64 for older macOS.** The published `v0.3.1` arm64 build
  effectively requires macOS 26, so set `mac.minimumSystemVersion` to the real
  floor once it's rebuilt.
- **Fix the shell lint gate.** `npm --workspace apps/shell run lint` calls
  `eslint`, but there's no ESLint dependency or config in the repo.

## Next

- **Windows x64 build:** signed installer and release.
- **Cloud vision scoring (optional, opt-in):** decide where an API key lives
  (keychain / user settings), then wire up Claude / Google Vision scoring.
- **CLIP smart scenes:** pick a model file and group scenes semantically.
- **Pop-out filmstrip performance on very large shoots.** A rating change re-sends
  the whole image list to the pop-out, so measure it and send diffs if needed.

## Ideas

- **Post-cull pipeline:** hand picks to Lightroom / Photoshop, then share edited
  exports (Instagram, Immich, a shared album for TV screens).
- Google Photos / iCloud as Import sources.

## Done

- 2026-10-05: **Zoom and pan in compare.** Each frame zooms and pans on its own,
  with optional synced zoom.
- 2026-10-05: **Compare starts with four frames** automatically instead of
  requiring manual selection.
- 2026-10-05: **Resizable filmstrip** that can be popped out into its own window.
- 2026-10-05: **Crop aspect defaults to Original.**
- 2026-10-04: **Sort into events** for flat card-dump folders.
