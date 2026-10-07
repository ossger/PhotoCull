import { useEffect, useMemo, useRef, useState } from "react";
import type { AstroAnalysis, AstroStackProgress } from "@shared/types";
import { useStore } from "../store";

type Phase = "analyzing" | "review" | "stacking" | "done" | "error";

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const num = (v: number | null, d = 1) => (v == null ? "—" : v.toFixed(d));

// Judge the frames of a star sequence, then stack the keepers.
// Opens on `stackPanelIds`; nothing is changed in the cull unless a button here says so.
export function StackPanel() {
  const ids = useStore((s) => s.stackPanelIds);
  if (ids == null) return null;
  // Remount per frame set so state never leaks between sequences.
  return <PanelBody key={ids.join(",")} ids={ids} />;
}

function PanelBody({ ids }: { ids: number[] }) {
  const close = useStore((s) => s.closeStackPanel);
  const setPickMany = useStore((s) => s.setPickMany);
  const showNotice = useStore((s) => s.showNotice);

  const [phase, setPhase] = useState<Phase>("analyzing");
  const [analysis, setAnalysis] = useState<AstroAnalysis | null>(null);
  const [include, setInclude] = useState<Record<number, boolean>>({});
  const [halfSize, setHalfSize] = useState(false);
  const [foreground, setForeground] = useState<"auto" | "none">("auto");
  const [progress, setProgress] = useState<AstroStackProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    window.photocull
      .astroAnalyze(ids)
      .then((a) => {
        if (!alive.current) return;
        setAnalysis(a);
        setInclude(Object.fromEntries(a.frames.map((f) => [f.id, f.include])));
        setPhase("review");
      })
      .catch((err: Error) => {
        if (!alive.current) return;
        setError(err.message);
        setPhase("error");
      });
    return () => {
      alive.current = false;
    };
  }, [ids]);

  // Esc closes, except mid-stack (the worker keeps going; closing would hide the result).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "stacking") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, close]);

  const kept = useMemo(
    () => (analysis ? analysis.frames.filter((f) => include[f.id]).map((f) => f.id) : []),
    [analysis, include],
  );
  const dropped = useMemo(
    () => (analysis ? analysis.frames.filter((f) => !include[f.id]).map((f) => f.id) : []),
    [analysis, include],
  );
  const maxStars = useMemo(
    () => Math.max(1, ...(analysis?.frames.map((f) => f.stars ?? 0) ?? [1])),
    [analysis],
  );

  async function startStack() {
    setPhase("stacking");
    setProgress(null);
    try {
      await window.photocull.astroStack(kept, { halfSize, foreground });
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        if (!alive.current) return;
        const p = await window.photocull.astroProgress();
        setProgress(p);
        if (p.state === "complete") {
          setPhase("done");
          return;
        }
        if (p.state === "error") {
          setError(p.error ?? "stacking failed");
          setPhase("error");
          return;
        }
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }

  async function rejectDropped() {
    await setPickMany(dropped, -1);
    setRejected(true);
    showNotice(`rejected ${dropped.length} frame${dropped.length === 1 ? "" : "s"}`);
  }

  const result = progress?.result ?? null;
  const busy = phase === "analyzing" || phase === "stacking";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onMouseDown={() => !busy && close()}
    >
      <div
        className="bg-panel border border-line rounded-lg shadow-xl w-full max-w-4xl max-h-full flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">✦ Stack stars</h2>
            <p className="text-xs text-muted">
              {ids.length} frames · aligns the sky on the middle frame and keeps the landscape
              still. Your originals are never changed.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={phase === "stacking"}
            className="text-sm text-muted hover:text-ink disabled:opacity-40"
          >
            Close
          </button>
        </div>

        {phase === "analyzing" && (
          <div className="px-5 py-10 text-sm text-muted">Measuring stars in each frame…</div>
        )}

        {phase === "error" && (
          <div className="px-5 py-8 space-y-3">
            <div className="text-reject text-sm">{error}</div>
            <button
              type="button"
              onClick={close}
              className="px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
            >
              Close
            </button>
          </div>
        )}

        {(phase === "review" || phase === "stacking" || phase === "done") && analysis && (
          <>
            <div className="px-5 py-2 text-sm border-b border-line">
              <span className="text-ink font-medium">{kept.length}</span> of{" "}
              {analysis.summary.frames} frames recommended for the stack
              {dropped.length > 0 && (
                <span className="text-muted"> · {dropped.length} left out (untick to override)</span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-panel text-xs text-muted">
                  <tr className="text-left">
                    <th className="pl-5 py-1.5 w-8" />
                    <th className="py-1.5 w-14" />
                    <th className="py-1.5">Frame</th>
                    <th className="py-1.5">Stars</th>
                    <th className="py-1.5" title="Median star width in pixels — higher is softer">
                      Sharpness
                    </th>
                    <th className="py-1.5" title="1.0 is round; higher means trailed or shaken">
                      Roundness
                    </th>
                    <th className="py-1.5" title="Median sky brightness">
                      Sky
                    </th>
                    <th className="py-1.5 pr-5">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.frames.map((f) => (
                    <tr
                      key={f.id}
                      className={`border-t border-line/60 ${include[f.id] ? "" : "opacity-60"}`}
                    >
                      <td className="pl-5 py-1">
                        <input
                          type="checkbox"
                          checked={!!include[f.id]}
                          disabled={phase !== "review"}
                          onChange={(e) => setInclude((m) => ({ ...m, [f.id]: e.target.checked }))}
                          aria-label={`Include ${f.filename}`}
                        />
                      </td>
                      <td className="py-1">
                        {f.thumb_path && (
                          <img
                            src={window.photocull.thumbUrl(f.thumb_path)}
                            alt=""
                            className="w-12 h-8 object-cover rounded bg-bg"
                            draggable={false}
                          />
                        )}
                      </td>
                      <td className="py-1 font-mono text-xs">{f.filename}</td>
                      <td className="py-1">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-bg rounded overflow-hidden">
                            <div
                              className="h-full bg-accent"
                              style={{ width: `${((f.stars ?? 0) / maxStars) * 100}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs w-8">{f.stars ?? "—"}</span>
                        </div>
                      </td>
                      <td className="py-1 font-mono text-xs">{num(f.fwhm)}</td>
                      <td className="py-1 font-mono text-xs">{num(f.elongation, 2)}</td>
                      <td className="py-1 font-mono text-xs">{pct(f.background)}</td>
                      <td className="py-1 pr-5 text-xs">
                        {f.reasons.map((r) => (
                          <span key={r} className="mr-1 px-1.5 py-0.5 rounded bg-reject/20 text-reject">
                            {r}
                          </span>
                        ))}
                        {f.trails > 0 && f.include && (
                          <span className="text-muted" title="Removed automatically when stacking">
                            streak ×{f.trails}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 border-t border-line space-y-3">
              {phase === "review" && (
                <div className="flex items-center gap-5 text-sm flex-wrap">
                  <label className="flex items-center gap-2">
                    <span className="text-muted">Foreground</span>
                    <select
                      value={foreground}
                      onChange={(e) => setForeground(e.target.value as "auto" | "none")}
                      className="bg-panel2 border border-line rounded px-2 py-1 text-sm"
                    >
                      <option value="auto">Keep landscape sharp (auto)</option>
                      <option value="none">None — sky only</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2" title="A quarter of the memory and much faster. Good for a first look.">
                    <input
                      type="checkbox"
                      checked={halfSize}
                      onChange={(e) => setHalfSize(e.target.checked)}
                    />
                    <span>Half resolution (faster)</span>
                  </label>
                </div>
              )}

              {phase === "stacking" && (
                <div className="space-y-1">
                  <div className="h-1.5 bg-bg rounded overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{
                        width: `${progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="text-xs text-muted">
                    Stacking {kept.length} frames…{" "}
                    {progress?.current ? <span className="font-mono">{progress.current}</span> : null}
                  </div>
                </div>
              )}

              {phase === "done" && result && (
                <div className="flex gap-4 items-start">
                  <img
                    src={window.photocull.previewUrl(result.preview_path)}
                    alt="Stacked result (stretched preview)"
                    className="w-64 rounded border border-line bg-bg"
                    draggable={false}
                  />
                  <div className="text-sm space-y-2 min-w-0">
                    <div>
                      Stacked <span className="font-medium">{result.used}</span> frames
                      <span className="text-muted">
                        {" "}
                        · {result.width}×{result.height}, 16-bit TIFF
                      </span>
                    </div>
                    <div className="text-xs text-muted break-all">{result.output}</div>
                    <div className="text-xs text-muted">
                      The preview is brightened so you can see it; the file itself is unstretched,
                      ready to edit.
                    </div>
                    {result.skipped.length > 0 && (
                      <div className="text-xs text-muted">
                        Skipped: {result.skipped.map((s) => `${s.filename} (${s.reason})`).join(", ")}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void window.photocull.revealPath(result.output)}
                      className="px-3 py-1 rounded-md bg-panel2 hover:bg-line text-sm border border-line"
                    >
                      Show in Finder
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                {phase === "review" && (
                  <>
                    <button
                      type="button"
                      onClick={() => void startStack()}
                      disabled={kept.length < 3}
                      className="px-3 py-1.5 rounded-md bg-accent text-white text-sm hover:opacity-90 disabled:opacity-40"
                    >
                      Stack {kept.length} frames
                    </button>
                    <button
                      type="button"
                      onClick={() => void rejectDropped()}
                      disabled={dropped.length === 0 || rejected}
                      className="px-3 py-1.5 rounded-md bg-panel2 hover:bg-line text-sm border border-line disabled:opacity-40"
                      title="Mark the unticked frames as rejects in your cull"
                    >
                      {rejected ? "Rejected" : `Reject the ${dropped.length} left out`}
                    </button>
                    {kept.length < 3 && (
                      <span className="text-xs text-muted">Keep at least 3 frames to stack.</span>
                    )}
                  </>
                )}
                {phase === "done" && (
                  <button
                    type="button"
                    onClick={close}
                    className="px-3 py-1.5 rounded-md bg-accent text-white text-sm hover:opacity-90"
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
