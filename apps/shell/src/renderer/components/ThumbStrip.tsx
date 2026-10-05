import { useEffect, useRef } from "react";
import { useStore, sceneImages } from "../store";
import { Thumbnail } from "./Thumbnail";
import { useMarquee, useThumbClick } from "../useMarquee";
import { RankBadge } from "./RankBadge";

// The filmstrip's thumbnails, shared by the docked strip ("row": one
// horizontally scrolling row) and the torn-off window ("grid": wrapping,
// vertically scrolling). `size` is the thumbnail edge in CSS px — width
// scales with the strip's height when docked, the grid's minimum cell in the
// pop-out. Click / modifier-click / marquee / compare toggling behave the
// same in both; in the pop-out the store actions they call are forwarded to
// the main window (see filmstripSync.ts).
export function ThumbStrip({ layout, size }: { layout: "row" | "grid"; size: number }) {
  const images = useStore(sceneImages);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const selectedImageId = useStore((s) => s.selectedImageId);
  const selectedIds = useStore((s) => s.selectedIds);
  const compareMode = useStore((s) => s.compareMode);
  const compareIds = useStore((s) => s.compareIds);
  const sortMode = useStore((s) => s.sortMode);
  const toggleCompareMember = useStore((s) => s.toggleCompareMember);
  const containerRef = useRef<HTMLDivElement>(null);
  const onThumbClick = useThumbClick();
  const { onPointerDown, onClickCapture, marqueeRect, previewIds } = useMarquee(containerRef);
  const effectiveSelected = previewIds ?? selectedIds;
  const isRow = layout === "row";

  useEffect(() => {
    if (selectedImageId == null || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-image-id="${selectedImageId}"]`,
    );
    el?.scrollIntoView(
      isRow
        ? { block: "nearest", inline: "center", behavior: "smooth" }
        : { block: "nearest", behavior: "smooth" },
    );
  }, [selectedImageId, isRow]);

  if (images.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-muted text-sm bg-panel ${isRow ? "" : "flex-1 min-h-0"}`}
        style={isRow ? { height: size + 16 } : undefined}
      >
        {selectedSceneId == null ? "Select a scene to see its frames" : "No frames match the current filter"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={compareMode ? undefined : onPointerDown}
      onClickCapture={compareMode ? undefined : onClickCapture}
      className={
        isRow
          ? "relative flex items-stretch gap-1.5 p-2 overflow-x-auto bg-panel"
          : "relative flex-1 min-h-0 overflow-y-auto bg-bg p-2 grid gap-2 content-start"
      }
      style={
        isRow
          ? { height: size + 16 }
          : { gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }
      }
    >
      {images.map((img, idx) => (
        <div
          key={img.id}
          data-image-id={img.id}
          className={isRow ? "h-full flex-shrink-0 relative" : "aspect-square relative"}
          style={isRow ? { width: size } : undefined}
        >
          <Thumbnail
            image={img}
            selected={img.id === selectedImageId && !compareMode}
            inSelection={!compareMode && effectiveSelected.includes(img.id)}
            inCompare={compareMode && compareIds.includes(img.id)}
            showScore
            onClick={(e) => {
              if (compareMode) toggleCompareMember(img.id);
              else onThumbClick(e, img.id);
            }}
          />
          {sortMode === "rank" && <RankBadge rank={idx + 1} total={images.length} />}
        </div>
      ))}
      {marqueeRect && (
        <div
          className="absolute border border-accent bg-accent/20 pointer-events-none"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}
    </div>
  );
}

// Thin labelled range input used by both filmstrip surfaces.
export function SizeSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-muted" title="Thumbnail size">
      <span aria-hidden className="text-[10px]">▫</span>
      <input
        type="range"
        min={min}
        max={max}
        step={4}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        // Hand focus back after a mouse drag so culling hotkeys (which skip
        // focused inputs) keep working without an extra click.
        onPointerUp={(e) => e.currentTarget.blur()}
        className="w-24 accent-accent h-3"
        aria-label="Thumbnail size"
      />
      <span aria-hidden className="text-sm leading-none">▢</span>
    </label>
  );
}
