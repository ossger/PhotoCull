import { useCallback, useEffect, useRef, useState } from "react";

interface Transform {
  scale: number;
  // Translation in CSS pixels at the current scale. (0,0) = image centred.
  tx: number;
  ty: number;
}

const FIT: Transform = { scale: 1, tx: 0, ty: 0 };

// A transform expressed independently of any one view's size: translation as
// a fraction of the displayed (fit-size) picture. Lets compare's "sync zoom"
// mirror one cell onto others whose pictures differ in size or aspect.
export interface SharedTransform {
  scale: number;
  nx: number;
  ny: number;
}

const MIN_SCALE = 1;       // 1 = fit-to-container
const MAX_SCALE = 16;      // 16x is plenty for pixel-peeping
const WHEEL_SENSITIVITY = 0.0018;

interface UseZoomPanResult {
  containerRef: React.RefObject<HTMLDivElement>;
  imgRef: React.RefObject<HTMLImageElement>;
  // The box that actually bounds the displayed picture — the crop's clipping
  // wrapper when a crop is showing, otherwise sized the same as the image
  // itself. Pan clamping and 1:1 scale measure this, not imgRef, so a
  // cropped frame can't be panned/zoomed past its own visible edges.
  boxRef: React.RefObject<HTMLDivElement>;
  transform: Transform;
  reset: () => void;
  toggleOneToOne: () => void;
  // Zoom + center on a normalized 0..1 sub-rect of the displayed image.
  zoomToRect: (rect: { x: number; y: number; w: number; h: number }, opts?: { pad?: number }) => void;
  // Size-independent view of the current transform (null until laid out),
  // and the inverse: apply one (clamped to this view).
  toShared: () => SharedTransform | null;
  applyShared: (t: SharedTransform) => void;
  // Bind these to the container element.
  onWheel: React.WheelEventHandler<HTMLDivElement>;
  onMouseDown: React.MouseEventHandler<HTMLDivElement>;
  onDoubleClick: React.MouseEventHandler<HTMLDivElement>;
}

/**
 * Zoom + pan for an image inside a container. The image is rendered at the
 * container's content-box size by default (1× = fit). Wheel zooms toward the
 * cursor; left-drag pans when zoomed in; double-click toggles fit / 1:1.
 *
 * "1:1" means one image pixel per device pixel — what photographers call
 * 100% — computed live from the image's natural width and the container.
 */
export function useZoomPan(naturalSize: { w: number; h: number } | null): UseZoomPanResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(FIT);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // The fit scale gives the displayed image its container-fit size. 1:1 needs
  // the ratio of (natural image px / displayed fit px) so 1 image px === 1
  // device px. Compute lazily; falls back to a fixed 4x if we have no sizes.
  // naturalSize here is the *displayed* size — the crop's pixel dimensions
  // when cropped, the whole frame's otherwise (see Loupe's displayNatural).
  const oneToOneScale = useCallback((): number => {
    if (!naturalSize || !boxRef.current) return 4;
    const displayed = boxRef.current.getBoundingClientRect();
    if (displayed.width === 0) return 4;
    const dpr = window.devicePixelRatio || 1;
    const ratio = (naturalSize.w / displayed.width) / dpr;
    return Math.max(1, Math.min(MAX_SCALE, ratio));
  }, [naturalSize]);

  const clamp = useCallback((next: Transform): Transform => {
    const c = containerRef.current;
    const box = boxRef.current;
    if (!c || !box) return next;
    // The image is centred at scale 1; when zoomed we don't let it slip past
    // the container edges by more than the image extent. offsetWidth/Height
    // are the untransformed (fit) size — getBoundingClientRect would already
    // include the current zoom and double-count it.
    const scaledW = box.offsetWidth * next.scale;
    const scaledH = box.offsetHeight * next.scale;
    const cRect = c.getBoundingClientRect();
    const maxTx = Math.max(0, (scaledW - cRect.width) / 2);
    const maxTy = Math.max(0, (scaledH - cRect.height) / 2);
    return {
      scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, next.scale)),
      tx: Math.max(-maxTx, Math.min(maxTx, next.tx)),
      ty: Math.max(-maxTy, Math.min(maxTy, next.ty)),
    };
  }, []);

  const reset = useCallback(() => setTransform(FIT), []);

  const toggleOneToOne = useCallback(() => {
    setTransform((cur) => {
      if (cur.scale > 1.1) return FIT;
      return clamp({ scale: oneToOneScale(), tx: cur.tx, ty: cur.ty });
    });
  }, [clamp, oneToOneScale]);

  // Zoom + center on a sub-rectangle of the displayed image, given in
  // normalized 0..1 coords of it — the crop, when one is showing, not the
  // full frame (naturalSize is the *displayed* pixel size; see Loupe's
  // displayNatural and mapIntoCrop). Used by the eye loupe to snap to the
  // subject's eyes. Scale is capped at 1:1 (100%) so we never upscale past
  // the native pixels — the whole point is to judge real sharpness.
  const zoomToRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number }, opts?: { pad?: number }) => {
      const c = containerRef.current;
      if (!c || !naturalSize) return;
      const cRect = c.getBoundingClientRect();
      if (cRect.width === 0 || cRect.height === 0) return;

      // Displayed (object-contain) image size at fit scale, derived from
      // geometry so it's independent of the current transform.
      const fitScale = Math.min(cRect.width / naturalSize.w, cRect.height / naturalSize.h);
      const fitW = naturalSize.w * fitScale;
      const fitH = naturalSize.h * fitScale;
      if (fitW === 0 || fitH === 0) return;

      const pad = opts?.pad ?? 0.18; // leave a margin around the rect
      const rectW = Math.max(rect.w * fitW, 1);
      const rectH = Math.max(rect.h * fitH, 1);
      const fillScale = (1 - pad) * Math.min(cRect.width / rectW, cRect.height / rectH);

      const dpr = window.devicePixelRatio || 1;
      const oneToOne = naturalSize.w / fitW / dpr; // 100% = 1 image px per device px

      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fillScale, oneToOne));

      // Offset of the rect center from the image center, in fit CSS px.
      const cx = (rect.x + rect.w / 2 - 0.5) * fitW;
      const cy = (rect.y + rect.h / 2 - 0.5) * fitH;

      setTransform(clamp({ scale, tx: -scale * cx, ty: -scale * cy }));
    },
    [naturalSize, clamp],
  );

  // Read through a ref so toShared stays stable (no re-render churn for callers).
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const toShared = useCallback((): SharedTransform | null => {
    const box = boxRef.current;
    if (!box || box.offsetWidth === 0 || box.offsetHeight === 0) return null;
    const t = transformRef.current;
    return {
      scale: t.scale,
      nx: t.tx / (box.offsetWidth * t.scale),
      ny: t.ty / (box.offsetHeight * t.scale),
    };
  }, []);

  const applyShared = useCallback(
    (n: SharedTransform) => {
      const box = boxRef.current;
      if (!box || box.offsetWidth === 0 || box.offsetHeight === 0) return;
      const next = clamp({
        scale: n.scale,
        tx: n.nx * box.offsetWidth * n.scale,
        ty: n.ny * box.offsetHeight * n.scale,
      });
      setTransform((cur) =>
        cur.scale === next.scale && cur.tx === next.tx && cur.ty === next.ty ? cur : next,
      );
    },
    [clamp],
  );

  const onWheel: React.WheelEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      e.preventDefault();
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      // Cursor position relative to the container center
      const cursorX = e.clientX - rect.left - rect.width / 2;
      const cursorY = e.clientY - rect.top - rect.height / 2;
      setTransform((cur) => {
        // Multiplicative zoom so each wheel notch has consistent feel.
        const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.scale * factor));
        if (nextScale === cur.scale) return cur;
        // Keep the image point under the cursor stationary.
        //   image_pt = (cursor - translation) / scale
        // Want next translation such that the same image_pt maps to cursor:
        //   next_translation = cursor - image_pt * next_scale
        const ratio = nextScale / cur.scale;
        const nextTx = cursorX - (cursorX - cur.tx) * ratio;
        const nextTy = cursorY - (cursorY - cur.ty) * ratio;
        return clamp({ scale: nextScale, tx: nextTx, ty: nextTy });
      });
    },
    [clamp],
  );

  const onMouseDown: React.MouseEventHandler<HTMLDivElement> = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: transform.tx,
      ty: transform.ty,
    };
  }, [transform.tx, transform.ty]);

  // Mouse-move + up are bound at window level so the drag survives the cursor
  // briefly leaving the loupe.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setTransform((cur) =>
        clamp({
          scale: cur.scale,
          tx: d.tx + (e.clientX - d.x),
          ty: d.ty + (e.clientY - d.y),
        }),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clamp]);

  const onDoubleClick: React.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      e.preventDefault();
      toggleOneToOne();
    },
    [toggleOneToOne],
  );

  return {
    containerRef,
    imgRef,
    boxRef,
    transform,
    reset,
    toggleOneToOne,
    zoomToRect,
    toShared,
    applyShared,
    onWheel,
    onMouseDown,
    onDoubleClick,
  };
}
