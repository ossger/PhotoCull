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
  selectedSceneId: number | null;
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

  openFolder: () => Promise<void>;
  // Open a known folder as the shoot (no picker) — e.g. a freshly sorted event.
  openPath: (folder: string) => Promise<void>;
  // Drop the open shoot from the UI after the worker closed it (event sort moved its files).
  forgetShoot: () => void;
  refresh: () => Promise<void>;
  pollProgress: () => Promise<void>;

  selectImage: (id: number | null) => void;
  selectScene: (id: number | null) => void;
  // Move selection by +/- delta within the current scene's images. When
  // `extend` is set (shift+arrow), grows the range from the anchor instead
  // of replacing the selection.
  moveImage: (delta: number, extend?: boolean) => void;
  // Move selection between scenes (in order); selects the first image of the new scene
  moveScene: (delta: number) => void;

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
  setPickMany: (ids: number[], pick: -1 | 0 | 1) => Promise<void>;
  setStarsMany: (ids: number[], stars: number) => Promise<void>;
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
  sceneId: number | null,
  mode: SortMode,
  filters: FilterState,
): number[] {
  const base = scope === "matches" ? images : images.filter((i) => i.scene_id === sceneId);
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
  "filters" | "viewScope" | "selectedSceneId" | "selectedImageId" | "selectedIds" | "rangeAnchorId"
> {
  const filters = partial.filters ?? s.filters;
  const viewScope = partial.viewScope ?? s.viewScope;
  const visible = computeVisibleScenes(s.scenes, s.images, filters);
  const selectedSceneId =
    s.selectedSceneId != null && visible.some((sc) => sc.id === s.selectedSceneId)
      ? s.selectedSceneId
      : (visible[0]?.id ?? null);
  const ids = visibleImageIds(s.images, viewScope, selectedSceneId, s.sortMode, filters);
  const sameScene = selectedSceneId === s.selectedSceneId && viewScope === s.viewScope;
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
  return { filters, viewScope, selectedSceneId, selectedImageId, selectedIds, rangeAnchorId };
}

export const useStore = create<Store>((set, get) => ({
  shootRoot: null,
  images: [],
  scenes: [],
  selectedSceneId: null,
  selectedImageId: null,
  selectedIds: [],
  rangeAnchorId: null,
  viewMode: loadViewMode(),
  compareIds: [],
  compareMode: false,
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
        const ids = visibleImageIds(images, s.viewScope, validSceneId, s.sortMode, s.filters);
        const validImageId =
          s.selectedImageId != null && ids.includes(s.selectedImageId)
            ? s.selectedImageId
            : ids[0] ?? null;
        const sameScene = validSceneId === s.selectedSceneId;
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
      return {
        selectedImageId: id,
        selectedSceneId: img?.scene_id ?? s.selectedSceneId,
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
        selectedImageId: first,
        selectedIds: first != null ? [first] : [],
        rangeAnchorId: first,
        compareIds: [],
        compareMode: false,
      };
    });
  },

  moveImage(delta, extend = false) {
    const { images, viewScope, selectedSceneId, selectedImageId, sortMode, filters, rangeAnchorId } =
      get();
    const ids = visibleImageIds(images, viewScope, selectedSceneId, sortMode, filters);
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

  moveScene(delta) {
    const { viewScope, scenes, images, selectedSceneId, filters } = get();
    // Scene boundaries don't exist in the flattened Matches view.
    if (viewScope === "matches") return;
    const visible = computeVisibleScenes(scenes, images, filters);
    if (visible.length === 0) return;
    const idx = selectedSceneId == null ? 0 : visible.findIndex((s) => s.id === selectedSceneId);
    const next = Math.max(0, Math.min(visible.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextScene = visible[next];
    if (nextScene) get().selectScene(nextScene.id);
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
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneId, s.sortMode, s.filters);
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
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneId, s.sortMode, s.filters);
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
      const ids = visibleImageIds(s.images, s.viewScope, s.selectedSceneId, s.sortMode, s.filters);
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
      // Entering compare: seed from the current multi-selection (capped at
      // 4), falling back to just the primary image.
      const initial =
        s.selectedIds.length > 0
          ? s.selectedIds.slice(0, 4)
          : s.selectedImageId != null
            ? [s.selectedImageId]
            : [];
      return { compareMode: true, compareIds: initial };
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
      : state.images.filter((i) => i.scene_id === state.selectedSceneId);
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
