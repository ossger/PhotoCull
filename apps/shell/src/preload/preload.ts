// Context bridge: exposes a typed, allow-listed API to the renderer.
import { contextBridge, ipcRenderer } from "electron";

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

interface ImageRowLike {
  rel_path: string;
  full_path: string | null;
}
function fullUrlFor(image: ImageRowLike): string {
  if (image.full_path) return fileUrl("full", image.full_path);
  return fileUrl("original", image.rel_path);
}

// Eagerly cache info at preload time so the renderer never sees an empty URL.
void ensureInfo();

contextBridge.exposeInMainWorld("photocull", {
  pickFolder: () => invoke("pickFolder"),
  openShoot: (p: string) => invoke("openShoot", p),
  shootProgress: () => invoke("shootProgress"),
  listImages: () => invoke("listImages"),
  listScenes: () => invoke("listScenes"),
  regroupScenes: () => invoke("regroupScenes"),
  exportXmp: (onlyPicked: boolean) => invoke("exportXmp", onlyPicked),
  organizePlan: (source: string, library: string, label: string | null) =>
    invoke("organizePlan", source, library, label),
  organizeRun: (source: string, library: string, label: string | null) =>
    invoke("organizeRun", source, library, label),
  organizeProgress: () => invoke("organizeProgress"),
  setPick: (id: number, pick: -1 | 0 | 1) => invoke("setPick", id, pick),
  setStars: (id: number, stars: number) => invoke("setStars", id, stars),
  setColor: (id: number, color: string | null) =>
    invoke("setColor", id, color),
  setCrop: (
    id: number,
    crop: { left: number; top: number; right: number; bottom: number } | null,
  ) => invoke("setCrop", id, crop),
  thumbUrl: (rel: string) => fileUrl("thumb", rel),
  previewUrl: (rel: string) => fileUrl("preview", rel),
  fullUrl: (image: ImageRowLike) => fullUrlFor(image),
});
