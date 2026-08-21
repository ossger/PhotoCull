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
$vendor = Join-Path $worker "vendor/exiftool"

# --- Stage a portable exiftool so the packaged app needs no separate install. ---
# On Windows the worker already auto-downloads exiftool at first run
# (see photocull/models.py::_download_exiftool_windows), so bundling here is a
# convenience — it makes the packaged app self-contained offline too — not a
# hard requirement the way it is on macOS.
$EXIFTOOL_VERSION = "13.59"
$EXIFTOOL_WIN_URL = "https://exiftool.org/exiftool-$EXIFTOOL_VERSION`_64.zip"

function Stage-Exiftool {
    if (Test-Path (Join-Path $vendor "exiftool.exe")) {
        Write-Host "exiftool already staged at $vendor"
        return
    }
    Write-Host "staging exiftool $EXIFTOOL_VERSION into $vendor"
    if (Test-Path $vendor) { Remove-Item -Recurse -Force $vendor }
    New-Item -ItemType Directory -Path $vendor | Out-Null

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp "exiftool.zip"
        try {
            Invoke-WebRequest -Uri $EXIFTOOL_WIN_URL -OutFile $zipPath -TimeoutSec 120
        } catch {
            Write-Warning "exiftool download failed ($_); packaged app will fall back to first-run download."
            Remove-Item -Recurse -Force $vendor -ErrorAction SilentlyContinue
            return
        }
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

        # 13.x nests the launcher + exiftool_files under exiftool-<ver>_64/.
        $launcher = Get-ChildItem -Path $tmp -Recurse -Filter "exiftool(-k).exe" | Select-Object -First 1
        if (-not $launcher) {
            $launcher = Get-ChildItem -Path $tmp -Recurse -Filter "exiftool.exe" | Select-Object -First 1
        }
        if (-not $launcher) {
            Write-Warning "exiftool zip extracted but no launcher found; skipping bundling."
            Remove-Item -Recurse -Force $vendor -ErrorAction SilentlyContinue
            return
        }
        $srcDir = $launcher.Directory.FullName
        Copy-Item -Path (Join-Path $srcDir "*") -Destination $vendor -Recurse -Force
        $bundled = Join-Path $vendor $launcher.Name
        if ($launcher.Name -ne "exiftool.exe") {
            Move-Item -Path $bundled -Destination (Join-Path $vendor "exiftool.exe") -Force
        }
        Write-Host "exiftool staged from exiftool.org release $EXIFTOOL_VERSION"
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Stage-Exiftool

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null

$pyinstallerArgs = @(
    "--onedir",
    "--name", "photocull-worker",
    "--distpath", $dist,
    "--workpath", (Join-Path $worker "build"),
    "--specpath", (Join-Path $worker "build"),
    "--noconfirm",
    "--clean",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--hidden-import", "uvicorn.protocols.websockets.auto",
    "--hidden-import", "uvicorn.lifespan.on",
    "--collect-all", "mediapipe",
    "--collect-all", "rawpy"
)
if (Test-Path (Join-Path $vendor "exiftool.exe")) {
    $pyinstallerArgs += @("--add-data", "$vendor;exiftool")
}
$pyinstallerArgs += (Join-Path $worker "entry.py")

Push-Location $worker
try {
    pyinstaller @pyinstallerArgs
} finally {
    Pop-Location
}
