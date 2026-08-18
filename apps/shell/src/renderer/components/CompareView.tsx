import { useStore } from "../store";
import type { ImageRow } from "@shared/types";

interface CellProps {
  image: ImageRow;
  onPick: () => void;
}

function Cell({ image, onPick }: CellProps) {
  const src = image.preview_path ? window.photocull.previewUrl(image.preview_path) : "";
  const score = image.score_overall;
  return (
    <button
      type="button"
      onClick={onPick}
      className="relative bg-bg overflow-hidden flex items-center justify-center min-h-0 min-w-0
        border border-line hover:border-accent transition-colors"
      title={`Click to select ${image.filename}`}
    >
      {src ? (
        <img
          src={src}
          alt={image.filename}
          className="max-w-full max-h-full object-contain"
          draggable={false}
        />
      ) : (
        <div className="text-muted">No preview</div>
      )}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-2 text-xs">
        <span className="bg-black/60 px-2 py-0.5 rounded truncate max-w-[60%]">
          {image.filename}
        </span>
        {score != null && (
          <span className="bg-black/60 px-2 py-0.5 rounded font-mono">
            {score.toFixed(1)}
          </span>
        )}
      </div>
      {image.pick === 1 && (
        <div className="absolute bottom-2 left-2 text-[10px] uppercase font-semibold tracking-wide bg-pick text-black px-1.5 py-0.5 rounded">
          Pick
        </div>
      )}
    </button>
  );
}

export function CompareView() {
  const images = useStore((s) => s.images);
  const compareIds = useStore((s) => s.compareIds);
  const selectImage = useStore((s) => s.selectImage);
  const exitCompare = useStore((s) => s.exitCompare);

  const picked = compareIds
    .map((id) => images.find((i) => i.id === id))
    .filter((i): i is ImageRow => i != null);

  if (picked.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-muted gap-2 bg-bg">
        <div>Compare mode — select up to 4 frames, or click frames in the filmstrip to add them.</div>
        <div className="text-xs">Esc to exit</div>
      </div>
    );
  }

  // 1 image → single, 2 → side-by-side, 3 or 4 → 2x2 grid
  const grid =
    picked.length === 1
      ? "grid-cols-1 grid-rows-1"
      : picked.length === 2
        ? "grid-cols-2 grid-rows-1"
        : "grid-cols-2 grid-rows-2";

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      <div className={`flex-1 min-h-0 grid ${grid} gap-1 p-1`}>
        {picked.map((img) => (
          <Cell
            key={img.id}
            image={img}
            onPick={() => {
              selectImage(img.id);
              exitCompare();
            }}
          />
        ))}
      </div>
    </div>
  );
}
