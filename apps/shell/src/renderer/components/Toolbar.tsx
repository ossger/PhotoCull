import { useMemo, useState } from "react";
import { useStore } from "../store";
import { activeCriterionCount, matchesFilters } from "../filters";
import { OrganizeModal } from "./OrganizeModal";
import { EventSortModal } from "./EventSortModal";
import { FilterPanel } from "./FilterPanel";

export function Toolbar() {
  const openFolder = useStore((s) => s.openFolder);
  const shootRoot = useStore((s) => s.shootRoot);
  const progress = useStore((s) => s.progress);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const images = useStore((s) => s.images);
  const sortMode = useStore((s) => s.sortMode);
  const setSortMode = useStore((s) => s.setSortMode);
  const eyeZoom = useStore((s) => s.eyeZoom);
  const toggleEyeZoom = useStore((s) => s.toggleEyeZoom);
  const filters = useStore((s) => s.filters);
  const filterPanelOpen = useStore((s) => s.filterPanelOpen);
  const toggleFilterPanel = useStore((s) => s.toggleFilterPanel);
  const viewScope = useStore((s) => s.viewScope);
  const setViewScope = useStore((s) => s.setViewScope);
  const selectedIds = useStore((s) => s.selectedIds);
  const setPickMany = useStore((s) => s.setPickMany);
  const viewMode = useStore((s) => s.viewMode);
  const toggleViewMode = useStore((s) => s.toggleViewMode);

  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [eventSortOpen, setEventSortOpen] = useState(false);

  const pickCount = images.filter((i) => i.pick === 1).length;
  const filterCount = activeCriterionCount(filters);
  // Whole-shoot match set — independent of scene selection, so "Export
  // matches" and the Matches-mode status line agree with each other and with
  // the flattened list Matches mode shows.
  const matchIds = useMemo(
    () => images.filter((i) => matchesFilters(i, filters, images)).map((i) => i.id),
    [images, filters],
  );
  const matchCount = matchIds.length;

  async function exportPicks() {
    if (exporting || pickCount === 0) return;
    setExporting(true);
    setExportStatus("writing sidecars…");
    try {
      const result = await window.photocull.exportXmp(true);
      setExportStatus(
        result.failed > 0
          ? `wrote ${result.written}, failed ${result.failed}`
          : `wrote ${result.written} sidecar${result.written === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setExportStatus(`failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
      // Clear status after a few seconds so it doesn't linger
      setTimeout(() => setExportStatus(null), 5000);
    }
  }

  async function exportMatches() {
    if (exporting || matchCount === 0) return;
    setExporting(true);
    setExportStatus("writing sidecars…");
    try {
      const result = await window.photocull.exportXmp(false, matchIds);
      setExportStatus(
        result.failed > 0
          ? `wrote ${result.written}, failed ${result.failed}`
          : `wrote ${result.written} sidecar${result.written === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setExportStatus(`failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
      setTimeout(() => setExportStatus(null), 5000);
    }
  }

  const status = (() => {
    if (exportStatus) return <span className="text-muted">{exportStatus}</span>;
    if (notice) return <span className="text-muted">{notice}</span>;
    if (error) return <span className="text-reject">{error}</span>;
    if (progress.state === "running") {
      const pct =
        progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      return (
        <span className="text-muted">
          Ingesting {progress.done}/{progress.total} ({pct}%)
        </span>
      );
    }
    if (viewScope === "matches" && images.length > 0) {
      return (
        <span className="text-muted">
          {matchCount} of {images.length} frames match
        </span>
      );
    }
    if (progress.state === "complete" && progress.total > 0) {
      return <span className="text-muted">Loaded {progress.total} images</span>;
    }
    return <span className="text-muted">Ready</span>;
  })();

  return (
    <>
    <div className="h-12 px-4 flex items-center justify-between gap-3 border-b border-line bg-panel">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-semibold tracking-tight">PhotoCull</span>
        <button
          type="button"
          onClick={openFolder}
          className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
        >
          Open folder…
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          title="Sort a memory card into your dated library before culling"
          className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
        >
          Import…
        </button>
        <button
          type="button"
          onClick={() => setEventSortOpen(true)}
          title="Split a card dump folder into one subfolder per event"
          className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
        >
          Sort into events…
        </button>
        <button
          type="button"
          onClick={exportPicks}
          disabled={exporting || pickCount === 0}
          title={
            pickCount === 0
              ? "No picks yet — press P on frames you want to keep"
              : `Write XMP sidecars for ${pickCount} picked frame${pickCount === 1 ? "" : "s"}`
          }
          className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line disabled:opacity-40 disabled:cursor-not-allowed text-sm border border-line"
        >
          {exporting ? "Exporting…" : `Export picks (${pickCount})`}
        </button>
        <button
          type="button"
          onClick={exportMatches}
          disabled={exporting || matchCount === 0}
          title={
            matchCount === 0
              ? "No frames match the current filter"
              : `Write XMP sidecars for ${matchCount} matching frame${matchCount === 1 ? "" : "s"}`
          }
          className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line disabled:opacity-40 disabled:cursor-not-allowed text-sm border border-line"
        >
          {exporting ? "Exporting…" : `Export matches (${matchCount})`}
        </button>
        {shootRoot && (
          <span className="text-muted text-sm truncate max-w-[42rem]" title={shootRoot}>
            {shootRoot}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {selectedIds.length > 1 && (
          <div className="flex items-center gap-1.5 bg-panel2 border border-line rounded-md pl-2 pr-1 py-1 text-xs">
            <span className="text-muted">{selectedIds.length} selected</span>
            <button
              type="button"
              onClick={() => setPickMany(selectedIds, 1)}
              className="px-2 py-0.5 rounded bg-pick/20 text-pick hover:bg-pick/30"
              title="Pick all selected frames (P)"
            >
              Pick
            </button>
            <button
              type="button"
              onClick={() => setPickMany(selectedIds, -1)}
              className="px-2 py-0.5 rounded bg-reject/20 text-reject hover:bg-reject/30"
              title="Reject all selected frames (X)"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setPickMany(selectedIds, 0)}
              className="px-2 py-0.5 rounded text-muted hover:text-ink hover:bg-line"
              title="Unset pick on all selected frames (U)"
            >
              Unset
            </button>
          </div>
        )}
        <div className="flex items-center bg-panel2 border border-line rounded-md overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => viewMode !== "grid" && toggleViewMode()}
            className={`px-2.5 py-1 ${viewMode === "grid" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Contact-sheet grid, for marquee (drag) multi-select (G)"
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => viewMode !== "loupe" && toggleViewMode()}
            className={`px-2.5 py-1 ${viewMode === "loupe" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Single-frame loupe (G)"
          >
            Loupe
          </button>
        </div>
        <div className="flex items-center bg-panel2 border border-line rounded-md overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => viewScope !== "scenes" && setViewScope("scenes")}
            className={`px-2.5 py-1 ${viewScope === "scenes" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Browse scene by scene"
          >
            Scenes
          </button>
          <button
            type="button"
            onClick={() => viewScope !== "matches" && setViewScope("matches")}
            className={`px-2.5 py-1 ${viewScope === "matches" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Flatten the whole shoot into one filtered, ranked list (M)"
          >
            Matches
          </button>
        </div>
        <button
          type="button"
          onClick={toggleEyeZoom}
          className={`text-xs rounded-md px-2.5 py-1 border bg-panel2 transition-colors ${
            eyeZoom ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
          }`}
          title="Auto-zoom the loupe to the subject's eyes on each frame (E)"
        >
          Eye-zoom {eyeZoom ? "on" : "off"}
        </button>
        <button
          id="filter-toggle-btn"
          type="button"
          onClick={toggleFilterPanel}
          className={`text-xs rounded-md px-2.5 py-1 border bg-panel2 transition-colors ${
            filterPanelOpen || filterCount > 0
              ? "border-accent text-accent"
              : "border-line text-muted hover:text-ink"
          }`}
          title="Advanced culling filters (/)"
        >
          Filter{filterCount > 0 ? ` (${filterCount})` : ""}
        </button>
        <div className="flex items-center bg-panel2 border border-line rounded-md overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setSortMode("rank")}
            className={`px-2.5 py-1 ${sortMode === "rank" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Sort each scene by AI score, best first"
          >
            Rank
          </button>
          <button
            type="button"
            onClick={() => setSortMode("time")}
            className={`px-2.5 py-1 ${sortMode === "time" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            title="Sort each scene chronologically"
          >
            Time
          </button>
        </div>
      </div>
      <div className="text-sm text-right truncate max-w-[16rem] flex-shrink-0">{status}</div>
    </div>
    {importOpen && <OrganizeModal onClose={() => setImportOpen(false)} />}
    {eventSortOpen && <EventSortModal onClose={() => setEventSortOpen(false)} />}
    {filterPanelOpen && <FilterPanel />}
    </>
  );
}
