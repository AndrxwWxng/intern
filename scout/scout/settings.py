"""
Scout Settings
==============

Environment and runtime objects shared across agents.
"""

from agno.models.google import Gemini

from db import get_postgres_db

agent_db = get_postgres_db()

# Pinned, and pinned to the alias rather than a version. agno defaults to
# gemini-3.5-flash, which this key cannot reach; gemini-2.5-flash returns
# "no longer available to new users"; gemini-2.0-flash is already over its
# free-tier quota. The alias tracks whatever Google currently serves, which
# is the only one of those that keeps working without a code change.
MODEL_ID = "gemini-flash-latest"


def default_model() -> Gemini:
    """Fresh model instance per agent — avoids shared-state footguns."""
    return Gemini(id=MODEL_ID)
