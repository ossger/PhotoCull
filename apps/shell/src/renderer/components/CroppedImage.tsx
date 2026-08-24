import { useCallback, useEffect, useRef, useState } from "react";
import type { CropRect } from "@shared/types";

/**
 * Renders an image inside a container, honouring an optional committed crop
 * — the display fills the container with just the cropped region, exactly
 * like `object-contain` would with the whole frame. A `null` crop is treated
 * as the identity rect `{0,0,1,1}`, so this reproduces plain object-contain
 * pixel-for-pixel when there's nothing to crop; callers don't need a
 * separate uncropped code path.
 *
 * Measures its own root via a ResizeObserver on a callback ref, rather than
 * reaching for a ref that may not exist yet on first mount (see Loupe.tsx
 * history — that's the bug this component exists to not repeat).
 */

interface Props {
  src: string;
  alt: string;
  crop: CropRect | null;
  // Identifies the underlying picture (e.g. image id). naturalSize resets
  // only when this changes, so swapping preview -> full resolution (same
  // picture, same src semantics, different URL) doesn't flash a reflow.
  sizeKey?: number | string;
  className?: string;
  onNaturalSize?: (s: { w: number; h: number }) => void;
  boxRef?: React.Ref<HTMLDivElement>;
  imgRef?: React.Ref<HTMLImageElement>;
}

export function CroppedImage({
  src,
  alt,
  crop,
  sizeKey,
  className,
  onNaturalSize,
  boxRef,
  imgRef,
}: Props) {
  const [rootSize, setRootSize] = useState<{ w: number; h: number } | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const rootCallbackRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const recompute = () => setRootSize({ w: el.offsetWidth, h: el.offsetHeight });
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  // Reset naturalSize on a genuine picture change (sizeKey), not a
  // preview->full src swap. Done synchronously during render — React's
  // documented pattern for "adjusting state when a prop changes" — rather
  // than in an effect, so the stale picture's naturalSize can never be used
  // to size a box around the new src for even one paint.
  const prevSizeKeyRef = useRef(sizeKey);
  if (prevSizeKeyRef.current !== sizeKey) {
    prevSizeKeyRef.current = sizeKey;
    if (naturalSize !== null) setNaturalSize(null);
  }

  const c = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
  const cw = c.right - c.left;
  const ch = c.bottom - c.top;

  let box: { width: number; height: number } | null = null;
  let img: { left: number; top: number; width: number; height: number } | null = null;
  if (naturalSize && rootSize && cw > 0 && ch > 0 && rootSize.w > 0 && rootSize.h > 0) {
    const cropPxW = cw * naturalSize.w;
    const cropPxH = ch * naturalSize.h;
    const scale = Math.min(rootSize.w / cropPxW, rootSize.h / cropPxH);
    const imgWidth = naturalSize.w * scale;
    const imgHeight = naturalSize.h * scale;
    box = { width: cropPxW * scale, height: cropPxH * scale };
    img = {
      left: -c.left * imgWidth,
      top: -c.top * imgHeight,
      width: imgWidth,
      height: imgHeight,
    };
  }

  return (
    <div ref={rootCallbackRef} className={`relative flex items-center justify-center ${className ?? ""}`}>
      {src && (
        <div
          ref={boxRef}
          className="relative overflow-hidden"
          style={box ? { width: box.width, height: box.height } : { width: 0, height: 0 }}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            decoding="async"
            onLoad={(e) => {
              const el = e.currentTarget;
              const s = { w: el.naturalWidth, h: el.naturalHeight };
              setNaturalSize(s);
              onNaturalSize?.(s);
            }}
            style={{
              position: "absolute",
              opacity: img ? 1 : 0,
              left: img?.left ?? 0,
              top: img?.top ?? 0,
              width: img?.width,
              height: img?.height,
              maxWidth: "none",
              maxHeight: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}
