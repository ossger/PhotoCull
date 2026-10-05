import { useEffect } from "react";
import { useStore, sceneImages } from "../store";
import { usePersistentNumber } from "../usePersistentNumber";
import { SizeSlider, ThumbStrip } from "./ThumbStrip";

// The torn-off filmstrip window (renderer loaded with #filmstrip): a
// full-window, wrapping, scalable thumbnail grid. Its store is a mirror of
// the main window's, and its actions/keys are forwarded there — see
// filmstripSync.ts. Closing the window (or Dock) docks the strip back.

const SIZE_KEY = "photocull.popoutThumbSize";
const MIN = 64;
const MAX = 400;

export function FilmstripWindow() {
  const [size, setSize] = usePersistentNumber(SIZE_KEY, 160, MIN, MAX);
  const shootRoot = useStore((s) => s.shootRoot);
  const count = useStore((s) => sceneImages(s).length);
  const compareMode = useStore((s) => s.compareMode);
  const sceneLabel = useStore((s) => {
    if (s.viewScope === "matches") return "Matches";
    const scene = s.scenes.find((sc) => sc.id === s.selectedSceneId);
    return scene ? (scene.label ?? `Scene ${scene.id}`) : null;
  });

  useEffect(() => {
    document.title = sceneLabel ? `Filmstrip — ${sceneLabel}` : "PhotoCull — Filmstrip";
  }, [sceneLabel]);

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="h-8 px-3 flex items-center justify-between gap-3 text-xs text-muted border-b border-line bg-panel">
        <span className="truncate">
          {sceneLabel ?? "Filmstrip"}
          {count > 0 ? ` · ${count} ${count === 1 ? "frame" : "frames"}` : ""}
          {compareMode ? " · compare: click to add/remove" : ""}
        </span>
        <div className="flex items-center gap-3">
          <SizeSlider value={size} min={MIN} max={MAX} onChange={setSize} />
          <button
            type="button"
            onClick={() => void window.photocull.dockFilmstrip()}
            className="rounded px-1.5 py-0.5 border border-line hover:text-ink"
            title="Close this window and dock the filmstrip back in the main window"
          >
            Dock
          </button>
        </div>
      </div>
      {shootRoot == null ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-muted text-sm">
          Open a shoot in the main window.
        </div>
      ) : (
        <ThumbStrip layout="grid" size={size} />
      )}
      <div className="px-3 py-1 text-[11px] text-muted border-t border-line bg-panel2">
        Hotkeys work here too — P / X / U, 0–5, ← / →, C compare, Esc.
      </div>
    </div>
  );
}
