from matcreator import config as config_module
from matcreator.llm_cards import load_llm_cards, select_executor_llm_card


def test_load_llm_cards_from_user_config(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
llm:
  model: openai/default-model
  executor_cards:
    default: cheap
    cards:
      cheap:
        model: openai/cheap-model
        description: Cheap filesystem and shell executor.
        skills: [filesystem]
        cost_tier: low
      reasoning:
        model: openai/reasoning-model
        description: Strong debugging and scientific reasoning executor.
        modalities: [text, image]
        routing_keywords: [debug, analyze]
        cost_tier: high
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(config_module, "_CONFIG_PATH", config_path)

    cards, default_name = load_llm_cards()

    assert default_name == "cheap"
    assert {card.name for card in cards} == {"cheap", "reasoning"}
    assert next(card for card in cards if card.name == "cheap").model == "openai/cheap-model"
    assert next(card for card in cards if card.name == "reasoning").supports_image_input()


def test_select_executor_llm_card_matches_skill_description(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
llm:
  executor_cards:
    default: cheap
    cards:
      cheap:
        model: openai/cheap-model
        description: Cheap filesystem executor.
        skills: [filesystem]
      vasp_reasoning:
        model: openai/strong-model
        description: Expensive executor for VASP debugging and materials analysis.
        skills: [vasp]
        routing_keywords: [debug, relaxation]
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(config_module, "_CONFIG_PATH", config_path)

    selected = select_executor_llm_card(
        action="Debug the failed VASP relaxation and analyze the OUTCAR error.",
        suggested_skills=["vasp"],
    )

    assert selected.name == "vasp_reasoning"
    assert selected.model == "openai/strong-model"


def test_select_executor_llm_card_can_be_forced(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """
llm:
  executor_cards:
    default: cheap
    cards:
      cheap:
        model: openai/cheap-model
      strong:
        model: openai/strong-model
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(config_module, "_CONFIG_PATH", config_path)
    monkeypatch.setenv("MATCREATOR_EXECUTOR_LLM_CARD", "strong")

    selected = select_executor_llm_card(action="List files.", suggested_skills=[])

    assert selected.name == "strong"
    assert selected.model == "openai/strong-model"