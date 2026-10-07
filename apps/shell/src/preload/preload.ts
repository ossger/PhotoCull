// Context bridge: exposes a typed, allow-listed API to the renderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  FilmstripAction,
  MenuTemplateItem,
  StoreSyncSnapshot,
} from "../shared/types";

const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args);

// We synchronously fetch the worker handshake once so the renderer can build
// authenticated <img src> URLs without a round-trip per image.
let cachedInfo: { port: number; token: string } | null = null;

async function ensureInfo() {
  if (!cachedInfo) {
    cachedInfo = (await invoke("workerInfo")) as { port: number; token: string };
  }
  return cachedInfo;
}

// Build a URL the renderer's <img> can load. We embed the token in a query
// param — the FastAPI side also accepts it, and there's no easy way to set
// headers on <img>. Token leaks are bounded to localhost.
function fileUrl(kind: "thumb" | "preview" | "full" | "original", rel: string): string {
  if (!cachedInfo) {
    // Fire-and-forget refresh; caller can retry once info is ready.
    void ensureInfo();
    return "";
  }
  const params = new URLSearchParams({ rel, token: cachedInfo.token });
  return `http://127.0.0.1:${cachedInfo.port}/files/${kind}?${params.toString()}`;
}

// Preview thumbnail of a loose file in a folder being sorted into events —
// there's no open shoot (and so no cache) for it yet.
function eventThumbUrl(folder: string, name: string): string {
  if (!cachedInfo) {
    void ensureInfo();
    return "";
  }
  const params = new URLSearchParams({ folder, name, token: cachedInfo.token });
  return `http://127.0.0.1:${cachedInfo.port}/events/thumb?${params.toString()}`;
}

interface ImageRowLike {
  rel_path: string;
  full_path: string | null;
}
function fullUrlFor(image: ImageRowLike): string {
  if (image.full_path) return fileUrl("full", image.full_path);
  return fileUrl("original", image.rel_path);
}

// Subscribe to a main -> renderer channel; returns an unsubscribe function.
// The raw IpcRendererEvent is never handed to the renderer (it carries `sender`).
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// Eagerly cache info at preload time so the renderer never sees an empty URL.
void ensureInfo();

contextBridge.exposeInMainWorld("photocull", {
  pickFolder: (title?: string, defaultPath?: string) =>
    invoke("pickFolder", title, defaultPath),
  openShoot: (p: string) => invoke("openShoot", p),
  shootProgress: () => invoke("shootProgress"),
  listImages: () => invoke("listImages"),
  listScenes: () => invoke("listScenes"),
  regroupScenes: (force?: boolean) => invoke("regroupScenes", force),
  mergeScenes: (sceneIds: number[]) => invoke("mergeScenes", sceneIds),
  splitScene: (sceneId: number, atImageId: number) =>
    invoke("splitScene", sceneId, atImageId),
  updateScene: (sceneId: number, patch: { label?: string; cover_image_id?: number }) =>
    invoke("updateScene", sceneId, patch),
  moveImagesToScene: (imageIds: number[], sceneId: number | null) =>
    invoke("moveImagesToScene", imageIds, sceneId),
  popupMenu: (template: MenuTemplateItem[]) => invoke("popupMenu", template),
  exportXmp: (onlyPicked: boolean, imageIds?: number[]) => invoke("exportXmp", onlyPicked, imageIds),
  organizePlan: (source: string, library: string, label: string | null) =>
    invoke("organizePlan", source, library, label),
  organizeRun: (source: string, library: string, label: string | null) =>
    invoke("organizeRun", source, library, label),
  organizeProgress: () => invoke("organizeProgress"),
  eventsPlan: (folder: string, gapHours: number) => invoke("eventsPlan", folder, gapHours),
  eventsRun: (folder: string, gapHours: number, groups: { event_ids: string[]; name: string }[]) =>
    invoke("eventsRun", folder, gapHours, groups),
  eventsProgress: () => invoke("eventsProgress"),
  eventsUndo: (folder: string) => invoke("eventsUndo", folder),
  eventThumbUrl: (folder: string, name: string) => eventThumbUrl(folder, name),
  setPick: (id: number, pick: -1 | 0 | 1) => invoke("setPick", id, pick),
  setStars: (id: number, stars: number) => invoke("setStars", id, stars),
  setColor: (id: number, color: string | null) =>
    invoke("setColor", id, color),
  setPickMany: (ids: number[], pick: -1 | 0 | 1) => invoke("setPickMany", ids, pick),
  setStarsMany: (ids: number[], stars: number) => invoke("setStarsMany", ids, stars),
  setColorMany: (ids: number[], color: string | null) =>
    invoke("setColorMany", ids, color),
  setCrop: (
    id: number,
    crop: { left: number; top: number; right: number; bottom: number } | null,
  ) => invoke("setCrop", id, crop),
  thumbUrl: (rel: string) => fileUrl("thumb", rel),
  previewUrl: (rel: string) => fileUrl("preview", rel),
  fullUrl: (image: ImageRowLike) => fullUrlFor(image),
  onMenuAction: (cb: (id: string) => void) => subscribe<string>("menu:action", cb),
  revealPath: (p: string) => invoke("revealPath", p),
  setShootTitle: (name: string | null) => ipcRenderer.send("window:setShootTitle", name),
  // Torn-off filmstrip window. main.ts checks which window each send came from.
  popOutFilmstrip: () => invoke("filmstrip:popOut"),
  dockFilmstrip: () => invoke("filmstrip:dock"),
  isFilmstripPoppedOut: () => invoke("filmstrip:isPoppedOut"),
  onFilmstripPoppedOut: (cb: (poppedOut: boolean) => void) =>
    subscribe<boolean>("filmstrip:poppedOut", cb),
  sendStoreSync: (snapshot: StoreSyncSnapshot) => ipcRenderer.send("filmstrip:sync", snapshot),
  onStoreSyncRequest: (cb: () => void) => subscribe<void>("filmstrip:syncRequest", () => cb()),
  onFilmstripAction: (cb: (action: FilmstripAction) => void) =>
    subscribe<FilmstripAction>("filmstrip:action", cb),
  onStoreSync: (cb: (snapshot: StoreSyncSnapshot) => void) =>
    subscribe<StoreSyncSnapshot>("filmstrip:sync", cb),
  requestStoreSync: () => ipcRenderer.send("filmstrip:syncRequest"),
  sendFilmstripAction: (action: FilmstripAction) => ipcRenderer.send("filmstrip:action", action),
});
