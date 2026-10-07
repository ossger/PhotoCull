import { useEffect } from "react";
import { sceneImages, useStore } from "./store";

// Maps native-menu item ids (see buildAppMenu in main.ts) onto store actions.
// Mounted once, in the main window only.
export function useMenuActions() {
  useEffect(() => {
    return window.photocull.onMenuAction((id) => {
      const s = useStore.getState();
      switch (id) {
        case "file:open":
          void s.openFolder();
          break;
        case "file:import":
          s.setImportOpen(true);
          break;
        case "file:sortEvents":
          s.setEventSortOpen(true);
          break;
        case "file:stackStars":
          s.openStackPanel();
          break;
        case "file:exportPicks":
          void s.exportPicks();
          break;
        case "file:exportMatches":
          void s.exportMatches();
          break;
        case "file:exportSelection": {
          const ids =
            s.selectedIds.length > 0
              ? s.selectedIds
              : s.selectedImageId != null
                ? [s.selectedImageId]
                : sceneImages(s).map((i) => i.id);
          void s.exportImageIds(ids);
          break;
        }
        case "view:toggleGrid":
          s.toggleViewMode();
          break;
        case "view:compare":
          s.toggleCompare();
          break;
        case "view:toggleScope":
          s.setViewScope(s.viewScope === "matches" ? "scenes" : "matches");
          break;
        case "view:sortRank":
          s.setSortMode("rank");
          break;
        case "view:sortTime":
          s.setSortMode("time");
          break;
        case "view:eyeZoom":
          s.toggleEyeZoom();
          break;
        case "view:faces":
          s.toggleFaces();
          break;
        case "view:filters":
          s.toggleFilterPanel();
          break;
        case "view:popOut":
          void window.photocull.popOutFilmstrip();
          break;
        case "help:shortcuts":
          s.setShortcutsOpen(!s.shortcutsOpen);
          break;
      }
    });
  }, []);
}
