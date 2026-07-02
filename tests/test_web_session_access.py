from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path


def _load_web_main(monkeypatch):
    root = Path(__file__).resolve().parents[1]
    monkeypatch.setenv("MATCREATOR_MODE", "local")
    for path in (root / "web", root / "src"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))

    spec = importlib.util.spec_from_file_location(
        "web_main_session_access_test",
        root / "web" / "main.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _create_session_db(path: Path, app_name: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE sessions (
                app_name TEXT,
                user_id TEXT,
                id TEXT,
                state TEXT,
                create_time TEXT,
                update_time TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE events (
                app_name TEXT,
                user_id TEXT,
                session_id TEXT,
                event_data TEXT,
                timestamp REAL
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
            (app_name, "legacy-display-name", "session-1", '{"answer": 42}', "1", "2"),
        )
        conn.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
            (app_name, "another-legacy-name", "session-1", '{"event": "persisted"}', 1.0),
        )
        conn.commit()


def test_local_mode_lists_sessions_regardless_of_requested_user(monkeypatch, tmp_path):
    web_main = _load_web_main(monkeypatch)
    db_path = tmp_path / "session.db"
    _create_session_db(db_path, web_main.APP_NAME)
    monkeypatch.setattr(web_main, "SESSION_DB_PATH", db_path)
    monkeypatch.setattr(web_main, "_MATCREATOR_MODE", "local")

    sessions = web_main._query_session_summaries("current-user")

    assert [session["id"] for session in sessions] == ["session-1"]
    assert sessions[0]["userId"] == "legacy-display-name"


def test_local_mode_reads_session_detail_regardless_of_requested_user(monkeypatch, tmp_path):
    web_main = _load_web_main(monkeypatch)
    db_path = tmp_path / "session.db"
    _create_session_db(db_path, web_main.APP_NAME)
    monkeypatch.setattr(web_main, "SESSION_DB_PATH", db_path)
    monkeypatch.setattr(web_main, "_MATCREATOR_MODE", "local")

    response = asyncio.run(web_main.get_user_session("current-user", "session-1"))
    payload = json.loads(response.body)

    assert payload["userId"] == "legacy-display-name"
    assert payload["state"] == {"answer": 42}
    assert payload["events"] == [{"event": "persisted"}]