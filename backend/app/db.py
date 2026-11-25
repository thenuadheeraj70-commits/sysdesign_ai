"""SQLite storage (standard library only). One short-lived connection per call."""

import os
import sqlite3
import threading
from contextlib import contextmanager

from app import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    architecture TEXT NOT NULL,
    requirements TEXT,
    positions TEXT,
    variants TEXT,
    active_variant TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS project_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON project_versions(project_id, id DESC);
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);
CREATE TABLE IF NOT EXISTS ai_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    rating INTEGER,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_generations_user ON ai_generations(user_id, created_at DESC);
"""

# Columns added after the first release: databases created earlier get them on startup.
_ADDED_COLUMNS = {
    "positions": "TEXT",
    "deleted_at": "TEXT",
    "variants": "TEXT",
    "active_variant": "TEXT",
    "share_token": "TEXT",
}


def _migrate(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(projects)")}
    for column, kind in _ADDED_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {column} {kind}")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_share ON projects(share_token) WHERE share_token IS NOT NULL"
    )


_ready: set[str] = set()
_lock = threading.Lock()


def _init(path: str) -> None:
    with _lock:
        if path in _ready:
            return
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        conn = sqlite3.connect(path)
        try:
            conn.executescript(_SCHEMA)
            _migrate(conn)
            conn.commit()
        finally:
            conn.close()
        _ready.add(path)


@contextmanager
def get_conn():
    path = os.getenv("DB_PATH") or config.DB_PATH
    _init(path)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
