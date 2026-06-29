"""Tests for web-layer-specific port integration scenarios.

These tests focus on port configuration scenarios that are specific to the
web layer (``web/main.py``), such as combined port scenarios and restart
command format invariants.  General port resolution tests (defaults,
env overrides, config.yaml fallback, precedence, legacy alias, invalid
ports, frozen dataclass) live in ``tests/test_ports_config.py``.

Key assertions:
  - The restart command (``get_local_adk_command()``) has a stable format
    regardless of port/host configuration.
  - All web-layer ports can be configured simultaneously without interference.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.matcreator.ports import (
    get_adk_port,
    get_local_adk_command,
    get_web_port,
    get_worker_base_port,
)

from conftest import ALL_CONFIG_ENV_VARS, clear_port_env_vars  # noqa: F401


# ===================================================================
# Combined scenario: all web-layer ports set simultaneously
# ===================================================================
# This test is kept in test_web_ports.py (rather than test_ports_config.py)
# because it verifies a web-layer-specific scenario: setting all ports that
# ``web/main.py`` depends on at once and confirming they resolve correctly
# without cross-interference.


def test_web_layer_ports_combined(monkeypatch) -> None:
    """Set all ports relevant to the web layer simultaneously and verify each."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_ADK_PORT", "8100")
    monkeypatch.setenv("MATCREATOR_WEB_PORT", "8101")
    monkeypatch.setenv("MATCREATOR_WORKER_BASE_PORT", "9500")

    assert get_adk_port() == 8100
    assert get_web_port() == 8101
    assert get_worker_base_port() == 9500

    cmd = get_local_adk_command()
    assert "8100" in cmd


# ===================================================================
# Restart command format invariants
# ===================================================================
# This test is kept in test_web_ports.py (rather than test_ports_config.py)
# because it tests structural invariants of the restart command that the
# web layer depends on (positional argument layout, types, length).  The
# port value itself is incidental; what matters is that the command format
# is stable for the web layer's subprocess invocation.


def test_get_local_adk_command_has_correct_format(
    monkeypatch, tmp_path: Path
) -> None:
    """Verify the command list structure: ['matcreator', 'api-server', '--host', <host>, '--port', <port>].

    Uses monkeypatch to isolate host resolution from the real OS environment,
    ensuring the test passes regardless of any ``MATCREATOR_ADK_HOST`` env var
    set in the developer's shell.
    """
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))
    cmd = get_local_adk_command()
    assert len(cmd) == 6
    assert cmd[0] == "matcreator"
    assert cmd[1] == "api-server"
    assert cmd[2] == "--host"
    assert isinstance(cmd[3], str)
    assert cmd[4] == "--port"
    assert isinstance(cmd[5], str)

    # Verify the port is an integer string
    int(cmd[5])

    # Verify custom host
    cmd2 = get_local_adk_command("0.0.0.0")
    assert cmd2[3] == "0.0.0.0"
