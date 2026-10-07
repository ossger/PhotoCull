import { useStore } from "../store";

// Floating actions for a multi-frame selection. Sits above the filmstrip and
// only exists while two or more frames are selected.
export function SelectionBar() {
  const selectedIds = useStore((s) => s.selectedIds);
  const setPickMany = useStore((s) => s.setPickMany);
  const clearSelection = useStore((s) => s.clearSelection);
  const exportImageIds = useStore((s) => s.exportImageIds);
  const makeStarSequence = useStore((s) => s.makeStarSequence);
  if (selectedIds.length < 2) return null;
  return (
    <div className="px-3 py-1.5 border-t border-line bg-panel flex items-center gap-2 text-xs">
      <span className="text-ink font-medium">{selectedIds.length} selected</span>
      <button
        type="button"
        onClick={() => void setPickMany(selectedIds, 1)}
        className="px-2 py-0.5 rounded bg-pick/20 text-pick hover:bg-pick/30"
        title="Pick all selected frames (P)"
      >
        Pick
      </button>
      <button
        type="button"
        onClick={() => void setPickMany(selectedIds, -1)}
        className="px-2 py-0.5 rounded bg-reject/20 text-reject hover:bg-reject/30"
        title="Reject all selected frames (X)"
      >
        Reject
      </button>
      <button
        type="button"
        onClick={() => void setPickMany(selectedIds, 0)}
        className="px-2 py-0.5 rounded text-muted hover:text-ink hover:bg-line"
        title="Unset pick on all selected frames (U)"
      >
        Unset
      </button>
      <span className="w-px h-4 bg-line mx-1" />
      <button
        type="button"
        onClick={() => void makeStarSequence(selectedIds)}
        className="px-2 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30"
        title="Group these frames into one star sequence, then judge and stack them"
      >
        ✦ Make star sequence{selectedIds.length >= 3 ? " & stack…" : ""}
      </button>

      <button
        type="button"
        onClick={() => void exportImageIds(selectedIds)}
        className="px-2 py-0.5 rounded text-muted hover:text-ink hover:bg-line"
        title="Write XMP sidecars for the selected frames"
      >
        Export
      </button>
      <button
        type="button"
        onClick={clearSelection}
        className="ml-auto px-2 py-0.5 rounded text-muted hover:text-ink hover:bg-line"
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    </div>
  );
}
