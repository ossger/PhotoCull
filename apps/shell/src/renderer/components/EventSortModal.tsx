import { useEffect, useRef, useState } from "react";
import type { EventProposal, EventsPlan, EventsProgress } from "@shared/types";
import { useStore } from "../store";

// The card-dump folder changes rarely (it's usually ~/Desktop/RAW), and the
// gap that suits your shooting does too — remember both.
const FOLDER_KEY = "photocull.eventSortFolder";
const GAP_KEY = "photocull.eventSortGap";
const DEFAULT_GAP = 3;

type Phase = "setup" | "planning" | "planned" | "running" | "done";

// One row the user sees: one or more proposed events merged together.
interface Group {
  ids: string[];
  name: string;
  include: boolean;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function joinPath(folder: string, name: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return folder.endsWith(sep) ? folder + name : folder + sep + name;
}

function overlaps(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/") ||
    x.startsWith(y + "\\") || y.startsWith(x + "\\");
}

function formatRange(e: EventProposal): string {
  const s = new Date(e.start);
  const t = new Date(e.end);
  const day: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const sameDay = s.toDateString() === t.toDateString();
  return sameDay
    ? `${s.toLocaleDateString(undefined, day)} · ${s.toLocaleTimeString(undefined, time)}–${t.toLocaleTimeString(undefined, time)}`
    : `${s.toLocaleDateString(undefined, day)} ${s.toLocaleTimeString(undefined, time)} → ${t.toLocaleDateString(undefined, day)} ${t.toLocaleTimeString(undefined, time)}`;
}

export function EventSortModal({ onClose }: { onClose: () => void }) {
  const shootRoot = useStore((s) => s.shootRoot);
  const forgetShoot = useStore((s) => s.forgetShoot);
  const openPath = useStore((s) => s.openPath);

  const [folder, setFolder] = useState<string | null>(() => readStored(FOLDER_KEY));
  const [gap, setGap] = useState<number>(() => {
    const g = Number(readStored(GAP_KEY));
    return g > 0 ? g : DEFAULT_GAP;
  });
  const [plan, setPlan] = useState<EventsPlan | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<EventsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Names typed so far, keyed by the first event id of their row — survives
  // re-planning at a different gap as long as that event still starts a row.
  const typedNames = useRef<Record<string, string>>({});

  const busy = phase === "running";

  // Re-plan (debounced) whenever the folder or gap changes.
  useEffect(() => {
    if (!folder || phase === "running" || phase === "done") return;
    let active = true;
    const id = setTimeout(async () => {
      setError(null);
      setPhase("planning");
      try {
        const p = await window.photocull.eventsPlan(folder, gap);
        if (!active) return;
        setPlan(p);
        setGroups(
          p.events.map((e) => ({ ids: [e.id], name: typedNames.current[e.id] ?? "", include: true })),
        );
        setPhase("planned");
      } catch (e) {
        if (!active) return;
        setError((e as Error).message);
        setPlan(null);
        setPhase("setup");
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(id);
    };
    // phase is deliberately left out: re-planning is driven by inputs, not by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, gap]);

  async function pickFolder() {
    const p = await window.photocull.pickFolder(
      "Choose the folder holding your card dump",
      folder ?? undefined,
    );
    if (p) {
      setFolder(p);
      store(FOLDER_KEY, p);
      setNotice(null);
    }
  }

  function changeGap(value: number) {
    setGap(value);
    store(GAP_KEY, String(value));
  }

  function setName(idx: number, name: string) {
    const key = groups[idx]?.ids[0];
    if (key) typedNames.current[key] = name;
    setGroups((gs) => gs.map((g, i) => (i === idx ? { ...g, name } : g)));
  }

  function toggleInclude(idx: number) {
    setGroups((gs) => gs.map((g, i) => (i === idx ? { ...g, include: !g.include } : g)));
  }

  function mergeWithNext(idx: number) {
    setGroups((gs) => {
      const a = gs[idx];
      const b = gs[idx + 1];
      if (!a || !b) return gs;
      const merged = { ids: [...a.ids, ...b.ids], name: a.name || b.name, include: true };
      return [...gs.slice(0, idx), merged, ...gs.slice(idx + 2)];
    });
  }

  function split(idx: number) {
    setGroups((gs) => {
      const g = gs[idx];
      if (!g) return gs;
      const parts = g.ids.map((id, i) => ({
        ids: [id],
        name: i === 0 ? g.name : typedNames.current[id] ?? "",
        include: true,
      }));
      return [...gs.slice(0, idx), ...parts, ...gs.slice(idx + 1)];
    });
  }

  async function run() {
    if (!folder || !plan) return;
    const chosen = groups.filter((g) => g.include);
    if (chosen.length === 0) return;
    setError(null);
    setNotice(null);
    setPhase("running");
    setProgress({
      state: "running", done: 0, total: 0, current: "reading metadata",
      moved: 0, renamed: 0, folders: [], error: null,
    });
    try {
      await window.photocull.eventsRun(
        folder,
        gap,
        chosen.map((g) => ({ event_ids: g.ids, name: g.name })),
      );
      // The worker closes an open shoot that lives in this folder — mirror it here.
      if (shootRoot && overlaps(shootRoot, folder)) forgetShoot();
    } catch (e) {
      setError((e as Error).message);
      setPhase("planned");
    }
  }

  async function undo() {
    if (!folder) return;
    setError(null);
    try {
      const r = await window.photocull.eventsUndo(folder);
      if (shootRoot && overlaps(shootRoot, folder)) forgetShoot();
      setNotice(
        `Undid the last sort — ${r.restored} file${r.restored === 1 ? "" : "s"} back in place` +
          (r.missing > 0 ? ` (${r.missing} had moved since and were left alone)` : "") +
          ".",
      );
      setProgress(null);
      setPlan(null);
      // Force a fresh plan of the now-flat folder.
      setPhase("setup");
      const p = await window.photocull.eventsPlan(folder, gap);
      setPlan(p);
      setGroups(p.events.map((e) => ({ ids: [e.id], name: typedNames.current[e.id] ?? "", include: true })));
      setPhase("planned");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function openEvent(name: string) {
    if (!folder) return;
    onClose();
    await openPath(joinPath(folder, name));
  }

  // Poll move progress while running.
  useEffect(() => {
    if (phase !== "running") return;
    let active = true;
    const tick = async () => {
      try {
        const p = await window.photocull.eventsProgress();
        if (!active) return;
        setProgress(p);
        if (p.state === "complete") {
          setPhase("done");
          return;
        }
        if (p.state === "error") {
          setError(p.error ?? "Sort failed.");
          setPhase("planned");
          return;
        }
        setTimeout(tick, 400);
      } catch (e) {
        if (!active) return;
        setError((e as Error).message);
        setPhase("planned");
      }
    };
    const id = setTimeout(tick, 300);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [phase]);

  // Swallow keys so the grid's hotkeys don't fire behind the modal; Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape" && phase !== "running") onClose();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, onClose]);

  const byId = new Map(plan?.events.map((e) => [e.id, e]) ?? []);
  const included = groups.filter((g) => g.include);
  const includedCount = included.reduce(
    (n, g) => n + g.ids.reduce((m, id) => m + (byId.get(id)?.count ?? 0), 0),
    0,
  );
  const canSort = phase === "planned" && included.length > 0;
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-[52rem] max-w-[94vw] max-h-[88vh] flex flex-col bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-line flex items-start justify-between">
          <div>
            <div className="font-semibold tracking-tight">Sort into events</div>
            <div className="text-xs text-muted mt-0.5">
              Split a card dump into “YYYY-MM-DD Name” folders by gaps between shots, then cull
              each event.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted hover:text-ink disabled:opacity-30 text-lg leading-none px-1"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">Card dump folder</span>
            <div className="flex items-center gap-2">
              <div
                className="flex-1 min-w-0 bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm truncate"
                title={folder ?? undefined}
              >
                {folder ?? <span className="text-muted">No folder chosen</span>}
              </div>
              <button
                type="button"
                onClick={pickFolder}
                disabled={busy || phase === "done"}
                className="px-3 py-1.5 rounded-md bg-panel2 hover:bg-line text-sm border border-line disabled:opacity-40 shrink-0"
              >
                Choose…
              </button>
            </div>
          </div>

          {phase !== "done" && (
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wide text-muted shrink-0">
                New event after a gap of
              </span>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.5}
                value={gap}
                disabled={busy}
                onChange={(e) => changeGap(Number(e.target.value))}
                className="flex-1 accent-[var(--color-accent,#4f8cff)]"
              />
              <span className="text-sm w-14 text-right tabular-nums">
                {gap} h
              </span>
            </div>
          )}

          {error && (
            <div className="text-sm text-reject border border-reject/40 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          {notice && (
            <div className="text-sm text-muted border border-line rounded-md px-3 py-2">{notice}</div>
          )}

          {phase === "planning" && !plan && <div className="text-sm text-muted">Reading capture times…</div>}

          {plan && (phase === "planned" || phase === "planning") && (
            <PlanList
              plan={plan}
              groups={groups}
              byId={byId}
              dimmed={phase === "planning"}
              onName={setName}
              onToggle={toggleInclude}
              onMerge={mergeWithNext}
              onSplit={split}
            />
          )}

          {(phase === "running" || phase === "done") && progress && (
            <div className="flex flex-col gap-2">
              <div className="h-2 rounded bg-panel2 overflow-hidden">
                <div className="h-2 bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              {phase === "running" ? (
                <div className="text-xs text-muted truncate">
                  Moving {progress.done}/{progress.total || "…"} · {progress.current ?? "…"}
                </div>
              ) : (
                <div className="flex flex-col gap-2 text-sm">
                  <div>
                    <span className="text-ink">
                      Moved {progress.moved} file{progress.moved === 1 ? "" : "s"} into{" "}
                      {progress.folders.length} folder{progress.folders.length === 1 ? "" : "s"}
                    </span>
                    {progress.renamed > 0 && (
                      <span className="text-muted"> · {progress.renamed} renamed to avoid collisions</span>
                    )}
                  </div>
                  <div className="border border-line rounded-md divide-y divide-line">
                    {progress.folders.map((f) => (
                      <div key={f} className="flex items-center justify-between px-3 py-1.5">
                        <span className="truncate">{f}</span>
                        <button
                          type="button"
                          onClick={() => void openEvent(f)}
                          className="px-2 py-0.5 rounded-md bg-panel2 hover:bg-line text-xs border border-line shrink-0 ml-3"
                        >
                          Open in PhotoCull
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-2">
          <div>
            {(phase === "done" || (plan?.can_undo && phase === "planned")) && (
              <button
                type="button"
                onClick={() => void undo()}
                title="Put the files from the most recent sort of this folder back where they were"
                className="px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
              >
                Undo last sort
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {phase === "done" ? (
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 rounded-md bg-accent text-white hover:bg-accent/90 text-sm"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void run()}
                  disabled={!canSort}
                  className="px-3 py-1 rounded-md bg-accent text-white hover:bg-accent/90 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {phase === "running"
                    ? "Sorting…"
                    : `Sort ${includedCount} capture${includedCount === 1 ? "" : "s"} into ${included.length} folder${included.length === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanList({
  plan,
  groups,
  byId,
  dimmed,
  onName,
  onToggle,
  onMerge,
  onSplit,
}: {
  plan: EventsPlan;
  groups: Group[];
  byId: Map<string, EventProposal>;
  dimmed: boolean;
  onName: (idx: number, name: string) => void;
  onToggle: (idx: number) => void;
  onMerge: (idx: number) => void;
  onSplit: (idx: number) => void;
}) {
  if (plan.total_units === 0) {
    return (
      <div className="text-sm text-muted">
        No loose photos or videos at the top of that folder — anything already in a subfolder is
        left alone.
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-2 ${dimmed ? "opacity-60" : ""}`}>
      <div className="text-sm text-muted">
        {plan.total_units} capture{plan.total_units === 1 ? "" : "s"} ({plan.total_files} files) →{" "}
        {groups.length} event{groups.length === 1 ? "" : "s"}
        {plan.orphans.length > 0 &&
          ` · ${plan.orphans.length} sidecar${plan.orphans.length === 1 ? "" : "s"} with no photo stay put`}
      </div>
      <div className="flex flex-col gap-2">
        {groups.map((g, idx) => {
          const evs = g.ids.map((id) => byId.get(id)).filter((e): e is EventProposal => !!e);
          const first = evs[0];
          const last = evs[evs.length - 1];
          if (!first || !last) return null;
          const span: EventProposal = { ...first, end: last.end };
          const count = evs.reduce((n, e) => n + e.count, 0);
          const undated = evs.reduce((n, e) => n + e.undated, 0);
          const samples = evs.flatMap((e) => e.samples).slice(0, 4);
          const datePrefix = first.default_name.slice(0, 10);
          return (
            <div
              key={g.ids.join("|")}
              className={`border border-line rounded-md p-2.5 flex gap-3 ${g.include ? "" : "opacity-40"}`}
            >
              <input
                type="checkbox"
                checked={g.include}
                onChange={() => onToggle(idx)}
                title={g.include ? "Leave this event unsorted" : "Include this event"}
                className="mt-1 shrink-0"
              />
              <div className="flex gap-1 shrink-0">
                {samples.map((name) => (
                  <Thumb key={name} folder={plan.folder} name={name} />
                ))}
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="text-xs text-muted truncate">
                  {formatRange(span)} · {count} capture{count === 1 ? "" : "s"}
                  {evs.length > 1 && ` · ${evs.length} merged`}
                  {undated > 0 && ` · ${undated} dated by file time`}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-mono text-muted shrink-0">{datePrefix}</span>
                  <input
                    type="text"
                    value={g.name}
                    disabled={!g.include}
                    placeholder="Event name (e.g. Soccer)"
                    onChange={(e) => onName(idx, e.target.value)}
                    className="flex-1 min-w-0 bg-panel2 border border-line rounded-md px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-50"
                  />
                </div>
                <div className="flex gap-2 text-xs">
                  {idx < groups.length - 1 && (
                    <button type="button" onClick={() => onMerge(idx)} className="text-muted hover:text-ink">
                      Merge with next ↓
                    </button>
                  )}
                  {g.ids.length > 1 && (
                    <button type="button" onClick={() => onSplit(idx)} className="text-muted hover:text-ink">
                      Split apart
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ folder, name }: { folder: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = window.photocull.eventThumbUrl(folder, name);
  if (failed || !src) {
    return (
      <div
        className="w-16 h-16 rounded bg-panel2 border border-line flex items-center justify-center text-[10px] text-muted"
        title={name}
      >
        {name.split(".").pop()?.toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      title={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-16 h-16 rounded object-cover bg-panel2"
    />
  );
}
