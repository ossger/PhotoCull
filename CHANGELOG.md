# Changelog

All notable changes to PhotoCull. Versions correspond to git tags (`v0.3.0`, …).

## 0.4.1 — 2026-10-09

- **Fixed: the C key flashed Compare and immediately closed it on macOS.** The
  keypress reached both the hotkey handler and the View ▸ Compare menu item, so
  compare toggled twice. The hotkey now consumes the key, and menu items that
  only display a plain-letter shortcut ignore keyboard-triggered clicks.
- **Fixed: photos missing after opening a folder.** Ingest reported "complete"
  before scenes were grouped, so the last refresh could miss frames that hadn't
  been assigned a scene yet. An ingest left over from a previous open could also
  end the new one early. Files that can't be read are now counted in the status
  bar instead of silently skipped, and an ingest crash shows an error.
- **Fixed: eye-zoom snapped back after you zoomed out.** When the full-resolution
  image finished loading it re-applied the eye zoom over your own zoom. The
  zoom chip now says "Eye zoom" when E caused it, and tiny faces with no
  detected eyes (usually false hits on scenery) no longer trigger it.
- **Hardened: loupe image sizing on frame switch.** A stale full-res load flag
  or a late image-load event could size the picture from the previous frame.
- **Fixed: opening a second folder mid-ingest.** The first folder's ingest is
  now cancelled and drained before the new one starts, instead of silently
  decoding on in the background (or fighting the new run over the same
  database). Progress updates are atomic, so the status bar can no longer show
  a mix of two folders, or "complete" without the unreadable-file count.
- **Fixed: ingest counts.** The status bar reports images actually ingested
  (previously unreadable files were counted too), lists unreadable files by
  folder path, notes when the list is truncated, and no longer shows the count
  going backwards while scenes group.
- **Fixed: eye-zoom stays put on a click, and tiny faces count.** Only a real
  drag or a zoom after the frame has loaded takes the view away from eye-zoom;
  small faces with no eye points (group shots) are no longer filtered out. A
  late full-res load from the previous frame can no longer blank the next one.
- **Fixed: menu shortcuts outside the main window** (e.g. the popped-out
  filmstrip) work again, and a programmatic menu click no longer throws.
- **Housekeeping:** eslint is installed and configured (the lint gate now
  runs), `react-window` removed, ruff rule set pinned in `pyproject.toml`,
  fire-and-forget worker tasks kept referenced, lockfile version synced.

## 0.4.0 — 2026-10-08

Star stacking, a regrouped top bar with a native menu, scene editing, and a
compare/filmstrip overhaul. The Apple Silicon build is rebuilt so it runs on
macOS 13 Ventura or newer (0.3.1 effectively required macOS 26).

- **Star stacking.** Untracked, tripod star sequences (long exposures shot back
  to back with the same settings) are detected on open and kept together as one
  ✦ scene. Right-click a star scene, or select its frames, and choose **Stack
  stars…**. PhotoCull measures stars in every frame (count, sharpness, roundness,
  sky brightness, satellite streaks) against the sequence's own median and
  recommends which frames to leave out: cloud or haze, soft or shaken frames,
  light creeping into the sky. You can override every call and, if you like,
  reject the left-out frames in your cull. It then aligns the sky on the middle
  frame, sigma-clips out satellites and hot pixels, keeps the landscape still
  (an automatic sky/foreground mask), and writes a 16-bit TIFF to `Stacks/` beside
  your shoot. Your originals are never changed. Mark a scene by hand with
  "Mark as star sequence" if detection misses one.
- **Cleaner top bar and a real menu.** The bar now reads left to right: the shoot
  name and an Open menu, the view switches (Grid / Loupe / Compare, Scenes /
  Matches), then Sort, Filter, Eyes, and a single Export button with matches and
  selection under its arrow. The File and View menus carry everything else, with
  ⌘O, ⌘I and ⌘E. Status and ingest progress moved to a bottom bar, the multi-select
  Pick/Reject/Unset actions to a bar above the filmstrip, and the long hint line
  to a `?` shortcuts sheet. The window title shows the open shoot.
- **Zoom while cropping.** Scroll or pinch to zoom the picture under the crop
  box. Pan with Space+drag or middle-drag, and press Z to flip between fit and 100%.
- **Multi-select scenes.** ⌘/Ctrl-click and Shift-click pick several scenes in
  the sidebar (Shift+↑/↓ extends), and the filmstrip and grid show their
  frames together, so a pick, reject, or rating applies across all of them.
- **Right-click menus** for photos, scenes, the loupe, compare cells and the
  crop box. The items change with what's selected: bulk pick/reject/rating/color,
  compare, move to scene, export XMP for the selection, and more.
- **Edit scenes by hand:** merge, split at a frame, rename, set the cover, and
  move photos between scenes. Edits survive re-ingest; "Reset to automatic
  grouping" undoes them.

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
