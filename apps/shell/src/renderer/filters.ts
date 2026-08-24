// Advanced culling filter logic — pure, no store/React imports so the rules
// are inspectable and testable on their own.
//
// Every score on ImageRow is 0..10 or null (null = "not scored yet"; for
// score_eyes specifically, null also means "no faces detected" — a landscape
// isn't unscored so much as not applicable). Each score criterion therefore
// carries its own `includeUnscored`, defaulting true for eyes and false for
// everything else, rather than baking in one global null policy.
import type { ImageRow } from "@shared/types";

export type MatchMode = "all" | "any";
export type ScoreKey = "overall" | "focus" | "exposure" | "eyes" | "aesthetic";
export type SceneAgg = "best" | "avg" | "worst";
export type PickState = "picked" | "unset" | "rejected";
export type HasCropState = "any" | "yes" | "no";
export type Orientation = "landscape" | "portrait" | "square";

export const SCORE_KEYS: ScoreKey[] = ["overall", "focus", "exposure", "eyes", "aesthetic"];

export const SCORE_LABELS: Record<ScoreKey, string> = {
  overall: "Overall",
  focus: "Focus",
  exposure: "Exposure",
  eyes: "Eyes",
  aesthetic: "Aesthetic",
};

// A bound with either side open (null = unconstrained on that side).
export interface Range {
  min: number | null;
  max: number | null;
}

export interface ScoreCriterion extends Range {
  enabled: boolean;
  includeUnscored: boolean;
}

export interface SceneScoreCriterion extends ScoreCriterion {
  agg: SceneAgg;
}

export interface FilterState {
  // "all" = every enabled criterion must pass (AND); "any" = at least one
  // must pass (OR) — needed for e.g. "eyes closed OR out of focus".
  matchMode: MatchMode;

  scores: Record<ScoreKey, ScoreCriterion>;
  sceneScores: Record<ScoreKey, SceneScoreCriterion>;

  picks: PickState[]; // empty = no constraint
  stars: Range;
  colors: string[]; // empty = no constraint; color_label must match one
  hasCrop: HasCropState;

  facesCount: Range; // against n_faces

  cameras: string[]; // empty = no constraint; against cameraLabel(img)
  lenses: string[]; // empty = no constraint; against lensLabel(img)
  iso: Range;
  aperture: Range;
  focalLength: Range;
  shutterSec: Range; // parsed from the TEXT shutter field, in seconds
  orientation: Orientation[]; // empty = no constraint

  capturedFrom: string | null; // ISO-ish string, compared lexicographically
  capturedTo: string | null;
  filenameContains: string;

  sceneFrameCount: Range; // count of images sharing the frame's scene_id
}

// ----- range helpers -----

export function isRangeActive(r: Range): boolean {
  return r.min != null || r.max != null;
}

function inRange(v: number, r: Range): boolean {
  if (r.min != null && v < r.min) return false;
  if (r.max != null && v > r.max) return false;
  return true;
}

// null = criterion not active (caller should ignore); a value that fails to
// resolve (image has no data for this field) always reads as a miss, not a
// pass — an ISO filter shouldn't match a frame with no ISO recorded.
function rangePredicate(value: number | null, r: Range): boolean | null {
  if (!isRangeActive(r)) return null;
  if (value == null) return false;
  return inRange(value, r);
}

function pushIf(preds: boolean[], v: boolean | null): void {
  if (v != null) preds.push(v);
}

// ----- score access -----

function scoreValue(img: ImageRow, key: ScoreKey): number | null {
  switch (key) {
    case "overall":
      return img.score_overall;
    case "focus":
      return img.score_focus;
    case "exposure":
      return img.score_exposure;
    case "eyes":
      return img.score_eyes;
    case "aesthetic":
      return img.score_aesthetic;
  }
}

function evalScoreCriterion(value: number | null, c: Range & { includeUnscored: boolean }): boolean {
  if (value == null) return c.includeUnscored;
  return inRange(value, c);
}

// Best/average/worst of a score across a scene's member images. Always
// computed over the full shoot's images for that scene_id — a fixed scene
// property, not one that shrinks as other filters narrow what's on screen.
export function sceneAggregate(
  images: ImageRow[],
  sceneId: number | null,
  key: ScoreKey,
  agg: SceneAgg,
): number | null {
  const vals: number[] = [];
  for (const img of images) {
    if (img.scene_id !== sceneId) continue;
    const v = scoreValue(img, key);
    if (v != null) vals.push(v);
  }
  if (vals.length === 0) return null;
  if (agg === "best") return Math.max(...vals);
  if (agg === "worst") return Math.min(...vals);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ----- field labels (shared between facet generation and predicates so a
// filter chip built from one always matches the other) -----

export function cameraLabel(img: ImageRow): string {
  return [img.camera_make, img.camera_model].filter(Boolean).join(" ") || "Unknown camera";
}

export function lensLabel(img: ImageRow): string {
  return img.lens ?? "Unknown lens";
}

export function orientationOf(img: ImageRow): Orientation | null {
  if (img.width == null || img.height == null) return null;
  if (img.width === img.height) return "square";
  return img.width > img.height ? "landscape" : "portrait";
}

// Shutter is stored as text ("1/250", "2s", "0.5") — parse to seconds so it's
// range-filterable. Returns null when unparseable.
export function parseShutter(s: string | null): number | null {
  if (!s) return null;
  const str = s.trim().replace(/s$/i, "");
  if (str.includes("/")) {
    const [nStr, dStr] = str.split("/");
    const n = Number(nStr);
    const d = Number(dStr);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return n / d;
  }
  const v = Number(str);
  return Number.isFinite(v) ? v : null;
}

export function uniqueSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) =>
    a.localeCompare(b),
  );
}

// ----- per-criterion predicates (each returns null when inactive) -----

function picksPredicate(img: ImageRow, picks: PickState[]): boolean | null {
  if (picks.length === 0) return null;
  const state: PickState = img.pick === 1 ? "picked" : img.pick === -1 ? "rejected" : "unset";
  return picks.includes(state);
}

function colorsPredicate(img: ImageRow, colors: string[]): boolean | null {
  if (colors.length === 0) return null;
  if (!img.color_label) return false;
  const label = img.color_label.toLowerCase();
  return colors.some((c) => c.toLowerCase() === label);
}

function hasCropPredicate(img: ImageRow, state: HasCropState): boolean | null {
  if (state === "any") return null;
  const has = img.crop_left != null;
  return state === "yes" ? has : !has;
}

function cameraPredicate(img: ImageRow, cameras: string[]): boolean | null {
  if (cameras.length === 0) return null;
  return cameras.includes(cameraLabel(img));
}

function lensPredicate(img: ImageRow, lenses: string[]): boolean | null {
  if (lenses.length === 0) return null;
  return lenses.includes(lensLabel(img));
}

function orientationPredicate(img: ImageRow, wanted: Orientation[]): boolean | null {
  if (wanted.length === 0) return null;
  const o = orientationOf(img);
  return o != null && wanted.includes(o);
}

function capturedPredicate(img: ImageRow, from: string | null, to: string | null): boolean | null {
  if (!from && !to) return null;
  if (!img.captured_at) return false;
  if (from && img.captured_at < from) return false;
  if (to && img.captured_at > to) return false;
  return true;
}

function filenamePredicate(img: ImageRow, query: string): boolean | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return img.filename.toLowerCase().includes(q);
}

function sceneFrameCountPredicate(img: ImageRow, allImages: ImageRow[], r: Range): boolean | null {
  if (!isRangeActive(r)) return null;
  const count = allImages.reduce((n, i) => (i.scene_id === img.scene_id ? n + 1 : n), 0);
  return inRange(count, r);
}

// ----- the combinator -----

// `allImages` must be the full, unfiltered shoot list — scene-level criteria
// (aggregate scores, frame count) need it regardless of what subset `img` is
// drawn from (a single scene, or the whole shoot in Matches mode).
export function matchesFilters(img: ImageRow, filters: FilterState, allImages: ImageRow[]): boolean {
  const preds: boolean[] = [];

  for (const key of SCORE_KEYS) {
    const c = filters.scores[key];
    if (c.enabled) preds.push(evalScoreCriterion(scoreValue(img, key), c));
  }
  for (const key of SCORE_KEYS) {
    const c = filters.sceneScores[key];
    if (c.enabled) preds.push(evalScoreCriterion(sceneAggregate(allImages, img.scene_id, key, c.agg), c));
  }

  pushIf(preds, picksPredicate(img, filters.picks));
  pushIf(preds, rangePredicate(img.stars, filters.stars));
  pushIf(preds, colorsPredicate(img, filters.colors));
  pushIf(preds, hasCropPredicate(img, filters.hasCrop));
  pushIf(preds, rangePredicate(img.n_faces, filters.facesCount));
  pushIf(preds, cameraPredicate(img, filters.cameras));
  pushIf(preds, lensPredicate(img, filters.lenses));
  pushIf(preds, rangePredicate(img.iso, filters.iso));
  pushIf(preds, rangePredicate(img.aperture, filters.aperture));
  pushIf(preds, rangePredicate(img.focal_length, filters.focalLength));
  pushIf(preds, rangePredicate(parseShutter(img.shutter), filters.shutterSec));
  pushIf(preds, orientationPredicate(img, filters.orientation));
  pushIf(preds, capturedPredicate(img, filters.capturedFrom, filters.capturedTo));
  pushIf(preds, filenamePredicate(img, filters.filenameContains));
  pushIf(preds, sceneFrameCountPredicate(img, allImages, filters.sceneFrameCount));

  if (preds.length === 0) return true; // no active criteria = show everything
  return filters.matchMode === "all" ? preds.every(Boolean) : preds.some(Boolean);
}

export function activeCriterionCount(filters: FilterState): number {
  let n = 0;
  for (const key of SCORE_KEYS) if (filters.scores[key].enabled) n++;
  for (const key of SCORE_KEYS) if (filters.sceneScores[key].enabled) n++;
  if (filters.picks.length > 0) n++;
  if (isRangeActive(filters.stars)) n++;
  if (filters.colors.length > 0) n++;
  if (filters.hasCrop !== "any") n++;
  if (isRangeActive(filters.facesCount)) n++;
  if (filters.cameras.length > 0) n++;
  if (filters.lenses.length > 0) n++;
  if (isRangeActive(filters.iso)) n++;
  if (isRangeActive(filters.aperture)) n++;
  if (isRangeActive(filters.focalLength)) n++;
  if (isRangeActive(filters.shutterSec)) n++;
  if (filters.orientation.length > 0) n++;
  if (filters.capturedFrom || filters.capturedTo) n++;
  if (filters.filenameContains.trim() !== "") n++;
  if (isRangeActive(filters.sceneFrameCount)) n++;
  return n;
}

// ----- defaults -----

function defaultIncludeUnscored(key: ScoreKey): boolean {
  return key === "eyes"; // every faceless frame has score_eyes === null by design
}

function emptyScoreCriterion(key: ScoreKey): ScoreCriterion {
  return { enabled: false, min: null, max: null, includeUnscored: defaultIncludeUnscored(key) };
}

function emptySceneScoreCriterion(key: ScoreKey): SceneScoreCriterion {
  // "best" by default: out of the box, a scene-level filter answers "does
  // this scene have anything usable" rather than the stricter "is every
  // frame in it usable" — switchable per criterion in the panel.
  return { ...emptyScoreCriterion(key), agg: "best" };
}

export function emptyFilters(): FilterState {
  return {
    matchMode: "all",
    scores: {
      overall: emptyScoreCriterion("overall"),
      focus: emptyScoreCriterion("focus"),
      exposure: emptyScoreCriterion("exposure"),
      eyes: emptyScoreCriterion("eyes"),
      aesthetic: emptyScoreCriterion("aesthetic"),
    },
    sceneScores: {
      overall: emptySceneScoreCriterion("overall"),
      focus: emptySceneScoreCriterion("focus"),
      exposure: emptySceneScoreCriterion("exposure"),
      eyes: emptySceneScoreCriterion("eyes"),
      aesthetic: emptySceneScoreCriterion("aesthetic"),
    },
    picks: [],
    stars: { min: null, max: null },
    colors: [],
    hasCrop: "any",
    facesCount: { min: null, max: null },
    cameras: [],
    lenses: [],
    iso: { min: null, max: null },
    aperture: { min: null, max: null },
    focalLength: { min: null, max: null },
    shutterSec: { min: null, max: null },
    orientation: [],
    capturedFrom: null,
    capturedTo: null,
    filenameContains: "",
    sceneFrameCount: { min: null, max: null },
  };
}

// ----- presets: one-click filters that populate the (still-editable) criteria -----

function withScore(
  f: FilterState,
  key: ScoreKey,
  patch: Partial<Omit<ScoreCriterion, "enabled">>,
): FilterState {
  return { ...f, scores: { ...f.scores, [key]: { ...f.scores[key], enabled: true, ...patch } } };
}

function withPicks(f: FilterState, picks: PickState[]): FilterState {
  return { ...f, picks };
}

function withStars(f: FilterState, min: number | null, max: number | null): FilterState {
  return { ...f, stars: { min, max } };
}

function withMatchMode(f: FilterState, matchMode: MatchMode): FilterState {
  return { ...f, matchMode };
}

export interface FilterPreset {
  id: string;
  label: string;
  hint: string;
  build: () => FilterState;
}

export const PRESETS: FilterPreset[] = [
  {
    id: "keepers",
    label: "Keepers",
    hint: "Overall ≥ 7, focus ≥ 6, eyes ≥ 6",
    build: () =>
      withScore(withScore(withScore(emptyFilters(), "overall", { min: 7 }), "focus", { min: 6 }), "eyes", {
        min: 6,
      }),
  },
  {
    id: "technically-clean",
    label: "Technically clean",
    hint: "Focus ≥ 7, exposure ≥ 6",
    build: () => withScore(withScore(emptyFilters(), "focus", { min: 7 }), "exposure", { min: 6 }),
  },
  {
    id: "needs-a-look",
    label: "Needs a look",
    hint: "Overall 5–7, not yet picked",
    build: () => withPicks(withScore(emptyFilters(), "overall", { min: 5, max: 7 }), ["unset"]),
  },
  {
    id: "blinks-and-misses",
    label: "Blinks & misses",
    hint: "Eyes ≤ 4 or focus ≤ 4 (excludes unscored)",
    build: () =>
      withMatchMode(
        withScore(withScore(emptyFilters(), "eyes", { max: 4, includeUnscored: false }), "focus", {
          max: 4,
        }),
        "any",
      ),
  },
  {
    id: "unreviewed",
    label: "Unreviewed",
    hint: "No pick decision, no stars",
    build: () => withStars(withPicks(emptyFilters(), ["unset"]), 0, 0),
  },
  {
    id: "rejects",
    label: "Rejects",
    hint: "Marked reject",
    build: () => withPicks(emptyFilters(), ["rejected"]),
  },
];
