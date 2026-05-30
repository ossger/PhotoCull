import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useZoomPan } from "../useZoomPan";
import { CropOverlay } from "./CropOverlay";

function StarRow({ stars }: { stars: number }) {
  return (
    <div className="text-yellow-400 text-base tracking-widest">
      {"★".repeat(stars)}
      <span className="text-line">{"★".repeat(5 - stars)}</span>
    </div>
  );
}

function ScoreChip({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  const tier =
    value >= 7 ? "text-pick" : value >= 4 ? "text-yellow-300" : "text-reject";
  return (
    <span className="text-xs text-muted">
      {label}{" "}
      <span className={`font-mono font-semibold ${tier}`}>{value.toFixed(1)}</span>
    </span>
  );
}

export function Loupe() {
  const image = useStore((s) =>
    s.selectedImageId == null
      ? null
      : s.images.find((i) => i.id === s.selectedImageId) ?? null,
  );
  const cropMode = useStore((s) => s.cropMode);

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  // Live bounding box of the displayed image (post-object-contain) so the crop
  // overlay knows where to draw. Recomputed when the image or layout changes.
  const [imageBox, setImageBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const fullPreloaderRef = useRef<HTMLImageElement>(null);
  const containerInnerRef = useRef<HTMLDivElement>(null);

  const zoom = useZoomPan(naturalSize);

  // Reset zoom + full-loaded + crop draft state whenever the selected image changes.
  useEffect(() => {
    zoom.reset();
    setNaturalSize(null);
    setFullLoaded(false);
  }, [image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Space toggles fit / 1:1 — disabled in crop mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (cropMode) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        zoom.toggleOneToOne();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, cropMode]);

  const previewSrc = useMemo(
    () => (image?.preview_path ? window.photocull.previewUrl(image.preview_path) : ""),
    [image?.preview_path],
  );
  const fullSrc = useMemo(
    () => (image ? window.photocull.fullUrl(image) : ""),
    [image],
  );

  // When in crop mode, force fit-scale so the crop math has a stable image rect.
  useEffect(() => {
    if (cropMode) zoom.reset();
  }, [cropMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the displayed image bounding box for the crop overlay.
  useLayoutEffect(() => {
    if (!cropMode || !zoom.imgRef.current || !containerInnerRef.current) {
      setImageBox(null);
      return;
    }
    const recompute = () => {
      const imgEl = zoom.imgRef.current;
      const wrap = containerInnerRef.current;
      if (!imgEl || !wrap) return;
      const imgRect = imgEl.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      setImageBox({
        left: imgRect.left - wrapRect.left,
        top: imgRect.top - wrapRect.top,
        width: imgRect.width,
        height: imgRect.height,
      });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (zoom.imgRef.current) ro.observe(zoom.imgRef.current);
    if (containerInnerRef.current) ro.observe(containerInnerRef.current);
    return () => ro.disconnect();
  }, [cropMode, fullLoaded, naturalSize, image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!image) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted bg-bg">
        Select an image
      </div>
    );
  }

  const zoomed = zoom.transform.scale > 1.01;
  const cursor = cropMode
    ? "cursor-default"
    : zoomed
      ? "cursor-grab active:cursor-grabbing"
      : "cursor-zoom-in";

  const useFull = fullLoaded;
  const visibleSrc = useFull ? fullSrc : previewSrc;

  const hasCrop = image.crop_left != null;
  const naturalAspect = naturalSize ? naturalSize.w / naturalSize.h : 3 / 2;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      <div
        ref={zoom.containerRef}
        onWheel={cropMode ? undefined : zoom.onWheel}
        onMouseDown={cropMode ? undefined : zoom.onMouseDown}
        onDoubleClick={cropMode ? undefined : zoom.onDoubleClick}
        className={`flex-1 min-h-0 relative overflow-hidden select-none ${cursor}`}
      >
        <div
          ref={containerInnerRef}
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: cropMode
              ? "none"
              : `translate(${zoom.transform.tx}px, ${zoom.transform.ty}px) scale(${zoom.transform.scale})`,
            transformOrigin: "center center",
            transition: zoom.transform.scale === 1 || cropMode ? "transform 120ms ease-out" : "none",
            willChange: "transform",
          }}
        >
          {visibleSrc ? (
            <img
              ref={zoom.imgRef}
              src={visibleSrc}
              alt={image.filename}
              draggable={false}
              decoding="async"
              onLoad={(e) => {
                const el = e.currentTarget;
                setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div className="text-muted">No preview yet</div>
          )}
        </div>

        {/* Hidden preloader for the full-resolution version. */}
        {fullSrc && !fullLoaded && (
          <img
            ref={fullPreloaderRef}
            src={fullSrc}
            alt=""
            decoding="async"
            onLoad={() => setFullLoaded(true)}
            style={{ display: "none" }}
          />
        )}

        {cropMode && imageBox && (
          <CropOverlay imageBox={imageBox} imageAspect={naturalAspect} />
        )}

        {/* Status chip */}
        {!cropMode && zoomed && (
          <div className="absolute top-2 right-2 px-2 py-1 text-xs font-mono bg-black/60 rounded">
            {Math.round(zoom.transform.scale * 100)}%{useFull ? "" : " (loading…)"}
          </div>
        )}
        {!cropMode && hasCrop && (
          <div
            className="absolute bottom-3 left-3 text-[10px] uppercase font-semibold tracking-wide
              bg-black/70 text-ink px-1.5 py-0.5 rounded"
            title="This frame has a saved crop. Press R to edit, Shift+R to clear."
          >
            Cropped
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-line bg-panel text-sm flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <span className="truncate font-medium" title={image.filename}>
            {image.filename}
          </span>
          <StarRow stars={image.stars} />
          {image.pick === 1 && (
            <span className="text-pick font-semibold uppercase text-xs">Pick</span>
          )}
          {image.pick === -1 && (
            <span className="text-reject font-semibold uppercase text-xs">Reject</span>
          )}
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <ScoreChip label="overall" value={image.score_overall} />
          <ScoreChip label="focus" value={image.score_focus} />
          <ScoreChip label="exp" value={image.score_exposure} />
          <ScoreChip label="eyes" value={image.score_eyes} />
        </div>
        <div className="text-muted text-xs flex gap-3 whitespace-nowrap">
          {image.camera_model && <span>{image.camera_model}</span>}
          {image.lens && <span>{image.lens}</span>}
          {image.focal_length && <span>{image.focal_length.toFixed(0)}mm</span>}
          {image.aperture && <span>f/{image.aperture}</span>}
          {image.shutter && <span>{image.shutter}</span>}
          {image.iso && <span>ISO {image.iso}</span>}
        </div>
      </div>
    </div>
  );
}
