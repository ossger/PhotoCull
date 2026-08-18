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
//     C           toggle compare mode (seeded from the selection)
//     F           toggle face / eye detection overlay
//     E           toggle auto eye-zoom loupe (snap to subject's eyes)
//     L           toggle "picks only" filter
//     R           enter crop mode
//     Shift+R     clear any saved crop
//     Esc         crop mode > compare mode > clear multi-selection, in that order
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
  const toggleFaces = useStore((s) => s.toggleFaces);
  const toggleEyeZoom = useStore((s) => s.toggleEyeZoom);
  const togglePicksOnly = useStore((s) => s.togglePicksOnly);
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
          moveScene(1);
          e.preventDefault();
          break;
        case "ArrowUp":
          moveScene(-1);
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
          togglePicksOnly();
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
          if (state.compareMode) {
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
    toggleFaces,
    toggleEyeZoom,
    togglePicksOnly,
    setPickMany,
    setStarsMany,
    enterCropMode,
    exitCropMode,
    applyCropDraft,
    clearCrop,
  ]);
}
