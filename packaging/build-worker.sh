#!/usr/bin/env bash
# Build the Python sidecar as a one-folder PyInstaller bundle (macOS/Linux).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
worker="$repo/apps/worker"
dist="$worker/dist-bin"

rm -rf "$dist"
mkdir -p "$dist"

cd "$worker"
pyinstaller \
    --onedir \
    --name photocull-worker \
    --distpath "$dist" \
    --workpath "$worker/build" \
    --specpath "$worker/build" \
    --noconfirm \
    --clean \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --collect-all mediapipe \
    --collect-all rawpy \
    "$worker/photocull/server.py"
