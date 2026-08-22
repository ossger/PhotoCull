// Shared types between main, preload, and renderer processes.

export interface ImageRow {
  id: number;
  rel_path: string;
  filename: string;
  captured_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  focus_mode: string | null;
  af_area_mode: string | null;
  af_points_in_focus: string | null;
  pick: -1 | 0 | 1;
  stars: number;
  color_label: string | null;
  scene_id: number | null;
  score_focus: number | null;
  score_exposure: number | null;
  score_eyes: number | null;
  n_faces: number | null;
  faces_json: string | null;
  score_aesthetic: number | null;
  score_overall: number | null;
  thumb_path: string | null;
  preview_path: string | null;
  full_path: string | null;
  crop_left: number | null;
  crop_top: number | null;
  crop_right: number | null;
  crop_bottom: number | null;
}

export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// One detected face, all coordinates normalized 0..1 of the scored image.
// Mirror of the worker's FaceDetail, parsed from ImageRow.faces_json.
export interface FaceDetection {
  box: [number, number, number, number]; // x, y, w, h
  eyes_open: number | null; // 0..10, or null when the face couldn't be eye-scored
  left_eye: [number, number] | null; // subject's left eye centre (image right)
  right_eye: [number, number] | null; // subject's right eye centre (image left)
}

export interface ShootProgress {
  state: "idle" | "running" | "complete";
  done: number;
  total: number;
  current: string | null;
}

export interface SceneRow {
  id: number;
  label: string | null;
  starts_at: string | null;
  ends_at: string | null;
  cover_image_id: number | null;
  image_count: number;
  cover_thumb: string | null;
  avg_score: number | null;
}

export interface OpenShootResult {
  root: string;
  cache: string;
}

// ----- card import / organize -----

// One destination folder in an import plan, e.g. "2026/2026-06-24_DJI-Drone".
export interface OrganizeGroup {
  folder: string;
  count: number;
}

// Dry preview of what an import would do (no files touched).
export interface OrganizePlan {
  total: number;
  groups: OrganizeGroup[];
  would_move: number;
  would_skip: number;
  would_rename: number;
}

export interface OrganizeRunResult {
  started: boolean;
  total: number;
}

export interface OrganizeProgress {
  state: "idle" | "running" | "complete";
  done: number;
  total: number;
  current: string | null;
  moved: number;
  skipped: number;
  renamed: number;
}

// The bridge exposed by the preload script to the renderer.
export interface PhotoCullBridge {
  pickFolder(): Promise<string | null>;
  openShoot(path: string): Promise<OpenShootResult>;
  shootProgress(): Promise<ShootProgress>;
  listImages(): Promise<ImageRow[]>;
  listScenes(): Promise<SceneRow[]>;
  regroupScenes(): Promise<{ scene_count: number }>;
  exportXmp(
    onlyPicked: boolean,
    imageIds?: number[],
  ): Promise<{ written: number; failed: number; sidecars: string[] }>;
  // Card import / organize. Paths are explicit (from folder pickers).
  organizePlan(source: string, library: string, label: string | null): Promise<OrganizePlan>;
  organizeRun(source: string, library: string, label: string | null): Promise<OrganizeRunResult>;
  organizeProgress(): Promise<OrganizeProgress>;
  setPick(imageId: number, pick: -1 | 0 | 1): Promise<void>;
  setStars(imageId: number, stars: number): Promise<void>;
  setColor(imageId: number, color: string | null): Promise<void>;
  setPickMany(imageIds: number[], pick: -1 | 0 | 1): Promise<void>;
  setStarsMany(imageIds: number[], stars: number): Promise<void>;
  setColorMany(imageIds: number[], color: string | null): Promise<void>;
  setCrop(imageId: number, crop: CropRect | null): Promise<void>;
  // URLs (with auth) that <img src> can load
  thumbUrl(rel: string): string;
  previewUrl(rel: string): string;
  // Full-resolution URL for a given image. JPEG sources stream from the
  // shoot root (full_path is null); RAW/HEIC stream from the cache.
  fullUrl(image: ImageRow): string;
}

declare global {
  interface Window {
    photocull: PhotoCullBridge;
  }
}
