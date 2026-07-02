"""User-level persistent configuration for MatCreator.

Config is stored at ~/.matcreator/config.yaml and controls runtime behaviour.

Supported sections:

  llm:
    model: openai/qwen3-plus
    api_key: sk-...
    base_url: https://...
    embedding_model: text-embedding-v4
    graph_agent_model: ...   # optional override
    review_agent_model: ...  # optional override
        executor_cards:
            default: balanced
            cards:
                balanced:
                    model: openai/qwen3-plus
                    description: General executor model for routine tool use.
                    skills: [filesystem, python]
                    cost_tier: medium
                    latency_tier: medium

  bohrium:
    email: user@example.com
    password: ...
    project_id: 12345

  compute:
    vasp_image: registry.dp.tech/...
    vasp_machine: c16_m32_cpu
    deepmd_image: registry.dp.tech/...
    deepmd_machine: c8_m32_gpu
    deepmd_model_path: /path/to/model.pt

  planning:
    extra_skills: [...]

  skills:
    disabled: [...]
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

_MATCREATOR_HOME = Path(os.environ.get("MATCREATOR_HOME", str(Path.home() / ".matcreator"))).expanduser()
_CONFIG_PATH = _MATCREATOR_HOME / "config.yaml"

# Mapping from config.yaml dotted keys to environment variable names.
# Used by constants.py (loading) and CLI (set/get) and web API (env-config).
YAML_TO_ENV: dict[str, str] = {
    "llm.model":              "LLM_MODEL",
    "llm.api_key":            "LLM_API_KEY",
    "llm.base_url":           "LLM_BASE_URL",
    "llm.embedding_model":    "EMBEDDING_MODEL",
    "llm.graph_agent_model":  "GRAPH_AGENT_MODEL",
    "llm.review_agent_model": "REVIEW_AGENT_MODEL",
    "bohrium.email":          "BOHRIUM_USERNAME",
    "bohrium.password":       "BOHRIUM_PASSWORD",
    "bohrium.project_id":     "BOHRIUM_PROJECT_ID",
    "compute.vasp_image":     "BOHRIUM_VASP_IMAGE",
    "compute.vasp_machine":   "BOHRIUM_VASP_MACHINE",
    "compute.deepmd_image":   "BOHRIUM_DEEPMD_IMAGE",
    "compute.deepmd_machine": "BOHRIUM_DEEPMD_MACHINE",
    "compute.deepmd_model_path": "DEEPMD_MODEL_PATH",
}

ENV_TO_YAML: dict[str, str] = {v: k for k, v in YAML_TO_ENV.items()}

# Fields whose values should be masked when displayed.
SENSITIVE_YAML_KEYS = frozenset({"llm.api_key", "bohrium.password"})


def load_config() -> dict[str, Any]:
    """Return the full config dict, or an empty dict if no file exists."""
    if not _CONFIG_PATH.exists():
        return {}
    try:
        return yaml.safe_load(_CONFIG_PATH.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError):
        return {}


def load_llm_cards_config() -> dict[str, Any]:
    """Return executor LLM-card config from ~/.matcreator/config.yaml."""
    cfg = load_config()
    llm_cfg = cfg.get("llm")
    if isinstance(llm_cfg, dict) and isinstance(llm_cfg.get("executor_cards"), dict):
        return llm_cfg["executor_cards"]
    if isinstance(cfg.get("llm_cards"), dict):
        return cfg["llm_cards"]
    return {}


def save_config(config: dict[str, Any]) -> None:
    """Persist *config* to disk, creating the directory if necessary."""
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(
        yaml.dump(config, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
    )


def get_config_value(dotted_key: str) -> str:
    """Return the string value at *dotted_key* (e.g. 'llm.api_key'), or ''."""
    parts = dotted_key.split(".")
    cfg = load_config()
    d = cfg
    for part in parts[:-1]:
        d = d.get(part, {})
        if not isinstance(d, dict):
            return ""
    return str(d.get(parts[-1], ""))


def set_config_value(dotted_key: str, value: str) -> None:
    """Write *value* to *dotted_key* in config.yaml."""
    parts = dotted_key.split(".")
    cfg = load_config()
    d = cfg
    for part in parts[:-1]:
        d = d.setdefault(part, {})
    d[parts[-1]] = value
    save_config(cfg)


def get_llm_config() -> dict[str, str]:
    return load_config().get("llm", {})


def get_bohrium_config() -> dict[str, Any]:
    return load_config().get("bohrium", {})


def get_compute_config() -> dict[str, str]:
    return load_config().get("compute", {})


def get_planning_skills() -> list[str]:
    """Return the list of extra skill names promoted to planning access."""
    return load_config().get("planning", {}).get("extra_skills", [])


def get_disabled_skills() -> list[str]:
    """Return the list of skill names disabled for knowledge graph search."""
    return load_config().get("skills", {}).get("disabled", [])
