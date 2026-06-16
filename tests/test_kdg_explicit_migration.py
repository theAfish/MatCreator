from __future__ import annotations

from pathlib import Path

from agents.MatCreator import constants
from agents.MatCreator.knowledge import migrate
from agents.MatCreator.knowledge import query


def test_default_kdg_db_path_is_used_when_env_is_missing(monkeypatch) -> None:
    monkeypatch.delenv("KDG_DB_PATH", raising=False)
    monkeypatch.setattr(constants.os, "environ", constants.os.environ.copy())

    expected = constants.DEFAULT_KDG_DB_PATH.resolve()

    constants.os.environ.setdefault("KDG_DB_PATH", str(constants.DEFAULT_KDG_DB_PATH))
    kdg_db_path = Path(constants.os.environ["KDG_DB_PATH"]).expanduser()
    if not kdg_db_path.is_absolute():
        kdg_db_path = (constants._PROJECT_ROOT / kdg_db_path).resolve()
    if kdg_db_path.suffix != ".db":
        kdg_db_path = kdg_db_path / "know_do_graph.db"

    assert kdg_db_path == expected


def test_get_kg_does_not_touch_legacy_sources(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "know_do_graph.db"
    memory_dir = tmp_path / "memory"

    monkeypatch.setattr(query, "_graph", None)
    monkeypatch.setattr(query, "_migration_result", None)

    calls: list[str] = []

    monkeypatch.setattr(constants, "KNOW_DO_GRAPH_DB", db_path)
    monkeypatch.setattr(constants, "KNOW_DO_MEMORY_DIR", memory_dir)

    kg = query._get_kg()

    assert kg.path == db_path.resolve()
    assert calls == []
    assert query.get_migration_result() == {
        "know_do_nodes": 0,
        "memory_entries": 0,
        "edges": 0,
    }


def test_run_legacy_migration_is_explicit(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "know_do_graph.db"
    memory_dir = tmp_path / "memory"
    old_memory_dir = tmp_path / "legacy-memory"

    monkeypatch.setattr(query, "_graph", None)
    monkeypatch.setattr(query, "_migration_result", None)

    calls: list[str] = []

    monkeypatch.setattr(
        migrate,
        "migrate_kdg_database",
        lambda *_args, **_kwargs: calls.append("kdg") or {"nodes": 2, "edges": 3},
    )
    monkeypatch.setattr(
        migrate,
        "migrate_legacy_memory_json",
        lambda *_args, **_kwargs: calls.append("memory") or 5,
    )
    monkeypatch.setattr(
        migrate,
        "migrate_legacy_graphs",
        lambda *_args, **_kwargs: calls.append("legacy") or {"know_do_nodes": 7, "memory_entries": 11, "edges": 13},
    )

    monkeypatch.setattr(constants, "KNOW_DO_GRAPH_DB", db_path)
    monkeypatch.setattr(constants, "KNOW_DO_MEMORY_DIR", memory_dir)
    monkeypatch.setattr(constants, "LEGACY_UNIFIED_GRAPH_DB", tmp_path / "old.db")
    monkeypatch.setattr(constants, "LEGACY_UNIFIED_MEMORY_DIR", old_memory_dir)
    monkeypatch.setattr(constants, "LEGACY_SKILL_GRAPH_DB", tmp_path / "skill_graph.db")
    monkeypatch.setattr(constants, "LEGACY_MEMORY_GRAPH_DB", tmp_path / "memory_graph.db")

    result = migrate.run_legacy_migration()

    assert calls == ["kdg", "memory", "legacy"]
    assert result == {
        "know_do_nodes": 9,
        "memory_entries": 16,
        "edges": 16,
    }
    assert query.get_migration_result() == result
