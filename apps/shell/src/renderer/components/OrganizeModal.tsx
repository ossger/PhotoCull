import { useEffect, useState } from "react";
import type { OrganizePlan, OrganizeProgress } from "@shared/types";

// Remember the library destination between imports — the card/source changes
// every time, but you sort into the same library.
const LIBRARY_KEY = "photocull.importLibrary";

type Phase = "setup" | "planning" | "planned" | "running" | "done";

export function OrganizeModal({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [library, setLibrary] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LIBRARY_KEY);
    } catch {
      return null;
    }
  });
  const [label, setLabel] = useState("");
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<OrganizeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "planning" || phase === "running";

  // A fresh plan must be re-scanned whenever the inputs change, so we can never
  // move against a stale preview.
  function invalidatePlan() {
    setPlan(null);
    if (phase === "planned") setPhase("setup");
  }

  async function pickSource() {
    const p = await window.photocull.pickFolder();
    if (p) {
      setSource(p);
      invalidatePlan();
    }
  }

  async function pickLibrary() {
    const p = await window.photocull.pickFolder();
    if (p) {
      setLibrary(p);
      try {
        localStorage.setItem(LIBRARY_KEY, p);
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
      invalidatePlan();
    }
  }

  async function preview() {
    if (!source || !library) return;
    setError(null);
    setPhase("planning");
    try {
      const result = await window.photocull.organizePlan(source, library, label.trim() || null);
      setPlan(result);
      setPhase("planned");
    } catch (e) {
      setError((e as Error).message);
      setPhase("setup");
    }
  }

  async function run() {
    if (!source || !library) return;
    setError(null);
    setProgress({
      state: "running",
      done: 0,
      total: plan?.total ?? 0,
      current: null,
      moved: 0,
      skipped: 0,
      renamed: 0,
    });
    setPhase("running");
    try {
      const res = await window.photocull.organizeRun(source, library, label.trim() || null);
      if (!res.started) {
        // Nothing matched (empty card) — jump straight to a zero-result summary.
        setProgress({
          state: "complete",
          done: 0,
          total: 0,
          current: null,
          moved: 0,
          skipped: 0,
          renamed: 0,
        });
        setPhase("done");
      }
      // Otherwise the poll effect below drives it to completion.
    } catch (e) {
      setError((e as Error).message);
      setPhase("planned");
    }
  }

  // Poll move progress while running.
  useEffect(() => {
    if (phase !== "running") return;
    let active = true;
    const tick = async () => {
      try {
        const p = await window.photocull.organizeProgress();
        if (!active) return;
        setProgress(p);
        if (p.state === "complete") {
          setPhase("done");
          return;
        }
        setTimeout(tick, 500);
      } catch (e) {
        if (!active) return;
        setError((e as Error).message);
        setPhase("planned");
      }
    };
    const id = setTimeout(tick, 400);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [phase]);

  // Swallow keys (in capture, before the global hotkeys) so arrows/P/X don't act
  // on the images behind the modal. Typing in the label input still flows
  // through, and Escape closes when not mid-move.
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

  const canPreview = !!source && !!library && !busy;
  const canMove = phase === "planned" && !!plan && plan.would_move > 0;
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
        className="w-[40rem] max-w-[92vw] max-h-[85vh] flex flex-col bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-line flex items-start justify-between">
          <div>
            <div className="font-semibold tracking-tight">Import / Organize</div>
            <div className="text-xs text-muted mt-0.5">
              Move a memory card into a dated library, then cull a day from it.
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
          <FolderRow label="Source card / inbox" path={source} onChoose={pickSource} disabled={busy} />
          <FolderRow label="Library destination" path={library} onChoose={pickLibrary} disabled={busy} />

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">Folder label (optional)</span>
            <input
              type="text"
              value={label}
              disabled={busy}
              placeholder="default: camera (e.g. DJI-Drone)"
              onChange={(e) => {
                setLabel(e.target.value);
                invalidatePlan();
              }}
              className="bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
            />
          </div>

          {error && (
            <div className="text-sm text-reject border border-reject/40 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {plan && (phase === "planned" || phase === "setup") && (
            <PlanSummary plan={plan} />
          )}

          {(phase === "running" || phase === "done") && progress && (
            <div className="flex flex-col gap-2">
              <div className="h-2 rounded bg-panel2 overflow-hidden">
                <div className="h-2 bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              {phase === "running" ? (
                <div className="text-xs text-muted truncate">
                  Moving {progress.done}/{progress.total} · {progress.current ?? "…"}
                </div>
              ) : (
                <div className="text-sm">
                  {progress.moved + progress.skipped === 0 ? (
                    <span className="text-muted">Nothing to import — no supported images found.</span>
                  ) : (
                    <>
                      <span className="text-ink">
                        Moved {progress.moved} file{progress.moved === 1 ? "" : "s"}
                      </span>
                      <span className="text-muted">
                        {progress.renamed > 0 && ` · ${progress.renamed} renamed`}
                        {progress.skipped > 0 && ` · ${progress.skipped} skipped (duplicates)`}
                      </span>
                      <div className="text-xs text-muted mt-1">
                        Open a day folder with “Open folder…” to start culling.
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
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
                onClick={preview}
                disabled={!canPreview}
                className="px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {phase === "planning" ? "Scanning…" : plan ? "Re-scan" : "Preview"}
              </button>
              <button
                type="button"
                onClick={run}
                disabled={!canMove}
                title={canMove ? undefined : "Preview first to see what will move"}
                className="px-3 py-1 rounded-md bg-accent text-white hover:bg-accent/90 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {phase === "running"
                  ? "Moving…"
                  : plan
                    ? `Move ${plan.would_move} file${plan.would_move === 1 ? "" : "s"}`
                    : "Move"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderRow({
  label,
  path,
  onChoose,
  disabled,
}: {
  label: string;
  path: string | null;
  onChoose: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <div
          className="flex-1 min-w-0 bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm truncate"
          title={path ?? undefined}
        >
          {path ?? <span className="text-muted">No folder chosen</span>}
        </div>
        <button
          type="button"
          onClick={onChoose}
          disabled={disabled}
          className="px-3 py-1.5 rounded-md bg-panel2 hover:bg-line text-sm border border-line disabled:opacity-40 shrink-0"
        >
          Choose…
        </button>
      </div>
    </div>
  );
}

function PlanSummary({ plan }: { plan: OrganizePlan }) {
  if (plan.total === 0) {
    return <div className="text-sm text-muted">No supported images found in that folder.</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm">
        <span className="text-ink">
          {plan.would_move} of {plan.total} image{plan.total === 1 ? "" : "s"}
        </span>{" "}
        <span className="text-muted">
          → {plan.groups.length} folder{plan.groups.length === 1 ? "" : "s"}
          {plan.would_skip > 0 && ` · ${plan.would_skip} already imported`}
          {plan.would_rename > 0 && ` · ${plan.would_rename} renamed to avoid collisions`}
        </span>
      </div>
      <div className="border border-line rounded-md divide-y divide-line max-h-48 overflow-y-auto">
        {plan.groups.map((g) => (
          <div key={g.folder} className="flex items-center justify-between px-3 py-1.5 text-sm">
            <span className="font-mono text-xs truncate" title={g.folder}>
              {g.folder}
            </span>
            <span className="text-muted shrink-0 ml-3">{g.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
