import { showImageMenu } from "../contextMenu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { CropRect, ImageRow } from "@shared/types";
import { useZoomPan, type SharedTransform } from "../useZoomPan";
import { CroppedImage } from "./CroppedImage";

// Same "all four fields or none" read as Loupe's cropRect.
function cropRectOf(image: ImageRow): CropRect | null {
  return image.crop_left != null &&
    image.crop_top != null &&
    image.crop_right != null &&
    image.crop_bottom != null
    ? { left: image.crop_left, top: image.crop_top, right: image.crop_right, bottom: image.crop_bottom }
    : null;
}

// The last transform published by the cell the user is driving, for sync zoom.
interface SyncedTransform {
  from: number; // image id of the publishing cell
  t: SharedTransform;
}

interface CellProps {
  image: ImageRow;
  syncZoom: boolean;
  // Which cell the user last touched (wheel / mouse-down). Only that cell
  // publishes under sync zoom, so mirrored cells never echo back.
  activeIdRef: React.MutableRefObject<number | null>;
  synced: SyncedTransform | null;
  onPublish: (from: number, t: SharedTransform) => void;
  onOpenInLoupe: () => void;
}

// One independently zoomable/pannable compare cell. Wired like Loupe: the
// saved crop is displayed (CroppedImage), and useZoomPan measures the crop's
// clipping box (boxRef) with the crop's pixel size as its natural size, so
// pan clamping and 1:1 respect the visible picture, not the uncropped frame.
function Cell({ image, syncZoom, activeIdRef, synced, onPublish, onOpenInLoupe }: CellProps) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const crop = cropRectOf(image);

  const displayNatural = useMemo(() => {
    if (!naturalSize) return null;
    if (!crop) return naturalSize;
    const cw = crop.right - crop.left;
    const ch = crop.bottom - crop.top;
    if (cw <= 0 || ch <= 0) return naturalSize;
    return { w: cw * naturalSize.w, h: ch * naturalSize.h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, crop?.left, crop?.top, crop?.right, crop?.bottom]);

  const zoom = useZoomPan(displayNatural);
  const zoomed = zoom.transform.scale > 1.01;

  const previewSrc = useMemo(
    () => (image.preview_path ? window.photocull.previewUrl(image.preview_path) : ""),
    [image.preview_path],
  );
  const fullSrc = useMemo(() => window.photocull.fullUrl(image), [image]);
  const visibleSrc = fullLoaded && fullSrc ? fullSrc : previewSrc;

  // Sync zoom, publishing side: the active cell broadcasts every change (and
  // its current view the moment sync is switched on).
  useEffect(() => {
    if (!syncZoom || activeIdRef.current !== image.id) return;
    const t = zoom.toShared();
    if (t) onPublish(image.id, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncZoom, zoom.transform, image.id]);

  // Receiving side: every other cell mirrors it. Re-applied once this cell's
  // picture has been laid out (displayNatural), so a cell added mid-sync
  // picks up the shared view as soon as it can be measured.
  useEffect(() => {
    if (!syncZoom || !synced || synced.from === image.id) return;
    zoom.applyShared(synced.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncZoom, synced, displayNatural, image.id]);

  const markActive = () => {
    activeIdRef.current = image.id;
  };

  const score = image.score_overall;
  const cursor = zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in";

  return (
    <div
      ref={zoom.containerRef}
      onWheelCapture={markActive}
      onMouseDownCapture={markActive}
      onWheel={zoom.onWheel}
      onMouseDown={zoom.onMouseDown}
      onContextMenu={(e) => {
        e.preventDefault();
        void showImageMenu(image.id);
      }}
      onDoubleClick={zoom.onDoubleClick}
      className={`relative bg-bg overflow-hidden min-h-0 min-w-0 select-none border border-line ${cursor}`}
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          transform: `translate(${zoom.transform.tx}px, ${zoom.transform.ty}px) scale(${zoom.transform.scale})`,
          transformOrigin: "center center",
          transition: zoom.transform.scale === 1 ? "transform 120ms ease-out" : "none",
          willChange: "transform",
        }}
      >
        {visibleSrc ? (
          <CroppedImage
            src={visibleSrc}
            alt={image.filename}
            crop={crop}
            sizeKey={image.id}
            className="w-full h-full"
            onNaturalSize={setNaturalSize}
            boxRef={zoom.boxRef}
            imgRef={zoom.imgRef}
          />
        ) : (
          <div className="text-muted">No preview</div>
        )}
      </div>

      {/* Full resolution is only fetched once the cell is zoomed in — four
          full-size decodes up front would stall entering compare. */}
      {zoomed && fullSrc && !fullLoaded && (
        <img
          src={fullSrc}
          alt=""
          decoding="async"
          onLoad={() => setFullLoaded(true)}
          style={{ display: "none" }}
        />
      )}

      <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-2 text-xs pointer-events-none">
        <span className="bg-black/60 px-2 py-0.5 rounded truncate max-w-[55%]" title={image.filename}>
          {image.filename}
        </span>
        <div className="flex items-center gap-1.5">
          {zoomed && (
            <span className="bg-black/60 px-2 py-0.5 rounded font-mono">
              {Math.round(zoom.transform.scale * 100)}%{fullLoaded ? "" : " …"}
            </span>
          )}
          {score != null && (
            <span className="bg-black/60 px-2 py-0.5 rounded font-mono">{score.toFixed(1)}</span>
          )}
          <button
            type="button"
            // Keep the button out of the cell's pan/zoom gestures.
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={onOpenInLoupe}
            className="pointer-events-auto bg-black/60 hover:bg-accent hover:text-black px-1.5 py-0.5 rounded
              transition-colors leading-none"
            title={`Open ${image.filename} in the loupe`}
            aria-label={`Open ${image.filename} in the loupe`}
          >
            {/* "expand" glyph */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M7 1h4v4M11 1L6.5 5.5M5 11H1V7M1 11l4.5-4.5" />
            </svg>
          </button>
        </div>
      </div>
      {image.pick === 1 && (
        <div className="absolute bottom-2 left-2 text-[10px] uppercase font-semibold tracking-wide bg-pick text-black px-1.5 py-0.5 rounded pointer-events-none">
          Pick
        </div>
      )}
      {image.pick === -1 && (
        <div className="absolute bottom-2 left-2 text-[10px] uppercase font-semibold tracking-wide bg-reject text-white px-1.5 py-0.5 rounded pointer-events-none">
          Reject
        </div>
      )}
    </div>
  );
}

export function CompareView() {
  const images = useStore((s) => s.images);
  const compareIds = useStore((s) => s.compareIds);
  const syncZoom = useStore((s) => s.compareSyncZoom);
  const toggleSyncZoom = useStore((s) => s.toggleCompareSyncZoom);
  const selectImage = useStore((s) => s.selectImage);
  const exitCompare = useStore((s) => s.exitCompare);

  const activeIdRef = useRef<number | null>(null);
  const [synced, setSynced] = useState<SyncedTransform | null>(null);

  const picked = compareIds
    .map((id) => images.find((i) => i.id === id))
    .filter((i): i is ImageRow => i != null);

  // Turning sync on before touching any cell: the first cell leads. Set
  // during render (not an effect) because the cells' publish effects run
  // before this component's own effects would.
  if (syncZoom && (activeIdRef.current == null || !compareIds.includes(activeIdRef.current))) {
    activeIdRef.current = picked[0]?.id ?? null;
  }

  // Drop the last shared view when sync goes off, so switching it back on
  // starts from whichever cell leads then rather than a stale transform.
  useEffect(() => {
    if (!syncZoom) setSynced(null);
  }, [syncZoom]);

  const onPublish = useCallback((from: number, t: SharedTransform) => {
    setSynced({ from, t });
  }, []);

  if (picked.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-muted gap-2 bg-bg">
        <div>Compare mode — nothing to compare yet.</div>
        <div className="text-xs">
          Click frames in the filmstrip to add up to 4, or press C on a frame to compare it with the
          three after it. Esc to exit.
        </div>
      </div>
    );
  }

  // 1 image → single, 2 → side-by-side, 3 or 4 → 2x2 grid
  const grid =
    picked.length === 1
      ? "grid-cols-1 grid-rows-1"
      : picked.length === 2
        ? "grid-cols-2 grid-rows-1"
        : "grid-cols-2 grid-rows-2";

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      <div className="px-2 py-1 flex items-center justify-between gap-2 text-xs text-muted border-b border-line bg-panel">
        <span>
          Comparing {picked.length} {picked.length === 1 ? "frame" : "frames"} · scroll to zoom,
          drag to pan, double-click for 1:1
        </span>
        <button
          type="button"
          onClick={toggleSyncZoom}
          className={`rounded px-1.5 py-0.5 border transition-colors ${
            syncZoom ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
          }`}
          title="Mirror one frame's zoom and pan onto the others (L)"
          aria-pressed={syncZoom}
        >
          Sync zoom {syncZoom ? "on" : "off"}
        </button>
      </div>
      <div className={`flex-1 min-h-0 grid ${grid} gap-1 p-1`}>
        {picked.map((img) => (
          <Cell
            key={img.id}
            image={img}
            syncZoom={syncZoom}
            activeIdRef={activeIdRef}
            synced={synced}
            onPublish={onPublish}
            onOpenInLoupe={() => {
              selectImage(img.id);
              exitCompare();
            }}
          />
        ))}
      </div>
    </div>
  );
}
