import { useRef } from "react";
import { useStore, sceneImages } from "../store";
import { usePersistentNumber } from "../usePersistentNumber";
import { SizeSlider, ThumbStrip } from "./ThumbStrip";

// Docked filmstrip: a resizable row of thumbnails under the loupe. Drag the
// top edge (or use the header slider) to resize; thumbnail width follows the
// height. "Pop out" tears it off into its own window (FilmstripWindow), in
// which case this collapses to a one-line placeholder with a Dock button.

const SIZE_KEY = "photocull.filmstripSize";
export const FILMSTRIP_MIN = 64;
export const FILMSTRIP_MAX = 320;
const FILMSTRIP_DEFAULT = 128; // the strip's original fixed h-36 / w-32 look

export function Filmstrip() {
  const poppedOut = useStore((s) => s.filmstripPoppedOut);
  const count = useStore((s) => sceneImages(s).length);
  const [size, setSize] = usePersistentNumber(SIZE_KEY, FILMSTRIP_DEFAULT, FILMSTRIP_MIN, FILMSTRIP_MAX);
  const dragRef = useRef<{ startY: number; startSize: number } | null>(null);

  if (poppedOut) {
    return (
      <div className="px-3 py-1 flex items-center justify-between text-xs text-muted border-t border-line bg-panel">
        <span>Filmstrip is open in its own window.</span>
        <button
          type="button"
          onClick={() => void window.photocull.dockFilmstrip()}
          className="rounded px-1.5 py-0.5 border border-line hover:text-ink"
          title="Close the filmstrip window and dock it back here"
        >
          Dock
        </button>
      </div>
    );
  }

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startSize: size };
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // Dragging the top edge up grows the strip.
    setSize(d.startSize + (d.startY - e.clientY));
  };
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="relative flex flex-col border-t border-line bg-panel">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize filmstrip"
        title="Drag to resize the filmstrip"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onDoubleClick={() => setSize(FILMSTRIP_DEFAULT)}
        className="absolute left-0 right-0 -top-1 h-2 z-10 cursor-ns-resize hover:bg-accent/40 transition-colors"
      />
      <div className="h-6 px-2 flex items-center justify-between gap-3 text-[11px] text-muted border-b border-line/60">
        <span className="uppercase tracking-wide">
          Filmstrip{count > 0 ? ` · ${count}` : ""}
        </span>
        <div className="flex items-center gap-3">
          <SizeSlider value={size} min={FILMSTRIP_MIN} max={FILMSTRIP_MAX} onChange={setSize} />
          <button
            type="button"
            onClick={() => void window.photocull.popOutFilmstrip()}
            className="rounded px-1.5 leading-4 border border-line hover:text-ink"
            title="Open the filmstrip in its own window"
          >
            Pop out
          </button>
        </div>
      </div>
      <ThumbStrip layout="row" size={size} />
    </div>
  );
}
