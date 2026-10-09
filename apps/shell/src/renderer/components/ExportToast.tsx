import { useStore } from "../store";

// Result card anchored under the toolbar's export button, so the outcome of an
// export shows up where the user just clicked. Success clears itself (store);
// failures stay until dismissed.
export function ExportToast() {
  const result = useStore((s) => s.exportResult);
  const dismiss = useStore((s) => s.dismissExportResult);
  if (!result) return null;

  const isWindows = navigator.platform.toLowerCase().startsWith("win");
  const failed = result.error != null || result.failed > 0;
  const n = result.written;
  const first = result.sidecars[0];

  let title: string;
  if (result.error) title = `Export failed: ${result.error}`;
  else if (result.failed > 0) title = `Wrote ${n}, failed ${result.failed}`;
  else title = `Wrote ${n} XMP sidecar${n === 1 ? "" : "s"}`;

  return (
    <div
      role="status"
      className="fixed right-4 top-[52px] z-50 w-80 rounded-md border border-line bg-panel shadow-lg p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <span className={failed ? "text-reject" : "text-accent"}>{failed ? "!" : "✓"}</span>
        <div className="min-w-0 flex-1">
          <div className={failed ? "text-reject" : "text-ink font-medium"}>{title}</div>
          {!failed && (
            <div className="text-xs text-muted mt-0.5">
              Lightroom / Capture One will pick them up on Read Metadata.
            </div>
          )}
          {first && (
            <button
              type="button"
              onClick={() => void window.photocull.revealPath(first)}
              className="mt-2 text-xs text-accent hover:underline"
            >
              {isWindows ? "Show in Explorer" : "Show in Finder"}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-muted hover:text-ink leading-none"
          title="Dismiss"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
