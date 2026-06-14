import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FaceDetection } from "@shared/types";
import { useStore } from "../store";
import { useZoomPan } from "../useZoomPan";
import { CropOverlay } from "./CropOverlay";
import { FacesOverlay } from "./FacesOverlay";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function rectFromCenter(cx: number, cy: number, halfW: number, halfH: number) {
  const x0 = clamp01(cx - halfW);
  const y0 = clamp01(cy - halfH);
  const x1 = clamp01(cx + halfW);
  const y1 = clamp01(cy + halfH);
  return { x: x0, y: y0, w: Math.max(x1 - x0, 0.01), h: Math.max(y1 - y0, 0.01) };
}

// Build a normalized 0..1 target rect around the subject's eyes for the auto
// loupe: largest face, framing both eyes (fallback: one eye, then the face
// box). Returns null when there's no usable face.
function eyeRectForFaces(
  faces: FaceDetection[],
): { x: number; y: number; w: number; h: number } | null {
  if (faces.length === 0) return null;
  const face = faces.reduce((best, f) =>
    f.box[2] * f.box[3] > best.box[2] * best.box[3] ? f : best,
  );
  const [fx, fy, fw, fh] = face.box;
  const l = face.left_eye;
  const r = face.right_eye;

  if (l && r) {
    const cx = (l[0] + r[0]) / 2;
    const cy = (l[1] + r[1]) / 2;
    const interoc = Math.hypot(l[0] - r[0], l[1] - r[1]) || fw * 0.5;
    return rectFromCenter(cx, cy, interoc * 1.15, Math.max(interoc * 0.6, fh * 0.12));
  }
  const one = l ?? r;
  if (one) {
    return rectFromCenter(one[0], one[1], fw * 0.35, fh * 0.22);
  }
  // No eyes detected: frame the face box (eyes sit in its upper half anyway).
  return {
    x: clamp01(fx),
    y: clamp01(fy),
    w: clamp01(fx + fw) - clamp01(fx),
    h: clamp01(fy + fh) - clamp01(fy),
  };
}

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
  const showFaces = useStore((s) => s.showFaces);
  const toggleFaces = useStore((s) => s.toggleFaces);
  const eyeZoom = useStore((s) => s.eyeZoom);

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

  const faces = useMemo<FaceDetection[]>(() => {
    if (!image?.faces_json) return [];
    try {
      const parsed = JSON.parse(image.faces_json);
      return Array.isArray(parsed) ? (parsed as FaceDetection[]) : [];
    } catch {
      return [];
    }
  }, [image?.faces_json]);

  // Read faces through a ref so the snap effect below can fire purely on image
  // readiness (naturalSize) without also firing on the image-change render,
  // when naturalSize still holds the previous frame's stale dimensions.
  const facesRef = useRef(faces);
  facesRef.current = faces;

  // Auto-snap the loupe to the subject's eyes once the frame's pixels are ready
  // (naturalSize), and again when the full-res image swaps in (sharpening the
  // same view). Toggling eyeZoom off returns to fit. Skipped in crop mode and
  // on frames with no detected face.
  useEffect(() => {
    if (cropMode || !naturalSize) return;
    if (!eyeZoom) {
      zoom.reset();
      return;
    }
    const target = eyeRectForFaces(facesRef.current);
    if (target) zoom.zoomToRect(target);
    else zoom.reset();
  }, [eyeZoom, cropMode, naturalSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // The face overlay shares the crop overlay's image rect, which is only valid
  // in fit view (it's drawn in the untransformed outer container). Hide it while
  // zoomed so the boxes can't drift off the photo.
  const facesOverlayActive =
    showFaces && !cropMode && faces.length > 0 && zoom.transform.scale <= 1.01;

  // Track the displayed image bounding box for the crop / faces overlays.
  useLayoutEffect(() => {
    if ((!cropMode && !facesOverlayActive) || !zoom.imgRef.current || !containerInnerRef.current) {
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
  }, [cropMode, facesOverlayActive, fullLoaded, naturalSize, image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

        {facesOverlayActive && imageBox && (
          <FacesOverlay imageBox={imageBox} faces={faces} />
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
          {image.n_faces != null && image.n_faces > 0 && (
            <button
              type="button"
              onClick={toggleFaces}
              className={`text-xs rounded px-1.5 py-0.5 border transition-colors ${
                showFaces ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
              }`}
              title="Toggle face / eye overlay (F)"
            >
              {image.n_faces} {image.n_faces === 1 ? "face" : "faces"}
            </button>
          )}
        </div>
        <div className="text-muted text-xs flex gap-3 whitespace-nowrap">
          {image.camera_model && <span>{image.camera_model}</span>}
          {image.lens && <span>{image.lens}</span>}
          {image.focal_length && <span>{image.focal_length.toFixed(0)}mm</span>}
          {image.aperture && <span>f/{image.aperture}</span>}
          {image.shutter && <span>{image.shutter}</span>}
          {image.iso && <span>ISO {image.iso}</span>}
        </div>
        {(image.focus_mode || image.af_area_mode || image.af_points_in_focus) && (
          <div className="text-muted text-xs flex items-center gap-2 min-w-0">
            <span className="uppercase tracking-wide text-[10px] text-line">AF</span>
            {image.focus_mode && <span title="Focus mode">{image.focus_mode}</span>}
            {image.af_area_mode && <span title="AF area mode">{image.af_area_mode}</span>}
            {image.af_points_in_focus && (
              <span
                className="truncate max-w-[14rem]"
                title={`AF points in focus: ${image.af_points_in_focus}`}
              >
                {image.af_points_in_focus}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
