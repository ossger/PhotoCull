import { useMemo } from "react";
import { useStore } from "../store";
import { matchesFilters } from "../filters";

// Bottom bar: what the app is doing (status / ingest progress) on the left,
// a few context hints and the shortcuts link on the right.
export function StatusBar() {
  const progress = useStore((s) => s.progress);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const images = useStore((s) => s.images);
  const filters = useStore((s) => s.filters);
  const viewScope = useStore((s) => s.viewScope);
  const compareMode = useStore((s) => s.compareMode);
  const cropMode = useStore((s) => s.cropMode);
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen);
  const matchCount = useMemo(
    () =>
      viewScope === "matches" ? images.filter((i) => matchesFilters(i, filters, images)).length : 0,
    [images, filters, viewScope],
  );

  const running = progress.state === "running";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  let status: React.ReactNode;
  if (notice) status = <span className="text-ink">{notice}</span>;
  else if (error) status = <span className="text-reject">{error}</span>;
  else if (running)
    status = (
      <span className="text-ink">
        {progress.phase === "grouping"
          ? "Grouping scenes…"
          : `Ingesting ${progress.done}/${progress.total} (${pct}%)`}
      </span>
    );
  else if (viewScope === "matches" && images.length > 0)
    status = (
      <span>
        {matchCount} of {images.length} frames match
      </span>
    );
  else if (progress.state === "complete" && (progress.total > 0 || progress.failed))
    status = (
      <span>
        {progress.total} images
        {progress.failed ? (
          <span
            className="text-reject ml-2"
            title={[
              ...(progress.failed_files ?? []),
              ...(progress.failed > (progress.failed_files?.length ?? 0)
                ? [`…and ${progress.failed - (progress.failed_files?.length ?? 0)} more`]
                : []),
            ].join("\n")}
          >
            · {progress.failed} couldn&apos;t be read
          </span>
        ) : null}
      </span>
    );
  else status = <span>Ready</span>;

  const hint = cropMode
    ? "Drag to crop · Enter apply · Esc cancel"
    : compareMode
      ? "Click filmstrip to add/remove · L sync zoom · Esc exit"
      : "←/→ frame · ↑/↓ scene · P pick · X reject · 0-5 stars";

  return (
    <div className="relative px-3 py-1.5 text-xs text-muted border-t border-line bg-panel2 flex items-center gap-4">
      {running && (
        <div
          className="absolute left-0 top-0 h-0.5 bg-accent transition-all"
          style={{ width: `${pct}%` }}
        />
      )}
      <div className="truncate min-w-0">{status}</div>
      <div className="ml-auto flex items-center gap-3 flex-shrink-0">
        <span className="truncate">{hint}</span>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          className="text-ink hover:text-accent"
          title="All keyboard shortcuts (?)"
        >
          ? Shortcuts
        </button>
      </div>
    </div>
  );
}
