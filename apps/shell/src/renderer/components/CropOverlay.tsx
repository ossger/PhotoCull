import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { CropRect, MenuTemplateItem } from "@shared/types";
import { panKeyState } from "../useZoomPan";

/**
 * Lightroom-style crop overlay.
 *
 * Renders dimmed-exterior + clear-interior on top of the loupe image.
 * Drag inside the clear rect to move; drag any of the 8 handles to resize.
 * An aspect-ratio dropdown locks the rect proportions (Free / Original /
 * 1:1 / 3:2 / 4:5 / 16:9 …). It starts on Original (the frame's own aspect)
 * — unless the frame already has a saved crop of some other shape, in which
 * case it starts on whichever preset matches that crop (or Free), so simply
 * re-opening crop mode never reshapes a crop you already made.
 *
 * The crop is stored normalised 0..1 of the image. The component takes the
 * displayed image's bounding rect (the area the photo actually occupies on
 * screen, after object-contain inside the loupe container) so we can convert
 * between mouse pixels and normalised image space without caring about scale.
 *
 * Mouse events are bound at window-level for drags so the handle survives
 * the cursor briefly leaving the overlay element.
 */

interface Props {
  imageBox: { left: number; top: number; width: number; height: number };
  imageAspect: number; // natural width / height
  // The overlay owns the aspect state, so it publishes its right-click menu
  // here for Loupe to open (see Loupe's onContextMenu).
  menuRef: React.MutableRefObject<(() => void) | null>;
  onToggleZoom: () => void;
  zoomScale: number;
}

const ASPECT_PRESETS: Array<{ key: string; label: string; ratio: number | null }> = [
  { key: "free", label: "Free", ratio: null },
  { key: "orig", label: "Original", ratio: -1 }, // sentinel — resolved at runtime
  { key: "1x1", label: "1 : 1", ratio: 1 },
  { key: "3x2", label: "3 : 2", ratio: 3 / 2 },
  { key: "2x3", label: "2 : 3", ratio: 2 / 3 },
  { key: "4x5", label: "4 : 5", ratio: 4 / 5 },
  { key: "5x4", label: "5 : 4", ratio: 5 / 4 },
  { key: "16x9", label: "16 : 9", ratio: 16 / 9 },
  { key: "9x16", label: "9 : 16", ratio: 9 / 16 },
];

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

interface Drag {
  handle: Handle;
  startMouseX: number;
  startMouseY: number;
  startRect: CropRect; // normalised image space
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function applyAspect(
  rect: CropRect,
  handle: Handle,
  targetAspect: number,
  imageAspect: number,
): CropRect {
  // Aspect is in *displayed* terms. The rect is normalised so we need to
  // multiply width by imageAspect to compare in displayed proportions.
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  const currentDisplayedAspect = (w * imageAspect) / h;
  if (currentDisplayedAspect === targetAspect) return rect;

  // Resolve which dimension to adjust based on the handle that's moving.
  // Corners adjust both; edges adjust the one perpendicular to themselves.
  let next = { ...rect };
  const adjustH = (newH: number) => {
    const cy = (rect.top + rect.bottom) / 2;
    next.top = clamp(cy - newH / 2, 0, 1);
    next.bottom = clamp(cy + newH / 2, 0, 1);
  };
  const adjustW = (newW: number) => {
    const cx = (rect.left + rect.right) / 2;
    next.left = clamp(cx - newW / 2, 0, 1);
    next.right = clamp(cx + newW / 2, 0, 1);
  };

  if (handle === "n" || handle === "s") {
    // Height was driven; adjust width to match
    const newW = (h * targetAspect) / imageAspect;
    adjustW(newW);
  } else if (handle === "e" || handle === "w") {
    // Width was driven; adjust height to match
    const newH = (w * imageAspect) / targetAspect;
    adjustH(newH);
  } else {
    // Corner or move: prefer to keep the larger dimension and shrink the other
    const desiredHFromW = (w * imageAspect) / targetAspect;
    if (desiredHFromW <= 1) {
      adjustH(desiredHFromW);
    } else {
      adjustW((h * targetAspect) / imageAspect);
    }
  }
  return next;
}

// The preset the overlay opens on, given the draft it's handed at mount.
// imageAspect must be the real frame aspect here (Loupe only mounts the
// overlay once the image's natural size is known).
function initialAspectKey(draft: CropRect | null, imageAspect: number, hasSavedCrop: boolean): string {
  if (!draft || !hasSavedCrop) return "orig";
  const w = draft.right - draft.left;
  const h = draft.bottom - draft.top;
  if (w <= 0 || h <= 0) return "orig";
  const displayed = (w * imageAspect) / h;
  const close = (r: number) => Math.abs(displayed / r - 1) < 0.01;
  if (close(imageAspect)) return "orig";
  const match = ASPECT_PRESETS.find((p) => p.ratio != null && p.ratio > 0 && close(p.ratio));
  return match?.key ?? "free";
}

export function CropOverlay({ imageBox, imageAspect, menuRef, onToggleZoom, zoomScale }: Props) {
  const draft = useStore((s) => s.cropDraft);
  const setDraft = useStore((s) => s.setCropDraft);
  const applyDraft = useStore((s) => s.applyCropDraft);
  const exitCrop = useStore((s) => s.exitCropMode);
  const clearCrop = useStore((s) => s.clearCrop);

  const hasSavedCrop = useStore((s) => {
    const img = s.images.find((i) => i.id === s.selectedImageId);
    return img?.crop_left != null;
  });

  const [aspectKey, setAspectKey] = useState(() =>
    initialAspectKey(useStore.getState().cropDraft, imageAspect, hasSavedCrop),
  );

  const targetAspect = useMemo(() => {
    const found = ASPECT_PRESETS.find((p) => p.key === aspectKey);
    if (!found || found.ratio === null) return null;
    return found.ratio === -1 ? imageAspect : found.ratio;
  }, [aspectKey, imageAspect]);

  const dragRef = useRef<Drag | null>(null);

  // Right-click menu while cropping: apply/cancel/reset, aspect presets, zoom.
  menuRef.current = async () => {
    const template: MenuTemplateItem[] = [
      { id: "apply", label: "Apply crop", shortcut: "Enter" },
      { id: "cancel", label: "Cancel", shortcut: "Escape" },
      { id: "reset", label: "Clear saved crop", enabled: hasSavedCrop, shortcut: "Shift+R" },
      { type: "separator" },
      {
        label: "Aspect",
        submenu: ASPECT_PRESETS.map((p) => ({
          id: `aspect:${p.key}`,
          label: p.label,
          checked: p.key === aspectKey,
        })),
      },
      { id: "zoom", label: zoomScale > 1.01 ? "Zoom to fit" : "Zoom to 100%", shortcut: "Z" },
    ];
    const choice = await window.photocull.popupMenu(template);
    if (!choice) return;
    if (choice.startsWith("aspect:")) setAspectKey(choice.slice(7));
    else if (choice === "apply") await applyDraft();
    else if (choice === "cancel") exitCrop();
    else if (choice === "reset") await clearCrop();
    else if (choice === "zoom") onToggleZoom();
  };

  // Enforce the aspect lock at mount (so the first draft you see is already
  // locked), whenever the ratio changes, and whenever a fresh draft appears
  // (null -> rect). Not on every draft change: drags already apply it.
  const hasDraft = draft != null;
  useEffect(() => {
    if (!draft || targetAspect == null) return;
    const fixed = applyAspect(draft, "move", targetAspect, imageAspect);
    if (
      fixed.left !== draft.left ||
      fixed.right !== draft.right ||
      fixed.top !== draft.top ||
      fixed.bottom !== draft.bottom
    ) {
      setDraft(fixed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAspect, hasDraft]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !draft) return;
      const dxNorm = (e.clientX - d.startMouseX) / imageBox.width;
      const dyNorm = (e.clientY - d.startMouseY) / imageBox.height;
      let next: CropRect = { ...d.startRect };

      switch (d.handle) {
        case "move": {
          const w = d.startRect.right - d.startRect.left;
          const h = d.startRect.bottom - d.startRect.top;
          let newLeft = clamp(d.startRect.left + dxNorm, 0, 1 - w);
          let newTop = clamp(d.startRect.top + dyNorm, 0, 1 - h);
          next = { left: newLeft, top: newTop, right: newLeft + w, bottom: newTop + h };
          break;
        }
        case "n":
          next.top = clamp(d.startRect.top + dyNorm, 0, d.startRect.bottom - 0.02);
          break;
        case "s":
          next.bottom = clamp(d.startRect.bottom + dyNorm, d.startRect.top + 0.02, 1);
          break;
        case "w":
          next.left = clamp(d.startRect.left + dxNorm, 0, d.startRect.right - 0.02);
          break;
        case "e":
          next.right = clamp(d.startRect.right + dxNorm, d.startRect.left + 0.02, 1);
          break;
        case "nw":
          next.left = clamp(d.startRect.left + dxNorm, 0, d.startRect.right - 0.02);
          next.top = clamp(d.startRect.top + dyNorm, 0, d.startRect.bottom - 0.02);
          break;
        case "ne":
          next.right = clamp(d.startRect.right + dxNorm, d.startRect.left + 0.02, 1);
          next.top = clamp(d.startRect.top + dyNorm, 0, d.startRect.bottom - 0.02);
          break;
        case "sw":
          next.left = clamp(d.startRect.left + dxNorm, 0, d.startRect.right - 0.02);
          next.bottom = clamp(d.startRect.bottom + dyNorm, d.startRect.top + 0.02, 1);
          break;
        case "se":
          next.right = clamp(d.startRect.right + dxNorm, d.startRect.left + 0.02, 1);
          next.bottom = clamp(d.startRect.bottom + dyNorm, d.startRect.top + 0.02, 1);
          break;
      }
      if (targetAspect != null && d.handle !== "move") {
        next = applyAspect(next, d.handle, targetAspect, imageAspect);
      }
      setDraft(next);
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
  }, [imageBox.width, imageBox.height, imageAspect, targetAspect, draft, setDraft]);

  if (!draft) return null;

  // Convert normalised rect to pixel rect positioned over imageBox
  const px = {
    left: imageBox.left + draft.left * imageBox.width,
    top: imageBox.top + draft.top * imageBox.height,
    width: (draft.right - draft.left) * imageBox.width,
    height: (draft.bottom - draft.top) * imageBox.height,
  };

  const onDragStart = (handle: Handle) => (e: React.MouseEvent) => {
    // Space held = pan gesture (handled by useZoomPan), not a crop drag.
    if (e.button !== 0 || panKeyState.space) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      handle,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startRect: draft,
    };
  };

  // Zoomed in, the crop box can extend past (or sit wholly outside) the
  // container; keep the dimming rects from going negative.
  const dim = {
    top: Math.max(0, px.top),
    bottom: Math.max(0, px.top + px.height),
    left: Math.max(0, px.left),
    right: Math.max(0, px.left + px.width),
  };

  const handleSize = 12;
  const handles: Array<{ h: Handle; style: React.CSSProperties; cursor: string }> = [
    { h: "nw", style: { left: -handleSize / 2, top: -handleSize / 2 }, cursor: "nwse-resize" },
    { h: "ne", style: { right: -handleSize / 2, top: -handleSize / 2 }, cursor: "nesw-resize" },
    { h: "sw", style: { left: -handleSize / 2, bottom: -handleSize / 2 }, cursor: "nesw-resize" },
    { h: "se", style: { right: -handleSize / 2, bottom: -handleSize / 2 }, cursor: "nwse-resize" },
    { h: "n", style: { left: "50%", top: -handleSize / 2, transform: "translateX(-50%)" }, cursor: "ns-resize" },
    { h: "s", style: { left: "50%", bottom: -handleSize / 2, transform: "translateX(-50%)" }, cursor: "ns-resize" },
    { h: "w", style: { left: -handleSize / 2, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
    { h: "e", style: { right: -handleSize / 2, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  ];

  return (
    <>
      {/* Dimming overlay outside the crop rect (four dark rectangles) */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute bg-black/60" style={{ left: 0, top: 0, right: 0, height: dim.top }} />
        <div className="absolute bg-black/60" style={{ left: 0, top: dim.bottom, right: 0, bottom: 0 }} />
        <div className="absolute bg-black/60" style={{ left: 0, top: dim.top, width: dim.left, height: Math.max(0, dim.bottom - dim.top) }} />
        <div className="absolute bg-black/60" style={{ left: dim.right, top: dim.top, right: 0, height: Math.max(0, dim.bottom - dim.top) }} />
      </div>

      {/* Crop rect — drag inside to move, drag handles to resize */}
      <div
        className="absolute border border-accent/90 select-none"
        style={{ left: px.left, top: px.top, width: px.width, height: px.height, cursor: "move" }}
        onMouseDown={onDragStart("move")}
      >
        {/* Rule-of-thirds gridlines */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
          <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
          <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
        </div>
        {handles.map(({ h, style, cursor }) => (
          <div
            key={h}
            onMouseDown={onDragStart(h)}
            className="absolute bg-accent border border-white/90 rounded-sm"
            style={{ width: handleSize, height: handleSize, cursor, ...style }}
          />
        ))}
      </div>

      {/* Floating toolbar with aspect picker + apply / cancel */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-panel/95 border border-line rounded-md px-3 py-2 flex items-center gap-3 text-sm shadow-lg">
        <span
          className="text-muted text-[10px] hidden md:inline"
          title="Scroll or pinch to zoom. Hold Space and drag (or middle-drag) to pan. Z toggles fit / 100%."
        >
          Scroll/pinch zoom · Space+drag pan
        </span>
        <label className="text-muted text-xs uppercase tracking-wide">Aspect</label>
        <select
          value={aspectKey}
          onChange={(e) => setAspectKey(e.target.value)}
          className="bg-panel2 border border-line rounded px-2 py-1 text-sm"
        >
          {ASPECT_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => clearCrop()}
          className="px-2 py-1 rounded border border-line hover:bg-line text-xs"
          title="Clear any saved crop (Shift+R)"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => exitCrop()}
          className="px-2 py-1 rounded border border-line hover:bg-line text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => applyDraft()}
          className="px-3 py-1 rounded bg-pick text-black font-semibold text-xs"
        >
          Apply
        </button>
      </div>
    </>
  );
}
