"""CLI entry point.

Usage:
    python -m scout                     # interactive chat with Scout
    python -m scout contexts            # list registered contexts + status
"""

from __future__ import annotations

import asyncio
import json
import sys


async def _contexts_rows() -> list[dict]:
    from scout.contexts import astatus_row, create_context_providers

    return [await astatus_row(ctx) for ctx in create_context_providers()]


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "contexts":
        print(json.dumps(asyncio.run(_contexts_rows()), indent=2))
        return

    from scout.agent import scout

    scout.cli_app(stream=True)


if __name__ == "__main__":
    main()
