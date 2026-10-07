import { Toolbar } from "./components/Toolbar";
import { SceneList } from "./components/SceneList";
import { Filmstrip } from "./components/Filmstrip";
import { Loupe } from "./components/Loupe";
import { GridView } from "./components/GridView";
import { CompareView } from "./components/CompareView";
import { useStore } from "./store";
import { useHotkeys } from "./useHotkeys";
import { useFilmstripHost } from "./filmstripSync";

export function App() {
  useHotkeys();
  useFilmstripHost();
  const compareMode = useStore((s) => s.compareMode);
  const viewMode = useStore((s) => s.viewMode);
  return (
    <div className="h-full flex flex-col">
      <Toolbar />
      <div className="flex-1 min-h-0 flex">
        {/* Left: scene list */}
        <div className="w-72 min-w-[14rem] max-w-[20rem] flex flex-col border-r border-line bg-panel">
          <div className="px-3 py-2 text-xs uppercase tracking-wide text-muted border-b border-line">
            Scenes
          </div>
          <SceneList />
        </div>
        {/* Center column: loupe/grid (or compare) + filmstrip */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex">
            {compareMode ? <CompareView /> : viewMode === "grid" ? <GridView /> : <Loupe />}
          </div>
          <Filmstrip />
          <HotkeyHint />
        </div>
      </div>
    </div>
  );
}

function HotkeyHint() {
  const compareMode = useStore((s) => s.compareMode);
  const cropMode = useStore((s) => s.cropMode);
  return (
    <div className="px-3 py-1.5 text-xs text-muted border-t border-line bg-panel2 flex gap-3 flex-wrap">
      {cropMode ? (
        <>
          <Key>Drag</Key> rect/handles · <Key>Scroll</Key>/pinch zoom ·{" "}
          <Key>Space+drag</Key> pan · <Key>Z</Key> fit/100% · <Key>Enter</Key> apply ·{" "}
          <Key>Esc</Key> cancel · <Key>Shift+R</Key> clear crop · <Key>Right-click</Key> menu
        </>
      ) : compareMode ? (
        <>
          <Key>Click</Key> filmstrip add/remove · <Key>Scroll</Key> zoom ·{" "}
          <Key>Drag</Key> pan · <Key>Dbl-click</Key> fit/1:1 · <Key>⤢</Key> open in loupe ·{" "}
          <Key>L</Key> sync zoom · <Key>Esc</Key>/<Key>C</Key> exit compare
        </>
      ) : (
        <>
          <Key>←/→</Key> frame · <Key>↑/↓</Key> scene (<Key>Shift</Key> extends) ·{" "}
          <Key>⌘/Ctrl+click</Key> toggle · <Key>Shift+click</Key> range ·{" "}
          <Key>Right-click</Key> menu ·{" "}
          <Key>Drag</Key> marquee · <Key>⌘/Ctrl+A</Key> select all ·{" "}
          <Key>P</Key> pick · <Key>X</Key> reject · <Key>U</Key> unset ·{" "}
          <Key>0-5</Key> stars · <Key>G</Key> grid · <Key>C</Key> compare ·{" "}
          <Key>R</Key> crop · <Key>E</Key> eye-zoom ·{" "}
          <Key>Space</Key>/dbl-click 1:1 · <Key>/</Key> filters ·{" "}
          <Key>M</Key> matches
        </>
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-ink">{children}</span>;
}
