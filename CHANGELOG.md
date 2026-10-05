# Changelog

All notable changes to PhotoCull. Versions correspond to git tags (`v0.3.0`, …).

## Unreleased

- **Sort into events.** A new toolbar action splits a flat card-dump folder into
  `YYYY-MM-DD Name` subfolders, one per event, wherever there's a gap between
  shots longer than an adjustable threshold (default 3 h). You get a preview with
  thumbnails, typed names, and merge/skip controls before anything moves.
  RAW+JPEG pairs, sidecars and videos move together, nothing is ever overwritten,
  and the last sort can be undone. Each sorted event opens straight into a cull.
- The folder picker now takes a per-use title instead of always saying "Open shoot folder".
- **Zoom and pan in compare.** Each compared frame now zooms on its own: scroll
  to zoom toward the cursor, drag to pan, double-click for fit / 1:1, honouring
  any saved crop. Full resolution loads once you zoom in. Clicking a frame no
  longer leaves compare. Each frame has an **Open in loupe** button instead.
  **Sync zoom** (toolbar toggle, or `L` while comparing) mirrors one frame's
  zoom and pan onto the others. It is off by default.
- **Compare starts with four frames.** Pressing `C` with a single frame selected
  now compares it with the next three in the filmstrip's order (or the frames
  before it near the end of a scene). A multi-selection of two or more is still
  compared as-is.
- **Resizable, pop-out filmstrip.** Drag the filmstrip's top edge or use its size
  slider to scale the thumbnails. The size is remembered. **Pop out** moves the
  filmstrip into its own window as a wrapping, scalable thumbnail grid. Clicks,
  multi-select, compare and rating hotkeys there act on the main window.
  Closing that window (or **Dock**) puts the strip back. The window's position
  and size are remembered.
- **Crop defaults to Original aspect.** Crop mode now opens locked to the frame's
  own aspect ratio. Re-editing a saved crop of another shape keeps that shape:
  the matching preset is selected, or Free if none matches.

## 0.3.1 — 2026-08-25

No app changes — same feature set as 0.3.0. The macOS build is now signed with
a Developer ID Application certificate and notarized by Apple, replacing the
ad-hoc signature 0.3.0 shipped with. macOS 15 Sequoia removed the right-click →
Open bypass ad-hoc signing depended on, so a plain double-click is again enough
to open a freshly downloaded `.dmg` — no System Settings detour required.

## 0.3.0 — 2026-08-24

First publicly released version — same feature set as 0.2.0, bumped for a clean,
unambiguous version to ship. Packaged artifacts now use consistent, URL-safe names
(`PhotoCull-<version>-<platform>-<arch>.<ext>`).

## 0.2.0 — 2026-08-21

- **Advanced culling filters.** A full criteria builder over score ranges (focus /
  exposure / eyes / aesthetic / overall), scene-level aggregates, pick/stars/color/
  crop/faces, camera and lens metadata, orientation, capture time, filename search,
  and scene frame count — match-all or match-any. Six one-click presets (Keepers,
  Technically clean, Needs a look, Blinks & misses, Unreviewed, Rejects).
- A new **Matches** view flattens the whole shoot into one filtered, ranked list
  across scene boundaries, with **Export matches** alongside Export picks.
- New hotkeys: `/` (search), `Shift+L` (picks filter), `M` (matches scope).
- **Loupe crop-zoom + face-overlay fix** (2026-08-23, folded into this release): with
  a saved crop active, zoom/pan and eye-zoom auto-snap now measure against the
  visible cropped picture instead of the full frame, and the face overlay clips to
  the crop instead of drawing outside it. Compare-view thumbnails also honor a saved
  crop now.
- macOS `.dmg` packaging validated: the assembled app is ad-hoc signed so Gatekeeper
  shows the normal, bypassable "unidentified developer" prompt instead of an
  unfixable "damaged" dialog. See the install instructions on the download page for
  the one-time step this requires.

## 0.1.0 — 2026-08-21

- Grid view with marquee multi-select and batch pick/star/color.
- Picks-only and minimum-star filters; RAW+JPEG dedupe on ingest (RAW is kept as the
  canonical file).
- First validated cross-platform packaging pipeline (Windows + macOS).

## Phase 3 baseline — 2026-07 and earlier

- Ingest (RAW + JPEG + HEIC, deduped), automatic scene grouping, local offline
  scoring (focus, exposure, faces/eyes-open, camera AF metadata, aesthetic
  heuristic), crop overlay, and XMP sidecar export for Lightroom / Capture One.
- In-app Import flow; standalone `organize` command for sorting card dumps into a
  dated library.
