"""Tests for start_matcreator.sh port and host resolution.

The bash script delegates port and host resolution to :mod:`src.matcreator.ports`
functions.  These tests verify the end-to-end behaviour:

1. ``config.yaml`` values are used when environment variables are not set
2. Environment variables take precedence over ``config.yaml`` values
3. Host resolution follows the same precedence (env > config.yaml > defaults)
4. The bash script itself passes a syntax check (``bash -n``)
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional

import pytest
import yaml

from conftest import clear_port_env_vars
from src.matcreator.ports import (
    get_adk_host,
    get_adk_port,
    get_frontend_host,
    get_frontend_port,
    get_web_host,
    get_web_port,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_config_yaml(config_dir: Path, ports: dict) -> Path:
    """Write a ``config.yaml`` file under *config_dir* and return its path."""
    config_path = config_dir / "config.yaml"
    config_path.write_text(
        yaml.dump({"ports": ports}, default_flow_style=False),
        encoding="utf-8",
    )
    return config_path


def _find_bash() -> Optional[str]:
    """Locate a bash executable on the system that can handle Windows paths.

    On Windows, ``C:\\Windows\\System32\\bash.exe`` is the WSL stub which
    requires WSL-style paths (e.g. ``/mnt/c/...``).  We prefer Git Bash
    (which handles Windows paths natively) over the WSL stub.

    Returns ``None`` when no suitable bash is available.
    """
    candidates = [
        # Git Bash (handles Windows paths natively)
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        # WSL bash (only works with WSL path translation)
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate

    # Fall back to whatever is on PATH (may be WSL stub)
    return shutil.which("bash") or shutil.which("bash.exe")


def _is_wsl_bash(bash_path: str) -> bool:
    """Return ``True`` if *bash_path* is the WSL bash stub."""
    return (
        "Windows\\System32\\bash.exe" in bash_path.replace("/", "\\")
        or "Windows\\System32\\bash" in bash_path.replace("/", "\\")
    )


def _to_wsl_path(windows_path: Path) -> str:
    """Convert a Windows path to a WSL-compatible path (e.g. ``/mnt/c/...``)."""
    p = str(windows_path.resolve()).replace("\\", "/")
    if p[1:2] == ":":
        drive = p[0:1].lower()
        rest = p[2:]
        return f"/mnt/{drive}{rest}"
    return p


# ---------------------------------------------------------------------------
# Test 1: config.yaml values used when env vars are NOT set
# ---------------------------------------------------------------------------


def test_config_yaml_ports_when_env_vars_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Config.yaml ports are used when no environment variables override them.

    This mirrors what happens when a user runs ``start_matcreator.sh`` after
    having previously set custom ports via ``matcreator config set``, without
    exporting any ``MATCREATOR_*_PORT`` environment variable.
    """
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(
        tmp_path,
        {
            "adk": 8100,
            "web": 8101,
            "frontend": 5174,
        },
    )

    assert get_adk_port() == 8100, "ADK port should come from config.yaml"
    assert get_web_port() == 8101, "Web port should come from config.yaml"
    assert get_frontend_port() == 5174, "Frontend port should come from config.yaml"


def test_config_yaml_partial_ports_fallback_to_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only ports defined in config.yaml are overridden; the rest use defaults."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(tmp_path, {"adk": 8100})  # only ADK is configured

    assert get_adk_port() == 8100       # from config
    assert get_web_port() == 8001       # default
    assert get_frontend_port() == 5173  # default


# ---------------------------------------------------------------------------
# Test 2: Env vars override config.yaml
# ---------------------------------------------------------------------------


def test_env_var_overrides_config_yaml(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Environment variables take precedence over config.yaml values.

    This is the documented precedence:
        environment variable > config.yaml > built-in default
    """
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(tmp_path, {"adk": 8100})
    monkeypatch.setenv("MATCREATOR_ADK_PORT", "9000")

    assert get_adk_port() == 9000, (
        "MATCREATOR_ADK_PORT env var should override config.yaml adk=8100"
    )


def test_env_var_overrides_all_three_ports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Env vars override config.yaml for all three core ports simultaneously."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(
        tmp_path,
        {"adk": 8100, "web": 8200, "frontend": 8300},
    )
    monkeypatch.setenv("MATCREATOR_ADK_PORT", "9100")
    monkeypatch.setenv("MATCREATOR_WEB_PORT", "9200")
    monkeypatch.setenv("MATCREATOR_FRONTEND_PORT", "9300")

    assert get_adk_port() == 9100
    assert get_web_port() == 9200
    assert get_frontend_port() == 9300


def test_no_config_yaml_uses_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When neither env vars nor config.yaml exist, built-in defaults are used."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))
    # Do NOT write config.yaml — directory is empty

    assert get_adk_port() == 8000, "Default ADK port"
    assert get_web_port() == 8001, "Default web port"
    assert get_frontend_port() == 5173, "Default frontend port"


# ---------------------------------------------------------------------------
# Test 3: Host resolution (env > config.yaml > defaults)
# ---------------------------------------------------------------------------


def test_config_yaml_hosts_when_env_vars_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Config.yaml hosts are used when no environment variables override them."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(
        tmp_path,
        {
            "adk_host": "0.0.0.0",
            "web_host": "10.0.0.1",
            "frontend_host": "192.168.1.1",
        },
    )

    assert get_adk_host() == "0.0.0.0", "ADK host should come from config.yaml"
    assert get_web_host() == "10.0.0.1", "Web host should come from config.yaml"
    assert get_frontend_host() == "192.168.1.1", "Frontend host should come from config.yaml"


def test_env_var_overrides_config_yaml_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Environment variable wins over config.yaml for a host."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))

    _write_config_yaml(tmp_path, {"adk_host": "10.0.0.1"})
    monkeypatch.setenv("MATCREATOR_ADK_HOST", "0.0.0.0")

    assert get_adk_host() == "0.0.0.0", (
        "MATCREATOR_ADK_HOST env var should override config.yaml adk_host=10.0.0.1"
    )


def test_no_config_yaml_uses_default_hosts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When neither env vars nor config.yaml exist for hosts, built-in defaults (127.0.0.1) apply."""
    clear_port_env_vars(monkeypatch)
    monkeypatch.setenv("MATCREATOR_HOME", str(tmp_path))
    # Do NOT write config.yaml — directory is empty

    assert get_adk_host() == "127.0.0.1", "Default ADK host"
    assert get_web_host() == "127.0.0.1", "Default web host"
    assert get_frontend_host() == "127.0.0.1", "Default frontend host"


# ---------------------------------------------------------------------------
# Test 4: bash syntax validation
# ---------------------------------------------------------------------------


def test_start_matcreator_syntax() -> None:
    """The start_matcreator.sh script passes ``bash -n`` syntax check.

    This catches issues like unclosed quotes, missing ``fi``/``done`` tokens,
    or invalid parameter expansions that would cause runtime errors even before
    any command is executed.
    """
    bash = _find_bash()
    if bash is None:
        pytest.skip("bash not found on this system")

    script_path = (
        Path(__file__).resolve().parents[1] / "script" / "start_matcreator.sh"
    )

    if _is_wsl_bash(bash):
        # WSL bash requires Linux-style paths — translate via wslpath
        wsl = shutil.which("wsl") or shutil.which("wsl.exe")
        if wsl is None:
            pytest.skip("WSL bash found but wsl.exe not available for path translation")
        result = subprocess.run(
            [wsl, "bash", "-n", _to_wsl_path(script_path)],
            capture_output=True,
            text=True,
        )
    else:
        # Git Bash or native bash — Windows paths work directly
        result = subprocess.run(
            [bash, "-n", str(script_path)],
            capture_output=True,
            text=True,
        )

    assert result.returncode == 0, (
        f"bash -n failed for {script_path}:\n"
        f"stderr: {result.stderr}\n"
        f"stdout: {result.stdout}"
    )
