"""Static tests reading vite.config.js as text. No Node/Vite required.

These tests verify that the Vite configuration uses environment variable
substitution for port configuration rather than hardcoded values.
"""

from __future__ import annotations

import os

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_vite_config() -> str:
    """Read the Vite config file from the repo root, relative to this test file."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "web", "vite-frontend", "vite.config.js"
    )
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# ===================================================================
# Tests
# ===================================================================


def test_vite_config_no_hardcoded_8001() -> None:
    """vite.config.js must not contain the hardcoded string 'http://localhost:8001'.

    This URL should be constructed via the webTarget variable instead.
    """
    content = _read_vite_config()
    assert '"http://localhost:8001"' not in content, (
        "vite.config.js should not contain hardcoded 'http://localhost:8001'; "
        "use webTarget variable with MATCREATOR_WEB_PORT or MATCREATOR_WEB_TARGET"
    )


def test_vite_config_uses_env_var() -> None:
    """vite.config.js must reference MATCREATOR_WEB_PORT or MATCREATOR_WEB_TARGET."""
    content = _read_vite_config()
    has_web_port = "MATCREATOR_WEB_PORT" in content
    has_web_target = "MATCREATOR_WEB_TARGET" in content
    assert has_web_port or has_web_target, (
        "vite.config.js should reference MATCREATOR_WEB_PORT or MATCREATOR_WEB_TARGET"
    )


def test_vite_config_has_strict_port() -> None:
    """vite.config.js must set strictPort: true for the dev server."""
    content = _read_vite_config()
    assert "strictPort: true" in content, (
        "vite.config.js should contain 'strictPort: true'"
    )
