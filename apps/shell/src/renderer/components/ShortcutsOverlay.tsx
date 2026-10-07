import { useStore } from "../store";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Move",
    rows: [
      ["← / →", "Previous / next frame"],
      ["↑ / ↓", "Previous / next scene"],
      ["Shift + ↑ / ↓", "Extend scene selection"],
      ["⌘/Ctrl + A", "Select all in scene"],
    ],
  },
  {
    title: "Cull",
    rows: [
      ["P · X · U", "Pick · reject · unset"],
      ["0 – 5", "Star rating"],
      ["L", "Picks-only filter (sync zoom in compare)"],
      ["Shift + L", "Clear filters"],
    ],
  },
  {
    title: "View",
    rows: [
      ["G", "Grid ↔ loupe"],
      ["C", "Compare"],
      ["M", "Scenes ↔ matches"],
      ["/", "Filter panel"],
      ["E · F", "Eye-zoom · face overlay"],
      ["Space / double-click", "Fit ↔ 1:1"],
    ],
  },
  {
    title: "Crop",
    rows: [
      ["R", "Crop mode"],
      ["Enter · Esc", "Apply · cancel"],
      ["Shift + R", "Clear crop"],
      ["Z", "Fit ↔ 100%"],
      ["Space + drag", "Pan"],
    ],
  },
  {
    title: "Selecting",
    rows: [
      ["⌘/Ctrl + click", "Toggle one"],
      ["Shift + click", "Range"],
      ["Drag", "Marquee select"],
      ["Right-click", "Menu for the selection"],
      ["Esc", "Leave compare / clear selection"],
    ],
  },
];

export function ShortcutsOverlay() {
  const open = useStore((s) => s.shortcutsOpen);
  const setOpen = useStore((s) => s.setShortcutsOpen);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="bg-panel border border-line rounded-lg shadow-xl max-w-3xl w-full max-h-full overflow-auto p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted hover:text-ink text-sm"
          >
            Close (Esc)
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-xs uppercase tracking-wide text-muted mb-1.5">{g.title}</h3>
              <dl className="space-y-1 text-sm">
                {g.rows.map(([k, d]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="font-mono text-ink w-40 flex-shrink-0">{k}</dt>
                    <dd className="text-muted">{d}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
