from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from .config import load_llm_cards_config
from .constants import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL


_TOKEN_RE = re.compile(r"[a-z0-9_+.-]+")


@dataclass(frozen=True)
class LLMCard:
    name: str
    model: str
    description: str = ""
    api_key: str = ""
    base_url: str = ""
    modalities: tuple[str, ...] = field(default_factory=tuple)
    skills: tuple[str, ...] = field(default_factory=tuple)
    tags: tuple[str, ...] = field(default_factory=tuple)
    routing_keywords: tuple[str, ...] = field(default_factory=tuple)
    cost_tier: str = ""
    latency_tier: str = ""
    priority: int = 0

    def public_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "model": self.model,
            "description": self.description,
            "modalities": list(self.modalities),
            "skills": list(self.skills),
            "tags": list(self.tags),
            "routing_keywords": list(self.routing_keywords),
            "cost_tier": self.cost_tier,
            "latency_tier": self.latency_tier,
            "priority": self.priority,
        }

    def supports_image_input(self) -> bool:
        markers = {
            value.lower()
            for value in (*self.modalities, *self.tags, *self.routing_keywords)
        }
        description = self.description.lower()
        return bool(
            {"image", "images", "vision", "visual", "multimodal", "multi-modal"} & markers
            or "vision" in description
            or "multimodal" in description
            or "multi-modal" in description
        )


def _as_str_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, Iterable) and not isinstance(value, dict):
        return tuple(str(item) for item in value if str(item))
    return ()


def _default_card() -> LLMCard:
    return LLMCard(
        name="default",
        model=os.environ.get("LLM_MODEL", LLM_MODEL),
        api_key=os.environ.get("LLM_API_KEY", LLM_API_KEY),
        base_url=os.environ.get("LLM_BASE_URL", LLM_BASE_URL),
        description="Default MatCreator executor model from LLM_MODEL/LLM_API_KEY/LLM_BASE_URL.",
    )


def _card_from_config(name: str, data: dict[str, Any]) -> LLMCard:
    fallback = _default_card()
    return LLMCard(
        name=name,
        model=str(data.get("model") or fallback.model),
        api_key=str(data.get("api_key") or fallback.api_key),
        base_url=str(data.get("base_url") or fallback.base_url),
        description=str(data.get("description") or ""),
        modalities=_as_str_tuple(data.get("modalities")),
        skills=_as_str_tuple(data.get("skills")),
        tags=_as_str_tuple(data.get("tags")),
        routing_keywords=_as_str_tuple(data.get("routing_keywords") or data.get("keywords")),
        cost_tier=str(data.get("cost_tier") or ""),
        latency_tier=str(data.get("latency_tier") or ""),
        priority=int(data.get("priority") or 0),
    )


def load_llm_cards() -> tuple[list[LLMCard], str]:
    """Load executor LLM cards and the configured default card name."""
    cfg = load_llm_cards_config()
    cards_cfg = cfg.get("cards") if isinstance(cfg, dict) else None
    default_name = str(cfg.get("default") or "default") if isinstance(cfg, dict) else "default"
    cards: list[LLMCard] = []

    if isinstance(cards_cfg, dict):
        for name, data in cards_cfg.items():
            if isinstance(data, dict):
                cards.append(_card_from_config(str(name), data))
    elif isinstance(cards_cfg, list):
        for item in cards_cfg:
            if isinstance(item, dict) and item.get("name"):
                cards.append(_card_from_config(str(item["name"]), item))

    if not cards:
        return [_default_card()], "default"
    if all(card.name != default_name for card in cards):
        cards.append(_default_card())
        default_name = "default"
    return cards, default_name


def _tokens(*values: Any) -> set[str]:
    text = " ".join(str(value or "").lower() for value in values)
    return set(_TOKEN_RE.findall(text))


def _score_card(card: LLMCard, action_tokens: set[str], skill_tokens: set[str]) -> int:
    card_tokens = _tokens(
        card.name,
        card.description,
        " ".join(card.modalities),
        " ".join(card.skills),
        " ".join(card.tags),
        " ".join(card.routing_keywords),
    )
    score = card.priority
    score += 6 * len(skill_tokens & card_tokens)
    score += 3 * len(action_tokens & set(token.lower() for token in card.routing_keywords))
    score += 2 * len(action_tokens & card_tokens)
    return score


def select_executor_llm_card(
    *,
    action: str,
    suggested_skills: list[str],
    prior_context: str | None = None,
) -> LLMCard:
    """Select the best executor LLM card for one step.

    Selection is deterministic and intentionally cheap: match the task action,
    suggested skills, and prior-context tokens against each card's description,
    skills, tags, and routing keywords. Set MATCREATOR_EXECUTOR_LLM_CARD to force
    a specific card by name. Cards are read from llm.executor_cards in
    ~/.matcreator/config.yaml.
    """
    cards, default_name = load_llm_cards()
    forced_name = os.environ.get("MATCREATOR_EXECUTOR_LLM_CARD")
    if forced_name:
        forced = next((card for card in cards if card.name == forced_name), None)
        if forced is not None:
            return forced

    default_card = next((card for card in cards if card.name == default_name), cards[0])
    action_tokens = _tokens(action, prior_context)
    skill_tokens = _tokens(" ".join(suggested_skills))
    scored = [(_score_card(card, action_tokens, skill_tokens), card) for card in cards]
    scored.sort(key=lambda item: (item[0], item[1].priority, item[1].name), reverse=True)
    best_score, best_card = scored[0]
    return best_card if best_score > 0 else default_card