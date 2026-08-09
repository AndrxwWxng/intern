"""Custom API routes for Scout

GET  /contexts                 — list all contexts + status
GET  /contexts/{id}/status     — single context status
POST /contexts/{id}/query      — debug: query context directly
GET  /brain/graph              — structural graph of everything Scout knows
"""

from __future__ import annotations

import uuid
from dataclasses import asdict

from agno.os.auth import get_authentication_dependency
from agno.os.settings import AgnoAPISettings
from agno.run import RunContext
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.brain import build_graph
from scout.contexts import (
    WIKI_KNOWLEDGE_PATH,
    WIKI_VOICE_PATH,
    get_context_providers,
    status_row,
)


class QueryRequest(BaseModel):
    question: str
    user_id: str | None = None


def create_router(settings: AgnoAPISettings) -> APIRouter:
    router = APIRouter(
        dependencies=[Depends(get_authentication_dependency(settings))],
    )

    @router.get("/contexts")
    def list_contexts_route():
        return [status_row(ctx) for ctx in get_context_providers()]

    @router.get("/contexts/{target_id:path}/status")
    def context_status(target_id: str):
        target = _target(target_id)
        if target is None:
            return JSONResponse({"error": f"unknown target {target_id}"}, status_code=404)
        return status_row(target)

    @router.post("/contexts/{target_id:path}/query")
    async def context_query(target_id: str, body: QueryRequest):
        target = _target(target_id)
        if target is None:
            return JSONResponse({"error": f"unknown target {target_id}"}, status_code=404)
        run_context = _build_debug_run_context(body.user_id)
        answer = await target.aquery(body.question, run_context=run_context)
        return {
            "text": answer.text,
            "results": [asdict(r) for r in answer.results],
        }

    @router.get("/brain/graph")
    def brain_graph():
        """Everything Scout knows, as nodes + edges. Powers the cockpit UI."""
        return build_graph(
            wiki_roots={
                "knowledge": WIKI_KNOWLEDGE_PATH,
                "voice": WIKI_VOICE_PATH,
            }
        )

    return router


def _target(target_id: str):
    for ctx in get_context_providers():
        if ctx.id == target_id:
            return ctx
    return None


def _build_debug_run_context(user_id: str | None) -> RunContext | None:
    """Fresh RunContext per debug call so the sub-agent's {user_id} template
    substitutes correctly. run_id/session_id are required by the constructor
    but the sub-agent picks its own session when it runs; these IDs just
    identify this debug hop in traces.
    """
    if not user_id:
        return None
    debug_id = uuid.uuid4().hex[:8]
    return RunContext(
        run_id=f"debug-{debug_id}",
        session_id=f"debug-{debug_id}",
        user_id=user_id,
    )
