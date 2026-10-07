import { useMemo } from "react";
import { useStore } from "../store";
import { activeCriterionCount, matchesFilters } from "../filters";
import { OrganizeModal } from "./OrganizeModal";
import { EventSortModal } from "./EventSortModal";
import { FilterPanel } from "./FilterPanel";
import { Dropdown } from "./Dropdown";

const BTN =
  "flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line";
const SEG = "flex items-center bg-panel2 border border-line rounded-md overflow-hidden text-xs";
const segBtn = (active: boolean) =>
  `px-2.5 py-1 ${active ? "bg-accent text-white" : "text-muted hover:text-ink"}`;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function Toolbar() {
  const openFolder = useStore((s) => s.openFolder);
  const shootRoot = useStore((s) => s.shootRoot);
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
  const viewMode = useStore((s) => s.viewMode);
  const toggleViewMode = useStore((s) => s.toggleViewMode);
  const compareMode = useStore((s) => s.compareMode);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const exportPicks = useStore((s) => s.exportPicks);
  const exportMatches = useStore((s) => s.exportMatches);
  const exportImageIds = useStore((s) => s.exportImageIds);
  const importOpen = useStore((s) => s.importOpen);
  const setImportOpen = useStore((s) => s.setImportOpen);
  const eventSortOpen = useStore((s) => s.eventSortOpen);
  const setEventSortOpen = useStore((s) => s.setEventSortOpen);

  const pickCount = images.filter((i) => i.pick === 1).length;
  const filterCount = activeCriterionCount(filters);
  const matchCount = useMemo(
    () => images.filter((i) => matchesFilters(i, filters, images)).length,
    [images, filters],
  );
  const hasShoot = shootRoot != null;

  // Grid / Loupe / Compare behave as one three-way switch even though compare
  // is its own store flag layered over the grid-vs-loupe mode.
  function showView(target: "grid" | "loupe") {
    if (compareMode) toggleCompare();
    if (viewMode !== target) toggleViewMode();
  }

  return (
    <>
      <div className="h-12 px-4 flex items-center gap-3 border-b border-line bg-panel">
        {/* Left: where you are + getting photos in */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {hasShoot ? (
            <button
              type="button"
              onClick={() => void window.photocull.revealPath(shootRoot)}
              title={`${shootRoot}\nClick to show in Finder`}
              className="min-w-0 truncate max-w-[18rem] font-semibold tracking-tight hover:text-accent"
            >
              {basename(shootRoot)}
            </button>
          ) : (
            <span className="font-semibold tracking-tight">PhotoCull</span>
          )}
          {hasShoot ? (
            <Dropdown
              buttonClass={BTN}
              title="Open a folder, import a card, or sort a card dump"
              trigger={<>Open ▾</>}
              items={[
                { label: "Open folder…", hint: "⌘O", onSelect: () => void openFolder() },
                { label: "Import from card…", hint: "⌘I", onSelect: () => setImportOpen(true) },
                { label: "Sort into events…", onSelect: () => setEventSortOpen(true) },
              ]}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => void openFolder()}
                className="flex-shrink-0 whitespace-nowrap px-3 py-1 rounded-md bg-accent text-white text-sm hover:opacity-90"
              >
                Open folder…
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                title="Sort a memory card into your dated library before culling"
                className={BTN}
              >
                Import…
              </button>
              <button
                type="button"
                onClick={() => setEventSortOpen(true)}
                title="Split a card dump folder into one subfolder per event"
                className={BTN}
              >
                Sort into events…
              </button>
            </>
          )}
        </div>

        {/* Center: how you're looking at it */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className={SEG}>
            <button
              type="button"
              onClick={() => showView("grid")}
              className={segBtn(!compareMode && viewMode === "grid")}
              title="Contact-sheet grid, for marquee (drag) multi-select (G)"
            >
              Grid
            </button>
            <button
              type="button"
              onClick={() => showView("loupe")}
              className={segBtn(!compareMode && viewMode === "loupe")}
              title="Single-frame loupe (G)"
            >
              Loupe
            </button>
            <button
              type="button"
              onClick={() => !compareMode && toggleCompare()}
              className={segBtn(compareMode)}
              title="Compare up to four frames side by side (C)"
            >
              Compare
            </button>
          </div>
          <div className={SEG}>
            <button
              type="button"
              onClick={() => viewScope !== "scenes" && setViewScope("scenes")}
              className={segBtn(viewScope === "scenes")}
              title="Browse scene by scene"
            >
              Scenes
            </button>
            <button
              type="button"
              onClick={() => viewScope !== "matches" && setViewScope("matches")}
              className={segBtn(viewScope === "matches")}
              title="Flatten the whole shoot into one filtered, ranked list (M)"
            >
              Matches
            </button>
          </div>
        </div>

        {/* Right: narrowing, ordering, and getting picks out */}
        <div className="flex items-center gap-2 flex-1 justify-end">
          <Dropdown
            align="right"
            buttonClass="text-xs rounded-md px-2.5 py-1 border border-line bg-panel2 text-muted hover:text-ink whitespace-nowrap"
            title="How frames are ordered within each scene"
            trigger={<>Sort: {sortMode === "rank" ? "Rank" : "Time"} ▾</>}
            items={[
              { label: "Rank (best score first)", checked: sortMode === "rank", onSelect: () => setSortMode("rank") },
              { label: "Time (capture order)", checked: sortMode === "time", onSelect: () => setSortMode("time") },
            ]}
          />
          <button
            id="filter-toggle-btn"
            type="button"
            onClick={toggleFilterPanel}
            className={`flex-shrink-0 text-xs rounded-md px-2.5 py-1 border bg-panel2 transition-colors ${
              filterPanelOpen || filterCount > 0
                ? "border-accent text-accent"
                : "border-line text-muted hover:text-ink"
            }`}
            title="Advanced culling filters (/)"
          >
            Filter{filterCount > 0 ? ` (${filterCount})` : ""}
          </button>
          <button
            type="button"
            onClick={toggleEyeZoom}
            aria-pressed={eyeZoom}
            className={`flex-shrink-0 text-xs rounded-md px-2.5 py-1 border bg-panel2 transition-colors ${
              eyeZoom ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
            }`}
            title={`Auto-zoom the loupe to the subject's eyes (E) — ${eyeZoom ? "on" : "off"}`}
          >
            👁 Eyes
          </button>
          <div className="flex items-stretch flex-shrink-0">
            <button
              type="button"
              onClick={() => void exportPicks()}
              disabled={!hasShoot || pickCount === 0}
              title={
                pickCount === 0
                  ? "No picks yet — press P on frames you want to keep"
                  : `Write XMP sidecars for ${pickCount} picked frame${pickCount === 1 ? "" : "s"}`
              }
              className="whitespace-nowrap pl-3 pr-2.5 py-1 rounded-l-md bg-accent text-white text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export picks ({pickCount})
            </button>
            <Dropdown
              align="right"
              title="More export options"
              buttonClass="h-full px-2 rounded-r-md bg-accent text-white text-sm border-l border-white/30 hover:opacity-90"
              trigger={<>▾</>}
              items={[
                {
                  label: `Export matches (${matchCount})`,
                  disabled: !hasShoot || matchCount === 0,
                  onSelect: () => void exportMatches(),
                },
                {
                  label: `Export selection (${selectedIds.length})`,
                  disabled: selectedIds.length === 0,
                  onSelect: () => void exportImageIds(selectedIds),
                },
              ]}
            />
          </div>
        </div>
      </div>
      {importOpen && <OrganizeModal onClose={() => setImportOpen(false)} />}
      {eventSortOpen && <EventSortModal onClose={() => setEventSortOpen(false)} />}
      {filterPanelOpen && <FilterPanel />}
    </>
  );
}
