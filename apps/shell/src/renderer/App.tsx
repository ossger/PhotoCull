import { useEffect } from "react";
import { Toolbar } from "./components/Toolbar";
import { SceneList } from "./components/SceneList";
import { Filmstrip } from "./components/Filmstrip";
import { Loupe } from "./components/Loupe";
import { GridView } from "./components/GridView";
import { CompareView } from "./components/CompareView";
import { useStore } from "./store";
import { useHotkeys } from "./useHotkeys";
import { useFilmstripHost } from "./filmstripSync";
import { useMenuActions } from "./useMenuActions";
import { SelectionBar } from "./components/SelectionBar";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { StackPanel } from "./components/StackPanel";
import { StatusBar } from "./components/StatusBar";

export function App() {
  useHotkeys();
  useFilmstripHost();
  useMenuActions();
  const shootRoot = useStore((s) => s.shootRoot);
  useEffect(() => {
    window.photocull.setShootTitle(shootRoot ? shootRoot.split(/[\\/]/).filter(Boolean).pop() ?? null : null);
  }, [shootRoot]);
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
          <SelectionBar />
          <Filmstrip />
          <StatusBar />
        </div>
      </div>
      <ShortcutsOverlay />
      <StackPanel />
    </div>
  );
}
