// Shared "#n of total" badge shown on a thumbnail when sorted by rank.
// Used by both the filmstrip and the grid view.
export function RankBadge({ rank, total }: { rank: number; total: number }) {
  return (
    <span
      className="absolute top-1 right-1 text-[10px] font-mono font-semibold px-1.5 py-0.5
        rounded bg-black/70 text-ink pointer-events-none"
      title={`Rank ${rank} of ${total} in this scene`}
    >
      #{rank}
    </span>
  );
}
