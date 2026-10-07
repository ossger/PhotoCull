"""SQLite schema and helpers for per-shoot databases."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS shoot (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    root_path       TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    schema_version  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS image (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path        TEXT NOT NULL UNIQUE,
    filename        TEXT NOT NULL,
    bytes           INTEGER,
    mtime           REAL,
    -- EXIF
    captured_at     TEXT,          -- ISO 8601, sub-second when available
    camera_make     TEXT,
    camera_model    TEXT,
    lens            TEXT,
    iso             INTEGER,
    shutter         TEXT,
    aperture        REAL,
    focal_length    REAL,
    width           INTEGER,
    height          INTEGER,
    orientation     INTEGER,
    -- Camera AF / focus-detection (from MakerNotes via exiftool)
    focus_mode          TEXT,      -- One-Shot AF / AI Servo / AF-C / Manual ...
    af_area_mode        TEXT,      -- Single / Zone / Auto / Face+Tracking ...
    af_points_in_focus  TEXT,      -- which AF point(s) reported in-focus
    -- Perceptual hash (Phase 2)
    phash           TEXT,
    -- Scene grouping (Phase 2)
    scene_id        INTEGER,
    -- User decisions
    pick            INTEGER NOT NULL DEFAULT 0,    -- -1 reject, 0 unset, 1 pick
    stars           INTEGER NOT NULL DEFAULT 0,    -- 0..5
    color_label     TEXT,                          -- Lightroom-style: Red/Yellow/Green/Blue/Purple
    -- Scoring (Phase 2+)
    score_focus     REAL,
    score_exposure  REAL,
    score_eyes      REAL,
    n_faces         INTEGER,   -- detected face count (NULL = faces not scored)
    faces_json      TEXT,      -- per-face boxes + eye centres as JSON (NULL = none)
    score_aesthetic REAL,
    score_overall   REAL,
    -- Cached previews (relative to cache dir)
    thumb_path      TEXT,
    preview_path    TEXT,
    -- Full-resolution image path. For RAW sources this is the extracted
    -- embedded JPEG in the cache; for HEIC it's a converted JPEG. NULL means
    -- "use the original file at rel_path under the shoot root" (JPEGs).
    full_path       TEXT,
    -- Non-destructive crop, normalised 0..1 of the image. NULL = no crop.
    -- Exported to Lightroom/C1 via Adobe's crs:Crop* XMP tags on save.
    crop_left       REAL,
    crop_top        REAL,
    crop_right      REAL,
    crop_bottom     REAL
);
CREATE INDEX IF NOT EXISTS idx_image_captured ON image(captured_at);
CREATE INDEX IF NOT EXISTS idx_image_scene    ON image(scene_id);

CREATE TABLE IF NOT EXISTS scene (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT,
    starts_at       TEXT,
    ends_at         TEXT,
    cover_image_id  INTEGER REFERENCES image(id),
    -- 1 = hand-edited (merge/split/rename/move). regroup() leaves these alone.
    manual          INTEGER NOT NULL DEFAULT 0
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    """Open (or create) the per-shoot SQLite database with sane pragmas.

    `check_same_thread=False` lets us share one connection across FastAPI's
    threadpool and our ingest workers. Safe here because every write goes
    through Shoot's lock and WAL mode keeps concurrent readers consistent.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(db_path),
        isolation_level=None,  # autocommit
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.executescript("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply additive schema migrations to an existing DB.

    SQLite's `CREATE TABLE IF NOT EXISTS` doesn't add columns to an
    already-existing table, so we ALTER TABLE for any missing columns
    introduced in later phases.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(image)").fetchall()}
    if "full_path" not in cols:
        conn.execute("ALTER TABLE image ADD COLUMN full_path TEXT")
    for col in ("crop_left", "crop_top", "crop_right", "crop_bottom"):
        if col not in cols:
            conn.execute(f"ALTER TABLE image ADD COLUMN {col} REAL")
    for col in ("focus_mode", "af_area_mode", "af_points_in_focus"):
        if col not in cols:
            conn.execute(f"ALTER TABLE image ADD COLUMN {col} TEXT")
    if "n_faces" not in cols:
        conn.execute("ALTER TABLE image ADD COLUMN n_faces INTEGER")
    if "faces_json" not in cols:
        conn.execute("ALTER TABLE image ADD COLUMN faces_json TEXT")
    if "score_aesthetic" not in cols:
        conn.execute("ALTER TABLE image ADD COLUMN score_aesthetic REAL")
    scene_cols = {r["name"] for r in conn.execute("PRAGMA table_info(scene)").fetchall()}
    if "manual" not in scene_cols:
        conn.execute("ALTER TABLE scene ADD COLUMN manual INTEGER NOT NULL DEFAULT 0")


def initialise_shoot(conn: sqlite3.Connection, root_path: Path) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO shoot (id, root_path) VALUES (1, ?)",
        (str(root_path),),
    )


def upsert_image(conn: sqlite3.Connection, row: dict[str, Any]) -> int:
    """Insert or update an image row keyed on rel_path. Returns the row id."""
    cols = [
        "rel_path", "filename", "bytes", "mtime",
        "captured_at", "camera_make", "camera_model", "lens",
        "iso", "shutter", "aperture", "focal_length",
        "width", "height", "orientation",
        "focus_mode", "af_area_mode", "af_points_in_focus",
        "thumb_path", "preview_path", "full_path",
        "phash", "score_focus", "score_exposure", "score_eyes",
        "n_faces", "faces_json", "score_aesthetic", "score_overall",
    ]
    placeholders = ", ".join(["?"] * len(cols))
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "rel_path")
    values = [row.get(c) for c in cols]
    conn.execute(
        f"""
        INSERT INTO image ({", ".join(cols)})
        VALUES ({placeholders})
        ON CONFLICT(rel_path) DO UPDATE SET {updates}
        """,
        values,
    )
    cur = conn.execute("SELECT id FROM image WHERE rel_path = ?", (row["rel_path"],))
    return int(cur.fetchone()["id"])
