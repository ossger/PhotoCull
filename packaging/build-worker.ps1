# Owner: Ross (RG)   #RG
# Build the Python sidecar as a one-folder PyInstaller bundle.
# Output: apps/worker/dist-bin/photocull-worker(.exe) + dependencies
#
# Run from repo root in an activated venv that has photocull-worker installed:
#   pip install -e apps/worker pyinstaller
#   ./packaging/build-worker.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $repo "apps/worker"
$dist = Join-Path $worker "dist-bin"

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null

Push-Location $worker
try {
    pyinstaller `
        --onedir `
        --name photocull-worker `
        --distpath $dist `
        --workpath (Join-Path $worker "build") `
        --specpath (Join-Path $worker "build") `
        --noconfirm `
        --clean `
        --hidden-import uvicorn.logging `
        --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols.http.auto `
        --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan.on `
        --collect-all mediapipe `
        --collect-all rawpy `
        (Join-Path $worker "entry.py")
} finally {
    Pop-Location
}
