// Electron main process: window lifecycle, IPC handlers, sidecar supervision.

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { Sidecar } from "./sidecar";

const sidecar = new Sidecar();
let mainWindow: BrowserWindow | null = null;

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

  if (DEV_URL) {
    await mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
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
  ipcMain.handle("pickFolder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open shoot folder",
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

  ipcMain.handle("exportXmp", async (_e, onlyPicked: boolean) =>
    workerFetch("/export/xmp", {
      method: "POST",
      body: JSON.stringify({ only_picked: onlyPicked }),
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
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
