import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CropRect, FaceDetection } from "@shared/types";
import { useStore } from "../store";
import { useZoomPan } from "../useZoomPan";
import { CropOverlay } from "./CropOverlay";
import { CroppedImage } from "./CroppedImage";
import { FacesOverlay } from "./FacesOverlay";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Map a normalized 0..1 rect (eye-zoom target, face box) from full-frame
// space into a saved crop's own 0..1 space, so the loupe's zoom/faces logic
// can operate on what's actually displayed instead of the frame the crop cut
// down from. Returns null for a degenerate (zero-area) crop.
function mapIntoCrop(
  rect: { x: number; y: number; w: number; h: number },
  crop: CropRect,
): { x: number; y: number; w: number; h: number } | null {
  const cw = crop.right - crop.left;
  const ch = crop.bottom - crop.top;
  if (cw <= 0 || ch <= 0) return null;
  return {
    x: (rect.x - crop.left) / cw,
    y: (rect.y - crop.top) / ch,
    w: rect.w / cw,
    h: rect.h / ch,
  };
}

// Same mapping applied to a face detection's box + eye points. Returns null
// when the crop doesn't touch the face at all, so callers can drop it rather
// than draw an overlay off the visible picture.
function mapFaceIntoCrop(f: FaceDetection, crop: CropRect): FaceDetection | null {
  const cw = crop.right - crop.left;
  const ch = crop.bottom - crop.top;
  if (cw <= 0 || ch <= 0) return null;
  const mapPt = ([x, y]: [number, number]): [number, number] => [
    (x - crop.left) / cw,
    (y - crop.top) / ch,
  ];
  const [fx, fy, fw, fh] = f.box;
  const [bx, by] = mapPt([fx, fy]);
  const bw = fw / cw;
  const bh = fh / ch;
  if (bx + bw <= 0 || bx >= 1 || by + bh <= 0 || by >= 1) return null;
  return {
    ...f,
    box: [bx, by, bw, bh],
    left_eye: f.left_eye ? mapPt(f.left_eye) : null,
    right_eye: f.right_eye ? mapPt(f.right_eye) : null,
  };
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

  // The saved crop, if any — independent of crop *mode*. Crop mode always
  // shows the full frame (so CropOverlay can re-edit the saved rect against
  // it), so what's actually displayed is `effectiveCrop`, not this directly.
  const cropRect: CropRect | null =
    image?.crop_left != null &&
    image.crop_top != null &&
    image.crop_right != null &&
    image.crop_bottom != null
      ? {
          left: image.crop_left,
          top: image.crop_top,
          right: image.crop_right,
          bottom: image.crop_bottom,
        }
      : null;
  const effectiveCrop = cropMode ? null : cropRect;

  // The natural size of what's actually displayed — the crop's pixel extent
  // when one is showing, the whole frame otherwise. Feeding this (rather
  // than the frame's full naturalSize) into useZoomPan means pan clamping,
  // 1:1 scale, and eye-zoom all measure against the visible picture instead
  // of the uncropped frame behind it.
  const displayNatural = useMemo(() => {
    if (!naturalSize) return null;
    if (!effectiveCrop) return naturalSize;
    const cw = effectiveCrop.right - effectiveCrop.left;
    const ch = effectiveCrop.bottom - effectiveCrop.top;
    if (cw <= 0 || ch <= 0) return naturalSize;
    return { w: cw * naturalSize.w, h: ch * naturalSize.h };
  }, [
    naturalSize,
    effectiveCrop?.left,
    effectiveCrop?.top,
    effectiveCrop?.right,
    effectiveCrop?.bottom,
  ]);

  const zoom = useZoomPan(displayNatural);

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
  // same view), and whenever a crop is applied/cleared (the target rect has to
  // be re-mapped). Toggling eyeZoom off returns to fit. Skipped in crop mode and
  // on frames with no detected face. Also suppressed while the face overlay is
  // shown — the overlay is only valid at fit scale, so inspecting faces (F) and
  // pixel-peeping the eyes (E) are deliberately distinct views.
  useEffect(() => {
    if (cropMode || !naturalSize) return;
    if (!eyeZoom || showFaces) {
      zoom.reset();
      return;
    }
    const raw = eyeRectForFaces(facesRef.current);
    if (!raw) {
      zoom.reset();
      return;
    }
    if (!cropRect) {
      zoom.zoomToRect(raw);
      return;
    }
    // The saved crop may have cut the subject's eyes out entirely — in that
    // case fall back to fit rather than zooming to a rect off the picture.
    const mapped = mapIntoCrop(raw, cropRect);
    const cx = mapped ? mapped.x + mapped.w / 2 : -1;
    const cy = mapped ? mapped.y + mapped.h / 2 : -1;
    if (mapped && cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1) {
      zoom.zoomToRect(mapped);
    } else {
      zoom.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    eyeZoom,
    showFaces,
    cropMode,
    naturalSize,
    cropRect?.left,
    cropRect?.top,
    cropRect?.right,
    cropRect?.bottom,
  ]);

  // The face overlay shares the crop overlay's image rect, which is only valid
  // in fit view (it's drawn in the untransformed outer container). Hide it while
  // zoomed so the boxes can't drift off the photo.
  const facesOverlayActive =
    showFaces && !cropMode && faces.length > 0 && zoom.transform.scale <= 1.01;

  // Faces re-based into the saved crop's coordinate space, so the overlay
  // (rendered against the cropped display box) lines up with the visible
  // picture. Faces the crop cut out entirely are dropped rather than drawn
  // off-picture.
  const mappedFaces = useMemo(() => {
    if (!cropRect) return faces;
    return faces
      .map((f) => mapFaceIntoCrop(f, cropRect))
      .filter((f): f is FaceDetection => f != null);
  }, [faces, cropRect?.left, cropRect?.top, cropRect?.right, cropRect?.bottom]);

  // Track the displayed image's bounding box (the crop's clipping box, when
  // one is showing) for the crop / faces overlays. zoom.boxRef is exactly
  // that box — see useZoomPan — so this stays correct whether or not a crop
  // is active without needing its own crop-aware geometry.
  useLayoutEffect(() => {
    if ((!cropMode && !facesOverlayActive) || !zoom.boxRef.current || !containerInnerRef.current) {
      setImageBox(null);
      return;
    }
    const recompute = () => {
      const boxEl = zoom.boxRef.current;
      const wrap = containerInnerRef.current;
      if (!boxEl || !wrap) return;
      const boxRect = boxEl.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      setImageBox({
        left: boxRect.left - wrapRect.left,
        top: boxRect.top - wrapRect.top,
        width: boxRect.width,
        height: boxRect.height,
      });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (zoom.boxRef.current) ro.observe(zoom.boxRef.current);
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

  const hasCrop = cropRect != null;
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
            <CroppedImage
              src={visibleSrc}
              alt={image.filename}
              crop={effectiveCrop}
              sizeKey={image.id}
              className="w-full h-full"
              onNaturalSize={setNaturalSize}
              boxRef={zoom.boxRef}
              imgRef={zoom.imgRef}
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

        {/* Mounted only once the natural size is known, so the overlay's
            aspect presets (default: Original) see the real frame aspect. */}
        {cropMode && imageBox && naturalSize && (
          <CropOverlay imageBox={imageBox} imageAspect={naturalAspect} />
        )}

        {facesOverlayActive && imageBox && (
          <FacesOverlay imageBox={imageBox} faces={mappedFaces} />
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
          <ScoreChip label="aesthetic" value={image.score_aesthetic} />
          <ScoreChip label="eyes" value={image.score_eyes} />
          {image.n_faces != null && image.n_faces > 0 ? (
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
          ) : (
            image.n_faces === 0 && (
              <span className="text-xs text-muted" title="Face detection ran; no faces found">
                no faces
              </span>
            )
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
