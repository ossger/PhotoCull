import { useEffect, useRef } from "react";
import { useStore, sceneImages } from "../store";
import { Thumbnail } from "./Thumbnail";

export function Filmstrip() {
  const images = useStore(sceneImages);
  const selectedImageId = useStore((s) => s.selectedImageId);
  const compareMode = useStore((s) => s.compareMode);
  const compareIds = useStore((s) => s.compareIds);
  const sortMode = useStore((s) => s.sortMode);
  const selectImage = useStore((s) => s.selectImage);
  const toggleCompareMember = useStore((s) => s.toggleCompareMember);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedImageId == null || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-image-id="${selectedImageId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedImageId]);

  if (images.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-muted text-sm border-t border-line bg-panel">
        Select a scene to see its frames
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-36 flex items-stretch gap-1.5 p-2 overflow-x-auto border-t border-line bg-panel"
    >
      {images.map((img, idx) => (
        <div
          key={img.id}
          data-image-id={img.id}
          className="w-32 h-full flex-shrink-0 relative"
        >
          <Thumbnail
            image={img}
            selected={img.id === selectedImageId && !compareMode}
            inCompare={compareMode && compareIds.includes(img.id)}
            showScore
            onClick={() => {
              if (compareMode) toggleCompareMember(img.id);
              else selectImage(img.id);
            }}
          />
          {sortMode === "rank" && (
            <span
              className="absolute top-1 right-1 text-[10px] font-mono font-semibold px-1.5 py-0.5
                rounded bg-black/70 text-ink pointer-events-none"
              title={`Rank ${idx + 1} of ${images.length} in this scene`}
            >
              #{idx + 1}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
