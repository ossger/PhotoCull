import { useEffect, useRef } from "react";
import { useStore, visibleScenes } from "../store";
import type { SceneRow } from "@shared/types";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function SceneCard({ scene, selected }: { scene: SceneRow; selected: boolean }) {
  const selectScene = useStore((s) => s.selectScene);
  const src = scene.cover_thumb ? window.photocull.thumbUrl(scene.cover_thumb) : "";
  return (
    <button
      type="button"
      onClick={() => selectScene(scene.id)}
      data-scene-id={scene.id}
      className={`w-full flex gap-2 p-2 text-left rounded-md border transition-colors
        ${selected ? "bg-panel2 border-accent" : "bg-panel border-transparent hover:bg-panel2 hover:border-line"}`}
    >
      <div className="w-16 h-16 flex-shrink-0 overflow-hidden rounded bg-bg">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{scene.label ?? `Scene ${scene.id}`}</div>
        <div className="text-xs text-muted">
          {scene.image_count} {scene.image_count === 1 ? "frame" : "frames"}
          {scene.starts_at ? ` · ${fmtTime(scene.starts_at)}` : ""}
        </div>
        {scene.avg_score != null && (
          <div className="text-xs text-muted">
            avg <span className="font-mono">{scene.avg_score.toFixed(1)}</span>
          </div>
        )}
      </div>
    </button>
  );
}

export function SceneList() {
  const scenes = useStore(visibleScenes);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the selected scene visible when the keyboard moves it.
  useEffect(() => {
    if (selectedSceneId == null || !containerRef.current) return;
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-scene-id="${selectedSceneId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedSceneId]);

  if (scenes.length === 0) {
    return (
      <div className="px-3 py-6 text-sm text-muted">
        Scenes appear here once a folder finishes indexing.
      </div>
    );
  }
  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
      {scenes.map((s) => (
        <SceneCard key={s.id} scene={s} selected={s.id === selectedSceneId} />
      ))}
    </div>
  );
}
