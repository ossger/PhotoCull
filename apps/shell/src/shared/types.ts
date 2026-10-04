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

// ----- sort a card dump into event folders -----

// One proposed event: a run of captures with no gap longer than the threshold.
export interface EventProposal {
  id: string;
  start: string; // ISO local time of the first capture
  end: string;
  count: number; // captures (a RAW+JPEG pair counts once)
  files: number; // files on disk, incl. pairs and sidecars
  undated: number; // captures dated by file mtime (no EXIF date)
  default_name: string; // "YYYY-MM-DD" (+ a/b when a day has several)
  samples: string[]; // file names for eventThumbUrl
}

export interface EventsPlan {
  folder: string;
  gap_hours: number;
  total_units: number;
  total_files: number;
  orphans: string[]; // sidecars with no matching photo; left in place
  events: EventProposal[];
  can_undo: boolean;
}

export interface EventGroupInput {
  event_ids: string[];
  name: string;
}

export interface EventsProgress {
  state: "idle" | "running" | "complete" | "error";
  done: number;
  total: number;
  current: string | null;
  moved: number;
  renamed: number;
  folders: string[];
  error: string | null;
}

// The bridge exposed by the preload script to the renderer.
export interface PhotoCullBridge {
  pickFolder(title?: string, defaultPath?: string): Promise<string | null>;
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
  // Sort the loose files in one folder into "YYYY-MM-DD Name" event subfolders.
  eventsPlan(folder: string, gapHours: number): Promise<EventsPlan>;
  eventsRun(folder: string, gapHours: number, groups: EventGroupInput[]): Promise<{ started: boolean }>;
  eventsProgress(): Promise<EventsProgress>;
  eventsUndo(folder: string): Promise<{ restored: number; missing: number }>;
  eventThumbUrl(folder: string, name: string): string;
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
