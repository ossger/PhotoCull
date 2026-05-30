// Spawn and manage the Python FastAPI sidecar.
//
// In dev we shell out to `python -m photocull.server`. In a packaged build the
// sidecar is bundled as a PyInstaller one-folder under resources/worker — the
// `--print-handshake` flag is the same so the shell code below is identical.

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface SidecarHandshake {
  port: number;
  token: string;
}

export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private handshake: SidecarHandshake | null = null;

  async start(): Promise<SidecarHandshake> {
    const { cmd, args, cwd } = this.resolveCommand();
    this.proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
    });

    this.proc.stderr.on("data", (b) => process.stderr.write(`[worker] ${b}`));
    this.proc.on("exit", (code, sig) => {
      console.error(`[worker] exited code=${code} signal=${sig}`);
      this.proc = null;
    });

    this.handshake = await this.readHandshake();
    return this.handshake;
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
    this.handshake = null;
  }

  get info(): SidecarHandshake | null {
    return this.handshake;
  }

  // The sidecar prints exactly one JSON line on stdout once bound.
  private readHandshake(): Promise<SidecarHandshake> {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error("sidecar not started"));
        return;
      }
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const newlineIdx = buf.indexOf("\n");
        if (newlineIdx >= 0) {
          const line = buf.slice(0, newlineIdx).trim();
          try {
            const parsed = JSON.parse(line) as SidecarHandshake;
            this.proc?.stdout.off("data", onData);
            // Send the rest of stdout to console
            this.proc?.stdout.on("data", (b) =>
              process.stdout.write(`[worker] ${b}`),
            );
            resolve(parsed);
          } catch (err) {
            reject(new Error(`bad handshake line: ${line} (${err})`));
          }
        }
      };
      this.proc.stdout.on("data", onData);
      this.proc.on("error", reject);
      this.proc.on("exit", (code) => {
        if (!this.handshake) {
          reject(new Error(`sidecar exited before handshake (code ${code})`));
        }
      });
    });
  }

  private resolveCommand(): { cmd: string; args: string[]; cwd: string } {
    const baseArgs = ["--host", "127.0.0.1", "--port", "0", "--print-handshake"];
    if (app.isPackaged) {
      // PyInstaller one-folder build, see packaging/ scripts.
      const bin =
        process.platform === "win32"
          ? "photocull-worker.exe"
          : "photocull-worker";
      return {
        cmd: path.join(process.resourcesPath, "worker", bin),
        args: baseArgs,
        cwd: path.join(process.resourcesPath, "worker"),
      };
    }
    return {
      cmd: resolvePython(),
      args: ["-m", "photocull.server", ...baseArgs],
      cwd: path.resolve(__dirname, "../../worker"),
    };
  }
}

// Find the Python interpreter to run the sidecar with.
// Priority:
//   1. $PYTHON environment override (explicit user choice)
//   2. A `.venv` (or `venv`) next to the repo root — what `pip install -e
//      apps/worker` would have populated
//   3. Try PATH lookups via standard names. Important: Node's `spawn` on
//      Windows does NOT add `.exe` or search PATH, so we resolve to an
//      absolute path here.
function resolvePython(): string {
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) {
    return process.env.PYTHON;
  }

  const isWin = process.platform === "win32";
  const exe = isWin ? "python.exe" : "python3";
  const venvBin = isWin ? "Scripts" : "bin";

  // Walk up from this file looking for a venv. __dirname in dev is roughly
  // apps/shell/dist-electron, so check 1-4 levels up.
  let here = __dirname;
  for (let i = 0; i < 5; i++) {
    for (const venvName of [".venv", "venv"]) {
      const candidate = path.join(here, venvName, venvBin, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
    here = path.dirname(here);
  }

  // Fall back to PATH lookup. On Windows we walk PATH manually because
  // spawn() won't.
  if (isWin) {
    const paths = (process.env.PATH ?? "").split(path.delimiter);
    for (const name of ["python.exe", "python3.exe", "py.exe"]) {
      for (const dir of paths) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    throw new Error(
      "Could not find python.exe. Create a venv with `python -m venv .venv` " +
        "at the repo root and `pip install -e apps/worker`, or set the PYTHON " +
        "environment variable to a python executable.",
    );
  }
  // POSIX: spawn() does find executables on PATH.
  return process.env.PYTHON ?? "python3";
}
