#!/usr/bin/env python3
"""MatCreator CLI.

Usage:
    matcreator [OPTIONS] COMMAND [ARGS]

Commands:
    web         Launch the ADK web UI.
    api-server  Launch the ADK API server (used by the Streamlit app).
    run         Run the agent non-interactively on a single prompt.

Examples:
    matcreator web
    matcreator web --reload-agents --port 8080
    matcreator api-server
    matcreator run -p "Build a silicon FCC structure"
    matcreator run -f prompt.txt --output-format json -o result.json
    MATCLAW_WORKSPACE=/data/ws matcreator run -p "hello"
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
import yaml

import click


_CONFIG_PATH = Path("~/.matcreator/config.yaml").expanduser()


def _resolve_project_root() -> tuple[Path, bool]:
    """Resolve the MatCreator project root.
    Resolution order (first match wins):
      1. ``MATCREATOR`` environment variable
      2. ``project_root`` in ``~/.matcreator/config.yaml``
      3. Fallback: derive from ``__file__`` (works for editable / source installs)
    Returns (path, explicitly_configured).
    """
    # 1. Environment variable
    env_val = os.environ.get("MATCREATOR")
    if env_val:
        return Path(env_val).expanduser().resolve(), True

    # 2. Config file
    if _CONFIG_PATH.is_file():
        with open(_CONFIG_PATH) as fh:
            raw_cfg = yaml.safe_load(fh)
        cfg = raw_cfg if isinstance(raw_cfg, dict) else {}
        cfg_val = cfg.get("project_root")
        if cfg_val:
            return Path(cfg_val).expanduser().resolve(), True

    # 3. Fallback: __file__-based (src/matcreator/scripts/start_agent.py → repo root)
    return Path(__file__).resolve().parent.parent.parent.parent, False

PROJECT_ROOT, _project_root_explicit = _resolve_project_root()
AGENTS_DIR = PROJECT_ROOT / "agents"

# Shared options applied to both subcommands
_shared_options = [
    click.option("--host", default="127.0.0.1", show_default=True,
                 help="Binding host for the ADK server."),
    click.option("--port", default=8000, show_default=True, type=int,
                 help="Port for the ADK server."),
    click.option("--workspace", default=None, metavar="DIR",
                 help="Override the workspace root directory (also settable via MATCLAW_WORKSPACE)."),
    click.option("--log-level",
                 type=click.Choice(["debug", "info", "warning", "error", "critical"],
                                   case_sensitive=False),
                 default="info", show_default=True,
                 help="Logging level for the ADK server."),
    click.option("-v", "--verbose", is_flag=True, default=False,
                 help="Shortcut for --log-level debug."),
]


def add_shared_options(fn):
    for opt in reversed(_shared_options):
        fn = opt(fn)
    return fn


def _resolve_workspace() -> Path:
    """Resolve the workspace root using the same logic as workspace.py."""
    env_val = os.environ.get("MATCLAW_WORKSPACE", "")
    if env_val:
        return Path(env_val).expanduser().resolve()
    return AGENTS_DIR / "MatCreator" / ".workspace"


def _setup_workspace(workspace: str | None) -> Path:
    """Resolve, create, and chdir into the workspace root."""
    if workspace:
        ws_root = Path(workspace).expanduser().resolve()
        os.environ["MATCLAW_WORKSPACE"] = str(ws_root)
    else:
        ws_root = _resolve_workspace()

    ws_root.mkdir(parents=True, exist_ok=True)
    click.echo(f"Workspace : {ws_root}")
    click.echo(f"Agents dir: {AGENTS_DIR}")
    os.chdir(ws_root)
    click.echo(f"Working directory changed to: {ws_root}\n")
    return ws_root


def _run(cmd: list[str]) -> None:
    click.echo("Starting: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except KeyboardInterrupt:
        pass
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)


def _run_with_env(cmd: list[str], env: dict[str, str]) -> None:
    click.echo("Starting: " + " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, env=env)
    except KeyboardInterrupt:
        pass
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)


def _ensure_project_imports() -> None:
    """Add project root and agents dir to sys.path for imports."""
    for p in (str(PROJECT_ROOT), str(PROJECT_ROOT / "agents")):
        if p not in sys.path:
            sys.path.insert(0, p)


def _resolve_kdg_cli() -> str:
    """Resolve the know-do-graph executable from the current environment."""
    local_bin = Path(sys.executable).resolve().with_name("know-do-graph")
    if local_bin.is_file():
        return str(local_bin)

    found = shutil.which("know-do-graph")
    if found:
        return found

    raise click.ClickException(
        "Could not find the `know-do-graph` executable in the current environment."
    )


def _matcreator_kdg_env() -> dict[str, str]:
    """Return an environment that pins KDG CLI calls to MatCreator's database."""
    _ensure_project_imports()
    from agents.MatCreator.constants import KNOW_DO_GRAPH_DB

    env = os.environ.copy()
    env["KDG_DB_PATH"] = str(KNOW_DO_GRAPH_DB)
    return env


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
def main():
    """MatCreator CLI — manage and run the MatCreator agent."""


@main.command("web")
@add_shared_options
@click.option("--reload-agents", is_flag=True, default=False,
              help="Enable live reload when agent files change.")
@click.option("--reload", is_flag=True, default=False,
              help="Enable auto-reload for the FastAPI server.")
def web(host, port, workspace, log_level, verbose, reload_agents, reload):
    """Launch the ADK web UI (browser-based chat interface)."""
    _setup_workspace(workspace)

    cmd = [
        "adk", "web",
        str(AGENTS_DIR),
        "--host", host,
        "--port", str(port),
        "--log_level", "debug" if verbose else log_level,
    ]
    if reload_agents:
        cmd.append("--reload_agents")
    if reload:
        cmd.append("--reload")

    _run(cmd)


@main.command("api-server")
@add_shared_options
@click.option("--reload-agents", is_flag=True, default=False,
              help="Enable live reload when agent files change.")
@click.option("--reload", is_flag=True, default=False,
              help="Enable auto-reload for the FastAPI server.")
def api_server(host, port, workspace, log_level, reload_agents,
               verbose, reload):
    """Launch the ADK API server (used by the Streamlit app)."""
    _setup_workspace(workspace)

    cmd = [
        "adk", "api_server",
        str(AGENTS_DIR),
        "--host", host,
        "--port", str(port),
        "--log_level", "debug" if verbose else log_level,
    ]
    if reload:
        cmd.append("--reload")
        
    if reload_agents:
        cmd.append("--reload_agents")

    _run(cmd)


@main.group("graph", context_settings={"ignore_unknown_options": True})
def graph_group():
    """Run Know-Do Graph inspection commands against MatCreator's active database."""


@graph_group.command(
    "serve",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
)
@click.pass_context
def graph_serve(ctx: click.Context) -> None:
    """Launch the Know-Do Graph HTTP UI/server using MatCreator's active database."""
    env = _matcreator_kdg_env()
    cmd = [_resolve_kdg_cli(), "serve", *ctx.args]
    _run_with_env(cmd, env)


@graph_group.command(
    "stats",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
)
@click.pass_context
def graph_stats(ctx: click.Context) -> None:
    """Show graph statistics using MatCreator's configured Know-Do Graph database."""
    env = _matcreator_kdg_env()
    cmd = [_resolve_kdg_cli(), "graph", "stats", *ctx.args]
    _run_with_env(cmd, env)


@graph_group.command(
    "neighbors",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
)
@click.argument("entry_id")
@click.pass_context
def graph_neighbors(ctx: click.Context, entry_id: str) -> None:
    """Show graph neighbors for an entry using MatCreator's active database."""
    env = _matcreator_kdg_env()
    cmd = [_resolve_kdg_cli(), "graph", "neighbors", entry_id, *ctx.args]
    _run_with_env(cmd, env)


@graph_group.command(
    "export",
    context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
)
@click.pass_context
def graph_export(ctx: click.Context) -> None:
    """Export graph entries using MatCreator's configured Know-Do Graph database."""
    env = _matcreator_kdg_env()
    cmd = [_resolve_kdg_cli(), "graph", "export", *ctx.args]
    _run_with_env(cmd, env)


# ---------------------------------------------------------------------------
# Non-interactive runner core (used by `run` subcommand and benchmarks)
# ---------------------------------------------------------------------------

async def run_agent_async(
    workspace_dir: str,
    prompt: str,
    max_turns: int = 50,
    session_id: str | None = None,
    flash: bool = False,
) -> dict:
    """Run the agent non-interactively on a single prompt.

    Returns a dict with keys: answer, model_name, num_turns, is_error,
    duration_ms, num_events.
    """
    os.environ["MATCLAW_WORKSPACE"] = str(Path(workspace_dir).resolve())

    # agents/ lives at PROJECT_ROOT, which may not be on sys.path when matcreator
    # is invoked with a cwd other than the repo root (e.g. from run_question_answer.py).
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))

    from google.adk.runners import Runner
    from google.adk.sessions.sqlite_session_service import SqliteSessionService
    from google.genai import types

    from agents.MatCreator.agent import app

    # Use a persistent SQLite session service so sessions written by `matcreator run`
    # appear in the web frontend (which reads agents/MatCreator/.adk/session.db).
    _adk_db = AGENTS_DIR / "MatCreator" / ".adk" / "session.db"
    _adk_db.parent.mkdir(parents=True, exist_ok=True)
    session_service = SqliteSessionService(db_path=str(_adk_db))
    runner = Runner(app=app, session_service=session_service)

    session = await runner.session_service.create_session(
        app_name=app.name,
        user_id="user",
        state={"agent_mode": "flash" if flash else "bench"},
        session_id=session_id,
    )

    user_message = types.Content(
        role="user",
        parts=[types.Part(text=prompt)],
    )

    start_ms = time.monotonic_ns() // 1_000_000
    events = []
    turn_count = 0
    is_error = False
    error_msg = ""

    try:
        async for event in runner.run_async(
            user_id="user",
            session_id=session.id,
            new_message=user_message,
        ):
            events.append(event)
            if hasattr(event, "is_final_response") and event.is_final_response():
                turn_count += 1
            if turn_count >= max_turns:
                break
    except Exception as exc:
        is_error = True
        error_msg = str(exc)

    duration_ms = (time.monotonic_ns() // 1_000_000) - start_ms

    # Extract final answer from the last event with text content
    answer = ""
    for event in reversed(events):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if hasattr(part, "text") and part.text:
                    answer = part.text
                    break
            if answer:
                break

    if is_error and not answer:
        answer = error_msg

    return {
        "answer": answer,
        "model_name": os.environ.get("LLM_MODEL", "matcreator"),
        "num_turns": turn_count,
        "is_error": is_error,
        "duration_ms": duration_ms,
        "num_events": len(events),
    }


# ---------------------------------------------------------------------------
# `matcreator run` subcommand
# ---------------------------------------------------------------------------

@main.command("run")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory (also settable via MATCLAW_WORKSPACE).")
@click.option("-p", "--prompt", "prompt_text", default=None,
              help="Inline prompt text to send to the agent.")
@click.option("-f", "--prompt-file", default=None, type=click.Path(exists=True),
              help="Read prompt from a file (mutually exclusive with -p).")
@click.option("--output-format", "output_format",
              type=click.Choice(["text", "json"], case_sensitive=False),
              default="text", show_default=True,
              help="Output format: 'text' prints the answer, 'json' prints full structured result.")
@click.option("-o", "--output", "output_file", default=None, type=click.Path(),
              help="Write output to a file instead of stdout.")
@click.option("--max-turns", default=50, show_default=True, type=int,
              help="Maximum agent turns before stopping.")
@click.option("--session-id", default=None, metavar="ID",
              help="Custom session ID (default: auto-generated by ADK).")
@click.option("--flash", is_flag=True, default=False,
              help="Run in Flash mode: thinking agent executes directly, no DAG or approval required.")
def run_cmd(workspace, prompt_text, prompt_file, output_format, output_file, max_turns, session_id, flash):
    """Run the agent non-interactively on a single prompt."""
    if prompt_text and prompt_file:
        raise click.UsageError("Use either -p/--prompt or -f/--prompt-file, not both.")
    if not prompt_text and not prompt_file:
        raise click.UsageError("Provide a prompt via -p/--prompt or -f/--prompt-file.")

    if prompt_file:
        prompt_text = Path(prompt_file).read_text().strip()

    ws_root = Path(workspace).expanduser().resolve() if workspace else _resolve_workspace()
    ws_root.mkdir(parents=True, exist_ok=True)

    result = asyncio.run(run_agent_async(str(ws_root), prompt_text, max_turns, session_id, flash))

    if output_format == "json":
        content = json.dumps(result, ensure_ascii=False, indent=2)
    else:
        content = result["answer"]

    if output_file:
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        Path(output_file).write_text(content)
    else:
        click.echo(content)


# ---------------------------------------------------------------------------
# `matcreator knowledge` subcommand group
# ---------------------------------------------------------------------------

@main.group("knowledge")
def knowledge_group():
    """Inspect and manage the knowledge graph."""


@knowledge_group.command("query")
@click.argument("text")
@click.option("--top-k", default=15, show_default=True, type=int,
              help="Maximum number of nodes to return.")
@click.option("--depth", default=2, show_default=True, type=int,
              help="BFS expansion depth from seed nodes.")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_query(text, top_k, depth, workspace):
    """Query the memory knowledge graph for nodes matching TEXT."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.knowledge.query import query_knowledge_graph
    result = query_knowledge_graph(text, depth=depth, top_k=top_k)
    click.echo(result)


@knowledge_group.command("search-skills")
@click.argument("text")
@click.option("--top-k", default=5, show_default=True, type=int,
              help="Maximum number of skills to return.")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_search_skills(text, top_k, workspace):
    """Search for skill nodes semantically matching TEXT."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.knowledge.query import search_skills
    result = search_skills(text, top_k=top_k)
    click.echo(result)


@knowledge_group.command("related-skills")
@click.argument("start_node")
@click.option("--top-k", default=5, show_default=True, type=int,
              help="Maximum number of related skills to return.")
@click.option("--depth", default=2, show_default=True, type=int,
              help="BFS depth limit.")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_related_skills(start_node, top_k, depth, workspace):
    """Traverse the dependency graph from a known skill START_NODE."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.knowledge.query import get_related_skills
    result = get_related_skills(start_node, top_k=top_k, depth=depth)
    click.echo(result)


@knowledge_group.command("stats")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_stats(workspace):
    """Print durable Know-Do and writable MemGraph counts."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.knowledge.kdg_memory import iter_memory
    from agents.MatCreator.knowledge.query import _get_kg
    graph = _get_kg()
    stats = graph.stats()
    memories = list(iter_memory(graph))
    click.echo("Know-Do graph (all native nodes):")
    click.echo(f"  Nodes: {stats['nodes']}  Edges: {stats['edges']}")
    click.echo("MemGraph nodes:")
    click.echo(
        f"  Entries: {len(memories)}  "
        f"Unpromoted: {sum(not entry.promoted for entry in memories)}"
    )


@knowledge_group.command("seed")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_seed(workspace):
    """Seed Know-Do Graph with all SKILL.md and guide entries."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.skill import seed_skills_to_graph
    result = seed_skills_to_graph()
    click.echo(
        f"Created {result['seeded']} entries and "
        f"{result['edges_created']} dependency edges."
    )


@knowledge_group.command("migrate")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
@click.option("--memory-md", default=None, metavar="FILE",
              help="Also import a legacy MEMORY.md file.")
def knowledge_migrate(workspace, memory_md):
    """Migrate legacy skill, memory, and optional MEMORY.md data."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.constants import KNOW_DO_GRAPH_DB
    from agents.MatCreator.knowledge.kdg_memory import iter_memory
    from agents.MatCreator.knowledge.migrate import (
        migrate_memory_md,
        run_legacy_migration,
    )
    from agents.MatCreator.knowledge.query import (
        _get_kg,
        get_migration_result,
    )

    result = run_legacy_migration()
    click.echo(
        "Newly migrated from legacy sources: "
        f"{result.get('know_do_nodes', 0)} durable entries, "
        f"{result.get('memory_entries', 0)} memories, "
        f"{result.get('edges', 0)} edges."
    )
    if memory_md:
        md_result = migrate_memory_md(memory_md)
        click.echo(md_result["message"])

    graph = _get_kg()
    stats = graph.stats()
    memory_count = sum(1 for _ in iter_memory(graph))
    click.echo(f"Database: {KNOW_DO_GRAPH_DB}")
    click.echo(
        f"Current graph: {stats['nodes']} entries "
        f"({memory_count} memories), {stats['edges']} edges."
    )


@knowledge_group.command("distill")
@click.option("--min-evidence", default=3, show_default=True, type=int,
              help="Minimum similar memories required for promotion.")
@click.option("--stale-days", default=30, show_default=True, type=int,
              help="Age threshold for pruning unsuccessful memory.")
@click.option("--workspace", default=None, metavar="DIR",
              help="Override the workspace root directory.")
def knowledge_distill(min_evidence, stale_days, workspace):
    """Promote repeated successful memory into durable Know-Do entries."""
    _setup_workspace(workspace)
    _ensure_project_imports()
    from agents.MatCreator.knowledge.synthesizer import run_knowledge_synthesizer

    result = run_knowledge_synthesizer(
        stale_days=stale_days,
        min_insights_for_workflow=min_evidence,
    )
    click.echo(result["message"])


if __name__ == "__main__":
    main()
