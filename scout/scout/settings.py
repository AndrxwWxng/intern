"""
Scout Settings
==============

Environment and runtime objects shared across agents.
"""

from agno.models.openai import OpenAIResponses

from db import get_postgres_db

agent_db = get_postgres_db()


# The key belongs to a personal account, so the cheaper model is the default.
# An intern is a long run — the one above made 57 tool calls in a single
# brief — and cost scales with the tool loop, not with the question.
MODEL_ID = "gpt-5.6-luna"


def default_model() -> OpenAIResponses:
    """Fresh model instance per agent — avoids shared-state footguns."""
    return OpenAIResponses(id=MODEL_ID)
