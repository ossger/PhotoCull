import { create } from "zustand";
import type { CropRect, ImageRow, SceneRow, ShootProgress } from "@shared/types";

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

interface Store {
  shootRoot: string | null;
  images: ImageRow[];
  scenes: SceneRow[];
  selectedSceneId: number | null;
  selectedImageId: number | null;
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
  progress: ShootProgress;
  loading: boolean;
  error: string | null;

  openFolder: () => Promise<void>;
  refresh: () => Promise<void>;
  pollProgress: () => Promise<void>;

  selectImage: (id: number | null) => void;
  selectScene: (id: number | null) => void;
  // Move selection by +/- delta within the current scene's images
  moveImage: (delta: number) => void;
  // Move selection between scenes (in order); selects the first image of the new scene
  moveScene: (delta: number) => void;

  toggleCompare: () => void;
  toggleCompareMember: (id: number) => void;
  exitCompare: () => void;

  setSortMode: (mode: SortMode) => void;

  toggleFaces: () => void;
  toggleEyeZoom: () => void;

  enterCropMode: () => void;
  exitCropMode: () => void;
  setCropDraft: (rect: CropRect | null) => void;
  applyCropDraft: () => Promise<void>;
  clearCrop: () => Promise<void>;

  setPick: (id: number, pick: -1 | 0 | 1) => Promise<void>;
  setStars: (id: number, stars: number) => Promise<void>;
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

function sceneImageIds(images: ImageRow[], sceneId: number | null, mode: SortMode): number[] {
  return sortByMode(images.filter((i) => i.scene_id === sceneId), mode).map((i) => i.id);
}

export const useStore = create<Store>((set, get) => ({
  shootRoot: null,
  images: [],
  scenes: [],
  selectedSceneId: null,
  selectedImageId: null,
  compareIds: [],
  compareMode: false,
  cropMode: false,
  cropDraft: null,
  showFaces: false,
  eyeZoom: loadEyeZoom(),
  sortMode: "rank",
  progress: { state: "idle", done: 0, total: 0, current: null },
  loading: false,
  error: null,

  async openFolder() {
    set({ error: null });
    const folder = await window.photocull.pickFolder();
    if (!folder) return;
    set({
      loading: true,
      images: [],
      scenes: [],
      selectedSceneId: null,
      selectedImageId: null,
      compareIds: [],
      compareMode: false,
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
        const sceneImages = images.filter((i) => i.scene_id === validSceneId);
        const validImageId =
          s.selectedImageId != null && sceneImages.some((i) => i.id === s.selectedImageId)
            ? s.selectedImageId
            : sceneImages[0]?.id ?? null;
        return {
          images,
          scenes,
          selectedSceneId: validSceneId,
          selectedImageId: validImageId,
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
      // Selecting an image implicitly switches to that image's scene.
      const img = id == null ? null : s.images.find((i) => i.id === id);
      return {
        selectedImageId: id,
        selectedSceneId: img?.scene_id ?? s.selectedSceneId,
      };
    });
  },

  selectScene(id) {
    set((s) => {
      // First in the *sorted* order — so in rank mode the best frame is shown
      // immediately when you click a scene.
      const ids = sceneImageIds(s.images, id, s.sortMode);
      return {
        selectedSceneId: id,
        selectedImageId: ids[0] ?? null,
        compareIds: [],
        compareMode: false,
      };
    });
  },

  moveImage(delta) {
    const { images, selectedSceneId, selectedImageId, sortMode } = get();
    const ids = sceneImageIds(images, selectedSceneId, sortMode);
    if (ids.length === 0) return;
    const idx = selectedImageId == null ? 0 : ids.indexOf(selectedImageId);
    const next = Math.max(0, Math.min(ids.length - 1, (idx < 0 ? 0 : idx) + delta));
    set({ selectedImageId: ids[next] ?? null });
  },

  moveScene(delta) {
    const { scenes, selectedSceneId } = get();
    if (scenes.length === 0) return;
    const idx = selectedSceneId == null ? 0 : scenes.findIndex((s) => s.id === selectedSceneId);
    const next = Math.max(0, Math.min(scenes.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextScene = scenes[next];
    if (nextScene) get().selectScene(nextScene.id);
  },

  toggleCompare() {
    set((s) => {
      if (s.compareMode) return { compareMode: false, compareIds: [] };
      // Entering compare: start with the currently-selected image
      const initial = s.selectedImageId != null ? [s.selectedImageId] : [];
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
      return { cropMode: true, cropDraft: existing, compareMode: false, compareIds: [] };
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
    set((s) => ({
      images: s.images.map((i) => (i.id === id ? { ...i, pick } : i)),
    }));
    try {
      await window.photocull.setPick(id, pick);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },

  async setStars(id, stars) {
    set((s) => ({
      images: s.images.map((i) => (i.id === id ? { ...i, stars } : i)),
    }));
    try {
      await window.photocull.setStars(id, stars);
    } catch (err) {
      set({ error: (err as Error).message });
      await get().refresh();
    }
  },
}));

// Selector helpers
export const sceneImages = (state: Store): ImageRow[] =>
  sortByMode(
    state.images.filter((i) => i.scene_id === state.selectedSceneId),
    state.sortMode,
  );
