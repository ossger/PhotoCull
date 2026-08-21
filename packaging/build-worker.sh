#!/usr/bin/env bash
# Build the Python sidecar as a one-folder PyInstaller bundle (macOS/Linux).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
worker="$repo/apps/worker"
dist="$worker/dist-bin"
vendor="$worker/vendor/exiftool"

# --- Stage a portable exiftool so the packaged app needs no Homebrew/apt install. ---
# exiftool.org publishes the Unix tarball via SourceForge; the tarball's `exiftool`
# script already uses `#!/usr/bin/env perl`, which is portable across machines.
EXIFTOOL_VERSION="13.59"
EXIFTOOL_TARBALL_URL="https://sourceforge.net/projects/exiftool/files/Image-ExifTool-${EXIFTOOL_VERSION}.tar.gz/download"

stage_exiftool() {
    if [ -x "$vendor/exiftool" ]; then
        echo "exiftool already staged at $vendor"
        return 0
    fi
    echo "staging exiftool ${EXIFTOOL_VERSION} into $vendor"
    rm -rf "$vendor"
    mkdir -p "$vendor"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

    if curl -fsSL -o "$tmp/exiftool.tar.gz" "$EXIFTOOL_TARBALL_URL" \
        && tar -xzf "$tmp/exiftool.tar.gz" -C "$tmp"; then
        local src="$tmp/Image-ExifTool-${EXIFTOOL_VERSION}"
        cp "$src/exiftool" "$vendor/exiftool"
        cp -R "$src/lib" "$vendor/lib"
        chmod +x "$vendor/exiftool"
        echo "exiftool staged from exiftool.org release ${EXIFTOOL_VERSION}"
        return 0
    fi

    echo "download failed — falling back to the local Homebrew exiftool" >&2
    local brew_exiftool
    brew_exiftool="$(command -v exiftool || true)"
    if [ -z "$brew_exiftool" ]; then
        echo "error: no local exiftool on PATH to fall back to. Install it with" >&2
        echo "  'brew install exiftool' and re-run, or fix network access." >&2
        exit 1
    fi
    local real_exiftool
    real_exiftool="$(readlink -f "$brew_exiftool" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$brew_exiftool")"
    local brew_libexec
    brew_libexec="$(cd "$(dirname "$real_exiftool")/.." && pwd)"
    cp "$real_exiftool" "$vendor/exiftool"
    cp -R "$brew_libexec/lib" "$vendor/lib"
    chmod +x "$vendor/exiftool"
    # Homebrew's exiftool shebang pins a specific perl version (e.g. #!/usr/bin/perl5.34),
    # which won't exist on another machine. Rewrite it to the portable form.
    sed -i '' '1s|^#!.*perl.*$|#!/usr/bin/env perl|' "$vendor/exiftool"
    echo "exiftool staged from local Homebrew install (shebang rewritten for portability)"
}

stage_exiftool

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
    --add-data "$vendor:exiftool" \
    "$worker/entry.py"
