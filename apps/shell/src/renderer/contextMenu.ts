// Native right-click menus for photos and scenes. Items are built from the
// current selection each time, so the menu changes with the scenario: one vs
// many photos, one vs many scenes, whether a crop exists, whether a neighbour
// scene is there to merge with, and so on. The pop-out filmstrip window can
// only forward a fixed set of store actions to the main window (see
// filmstripSync.ts), so structural scene edits and crop are left out there.

import type { MenuTemplateItem } from "@shared/types";
import { sceneImages, useStore, visibleScenes } from "./store";

const COLORS = ["Red", "Yellow", "Green", "Blue", "Purple"];
const SEP: MenuTemplateItem = { type: "separator" };

const inPopOut = () => window.location.hash === "#filmstrip";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function header(label: string): MenuTemplateItem[] {
  return [{ label, enabled: false }, SEP];
}

// Pick / rating / colour entries shared by every menu; `what` names the target
// ("all" for bulk, "" for a single photo).
function cullItems(what: string): MenuTemplateItem[] {
  const sfx = what ? ` ${what}` : "";
  return [
    { id: "pick:1", label: `Pick${sfx}`, shortcut: "P" },
    { id: "pick:-1", label: `Reject${sfx}`, shortcut: "X" },
    { id: "pick:0", label: `Unset${sfx}`, shortcut: "U" },
    SEP,
    {
      label: "Rating",
      submenu: [0, 1, 2, 3, 4, 5].map((n) => ({
        id: `stars:${n}`,
        label: n === 0 ? "No stars" : "★".repeat(n),
        shortcut: String(n),
      })),
    },
    {
      label: "Color label",
      submenu: [
        { id: "color:none", label: "None" },
        ...COLORS.map((c) => ({ id: `color:${c}`, label: c })),
      ],
    },
  ];
}

// Shared handler for the ids produced by cullItems; returns true if handled.
function runCull(choice: string, ids: number[]): boolean {
  const st = useStore.getState();
  const [kind, val] = choice.split(":");
  if (kind === "pick") void st.setPickMany(ids, Number(val) as -1 | 0 | 1);
  else if (kind === "stars") void st.setStarsMany(ids, Number(val));
  else if (kind === "color") void st.setColorMany(ids, val === "none" || val === undefined ? null : val);
  else return false;
  return true;
}

// Scene's frames in the order the worker splits on (capture time, undated last, filename).
function sceneFrameIds(sceneId: number): number[] {
  return useStore
    .getState()
    .images.filter((i) => i.scene_id === sceneId)
    .sort((a, b) => {
      if ((a.captured_at == null) !== (b.captured_at == null)) return a.captured_at == null ? 1 : -1;
      return (a.captured_at ?? "").localeCompare(b.captured_at ?? "") || a.filename.localeCompare(b.filename);
    })
    .map((i) => i.id);
}

export async function showImageMenu(imageId: number): Promise<void> {
  // Finder-style: right-clicking outside the selection selects just that
  // frame; right-clicking inside it keeps the whole selection.
  if (!useStore.getState().selectedIds.includes(imageId)) useStore.getState().selectImage(imageId);
  const st = useStore.getState();
  const ids = st.selectedIds;
  const many = ids.length > 1;
  const popOut = inPopOut();
  const image = st.images.find((i) => i.id === imageId);
  if (!image) return;
  const hasCrop = image.crop_left != null;
  const sceneIds = new Set(ids.map((id) => st.images.find((i) => i.id === id)?.scene_id));

  const moveTargets: MenuTemplateItem[] = [
    ...st.scenes
      .filter((sc) => !(sceneIds.size === 1 && sceneIds.has(sc.id)))
      .map((sc) => ({ id: `move:${sc.id}`, label: sc.label ?? `Scene ${sc.id}` })),
  ];
  const moveItem: MenuTemplateItem = {
    label: "Move to scene",
    submenu: [{ id: "move:new", label: "New scene" }, ...(moveTargets.length ? [SEP, ...moveTargets] : [])],
  };

  const t: MenuTemplateItem[] = [
    ...(many ? header(plural(ids.length, "photo")) : []),
    ...cullItems(many ? "all" : ""),
    SEP,
  ];
  if (many && ids.length >= 3) t.push({ id: "stack", label: `Stack ${ids.length} frames as stars…` }, SEP);
  if (many) {
    t.push({
      id: "compare",
      label: ids.length > 4 ? "Compare (select up to 4)" : `Compare ${ids.length} photos`,
      enabled: ids.length <= 4,
      shortcut: "C",
    });
  } else if (!popOut) {
    t.push({ id: "crop", label: "Crop…", shortcut: "R" });
    if (hasCrop) t.push({ id: "clearCrop", label: "Clear crop", shortcut: "Shift+R" });
    t.push({ id: "cover", label: "Set as scene cover" });
    const frames = image.scene_id != null ? sceneFrameIds(image.scene_id) : [];
    t.push({ id: "split", label: "Split scene here", enabled: frames.length > 1 && frames[0] !== imageId });
  }
  if (!popOut) t.push(moveItem);
  t.push(SEP);
  if (!many && st.viewMode === "grid") t.push({ id: "loupe", label: "Open in loupe", shortcut: "G" });
  if (many) t.push({ id: "selectScene", label: "Select all in scene", shortcut: "CmdOrCtrl+A" });
  t.push({ id: "export", label: many ? `Export XMP for ${plural(ids.length, "photo")}` : "Export XMP for this photo" });
  if (many) t.push({ id: "clear", label: "Clear selection", shortcut: "Escape" });

  const choice = await window.photocull.popupMenu(t);
  if (!choice || runCull(choice, ids)) return;
  const s = useStore.getState();
  if (choice.startsWith("move:")) {
    const dest = choice.slice(5);
    await s.moveImagesToScene(ids, dest === "new" ? null : Number(dest));
    return;
  }
  switch (choice) {
    case "stack":
      s.openStackPanel(ids);
      break;
    case "compare":
      s.toggleCompare();
      break;
    case "crop":
      s.enterCropMode();
      break;
    case "clearCrop":
      await s.clearCrop();
      break;
    case "cover":
      if (image.scene_id != null) await s.setSceneCover(image.scene_id, imageId);
      break;
    case "split":
      await s.splitSceneAt(imageId);
      break;
    case "loupe":
      s.toggleViewMode();
      break;
    case "selectScene":
      s.selectAllInScene();
      break;
    case "export":
      await s.exportImageIds(ids);
      break;
    case "clear":
      s.clearSelection();
      break;
  }
}

export async function showSceneMenu(sceneId: number): Promise<void> {
  if (!useStore.getState().selectedSceneIds.includes(sceneId)) useStore.getState().selectScene(sceneId);
  const st = useStore.getState();
  const sceneIds = st.selectedSceneIds;
  const many = sceneIds.length > 1;
  const frames = sceneImages(st).map((i) => i.id);
  const order = visibleScenes(st).map((sc) => sc.id);
  const idx = order.indexOf(sceneId);
  const prev = !many && idx > 0 ? order[idx - 1] : null;
  const next = !many && idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const anyManual = st.scenes.some((sc) => sc.manual);

  const t: MenuTemplateItem[] = [
    ...header(many ? plural(sceneIds.length, "scene") : (st.scenes.find((sc) => sc.id === sceneId)?.label ?? "Scene")),
    { id: "selectPhotos", label: `Select ${plural(frames.length, "photo")}`, enabled: frames.length > 0 },
    SEP,
    ...cullItems("all"),
    SEP,
  ];
  const thisScene = st.scenes.find((sc) => sc.id === sceneId);
  if (many) t.push({ id: "merge", label: `Merge ${sceneIds.length} scenes` });
  else {
    if (thisScene?.kind === "astro") {
      t.push({ id: "stack", label: "Stack stars…", enabled: frames.length >= 3 });
      t.push({ id: "unmarkAstro", label: "Not a star sequence" });
    } else {
      t.push({ id: "markAstro", label: "Mark as star sequence" });
    }
    t.push(SEP);
    t.push({ id: "rename", label: "Rename…" });
    t.push({ id: "mergePrev", label: "Merge with previous scene", enabled: prev != null });
    t.push({ id: "mergeNext", label: "Merge with next scene", enabled: next != null });
  }
  t.push(SEP, {
    id: "export",
    label: many ? "Export XMP for scenes" : "Export XMP for scene",
    enabled: frames.length > 0,
  });
  if (anyManual) t.push({ id: "reset", label: "Reset to automatic grouping" });

  const choice = await window.photocull.popupMenu(t);
  if (!choice || runCull(choice, frames)) return;
  const s = useStore.getState();
  switch (choice) {
    case "selectPhotos":
      s.setSelection(frames, frames[0] ?? null);
      break;
    case "stack":
      s.openStackPanel(frames);
      break;
    case "markAstro":
      await s.markStarSequence(sceneId, true);
      break;
    case "unmarkAstro":
      await s.markStarSequence(sceneId, false);
      break;
    case "merge":
      await s.mergeScenes(sceneIds);
      break;
    case "mergePrev":
      if (prev != null) await s.mergeScenes([prev, sceneId]);
      break;
    case "mergeNext":
      if (next != null) await s.mergeScenes([sceneId, next]);
      break;
    case "rename":
      s.setRenamingScene(sceneId);
      break;
    case "export":
      await s.exportImageIds(frames);
      break;
    case "reset":
      await s.resetSceneGrouping();
      break;
  }
}
