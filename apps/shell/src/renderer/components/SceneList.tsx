import { useEffect, useRef, useState } from "react";
import { useStore, visibleScenes, sceneMatchCounts } from "../store";
import { showSceneMenu } from "../contextMenu";
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

function RenameInput({ scene }: { scene: SceneRow }) {
  const renameScene = useStore((s) => s.renameScene);
  const setRenamingScene = useStore((s) => s.setRenamingScene);
  const [value, setValue] = useState(scene.label ?? `Scene ${scene.id}`);
  return (
    <input
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => void renameScene(scene.id, value)}
      onKeyDown={(e) => {
        // Keep typing out of the global hotkeys (P/X/1-5 …).
        e.stopPropagation();
        if (e.key === "Enter") void renameScene(scene.id, value);
        else if (e.key === "Escape") setRenamingScene(null);
      }}
      className="w-full text-sm font-medium bg-bg border border-accent rounded px-1 outline-none"
    />
  );
}

function SceneCard({
  scene,
  selected,
  primary,
  matching,
}: {
  scene: SceneRow;
  selected: boolean;
  primary: boolean;
  matching: number;
}) {
  const selectScene = useStore((s) => s.selectScene);
  const toggleScene = useStore((s) => s.toggleScene);
  const selectSceneRange = useStore((s) => s.selectSceneRange);
  const renaming = useStore((s) => s.renamingSceneId === scene.id);
  const src = scene.cover_thumb ? window.photocull.thumbUrl(scene.cover_thumb) : "";
  // A filter can narrow what's visible within a scene — show "matching / total"
  // whenever that's happened, plain "N frames" otherwise.
  const countLabel =
    matching === scene.image_count
      ? `${scene.image_count} ${scene.image_count === 1 ? "frame" : "frames"}`
      : `${matching} / ${scene.image_count} frames`;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Same modifier semantics as the photo grid: cmd/ctrl toggles,
        // shift selects a range, plain click replaces.
        if (e.metaKey || e.ctrlKey) toggleScene(scene.id);
        else if (e.shiftKey) selectSceneRange(scene.id);
        else selectScene(scene.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void showSceneMenu(scene.id);
      }}
      data-scene-id={scene.id}
      className={`w-full flex gap-2 p-2 text-left rounded-md border transition-colors select-none
        ${
          primary
            ? "bg-panel2 border-accent"
            : selected
              ? "bg-panel2 border-accent/50"
              : "bg-panel border-transparent hover:bg-panel2 hover:border-line"
        }`}
    >
      <div className="w-16 h-16 flex-shrink-0 overflow-hidden rounded bg-bg">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameInput scene={scene} />
        ) : (
          <div className="text-sm font-medium truncate">
            {scene.kind === "astro" && (
              <span className="text-accent mr-1" title="Star sequence — right-click to stack">
                ✦
              </span>
            )}
            {scene.label ?? `Scene ${scene.id}`}
          </div>
        )}
        <div className="text-xs text-muted">
          {countLabel}
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
  const matchCounts = useStore(sceneMatchCounts);
  const selectedSceneId = useStore((s) => s.selectedSceneId);
  const selectedSceneIds = useStore((s) => s.selectedSceneIds);
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
        <SceneCard
          key={s.id}
          scene={s}
          selected={selectedSceneIds.includes(s.id)}
          primary={s.id === selectedSceneId}
          matching={matchCounts.get(s.id) ?? s.image_count}
        />
      ))}
    </div>
  );
}
