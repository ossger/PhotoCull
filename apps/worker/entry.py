"""PyInstaller entry point.

PyInstaller must be pointed at this instead of photocull/server.py directly —
server.py uses package-relative imports (`from . import __version__`), which
fail with "attempted relative import with no known parent package" when the
file itself is frozen as the top-level script.
"""
from photocull.server import cli

if __name__ == "__main__":
    cli()
