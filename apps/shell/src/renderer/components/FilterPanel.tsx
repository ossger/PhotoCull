import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import {
  activeCriterionCount,
  cameraLabel,
  lensLabel,
  matchesFilters,
  uniqueSorted,
  PRESETS,
  SCORE_KEYS,
  SCORE_LABELS,
  type HasCropState,
  type Orientation,
  type PickState,
  type Range,
  type SceneAgg,
  type SceneScoreCriterion,
  type ScoreCriterion,
} from "../filters";

// The advanced-filter criteria builder. Deliberately non-modal (no backdrop,
// unlike OrganizeModal) — it floats over the toolbar so the grid keeps
// re-filtering live as thresholds change. Two consequences of that:
//   - closing needs its own click-away + Esc handling (a modal gets that for
//     free from its backdrop).
//   - the capture-phase keydown guard is scoped to *this panel's own
//     subtree* rather than swallowing every key on the window like
//     OrganizeModal's does — clicking back into the grid/filmstrip while the
//     panel stays open should keep navigating normally.
export function FilterPanel() {
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const applyPreset = useStore((s) => s.applyPreset);
  const clearFilters = useStore((s) => s.clearFilters);
  const toggleFilterPanel = useStore((s) => s.toggleFilterPanel);
  const images = useStore((s) => s.images);
  const panelRef = useRef<HTMLDivElement>(null);

  const cameras = useMemo(() => uniqueSorted(images.map(cameraLabel)), [images]);
  const lenses = useMemo(() => uniqueSorted(images.map(lensLabel)), [images]);
  const matchCount = useMemo(
    () => images.reduce((n, i) => (matchesFilters(i, filters, images) ? n + 1 : n), 0),
    [images, filters],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!panelRef.current || !t || !panelRef.current.contains(t)) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return; // let typing through
      if (e.key === "Escape") {
        e.preventDefault();
        toggleFilterPanel();
        return;
      }
      // A focused <select>/<button> inside the panel would otherwise leak
      // arrows/P/X/0-5 to the global hotkey handler — useHotkeys only
      // guards INPUT/TEXTAREA targets.
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleFilterPanel]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current || !(e.target instanceof Node)) return;
      if (panelRef.current.contains(e.target)) return;
      if ((e.target as HTMLElement).closest?.("#filter-toggle-btn")) return; // toolbar button owns its own toggle
      toggleFilterPanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [toggleFilterPanel]);

  function patchScore(key: (typeof SCORE_KEYS)[number], patch: Partial<ScoreCriterion>) {
    setFilters({ ...filters, scores: { ...filters.scores, [key]: { ...filters.scores[key], ...patch } } });
  }
  function patchSceneScore(key: (typeof SCORE_KEYS)[number], patch: Partial<SceneScoreCriterion>) {
    setFilters({
      ...filters,
      sceneScores: { ...filters.sceneScores, [key]: { ...filters.sceneScores[key], ...patch } },
    });
  }
  function togglePick(v: PickState) {
    setFilters({ ...filters, picks: toggleMember(filters.picks, v) });
  }
  function toggleColor(v: string) {
    setFilters({ ...filters, colors: toggleMember(filters.colors, v) });
  }
  function toggleCamera(v: string) {
    setFilters({ ...filters, cameras: toggleMember(filters.cameras, v) });
  }
  function toggleLens(v: string) {
    setFilters({ ...filters, lenses: toggleMember(filters.lenses, v) });
  }
  function toggleOrientation(v: Orientation) {
    setFilters({ ...filters, orientation: toggleMember(filters.orientation, v) });
  }

  return (
    <div
      ref={panelRef}
      className="fixed top-14 right-4 z-40 w-[26rem] max-h-[calc(100vh-4.5rem)] flex flex-col
        bg-panel border border-line rounded-lg shadow-2xl text-ink"
    >
      <div className="px-4 py-3 border-b border-line flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-tight text-sm">Filters</span>
          <div className="flex items-center bg-panel2 border border-line rounded-md overflow-hidden text-[11px]">
            <button
              type="button"
              onClick={() => setFilters({ ...filters, matchMode: "all" })}
              className={`px-2 py-1 ${filters.matchMode === "all" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
              title="Every enabled criterion must pass"
            >
              Match all
            </button>
            <button
              type="button"
              onClick={() => setFilters({ ...filters, matchMode: "any" })}
              className={`px-2 py-1 ${filters.matchMode === "any" ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
              title="At least one enabled criterion must pass"
            >
              Match any
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={clearFilters}
            disabled={activeCriterionCount(filters) === 0}
            className="text-xs text-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={toggleFilterPanel}
            className="text-muted hover:text-ink text-lg leading-none px-1"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-line flex flex-wrap gap-1.5 flex-shrink-0">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => applyPreset(p)}
            className="text-xs rounded-md px-2.5 py-1 border border-line bg-panel2 text-muted
              hover:text-ink hover:border-accent transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 divide-y divide-line">
        <Section title="Scores" defaultOpen>
          {SCORE_KEYS.map((key) => (
            <ScoreRow
              key={key}
              label={SCORE_LABELS[key]}
              criterion={filters.scores[key]}
              onChange={(c) => patchScore(key, c)}
            />
          ))}
        </Section>

        <Section title="Scene-level scores">
          <div className="text-[11px] text-muted -mt-1 mb-0.5">
            Compares each scene's best / average / worst frame — matching
            frames belong to a scene that clears the bar.
          </div>
          {SCORE_KEYS.map((key) => (
            <SceneScoreRow
              key={key}
              label={SCORE_LABELS[key]}
              criterion={filters.sceneScores[key]}
              onChange={(c) => patchSceneScore(key, c)}
            />
          ))}
        </Section>

        <Section title="Decisions" defaultOpen>
          <div className="flex flex-wrap gap-1.5">
            {PICK_OPTIONS.map((o) => (
              <Chip key={o.value} active={filters.picks.includes(o.value)} onClick={() => togglePick(o.value)}>
                {o.label}
              </Chip>
            ))}
          </div>
          <RangeRow
            label="Stars"
            range={filters.stars}
            onChange={(r) => setFilters({ ...filters, stars: r })}
            min={0}
            max={5}
            step={1}
          />
          <div className="flex flex-wrap gap-1.5">
            {COLOR_OPTIONS.map((o) => (
              <Chip key={o.value} active={filters.colors.includes(o.value)} onClick={() => toggleColor(o.value)}>
                <span className={`inline-block w-2 h-2 rounded-full mr-1 ${o.dot}`} />
                {o.value}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-ink mr-0.5">Crop</span>
            {CROP_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                active={filters.hasCrop === o.value}
                onClick={() => setFilters({ ...filters, hasCrop: o.value })}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="Faces">
          <RangeRow
            label="Face count"
            range={filters.facesCount}
            onChange={(r) => setFilters({ ...filters, facesCount: r })}
            min={0}
            step={1}
          />
          <div className="flex gap-1.5">
            <Chip
              active={filters.facesCount.min === 0 && filters.facesCount.max === 0}
              onClick={() => setFilters({ ...filters, facesCount: { min: 0, max: 0 } })}
            >
              No faces
            </Chip>
            <Chip
              active={filters.facesCount.min === 1 && filters.facesCount.max === null}
              onClick={() => setFilters({ ...filters, facesCount: { min: 1, max: null } })}
            >
              Has faces
            </Chip>
          </div>
        </Section>

        <Section title="Technical">
          {cameras.length > 0 && (
            <div>
              <div className="text-[11px] text-muted mb-1">Camera</div>
              <div className="flex flex-wrap gap-1.5">
                {cameras.map((c) => (
                  <Chip key={c} active={filters.cameras.includes(c)} onClick={() => toggleCamera(c)}>
                    {c}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {lenses.length > 0 && (
            <div>
              <div className="text-[11px] text-muted mb-1">Lens</div>
              <div className="flex flex-wrap gap-1.5">
                {lenses.map((l) => (
                  <Chip key={l} active={filters.lenses.includes(l)} onClick={() => toggleLens(l)}>
                    {l}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <RangeRow
            label="ISO"
            range={filters.iso}
            onChange={(r) => setFilters({ ...filters, iso: r })}
            min={0}
            step={50}
          />
          <RangeRow
            label="Aperture (f/)"
            range={filters.aperture}
            onChange={(r) => setFilters({ ...filters, aperture: r })}
            min={0}
            step={0.1}
          />
          <RangeRow
            label="Focal length (mm)"
            range={filters.focalLength}
            onChange={(r) => setFilters({ ...filters, focalLength: r })}
            min={0}
            step={1}
          />
          <RangeRow
            label="Shutter (sec)"
            range={filters.shutterSec}
            onChange={(r) => setFilters({ ...filters, shutterSec: r })}
            min={0}
            step={0.001}
          />
          <div className="flex gap-1.5">
            <Chip
              active={filters.shutterSec.min === 1 / 60 && filters.shutterSec.max === null}
              onClick={() => setFilters({ ...filters, shutterSec: { min: 1 / 60, max: null } })}
              title="Duration ≥ 1/60s — surfaces motion-blur-risk frames"
            >
              Slower than 1/60
            </Chip>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ORIENTATION_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                active={filters.orientation.includes(o.value)}
                onClick={() => toggleOrientation(o.value)}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="Time & filename">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-ink">Captured</span>
            <div className="flex items-center gap-1">
              <input
                type="datetime-local"
                value={toLocalInput(filters.capturedFrom)}
                onChange={(e) => setFilters({ ...filters, capturedFrom: fromLocalInput(e.target.value) })}
                className="bg-panel2 border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
              />
              <span className="text-muted">–</span>
              <input
                type="datetime-local"
                value={toLocalInput(filters.capturedTo)}
                onChange={(e) => setFilters({ ...filters, capturedTo: fromLocalInput(e.target.value) })}
                className="bg-panel2 border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-ink">Filename contains</span>
            <input
              type="text"
              value={filters.filenameContains}
              onChange={(e) => setFilters({ ...filters, filenameContains: e.target.value })}
              placeholder="e.g. _DSC"
              className="w-40 bg-panel2 border border-line rounded px-1.5 py-0.5 text-xs outline-none focus:border-accent"
            />
          </div>
        </Section>

        <Section title="Scene size">
          <RangeRow
            label="Frames in scene"
            range={filters.sceneFrameCount}
            onChange={(r) => setFilters({ ...filters, sceneFrameCount: r })}
            min={0}
            step={1}
          />
        </Section>
      </div>

      <div className="px-4 py-2 border-t border-line text-xs text-muted flex-shrink-0">
        {matchCount} of {images.length} frame{images.length === 1 ? "" : "s"} match
      </div>
    </div>
  );
}

// ----- static option lists -----

const PICK_OPTIONS: { value: PickState; label: string }[] = [
  { value: "picked", label: "Picked" },
  { value: "unset", label: "Unset" },
  { value: "rejected", label: "Rejected" },
];

// Lightroom-convention labels — matches the values color_label already holds.
const COLOR_OPTIONS: { value: string; dot: string }[] = [
  { value: "Red", dot: "bg-red-500" },
  { value: "Yellow", dot: "bg-yellow-400" },
  { value: "Green", dot: "bg-green-500" },
  { value: "Blue", dot: "bg-blue-500" },
  { value: "Purple", dot: "bg-purple-500" },
];

const CROP_OPTIONS: { value: HasCropState; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "yes", label: "Has crop" },
  { value: "no", label: "No crop" },
];

const ORIENTATION_OPTIONS: { value: Orientation; label: string }[] = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
];

// ----- small building blocks -----

function toggleMember<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function parseNum(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// captured_at / capturedFrom / capturedTo are naive "YYYY-MM-DDTHH:MM:SS"
// strings with no timezone — slice rather than round-trip through Date, or a
// local-time input would silently shift the value by the browser's offset.
function toLocalInput(v: string | null): string {
  return v ? v.slice(0, 16) : "";
}
function fromLocalInput(v: string): string | null {
  return v === "" ? null : v;
}

function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="px-4 py-3" open={defaultOpen}>
      <summary className="text-xs uppercase tracking-wide text-muted cursor-pointer select-none">
        {title}
      </summary>
      <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>
    </details>
  );
}

function NumInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder ?? "any"}
      onChange={(e) => onChange(parseNum(e.target.value))}
      className="w-16 bg-panel2 border border-line rounded px-1.5 py-0.5 text-xs outline-none focus:border-accent"
    />
  );
}

function RangeRow({
  label,
  range,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  range: Range;
  onChange: (r: Range) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-ink">{label}</span>
      <div className="flex items-center gap-1 text-muted">
        <NumInput value={range.min} onChange={(v) => onChange({ ...range, min: v })} min={min} max={max} step={step} placeholder="min" />
        <span>–</span>
        <NumInput value={range.max} onChange={(v) => onChange({ ...range, max: v })} min={min} max={max} step={step} placeholder="max" />
        {unit && <span>{unit}</span>}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`text-xs rounded-md px-2 py-1 border transition-colors flex items-center ${
        active ? "border-accent text-accent bg-accent/10" : "border-line text-muted hover:text-ink bg-panel2"
      }`}
    >
      {children}
    </button>
  );
}

function ScoreRow({
  label,
  criterion,
  onChange,
}: {
  label: string;
  criterion: ScoreCriterion;
  onChange: (c: ScoreCriterion) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={criterion.enabled}
        onChange={(e) => onChange({ ...criterion, enabled: e.target.checked })}
        className="accent-accent"
      />
      <span className={`w-16 flex-shrink-0 ${criterion.enabled ? "text-ink" : "text-muted"}`}>{label}</span>
      <NumInput value={criterion.min} onChange={(v) => onChange({ ...criterion, min: v, enabled: true })} min={0} max={10} step={0.5} placeholder="min" />
      <span className="text-muted">–</span>
      <NumInput value={criterion.max} onChange={(v) => onChange({ ...criterion, max: v, enabled: true })} min={0} max={10} step={0.5} placeholder="max" />
      <label className="flex items-center gap-1 text-muted ml-auto text-[11px]">
        <input
          type="checkbox"
          checked={criterion.includeUnscored}
          onChange={(e) => onChange({ ...criterion, includeUnscored: e.target.checked })}
          className="accent-accent"
        />
        incl. unscored
      </label>
    </div>
  );
}

function SceneScoreRow({
  label,
  criterion,
  onChange,
}: {
  label: string;
  criterion: SceneScoreCriterion;
  onChange: (c: SceneScoreCriterion) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={criterion.enabled}
        onChange={(e) => onChange({ ...criterion, enabled: e.target.checked })}
        className="accent-accent"
      />
      <span className={`w-16 flex-shrink-0 ${criterion.enabled ? "text-ink" : "text-muted"}`}>{label}</span>
      <select
        value={criterion.agg}
        onChange={(e) => onChange({ ...criterion, agg: e.target.value as SceneAgg, enabled: true })}
        className="bg-panel2 border border-line rounded px-1 py-0.5 text-[11px] text-muted"
      >
        <option value="best">best</option>
        <option value="avg">avg</option>
        <option value="worst">worst</option>
      </select>
      <NumInput value={criterion.min} onChange={(v) => onChange({ ...criterion, min: v, enabled: true })} min={0} max={10} step={0.5} placeholder="min" />
      <span className="text-muted">–</span>
      <NumInput value={criterion.max} onChange={(v) => onChange({ ...criterion, max: v, enabled: true })} min={0} max={10} step={0.5} placeholder="max" />
    </div>
  );
}
