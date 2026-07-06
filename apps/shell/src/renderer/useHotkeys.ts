import { useEffect } from "react";
import { useStore } from "./store";

// Hotkeys.
//   Outside crop mode:
//     ← / →   navigate within the current scene
//     ↑ / ↓   move between scenes
//     P / X   pick / reject
//     U       unset pick
//     0-5     star rating
//     C       toggle compare mode (multi-select inside the scene)
//     F       toggle face / eye detection overlay
//     E       toggle auto eye-zoom loupe (snap to subject's eyes)
//     L       toggle "picks only" filter
//     R       enter crop mode
//     Shift+R clear any saved crop
//     Esc     exit compare mode
//   Inside crop mode:
//     Enter   apply
//     Esc     cancel
//     Shift+R clear crop
export function useHotkeys() {
  const moveImage = useStore((s) => s.moveImage);
  const moveScene = useStore((s) => s.moveScene);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const exitCompare = useStore((s) => s.exitCompare);
  const toggleFaces = useStore((s) => s.toggleFaces);
  const toggleEyeZoom = useStore((s) => s.toggleEyeZoom);
  const togglePicksOnly = useStore((s) => s.togglePicksOnly);
  const setPick = useStore((s) => s.setPick);
  const setStars = useStore((s) => s.setStars);
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
          moveImage(1);
          e.preventDefault();
          break;
        case "ArrowLeft":
        case "k":
          moveImage(-1);
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
          exitCompare();
          break;
        case "p":
        case "P":
          if (id != null) await setPick(id, 1);
          break;
        case "x":
        case "X":
          if (id != null) await setPick(id, -1);
          break;
        case "u":
        case "U":
          if (id != null) await setPick(id, 0);
          break;
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          if (id != null) await setStars(id, Number(e.key));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    moveImage,
    moveScene,
    toggleCompare,
    exitCompare,
    toggleFaces,
    toggleEyeZoom,
    togglePicksOnly,
    setPick,
    setStars,
    enterCropMode,
    exitCropMode,
    applyCropDraft,
    clearCrop,
  ]);
}
