import { useCallback, useEffect, useRef, useState } from "react";

interface Transform {
  scale: number;
  // Translation in CSS pixels at the current scale. (0,0) = image centred.
  tx: number;
  ty: number;
}

const FIT: Transform = { scale: 1, tx: 0, ty: 0 };

const MIN_SCALE = 1;       // 1 = fit-to-container
const MAX_SCALE = 16;      // 16x is plenty for pixel-peeping
const WHEEL_SENSITIVITY = 0.0018;

interface UseZoomPanResult {
  containerRef: React.RefObject<HTMLDivElement>;
  imgRef: React.RefObject<HTMLImageElement>;
  transform: Transform;
  reset: () => void;
  toggleOneToOne: () => void;
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
  const [transform, setTransform] = useState<Transform>(FIT);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // The fit scale gives the displayed image its container-fit size. 1:1 needs
  // the ratio of (natural image px / displayed fit px) so 1 image px === 1
  // device px. Compute lazily; falls back to a fixed 4x if we have no sizes.
  const oneToOneScale = useCallback((): number => {
    if (!naturalSize || !imgRef.current) return 4;
    const displayed = imgRef.current.getBoundingClientRect();
    if (displayed.width === 0) return 4;
    const dpr = window.devicePixelRatio || 1;
    const ratio = (naturalSize.w / displayed.width) / dpr;
    return Math.max(1, Math.min(MAX_SCALE, ratio));
  }, [naturalSize]);

  const clamp = useCallback((next: Transform): Transform => {
    const c = containerRef.current;
    if (!c || !imgRef.current) return next;
    const img = imgRef.current.getBoundingClientRect();
    // The image is centred at scale 1; when zoomed we don't let it slip past
    // the container edges by more than the image extent.
    const scaledW = img.width * next.scale;
    const scaledH = img.height * next.scale;
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
    transform,
    reset,
    toggleOneToOne,
    onWheel,
    onMouseDown,
    onDoubleClick,
  };
}
