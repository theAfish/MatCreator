"""Root entry point for MatCreator.

Wires the single MatCreator LlmAgent into an ADK App with event compaction
and resumability. The complex phase-routing state machine is gone — the agent
handles planning and execution in a single conversational loop.
"""

import os
import logging

from google.adk.agents.callback_context import CallbackContext
from google.adk.apps.llm_event_summarizer import LlmEventSummarizer
from google.adk.apps.app import App, EventsCompactionConfig
from google.adk.apps import ResumabilityConfig
from google.adk.models.lite_llm import LiteLlm

from .thinking_agent import thinking_agent
from .constants import LLM_MODEL, LLM_API_KEY, LLM_BASE_URL
from .callbacks import set_session_metadata, get_session_metadata

model_name = os.environ.get("LLM_MODEL", LLM_MODEL)
model_api_key = os.environ.get("LLM_API_KEY", LLM_API_KEY)
model_base_url = os.environ.get("LLM_BASE_URL", LLM_BASE_URL)

logger = logging.getLogger(__name__)


def before_agent_callback_root(callback_context: CallbackContext) -> None:
    """Set session env-vars and seed session state defaults."""
    session_id = callback_context._invocation_context.session.id
    user_id = callback_context._invocation_context.session.user_id
    app_name = callback_context._invocation_context.session.app_name

    os.environ["CURRENT_SESSION_ID"] = session_id
    os.environ["CURRENT_USER_ID"] = user_id
    os.environ["CURRENT_APP_NAME"] = app_name

    state = callback_context._invocation_context.session.state
    for key, default in [
        ("plan", None),
        ("goal", None),
        ("memory", ""),
        ("skills", None),
        ("guides", None),
        ("active_skill", None),
        ("skill_instruction", None),
        ("summarize", None),
    ]:
        if key not in state:
            callback_context.state[key] = default

    # Persist session metadata to DB on first call
    try:
        if not get_session_metadata(session_id):
            set_session_metadata(
                session_id=session_id,
                additional_metadata={"initialized_by": "root_agent"},
            )
    except Exception as exc:
        logger.warning("Failed to initialize session metadata: %s", exc)

    return None


# Attach the root before_agent_callback to the single agent
thinking_agent.before_agent_callback = before_agent_callback_root

compaction_summarizer = LlmEventSummarizer(
    llm=LiteLlm(
        model=model_name,
        base_url=model_base_url,
        api_key=model_api_key,
    ),
)

app = App(
    name="MatCreator",
    root_agent=thinking_agent,
    resumability_config=ResumabilityConfig(
        is_resumable=True,
    ),
    events_compaction_config=EventsCompactionConfig(
        compaction_interval=3,
        overlap_size=1,
        summarizer=compaction_summarizer,
    ),
)