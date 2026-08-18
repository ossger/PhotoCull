import { memo } from "react";
import type { ImageRow } from "@shared/types";

interface Props {
  image: ImageRow;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  showScore?: boolean;
  inCompare?: boolean;
  // A non-primary member of a multi-selection (the primary uses `selected`).
  inSelection?: boolean;
}

function Stars({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="text-yellow-400 text-xs leading-none">{"★".repeat(n)}</span>;
}

function PickBadge({ pick }: { pick: number }) {
  if (pick === 1)
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-pick text-black font-semibold">
        Pick
      </span>
    );
  if (pick === -1)
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-reject text-white font-semibold">
        Reject
      </span>
    );
  return null;
}

function ScoreBadge({ score }: { score: number }) {
  // Colour-grade by tier: 7+ green, 4-7 amber, <4 red
  const tier =
    score >= 7 ? "bg-pick text-black" : score >= 4 ? "bg-yellow-500 text-black" : "bg-reject text-white";
  return (
    <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${tier}`}>
      {score.toFixed(1)}
    </span>
  );
}

export const Thumbnail = memo(function Thumbnail({
  image,
  selected,
  onClick,
  showScore = false,
  inCompare = false,
  inSelection = false,
}: Props) {
  const src = image.thumb_path ? window.photocull.thumbUrl(image.thumb_path) : "";
  return (
    <button
      type="button"
      onClick={onClick}
      draggable={false}
      onPointerDown={(e) => e.preventDefault()}
      className={`relative group block w-full h-full overflow-hidden rounded-md
        border-2 transition-colors
        ${
          inCompare
            ? "border-accent ring-2 ring-accent"
            : selected
              ? "border-accent"
              : inSelection
                ? "border-accent/60"
                : "border-transparent hover:border-line"
        }`}
      title={image.filename}
    >
      {src ? (
        <img
          src={src}
          alt={image.filename}
          className="w-full h-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full bg-panel2 flex items-center justify-center text-muted text-xs">
          {image.filename}
        </div>
      )}
      {inSelection && !selected && !inCompare && (
        <div className="absolute inset-0 bg-accent/15 pointer-events-none" />
      )}
      {showScore && image.score_overall != null && (
        <div className="absolute top-1 left-1 pointer-events-none">
          <ScoreBadge score={image.score_overall} />
        </div>
      )}
      {image.crop_left != null && (
        <span
          className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] uppercase font-semibold
            tracking-wide px-1 py-0.5 rounded bg-black/70 text-ink pointer-events-none"
          title="Crop applied"
        >
          Crop
        </span>
      )}
      <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between pointer-events-none">
        <Stars n={image.stars} />
        <PickBadge pick={image.pick} />
      </div>
      {image.pick === -1 && (
        <div className="absolute inset-0 bg-black/40 pointer-events-none" />
      )}
    </button>
  );
});
