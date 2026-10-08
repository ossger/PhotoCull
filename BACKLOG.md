# PhotoCull backlog

The running list of what's next for PhotoCull. New ideas go to the bottom of
**Next** or **Ideas**. Each open item has a matching GitHub issue. When an item
ships, move it to **Done** with the date and add a line to `CHANGELOG.md`.

## Now

- [#1](https://github.com/ossger/PhotoCull/issues/1) **Notarize and publish the Intel (x64) macOS build.** It's signed but blocked
  on moving the notarization credential into a keychain profile.
- [#2](https://github.com/ossger/PhotoCull/issues/2) **Rebuild arm64 for older macOS.** Rebuilt as `v0.4.0` on a
  python-build-standalone interpreter (floor now macOS 13.0, pinned in
  `mac.minimumSystemVersion`); waiting on notarization and publish.
- [#3](https://github.com/ossger/PhotoCull/issues/3) **Fix the shell lint gate.** `npm --workspace apps/shell run lint` calls
  `eslint`, but there's no ESLint dependency or config in the repo.

## Next

- [#4](https://github.com/ossger/PhotoCull/issues/4) **Windows x64 build:** signed installer and release.
- [#5](https://github.com/ossger/PhotoCull/issues/5) **Cloud vision scoring (optional, opt-in):** decide where an API key lives
  (keychain / user settings), then wire up Claude / Google Vision scoring.
- [#6](https://github.com/ossger/PhotoCull/issues/6) **CLIP smart scenes:** pick a model file and group scenes semantically.
- [#7](https://github.com/ossger/PhotoCull/issues/7) **Pop-out filmstrip performance on very large shoots.** A rating change re-sends
  the whole image list to the pop-out, so measure it and send diffs if needed.

## Ideas

- **Star stacking, next:** try it on real RAW sequences and tune the thresholds;
  a brush to correct the foreground mask; local (grid) warp for very long
  sequences or wide lenses; dark-frame subtraction; star-tracker (fixed-sky)
  sequences.
- [#8](https://github.com/ossger/PhotoCull/issues/8) **Post-cull pipeline:** hand picks to Lightroom / Photoshop, then share edited
  exports (Instagram, Immich, a shared album for TV screens).
- Google Photos / iCloud as Import sources.

## Done

- 2026-10-07: **Star stacking** for untracked tripod sequences: detection,
  per-frame cull recommendations, and an in-app stacker (16-bit TIFF).
  Not yet run on real RAW sequences, only synthetic ones.
- 2026-10-07: **Top bar regrouped**, with a native File/View menu, a status bar,
  and a `?` shortcuts sheet.
- 2026-10-05: **Zoom and pan in compare.** Each frame zooms and pans on its own,
  with optional synced zoom.
- 2026-10-05: **Compare starts with four frames** automatically instead of
  requiring manual selection.
- 2026-10-05: **Resizable filmstrip** that can be popped out into its own window.
- 2026-10-05: **Crop aspect defaults to Original.**
- 2026-10-04: **Sort into events** for flat card-dump folders.
