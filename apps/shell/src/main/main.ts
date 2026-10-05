// Electron main process: window lifecycle, IPC handlers, sidecar supervision.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type Rectangle,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { Sidecar } from "./sidecar";

const sidecar = new Sidecar();
let mainWindow: BrowserWindow | null = null;
// The torn-off filmstrip (null while docked). See "filmstrip pop-out" below.
let filmstripWindow: BrowserWindow | null = null;

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#0f1115",
    title: "PhotoCull",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Block navigation away from the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // The pop-out is a satellite of this window — it can't act on its own.
  mainWindow.on("closed", () => {
    mainWindow = null;
    filmstripWindow?.close();
  });

  if (DEV_URL) {
    await mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// ----- filmstrip pop-out -----
//
// A second window loading the same renderer with a #filmstrip hash, which
// renders only a thumbnail grid. The main window stays the authority: it
// pushes store snapshots here, and the pop-out sends actions/keys back. This
// process only relays, and drops any message from the wrong window.

const FILMSTRIP_BOUNDS_FILE = "filmstrip-window.json";

function filmstripBoundsPath(): string {
  return path.join(app.getPath("userData"), FILMSTRIP_BOUNDS_FILE);
}

function loadFilmstripBounds(): Rectangle | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filmstripBoundsPath(), "utf8")) as Partial<Rectangle>;
    const { x, y, width, height } = raw;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      width < 200 ||
      height < 150
    ) {
      return null;
    }
    const bounds = { x, y, width, height };
    // Ignore bounds that no longer land on any display (monitor unplugged).
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y;
    });
    return onScreen ? bounds : null;
  } catch {
    return null;
  }
}

function saveFilmstripBounds(bounds: Rectangle): void {
  try {
    fs.writeFileSync(filmstripBoundsPath(), JSON.stringify(bounds));
  } catch (err) {
    console.warn("Could not save filmstrip window bounds:", err);
  }
}

function notifyPoppedOut(poppedOut: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("filmstrip:poppedOut", poppedOut);
  }
}

async function openFilmstripWindow(): Promise<void> {
  if (filmstripWindow) {
    if (filmstripWindow.isMinimized()) filmstripWindow.restore();
    filmstripWindow.focus();
    return;
  }
  const saved = loadFilmstripBounds();
  const win = new BrowserWindow({
    width: saved?.width ?? 900,
    height: saved?.height ?? 600,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 320,
    minHeight: 200,
    backgroundColor: "#0f1115",
    title: "PhotoCull — Filmstrip",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  filmstripWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", () => saveFilmstripBounds(win.getBounds()));
  win.on("closed", () => {
    if (filmstripWindow === win) filmstripWindow = null;
    notifyPoppedOut(false);
  });

  notifyPoppedOut(true);
  if (DEV_URL) {
    await win.loadURL(`${DEV_URL.replace(/#.*$/, "")}#filmstrip`);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "filmstrip" });
  }
}

function fromMainWindow(e: IpcMainEvent): boolean {
  return mainWindow != null && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
}

function fromFilmstripWindow(e: IpcMainEvent): boolean {
  return (
    filmstripWindow != null &&
    !filmstripWindow.isDestroyed() &&
    e.sender === filmstripWindow.webContents
  );
}

function registerFilmstripIpc(): void {
  ipcMain.handle("filmstrip:popOut", async (e) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    await openFilmstripWindow();
  });

  // Either window may dock (the pop-out has its own Dock button).
  ipcMain.handle("filmstrip:dock", async () => {
    filmstripWindow?.close();
  });

  ipcMain.handle("filmstrip:isPoppedOut", async () => filmstripWindow != null);

  // Main window -> pop-out: store snapshot.
  ipcMain.on("filmstrip:sync", (e, snapshot: unknown) => {
    if (!fromMainWindow(e) || !filmstripWindow || filmstripWindow.isDestroyed()) return;
    if (snapshot == null || typeof snapshot !== "object") return;
    filmstripWindow.webContents.send("filmstrip:sync", snapshot);
  });

  // Pop-out -> main window: "send me a full snapshot" (on pop-out mount).
  ipcMain.on("filmstrip:syncRequest", (e) => {
    if (!fromFilmstripWindow(e) || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("filmstrip:syncRequest");
  });

  // Pop-out -> main window: an action or keypress. The main window's
  // renderer re-checks the action name against its own allow-list.
  ipcMain.on("filmstrip:action", (e, action: unknown) => {
    if (!fromFilmstripWindow(e) || !mainWindow || mainWindow.isDestroyed()) return;
    if (action == null || typeof action !== "object") return;
    mainWindow.webContents.send("filmstrip:action", action);
  });
}

// ----- IPC bridge -----

function workerBase(): { base: string; headers: Record<string, string> } {
  const info = sidecar.info;
  if (!info) throw new Error("sidecar not ready");
  return {
    base: `http://127.0.0.1:${info.port}`,
    headers: { "X-PhotoCull-Token": info.token },
  };
}

async function workerFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  const { base, headers } = workerBase();
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...headers,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`worker ${pathname} ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function registerIpc(): void {
  ipcMain.handle("pickFolder", async (_e, title?: string, defaultPath?: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title ?? "Open shoot folder",
      defaultPath,
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("openShoot", async (_e, folderPath: string) =>
    workerFetch("/shoot/open", {
      method: "POST",
      body: JSON.stringify({ path: folderPath }),
    }),
  );

  ipcMain.handle("shootProgress", async () =>
    workerFetch("/shoot/progress"),
  );

  ipcMain.handle("listImages", async () => workerFetch("/images"));

  ipcMain.handle("listScenes", async () => workerFetch("/scenes"));

  ipcMain.handle("regroupScenes", async () =>
    workerFetch("/scenes/regroup", { method: "POST" }),
  );

  ipcMain.handle("exportXmp", async (_e, onlyPicked: boolean, imageIds?: number[]) =>
    workerFetch("/export/xmp", {
      method: "POST",
      body: JSON.stringify({ only_picked: onlyPicked, image_ids: imageIds ?? null }),
    }),
  );

  ipcMain.handle(
    "organizePlan",
    async (_e, source: string, library: string, label: string | null) =>
      workerFetch("/organize/plan", {
        method: "POST",
        body: JSON.stringify({ source, library, label }),
      }),
  );

  ipcMain.handle(
    "organizeRun",
    async (_e, source: string, library: string, label: string | null) =>
      workerFetch("/organize/run", {
        method: "POST",
        body: JSON.stringify({ source, library, label }),
      }),
  );

  ipcMain.handle("organizeProgress", async () => workerFetch("/organize/progress"));

  ipcMain.handle("eventsPlan", async (_e, folder: string, gapHours: number) =>
    workerFetch("/events/plan", {
      method: "POST",
      body: JSON.stringify({ folder, gap_hours: gapHours }),
    }),
  );

  ipcMain.handle(
    "eventsRun",
    async (
      _e,
      folder: string,
      gapHours: number,
      groups: { event_ids: string[]; name: string }[],
    ) =>
      workerFetch("/events/run", {
        method: "POST",
        body: JSON.stringify({ folder, gap_hours: gapHours, groups }),
      }),
  );

  ipcMain.handle("eventsProgress", async () => workerFetch("/events/progress"));

  ipcMain.handle("eventsUndo", async (_e, folder: string) =>
    workerFetch("/events/undo", {
      method: "POST",
      body: JSON.stringify({ folder }),
    }),
  );

  ipcMain.handle("setPick", async (_e, imageId: number, pick: number) =>
    workerFetch(`/images/${imageId}/pick`, {
      method: "POST",
      body: JSON.stringify({ pick }),
    }),
  );

  ipcMain.handle("setStars", async (_e, imageId: number, stars: number) =>
    workerFetch(`/images/${imageId}/stars`, {
      method: "POST",
      body: JSON.stringify({ stars }),
    }),
  );

  ipcMain.handle("setColor", async (_e, imageId: number, color: string | null) =>
    workerFetch(`/images/${imageId}/color`, {
      method: "POST",
      body: JSON.stringify({ color }),
    }),
  );

  ipcMain.handle("setPickMany", async (_e, imageIds: number[], pick: number) =>
    workerFetch(`/images/batch/pick`, {
      method: "POST",
      body: JSON.stringify({ image_ids: imageIds, pick }),
    }),
  );

  ipcMain.handle("setStarsMany", async (_e, imageIds: number[], stars: number) =>
    workerFetch(`/images/batch/stars`, {
      method: "POST",
      body: JSON.stringify({ image_ids: imageIds, stars }),
    }),
  );

  ipcMain.handle("setColorMany", async (_e, imageIds: number[], color: string | null) =>
    workerFetch(`/images/batch/color`, {
      method: "POST",
      body: JSON.stringify({ image_ids: imageIds, color }),
    }),
  );

  ipcMain.handle(
    "setCrop",
    async (
      _e,
      imageId: number,
      crop: { left: number; top: number; right: number; bottom: number } | null,
    ) =>
      workerFetch(`/images/${imageId}/crop`, {
        method: "POST",
        body: JSON.stringify(crop ?? { left: null, top: null, right: null, bottom: null }),
      }),
  );

  ipcMain.handle("workerInfo", async () => sidecar.info);

  registerFilmstripIpc();
}

// ----- bootstrap -----

app.whenReady().then(async () => {
  registerIpc();
  try {
    await sidecar.start();
    await waitForHealth();
  } catch (err) {
    console.error("Failed to start sidecar:", err);
    dialog.showErrorBox(
      "PhotoCull",
      `Failed to start image worker.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
    return;
  }
  await createWindow();
});

app.on("window-all-closed", () => {
  sidecar.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});

app.on("before-quit", () => sidecar.stop());

async function waitForHealth(maxAttempts = 50, delayMs = 100): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await workerFetch<{ status: string }>("/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("sidecar health check timed out");
}
