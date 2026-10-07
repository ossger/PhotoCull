import { create } from "zustand";
import type { CropRect, ImageRow, SceneRow, ShootProgress } from "@shared/types";
import {
  activeCriterionCount,
  emptyFilters,
  matchesFilters,
  type FilterPreset,
  type FilterState,
} from "./filters";

export type SortMode = "rank" | "time";

const EYE_ZOOM_KEY = "photocull.eyeZoom";

function loadEyeZoom(): boolean {
  try {
    const v = localStorage.getItem(EYE_ZOOM_KEY);
    return v == null ? true : v === "1";
  } catch {
    return true;
  }
}

export type ViewMode = "loupe" | "grid";

const VIEW_MODE_KEY = "photocull.viewMode";

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "loupe";
  } catch {
    return "loupe";
  }
}

// "scenes" = today's model, filters applied within the selected scene.
// "matches" = scene boundaries dissolved — one flat, filtered, ranked list
// across the whole shoot (e.g. "everything above an overall score of 7").
export type ViewScope = "scenes" | "matches";

const FILTER_PANEL_KEY = "photocull.filterPanelOpen";

function loadFilterPanelOpen(): boolean {
  try {
    return localStorage.getItem(FILTER_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

interface Store {
  shootRoot: string | null;
  images: ImageRow[];
  scenes: SceneRow[];
  // The "primary" scene (last clicked). Always a member of selectedSceneIds
  // when that is non-empty.
  selectedSceneId: number | null;
  // Multi-select in the scene sidebar. The filmstrip/grid show the union of
  // these scenes' frames.
  selectedSceneIds: number[];
  // Pivot for shift-click range selection in the scene sidebar.
  sceneAnchorId: number | null;
  // The "primary" image — what the loupe/crop/faces overlay shows. Always a
  // member of selectedIds when selectedIds is non-empty.
  selectedImageId: number | null;
  // Multi-select for batch pick/reject/star. Scene-scoped: reset whenever the
  // selected scene changes. Order is not meaningful.
  selectedIds: number[];
  // Pivot for shift-click / shift+arrow range selection.
  rangeAnchorId: number | null;
  viewMode: ViewMode;
  compareIds: number[];
  compareMode: boolean;
  // Compare view: mirror one cell's zoom/pan onto every other cell (hotkey L
  // while comparing). Off by default; not persisted.
  compareSyncZoom: boolean;
  // The filmstrip lives in its own window (main-window side only; the main
  // process tells us). Not part of the pop-out sync.
  filmstripPoppedOut: boolean;
  // Crop edit mode + the draft rect while editing. Committed crops live on
  // the ImageRow (crop_left/top/right/bottom) and persist through the worker.
  cropMode: boolean;
  cropDraft: CropRect | null;
  // Toggle for the face/eye detection overlay in the loupe (hotkey F).
  showFaces: boolean;
  // Auto-zoom the loupe to the subject's eyes on each frame (hotkey E). Persisted.
  eyeZoom: boolean;
  sortMode: SortMode;
  // Advanced culling filters (see filters.ts) — criteria over scores, picks,
  // stars, colour, faces, camera/lens/exposure settings, capture time, and
  // scene-level aggregates. Applied within the current scope: a single scene
  // (viewScope "scenes") or the whole shoot flattened (viewScope "matches").
  filters: FilterState;
  viewScope: ViewScope;
  filterPanelOpen: boolean;
  progress: ShootProgress;
  loading: boolean;
  error: string | null;
  // Transient status line (menu actions: export results, merge, …). Auto-clears.
  notice: string | null;
  // Scene whose card is showing the inline rename input (UI-only).
  renamingSceneId: number | null;

  openFolder: () => Promise<void>;
  // Open a known folder as the shoot (no picker) — e.g. a freshly sorted event.
  openPath: (folder: string) => Promise<void>;
  // Drop the open shoot from the UI after the worker closed it (event sort moved its files).
  forgetShoot: () => void;
  refresh: () => Promise<void>;
  pollProgress: () => Promise<void>;

  selectImage: (id: number | null) => void;
  selectScene: (id: number | null) => void;
  // Scene multi-select (cmd/ctrl-click, shift-click, shift+arrow, right-click).
  toggleScene: (id: number) => void;
  selectSceneRange: (id: number) => void;
  setSceneSelection: (ids: number[], primary?: number | null) => void;
  selectAllScenes: () => void;
  // Move selection by +/- delta within the current scene's images. When
  // `extend` is set (shift+arrow), grows the range from the anchor instead
  // of replacing the selection.
  moveImage: (delta: number, extend?: boolean) => void;
  // Move selection between scenes (in order); selects the first image of the new scene
  // When `extend` is set (shift+arrow) the scene range grows from the anchor.
  moveScene: (delta: number, extend?: boolean) => void;

  // Multi-select (cmd/ctrl-click, shift-click, shift+cmd-click, marquee drag).
  toggleSelect: (id: number) => void;
  selectRange: (id: number) => void;
  extendRange: (id: number) => void;
  setSelection: (ids: number[], primary?: number | null) => void;
  selectAllInScene: () => void;
  // Collapses back to just the primary image (or clears entirely if none).
  clearSelection: () => void;

  toggleViewMode: () => void;

  toggleCompare: () => void;
  toggleCompareMember: (id: number) => void;
  exitCompare: () => void;
  toggleCompareSyncZoom: () => void;
  setFilmstripPoppedOut: (poppedOut: boolean) => void;

  setSortMode: (mode: SortMode) => void;
  setFilters: (filters: FilterState) => void;
  applyPreset: (preset: FilterPreset) => void;
  clearFilters: () => void;
  setViewScope: (scope: ViewScope) => void;
  toggleFilterPanel: () => void;

  toggleFaces: () => void;
  toggleEyeZoom: () => void;

  enterCropMode: () => void;
  exitCropMode: () => void;
  setCropDraft: (rect: CropRect | null) => void;
  applyCropDraft: () => Promise<void>;
  clearCrop: () => Promise<void>;

  setPick: (id: number, pick: -1 | 0 | 1) => Promise<void>;
  setStars: (id: number, stars: number) => Promise<void>;
  setColorMany: (ids: number[], color: string | null) => Promise<void>;
  setPickMany: (ids: number[], pick: -1 | 0 | 1) => Promise<void>;
  setStarsMany: (ids: number[], stars: number) => Promise<void>;

  // Scene editing (hand edits survive re-ingest — see worker scenes.py).
  mergeScenes: (sceneIds: number[]) => Promise<void>;
  splitSceneAt: (imageId: number) => Promise<void>;
  renameScene: (sceneId: number, label: string) => Promise<void>;
  setSceneCover: (sceneId: number, imageId: number) => Promise<void>;
  moveImagesToScene: (imageIds: number[], sceneId: number | null) => Promise<void>;
  resetSceneGrouping: () => Promise<void>;
  setRenamingScene: (id: number | null) => void;
  exportImageIds: (ids: number[]) => Promise<void>;
  exportPicks: () => Promise<void>;
  exportMatches: () => Promise<void>;
  showNotice: (msg: string) => void;

  // Which top-level dialogs are open (driven by the toolbar, menu and hotkeys).
  importOpen: boolean;
  eventSortOpen: boolean;
  shortcutsOpen: boolean;
  setImportOpen: (open: boolean) => void;
  setEventSortOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;

  // Star stacking. `stackPanelIds` is the frame set the panel is open on (null = closed).
  stackPanelIds: number[] | null;
  openStackPanel: (ids?: number[]) => void;
  closeStackPanel: () => void;
  markStarSequence: (sceneId: number, on: boolean) => Promise<void>;
}

function sortByMode(images: ImageRow[], mode: SortMode): ImageRow[] {
  if (mode === "time") return images;
  // Rank: highest overall score first; NULLs to the end; ties broken by
  // capture time so the order is stable.
  return [...images].sort((a, b) => {
    const sa = a.score_overall;
    const sb = b.score_overall;
    if (sa == null && sb == null) {
      return (a.captured_at ?? "").localeCompare(b.captured_at ?? "");
    }
    if (sa == null) return 1;
    if (sb == null) return -1;
    if (sb !== sa) return sb - sa;
    return (a.captured_at ?? "").localeCompare(b.captured_at ?? "");
  });
}

// The single choke point every filtered view goes through. `allImages` is
// always the full shoot list — scene-level criteria need it even when
// `images` is already narrowed to one scene (or is the whole shoot in
// Matches mode, in which case the two happen to be equal).
function filterImages(images: ImageRow[], allImages: ImageRow[], filters: FilterState): ImageRow[] {
  return images.filter((i) => matchesFilters(i, filters, allImages));
}

function computeVisibleScenes(
  scenes: SceneRow[],
  images: ImageRow[],
  filters: FilterState,
): SceneRow[] {
  if (activeCriterionCount(filters) === 0) return scenes; // fast path: no filter
  const passing = new Set<number | null>();
  for (const img of filterImages(images, images, filters)) {
    passing.add(img.scene_id);
  }
  return scenes.filter((s) => passing.has(s.id));
}

// Ordered, filtered ids for the current view: one scene's images, or — in
// Matches mode — the whole shoot flattened, scene boundaries dissolved.
function visibleImageIds(
  images: ImageRow[],
  scope: ViewScope,
  sceneId: number | readonly number[] | null,
  mode: SortMode,
  filters: FilterState,
): number[] {
  const wanted = sceneId == null ? [] : typeof sceneId === "number" ? [sceneId] : sceneId;
  const base =
    scope === "matches" ? images : images.filter((i) => i.scene_id != null && wanted.includes(i.scene_id));
  return sortByMode(filterImages(base, images, filters), mode).map((i) => i.id);
}

// Ids from anchor to target inclusive, in the current visible order — used
// for shift-click / shift+arrow range selection. Falls back to just the
// target if either endpoint isn't in the visible list (e.g. filtered out).
function rangeIds(orderedIds: number[], anchor: number | null, target: number): number[] {
  const i1 = anchor == null ? -1 : orderedIds.indexOf(anchor);
  const i2 = orderedIds.indexOf(target);
  if (i1 === -1 || i2 === -1) return [target];
  const [lo, hi] = i1 <= i2 ? [i1, i2] : [i2, i1];
  return orderedIds.slice(lo, hi + 1);
}

// Drop ids that are no longer visible (filtered out / scene changed); falls
// back to `fallback` (the new primary) if that empties the selection.
function pruneSelection(
  selectedIds: number[],
  validIds: number[],
  fallback: number | null,
): number[] {
  const kept = selectedIds.filter((id) => validIds.includes(id));
  if (kept.length > 0) return kept;
  return fallback != null ? [fallback] : [];
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// Keep only still-visible scenes in the scene multi-selection, always
// including the primary; falls back to just the primary.
function repairSceneSelection(
  selected: readonly number[],
  visible: readonly SceneRow[],
  primary: number | null,
): number[] {
  const kept = selected.filter((id) => visible.some((sc) => sc.id === id));
  if (primary != null && !kept.includes(primary)) kept.push(primary);
  return kept.length > 0 ? kept : primary != null ? [primary] : [];
}

// Shared selection-repair after any change to filters or viewScope:
// re-derive the visible scene, re-derive the visible image ids within it,
// prune the multi-selection down to what's still visible, and fix the range
// anchor. Every filter/scope mutator below routes through this so none of
// them can drift out of sync with the others (this used to be copy-pasted
// per mutator — see git history for the pre-filters.ts shape).
function applyFilterChange(
  s: Store,
  partial: { filters?: FilterState; viewScope?: ViewScope },
): Pick<
  Store,
  | "filters"
  | "viewScope"
  | "selectedSceneId"
  | "selectedSceneIds"
  | "sceneAnchorId"
  | "selectedImageId"
  | "selectedIds"
  | "rangeAnchorId"
> {
  const filters = partial.filters ?? s.filters;
  const viewScope = partial.viewScope ?? s.viewScope;
  const visible = computeVisibleScenes(s.scenes, s.images, filters);
  const selectedSceneId =
    s.selectedSceneId != null && visible.some((sc) => sc.id === s.selectedSceneId)
      ? s.selectedSceneId
      : (visible[0]?.id ?? null);
  const selectedSceneIds = repairSceneSelection(s.selectedSceneIds, visible, selectedSceneId);
  const ids = visibleImageIds(s.images, viewScope, selectedSceneIds, s.sortMode, filters);
  const sameScene =
    sameIds(selectedSceneIds, s.selectedSceneIds) && viewScope === s.viewScope;
  const selectedImageId =
    sameScene && s.selectedImageId != null && ids.includes(s.selectedImageId)
      ? s.selectedImageId
      : (ids[0] ?? null);
  const selectedIds = sameScene
    ? pruneSelection(s.selectedIds, ids, selectedImageId)
    : selectedImageId != null
      ? [selectedImageId]
      : [];
  const rangeAnchorId =
    sameScene && s.rangeAnchorId != null && ids.includes(s.rangeAnchorId)
      ? s.rangeAnchorId
      : selectedImageId;
  const sceneAnchorId =
    s.sceneAnchorId != null && selectedSceneIds.includes(s.sceneAnchorId)
      ? s.sceneAnchorId
      : selectedSceneId;
  return {
    filters,
    viewScope,
    selectedSceneId,
    selectedSceneIds,
    sceneAnchorId,
    selectedImageId,
    selectedIds,
    rangeAnchorId,
  };
}

export const useStore = create<Store>((set, get) => ({
  shootRoot: null,
  images: [],
  scenes: [],
  selectedSceneId: null,
  selectedSceneIds: [],
  sceneAnchorId: null,
  selectedImageId: null,
  selectedIds: [],
  rangeAnchorId: null,
  viewMode: loadViewMode(),
  compareIds: [],
  compareMode: false,
  compareSyncZoom: false,
  filmstripPoppedOut: false,
  cropMode: false,
  cropDraft: null,
  showFaces: false,
  eyeZoom: loadEyeZoom(),
  sortMode: "rank",
  filters: emptyFilters(),
  viewScope: "scenes",
  filterPanelOpen: loadFilterPanelOpen(),
  progress: { state: "idle", done: 0, total: 0, current: null },
  loading: false,
  error: null,
  notice: null,
  renamingSceneId: null,
  importOpen: false,
  eventSortOpen: false,
  shortcutsOpen: false,
  stackPanelIds: null,

  async openFolder() {
    set({ error: null });
    const folder = await window.photocull.pickFolder();
    if (!folder) return;
    await get().openPath(folder);
  },

  forgetShoot() {
    set({
      shootRoot: null,
      images: [],
      scenes: [],
      selectedSceneId: null,
      selectedSceneIds: [],
      sceneAnchorId: null,
      selectedImageId: null,
      selectedIds: [],
      rangeAnchorId: null,
      compareIds: [],
      compareMode: false,
      progress: { state: "idle", done: 0, total: 0, current: null },
    });
  },

  async openPath(folder: string) {
    set({
      error: null,
      loading: true,
      images: [],
      scenes: [],
      selectedSceneId: null,
      selectedSceneIds: [],
      sceneAnchorId: null,
      selectedImageId: null,
      selectedIds: [],
      rangeAnchorId: null,
      compareIds: [],
      compareMode: false,
      // A fresh shoot shouldn't open with frames hidden by a stale filter.
      filters: emptyFilters(),
      viewScope: "scenes",
    });
    try {
      const result = await window.photocull.openShoot(folder);
      set({ shootRoot: result.root });
      await get().pollProgress();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  async refresh() {
    try {
      const [images, scenes] = await Promise.all([
        window.photocull.listImages(),
        window.photocull.listScenes(),
      ]);
      set((s) => {
        const validSceneId =
          s.selectedSceneId != null && scenes.some((sc) => sc.id === s.selectedSceneId)
            ? s.selectedSceneId
            : scenes[0]?.id ?? null;
        const validSceneIds = repairSceneSelection(s.selectedSceneIds, scenes, validSceneId);
        const ids = visibleImageIds(images, s.viewScope, validSceneIds, s.sortMode, s.filters);
        const validImageId =
          s.selectedImageId != null && ids.includes(s.selectedImageId)
            ? s.selectedImageId
            : ids[0] ?? null;
        const sameScene = sameIds(validSceneIds, s.selectedSceneIds);
        const selectedIds = sameScene
          ? pruneSelection(s.selectedIds, ids, validImageId)
          : validImageId != null
            ? [validImageId]
            : [];
        const rangeAnchorId =
          sameScene && s.rangeAnchorId != null && ids.includes(s.rangeAnchorId)
            ? s.rangeAnchorId
            : validImageId;
        return {
          images,
          scenes,
          selectedSceneId: validSceneId,
          selectedSceneIds: validSceneIds,
          sceneAnchorId:
            s.sceneAnchorId != null && validSceneIds.includes(s.sceneAnchorId)
              ? s.sceneAnchorId
              : validSceneId,
          selectedImageId: validImageId,
          selectedIds,
          rangeAnchorId,
        };
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async pollProgress() {
    const tick = async () => {
      try {
        const progress = await window.photocull.shootProgress();
        set({ progress });
        await get().refresh();
        if (progress.state !== "complete") {
          setTimeout(tick, 700);
        }
      } catch (err) {
        set({ error: (err as Error).message });
      }
    };
    await tick();
  },

  selectImage(id) {
    set((s) => {
      // Selecting an image implicitly switches to that image's scene, and
      // collapses any multi-selection down to just this frame.
      const img = id == null ? null : s.images.find((i) => i.id === id);
      const sceneId = img?.scene_id ?? s.selectedSceneId;
      const inSet = sceneId != null && s.selectedSceneIds.includes(sceneId);
      return {
        selectedImageId: id,
        selectedSceneId: sceneId,
        selectedSceneIds: inSet ? s.selectedSceneIds : sceneId != null ? [sceneId] : [],
        sceneAnchorId: inSet ? s.sceneAnchorId : sceneId,
        selectedIds: id == null ? [] : [id],
        rangeAnchorId: id,
      };
    });
  },

  selectScene(id) {
    set((s) => {
      // First in the *sorted* order — so in rank mode the best frame is shown
      // immediately when you click a scene.
      const ids = visibleImageIds(s.images, s.viewScope, id, s.sortMode, s.filters);
      const first = ids[0] ?? null;
      return {
        selectedSceneId: id,
        selectedSceneIds: id != null ? [id] : [],
        sceneAnchorId: id,
        selectedImageId: first,
        selectedIds: first != null ? [first] : [],
        rangeAnchorId: first,
        compareIds: [],
        compareMode: false,
      };
    });
  },

  // Re-derive the frame selection after the scene set changed: primary image
  // is the top of the union view, and the frame selection collapses to it.
  setSceneSelection(ids, primary) {
    set((s) => {
      const p = primary !== undefined ? primary : ids[ids.length - 1] ?? null;
      const frames = visibleImageIds(s.images, s.viewScope, ids, s.sortMode, s.filters);
      const keep =
        s.selectedImageId != null && frames.includes(s.selectedImageId) ? s.selectedImageId : frames[0] ?? null;
      return {
        selectedSceneId: p,
        selectedSceneIds: ids,
        sceneAnchorId: p,
        selectedImageId: keep,
        selectedIds: keep != null ? [keep] : [],
        rangeAnchorId: keep,
        compareIds: [],
        compareMode: false,
      };
    });
  },

  toggleScene(id) {
    const s = get();
    const was = s.selectedSceneIds.includes(id);
    if (was && s.selectedSceneIds.length === 1) return; // never empty the selection
    const ids = was ? s.selectedSceneIds.filter((x) => x !== id) : [...s.selectedSceneIds, id];
    const primary = was && s.selectedSceneId === id ? ids[ids.length - 1] ?? null : id;
    get().setSceneSelection(ids, primary);
    set({ sceneAnchorId: id });
  },

  selectSceneRange(id) {
    const s = get();
    const order = computeVisibleScenes(s.scenes, s.images, s.filters).map((sc) => sc.id);
    const anchor = s.sceneAnchorId ?? s.selectedSceneId ?? id;
    get().setSceneSelection(rangeIds(order, anchor, id), id);
    set({ sceneAnchorId: anchor });
  },

  selectAllScenes() {
    const s = get();
    const order = computeVisibleScenes(s.scenes, s.images, s.filters).map((sc) => sc.id);
    if (order.length === 0) return;
    get().setSceneSelection(order, s.selectedSceneId ?? order[order.length - 1]);
  },

  moveImage(delta, extend = false) {
    const { images, viewScope, selectedSceneIds, selectedImageId, sortMode, filters, rangeAnchorId } =
      get();
    const ids = visibleImageIds(images, viewScope, selectedSceneIds, sortMode, filters);
    if (ids.length === 0) return;
    const idx = selectedImageId == null ? 0 : ids.indexOf(selectedImageId);
    const next = Math.max(0, Math.min(ids.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextId = ids[next] ?? null;
    if (extend && nextId != null) {
      const anchor = rangeAnchorId ?? selectedImageId ?? nextId;
      set({
        selectedImageId: nextId,
        selectedIds: rangeIds(ids, anchor, nextId),
        rangeAnchorId: anchor,
      });
    } else {
      set({
        selectedImageId: nextId,
        selectedIds: nextId != null ? [nextId] : [],
        rangeAnchorId: nextId,
      });
    }
  },

  moveScene(delta, extend = false) {
    const { viewScope, scenes, images, selectedSceneId, filters } = get();
    // Scene boundaries don't exist in the flattened Matches view.
    if (viewScope === "matches") return;
    const visible = computeVisibleScenes(scenes, images, filters);
    if (visible.length === 0) return;
    const idx = selectedSceneId == null ? 0 : visible.findIndex((s) => s.id === selectedSceneId);
    const next = Math.max(0, Math.min(visible.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextScene = visible[next];
    if (!nextScene) return;
    if (extend) get().selectSceneRange(nextScene.id);
    else get().selectScene(nextScene.id);
  },

  toggleSelect(id) {
    set((s) => {
      const wasSelected = s.selectedIds.includes(id);
      const selectedIds = wasSelected
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id];
      const selectedImageId =
        wasSelected && s.selectedImageId === id
          ? selectedIds[selectedIds.length - 1] ?? null
          : id;
      return { selectedIds, selectedImageId, rangeAnchorId: id };
    });
  },

  selectRange(id) {
    set((s) => {
      const anchor = s.rangeAnchorId ?? s.selectedImageId ?? id;
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneIds, s.sortMode, s.filters);
      return {
        selectedIds: rangeIds(ids, anchor, id),
        selectedImageId: id,
        rangeAnchorId: anchor,
      };
    });
  },

  extendRange(id) {
    set((s) => {
      const anchor = s.rangeAnchorId ?? s.selectedImageId ?? id;
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneIds, s.sortMode, s.filters);
      const union = Array.from(new Set([...s.selectedIds, ...rangeIds(ids, anchor, id)]));
      return { selectedIds: union, selectedImageId: id, rangeAnchorId: anchor };
    });
  },

  setSelection(ids, primary) {
    set(() => {
      const p = primary !== undefined ? primary : ids[ids.length - 1] ?? null;
      return { selectedIds: ids, selectedImageId: p, rangeAnchorId: p };
    });
  },

  selectAllInScene() {
    set((s) => {
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneIds, s.sortMode, s.filters);
      const primary =
        s.selectedImageId != null && ids.includes(s.selectedImageId)
          ? s.selectedImageId
          : ids[ids.length - 1] ?? null;
      return { selectedIds: ids, selectedImageId: primary, rangeAnchorId: primary };
    });
  },

  clearSelection() {
    set((s) => ({
      selectedIds: s.selectedImageId != null ? [s.selectedImageId] : [],
      rangeAnchorId: s.selectedImageId,
    }));
  },

  toggleViewMode() {
    set((s) => {
      const next: ViewMode = s.viewMode === "grid" ? "loupe" : "grid";
      try {
        localStorage.setItem(VIEW_MODE_KEY, next);
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
      return { viewMode: next };
    });
  },

  toggleCompare() {
    set((s) => {
      if (s.compareMode) return { compareMode: false, compareIds: [] };
      // Entering compare: an explicit multi-selection (2+) wins, capped at 4.
      if (s.selectedIds.length >= 2) {
        return { compareMode: true, compareIds: s.selectedIds.slice(0, 4) };
      }
      // Otherwise seed four frames: the primary plus the next three in the
      // order the filmstrip shows (same as the sceneImages selector),
      // backfilling with the frames before it near the end of the scene.
      const primary = s.selectedImageId ?? s.selectedIds[0] ?? null;
      if (primary == null) return { compareMode: true, compareIds: [] };
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneIds, s.sortMode, s.filters);
      const idx = ids.indexOf(primary);
      if (idx === -1) return { compareMode: true, compareIds: [primary] };
      const start = Math.max(0, Math.min(idx, ids.length - 4));
      return { compareMode: true, compareIds: ids.slice(start, start + 4) };
    });
  },

  toggleCompareMember(id) {
    set((s) => {
      if (!s.compareMode) return s;
      if (s.compareIds.includes(id)) {
        return { compareIds: s.compareIds.filter((x) => x !== id) };
      }
      // Cap at 4 — Narrative Select tops out there and the layout breaks past that
      if (s.compareIds.length >= 4) {
        return { compareIds: [...s.compareIds.slice(1), id] };
      }
      return { compareIds: [...s.compareIds, id] };
    });
  },

  exitCompare() {
    set({ compareMode: false, compareIds: [] });
  },

  toggleCompareSyncZoom() {
    set((s) => ({ compareSyncZoom: !s.compareSyncZoom }));
  },

  setFilmstripPoppedOut(poppedOut) {
    set({ filmstripPoppedOut: poppedOut });
  },

  setSortMode(mode) {
    set({ sortMode: mode });
  },

  setFilters(filters) {
    set((s) => applyFilterChange(s, { filters }));
  },

  applyPreset(preset) {
    set((s) => applyFilterChange(s, { filters: preset.build() }));
  },

  clearFilters() {
    set((s) => applyFilterChange(s, { filters: emptyFilters() }));
  },

  setViewScope(scope) {
    set((s) => applyFilterChange(s, { viewScope: scope }));
  },

  toggleFilterPanel() {
    set((s) => {
      const next = !s.filterPanelOpen;
      try {
        localStorage.setItem(FILTER_PANEL_KEY, next ? "1" : "0");
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
      return { filterPanelOpen: next };
    });
  },

  toggleFaces() {
    set((s) => ({ showFaces: !s.showFaces }));
  },

  toggleEyeZoom() {
    set((s) => {
      const next = !s.eyeZoom;
      try {
        localStorage.setItem(EYE_ZOOM_KEY, next ? "1" : "0");
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
      return { eyeZoom: next };
    });
  },

  enterCropMode() {
    set((s) => {
      const img =
        s.selectedImageId == null
          ? null
          : s.images.find((i) => i.id === s.selectedImageId);
      if (!img) return s;
      // Seed the draft with the existing crop if any, else a centred 90% box
      // so the user has something visible to drag rather than starting empty.
      const existing: CropRect | null =
        img.crop_left != null && img.crop_top != null && img.crop_right != null && img.crop_bottom != null
          ? {
              left: img.crop_left,
              top: img.crop_top,
              right: img.crop_right,
              bottom: img.crop_bottom,
            }
          : { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 };
      // Cropping needs the loupe — drop out of grid view if it was active.
      return {
        cropMode: true,
        cropDraft: existing,
        compareMode: false,
        compareIds: [],
        viewMode: "loupe",
      };
    });
  },

  exitCropMode() {
    set({ cropMode: false, cropDraft: null });
  },

  setCropDraft(rect) {
    set({ cropDraft: rect });
  },

  async applyCropDraft() {
    const { selectedImageId, cropDraft } = get();
    if (selectedImageId == null || cropDraft == null) {
      set({ cropMode: false, cropDraft: null });
      return;
    }
    // Optimistic update on the row
    set((s) => ({
      images: s.images.map((i) =>
        i.id === selectedImageId
          ? {
              ...i,
              crop_left: cropDraft.left,
              crop_top: cropDraft.top,
              crop_right: cropDraft.right,
              crop_bottom: cropDraft.bottom,
            }
          : i,
      ),
      cropMode: false,
      cropDraft: null,
    }));
    try {
      await window.photocull.setCrop(selectedImageId, cropDraft);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },

  async clearCrop() {
    const { selectedImageId } = get();
    if (selectedImageId == null) return;
    set((s) => ({
      images: s.images.map((i) =>
        i.id === selectedImageId
          ? { ...i, crop_left: null, crop_top: null, crop_right: null, crop_bottom: null }
          : i,
      ),
      cropMode: false,
      cropDraft: null,
    }));
    try {
      await window.photocull.setCrop(selectedImageId, null);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },

  async setPick(id, pick) {
    await get().setPickMany([id], pick);
  },

  async setStars(id, stars) {
    await get().setStarsMany([id], stars);
  },

  async setPickMany(ids, pick) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((s) => ({
      images: s.images.map((i) => (idSet.has(i.id) ? { ...i, pick } : i)),
    }));
    try {
      await window.photocull.setPickMany(ids, pick);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },

  async setColorMany(ids, color) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((s) => ({
      images: s.images.map((i) => (idSet.has(i.id) ? { ...i, color_label: color } : i)),
    }));
    try {
      await window.photocull.setColorMany(ids, color);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },

  showNotice(msg) {
    set({ notice: msg });
    setTimeout(() => {
      if (get().notice === msg) set({ notice: null });
    }, 5000);
  },

  setRenamingScene(id) {
    set({ renamingSceneId: id });
  },

  async mergeScenes(sceneIds) {
    if (sceneIds.length < 2) return;
    try {
      const { scene_id } = await window.photocull.mergeScenes(sceneIds);
      await get().refresh();
      get().setSceneSelection([scene_id], scene_id);
      get().showNotice(`merged ${sceneIds.length} scenes`);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async splitSceneAt(imageId) {
    const img = get().images.find((i) => i.id === imageId);
    if (!img || img.scene_id == null) return;
    const oldScene = img.scene_id;
    try {
      const { scene_id } = await window.photocull.splitScene(oldScene, imageId);
      await get().refresh();
      get().setSceneSelection([oldScene, scene_id], scene_id);
      get().selectImage(imageId);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async renameScene(sceneId, label) {
    set({ renamingSceneId: null });
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      await window.photocull.updateScene(sceneId, { label: trimmed });
      await get().refresh();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async setSceneCover(sceneId, imageId) {
    try {
      await window.photocull.updateScene(sceneId, { cover_image_id: imageId });
      await get().refresh();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async moveImagesToScene(imageIds, sceneId) {
    if (imageIds.length === 0) return;
    try {
      const { scene_id } = await window.photocull.moveImagesToScene(imageIds, sceneId);
      await get().refresh();
      // Follow the moved frames: show the destination scene with them selected.
      get().setSceneSelection([scene_id], scene_id);
      get().setSelection(imageIds, imageIds[imageIds.length - 1]);
      get().showNotice(`moved ${imageIds.length} ${imageIds.length === 1 ? "photo" : "photos"}`);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async resetSceneGrouping() {
    try {
      await window.photocull.regroupScenes(true);
      await get().refresh();
      get().showNotice("scenes reset to automatic grouping");
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async exportImageIds(ids) {
    if (ids.length === 0) return;
    get().showNotice("writing sidecars…");
    try {
      const r = await window.photocull.exportXmp(false, ids);
      get().showNotice(
        r.failed > 0 ? `wrote ${r.written}, failed ${r.failed}` : `wrote ${r.written} sidecar${r.written === 1 ? "" : "s"}`,
      );
    } catch (err) {
      get().showNotice(`export failed: ${(err as Error).message}`);
    }
  },

  async exportPicks() {
    const ids = get().images.filter((i) => i.pick === 1).map((i) => i.id);
    if (ids.length === 0) {
      get().showNotice("no picks yet — press P on frames you want to keep");
      return;
    }
    get().showNotice("writing sidecars…");
    try {
      const r = await window.photocull.exportXmp(true);
      get().showNotice(
        r.failed > 0 ? `wrote ${r.written}, failed ${r.failed}` : `wrote ${r.written} sidecar${r.written === 1 ? "" : "s"}`,
      );
    } catch (err) {
      get().showNotice(`export failed: ${(err as Error).message}`);
    }
  },

  async exportMatches() {
    const { images, filters } = get();
    const ids = images.filter((i) => matchesFilters(i, filters, images)).map((i) => i.id);
    if (ids.length === 0) {
      get().showNotice("no frames match the current filter");
      return;
    }
    await get().exportImageIds(ids);
  },

  setImportOpen(open) {
    set({ importOpen: open });
  },
  setEventSortOpen(open) {
    set({ eventSortOpen: open });
  },
  setShortcutsOpen(open) {
    set({ shortcutsOpen: open });
  },

  openStackPanel(ids) {
    const s = get();
    // No explicit set: a multi-selection wins, else the whole current scene.
    const chosen = ids ?? (s.selectedIds.length >= 3 ? s.selectedIds : sceneImages(s).map((i) => i.id));
    if (chosen.length < 3) {
      get().showNotice("Select a star sequence (at least 3 frames) to stack");
      return;
    }
    set({ stackPanelIds: chosen });
  },
  closeStackPanel() {
    set({ stackPanelIds: null });
  },
  async markStarSequence(sceneId, on) {
    try {
      await window.photocull.updateScene(sceneId, { kind: on ? "astro" : "" });
      await get().refresh();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async setStarsMany(ids, stars) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((s) => ({
      images: s.images.map((i) => (idSet.has(i.id) ? { ...i, stars } : i)),
    }));
    try {
      await window.photocull.setStarsMany(ids, stars);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },
}));

// Selector helpers
// Scenes with at least one image passing the current filters — used by the
// sidebar so fully-filtered-out scenes don't show.
export const visibleScenes = (state: Store): SceneRow[] =>
  computeVisibleScenes(state.scenes, state.images, state.filters);

// The images for the current view: a single scene's, filtered and sorted —
// or, in Matches mode, the whole shoot flattened, filtered, and sorted, scene
// boundaries dissolved. Filmstrip / GridView don't need to know which mode is
// active; they just render what this returns.
export const sceneImages = (state: Store): ImageRow[] => {
  const base =
    state.viewScope === "matches"
      ? state.images
      : state.images.filter(
          (i) => i.scene_id != null && state.selectedSceneIds.includes(i.scene_id),
        );
  return sortByMode(filterImages(base, state.images, state.filters), state.sortMode);
};

// Per-scene count of images passing the current filters, for the sidebar's
// "N of M frames" — scene.image_count is an unfiltered SQL aggregate and reads
// wrong on its own the moment a filter is active.
export const sceneMatchCounts = (state: Store): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const img of filterImages(state.images, state.images, state.filters)) {
    if (img.scene_id == null) continue;
    counts.set(img.scene_id, (counts.get(img.scene_id) ?? 0) + 1);
  }
  return counts;
};
