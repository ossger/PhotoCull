import { useEffect } from "react";
import { useStore } from "./store";

// Hotkeys.
//   Outside crop mode:
//     ← / →       navigate within the current scene
//     Shift+← / → extend the range selection
//     ↑ / ↓       move between scenes
//     ⌘/Ctrl+A    select all frames in the current scene
//     P / X       pick / reject (applies to the whole selection)
//     U           unset pick (applies to the whole selection)
//     0-5         star rating (applies to the whole selection)
//     G           toggle grid view / loupe
//     C           toggle compare mode — seeded from a 2+ multi-selection,
//                 else the current frame plus the next three in the scene
//     F           toggle face / eye detection overlay
//     E           toggle auto eye-zoom loupe (snap to subject's eyes)
//     L           toggle a quick "picks only" filter
//                 (in compare mode: toggle sync zoom across the compared frames)
//     Shift+L     clear all advanced filters
//     /           toggle the advanced filter panel
//     M           toggle Scenes / Matches (flattened, filtered shoot-wide list)
//     R           enter crop mode
//     Shift+R     clear any saved crop
//     Esc         crop mode > compare mode > clear multi-selection, in that order
//   Inside compare mode, per frame (mouse, see CompareView): wheel zoom,
//   drag pan, double-click fit / 1:1; the frame's expand button opens it in
//   the loupe.
//   Inside crop mode:
//     Enter   apply
//     Esc     cancel
//     Shift+R clear crop
export function useHotkeys() {
  const moveImage = useStore((s) => s.moveImage);
  const moveScene = useStore((s) => s.moveScene);
  const selectAllInScene = useStore((s) => s.selectAllInScene);
  const clearSelection = useStore((s) => s.clearSelection);
  const toggleViewMode = useStore((s) => s.toggleViewMode);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const exitCompare = useStore((s) => s.exitCompare);
  const toggleCompareSyncZoom = useStore((s) => s.toggleCompareSyncZoom);
  const toggleFaces = useStore((s) => s.toggleFaces);
  const toggleEyeZoom = useStore((s) => s.toggleEyeZoom);
  const setFilters = useStore((s) => s.setFilters);
  const clearFilters = useStore((s) => s.clearFilters);
  const toggleFilterPanel = useStore((s) => s.toggleFilterPanel);
  const setViewScope = useStore((s) => s.setViewScope);
  const setPickMany = useStore((s) => s.setPickMany);
  const setStarsMany = useStore((s) => s.setStarsMany);
  const enterCropMode = useStore((s) => s.enterCropMode);
  const exitCropMode = useStore((s) => s.exitCropMode);
  const applyCropDraft = useStore((s) => s.applyCropDraft);
  const clearCrop = useStore((s) => s.clearCrop);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const state = useStore.getState();
      // A modal panel owns the keyboard; P/X/1-5 must not cull frames behind it.
      if (state.stackPanelIds != null) return;
      const id = state.selectedImageId;
      // Pick/reject/star hotkeys apply to the whole multi-selection when
      // there is one, falling back to just the primary frame.
      const targetIds = state.selectedIds.length > 0 ? state.selectedIds : id != null ? [id] : [];

      // Crop mode steals most keys
      if (state.cropMode) {
        if (e.key === "Enter") {
          e.preventDefault();
          await applyCropDraft();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          exitCropMode();
          return;
        }
        if ((e.key === "r" || e.key === "R") && e.shiftKey) {
          e.preventDefault();
          await clearCrop();
          return;
        }
        // Swallow remaining keys to avoid star-rating while cropping
        return;
      }

      switch (e.key) {
        case "ArrowRight":
        case "j":
          moveImage(1, e.shiftKey);
          e.preventDefault();
          break;
        case "ArrowLeft":
        case "k":
          moveImage(-1, e.shiftKey);
          e.preventDefault();
          break;
        case "ArrowDown":
          moveScene(1, e.shiftKey);
          e.preventDefault();
          break;
        case "ArrowUp":
          moveScene(-1, e.shiftKey);
          e.preventDefault();
          break;
        case "a":
        case "A":
          if (e.metaKey || e.ctrlKey) {
            selectAllInScene();
            e.preventDefault();
          }
          break;
        case "g":
        case "G":
          toggleViewMode();
          e.preventDefault();
          break;
        case "c":
        case "C":
          toggleCompare();
          break;
        case "f":
        case "F":
          toggleFaces();
          e.preventDefault();
          break;
        case "e":
        case "E":
          toggleEyeZoom();
          e.preventDefault();
          break;
        case "l":
        case "L":
          if (e.shiftKey) {
            clearFilters();
          } else if (state.compareMode) {
            toggleCompareSyncZoom();
          } else {
            // Quick toggle: picked-only, layered onto whatever else is set.
            const isPicksOnly =
              state.filters.picks.length === 1 && state.filters.picks[0] === "picked";
            setFilters({ ...state.filters, picks: isPicksOnly ? [] : ["picked"] });
          }
          e.preventDefault();
          break;
        case "/":
          toggleFilterPanel();
          e.preventDefault();
          break;
        case "?":
          state.setShortcutsOpen(!state.shortcutsOpen);
          e.preventDefault();
          break;
        case "m":
        case "M":
          setViewScope(state.viewScope === "matches" ? "scenes" : "matches");
          e.preventDefault();
          break;
        case "r":
        case "R":
          if (e.shiftKey) {
            await clearCrop();
          } else {
            enterCropMode();
          }
          e.preventDefault();
          break;
        case "Escape":
          // Precedence: crop mode (handled above, returns early) > compare
          // mode > clear a multi-selection.
          if (state.shortcutsOpen) {
            state.setShortcutsOpen(false);
          } else if (state.compareMode) {
            exitCompare();
          } else {
            clearSelection();
          }
          break;
        case "p":
        case "P":
          if (targetIds.length) await setPickMany(targetIds, 1);
          break;
        case "x":
        case "X":
          if (targetIds.length) await setPickMany(targetIds, -1);
          break;
        case "u":
        case "U":
          if (targetIds.length) await setPickMany(targetIds, 0);
          break;
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          if (targetIds.length) await setStarsMany(targetIds, Number(e.key));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    moveImage,
    moveScene,
    selectAllInScene,
    clearSelection,
    toggleViewMode,
    toggleCompare,
    exitCompare,
    toggleCompareSyncZoom,
    toggleFaces,
    toggleEyeZoom,
    setFilters,
    clearFilters,
    toggleFilterPanel,
    setViewScope,
    setPickMany,
    setStarsMany,
    enterCropMode,
    exitCropMode,
    applyCropDraft,
    clearCrop,
  ]);
}
