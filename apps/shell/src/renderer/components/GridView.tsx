import { useEffect, useRef } from "react";
import { useStore, sceneImages } from "../store";
import { Thumbnail } from "./Thumbnail";
import { RankBadge } from "./RankBadge";
import { useMarquee, useThumbClick } from "../useMarquee";

// Contact-sheet grid — the natural home for marquee (click-drag) multi
// -select. Toggled against the loupe with G / the toolbar's Grid/Loupe switch.
export function GridView() {
  const images = useStore(sceneImages);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const selectedImageId = useStore((s) => s.selectedImageId);
  const selectedIds = useStore((s) => s.selectedIds);
  const sortMode = useStore((s) => s.sortMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const onThumbClick = useThumbClick();
  const { onPointerDown, onClickCapture, marqueeRect, previewIds } = useMarquee(containerRef);
  const effectiveSelected = previewIds ?? selectedIds;

  useEffect(() => {
    if (selectedImageId == null || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-image-id="${selectedImageId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedImageId]);

  if (images.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-muted text-sm bg-bg">
        {selectedSceneId == null ? "Select a scene to see its frames" : "No frames match the current filter"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
      className="relative flex-1 min-h-0 overflow-y-auto bg-bg p-3 grid gap-3 content-start
        grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]"
    >
      {images.map((img, idx) => (
        <div key={img.id} data-image-id={img.id} className="aspect-square relative">
          <Thumbnail
            image={img}
            selected={img.id === selectedImageId}
            inSelection={effectiveSelected.includes(img.id)}
            showScore
            onClick={(e) => onThumbClick(e, img.id)}
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
