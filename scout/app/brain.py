"""
Brain Graph
===========

A single read that turns everything Scout knows into a node/edge graph:
context providers, every table in the ``scout`` schema, and the wiki pages.

This exists for the cockpit UI (the Next.js app at the repo root). Asking the
CRM sub-agent for this in natural language would be slow and non-deterministic
— the graph is structural, so read it structurally.

Read-only by construction: uses ``get_readonly_engine()``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from agno.utils.log import log_warning
from sqlalchemy import text

from db import SCOUT_SCHEMA, get_readonly_engine

# Per-table cap so a big CRM can't produce an unrenderable graph.
ROW_LIMIT = 120

# Table -> (node kind, column to use as the label)
KIND_BY_TABLE: dict[str, tuple[str, str]] = {
    "scout_contacts": ("contact", "name"),
    "scout_projects": ("project", "name"),
    "scout_notes": ("note", "title"),
    "scout_followups": ("followup", "title"),
}

LABEL_CANDIDATES = ("name", "title", "label", "subject", "summary")


def build_graph(wiki_roots: dict[str, Path] | None = None) -> dict[str, Any]:
    """Assemble the graph. Never raises — a partial brain beats a 500."""
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    seen_nodes: set[str] = set()
    tags: set[str] = set()

    def add_node(node_id: str, label: str, kind: str, **extra: Any) -> None:
        if node_id in seen_nodes:
            return
        seen_nodes.add(node_id)
        nodes.append({"id": node_id, "label": label, "kind": kind, **extra})

    def add_edge(source: str, target: str, rel: str) -> None:
        edges.append({"source": source, "target": target, "rel": rel})

    add_node("brain", "brain", "intern", weight=12, detail="company brain")

    # --- context providers -------------------------------------------------
    try:
        from scout.contexts import get_context_providers

        for provider in get_context_providers():
            src = f"src:{provider.id}"
            add_node(src, provider.id, "source", weight=7, detail=type(provider).__name__)
            add_edge("brain", src, "provides")
    except Exception as exc:  # pragma: no cover - defensive
        log_warning(f"brain graph: contexts unavailable ({exc})")

    for fallback in ("crm", "knowledge", "voice"):
        add_node(f"src:{fallback}", fallback, "source", weight=7)
        add_edge("brain", f"src:{fallback}", "provides")

    # --- scout schema ------------------------------------------------------
    try:
        engine = get_readonly_engine()
        with engine.connect() as conn:
            table_rows = conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = :schema ORDER BY table_name"
                ),
                {"schema": SCOUT_SCHEMA},
            ).fetchall()

            for (table,) in table_rows:
                columns = {
                    row[0]
                    for row in conn.execute(
                        text(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_schema = :schema AND table_name = :table"
                        ),
                        {"schema": SCOUT_SCHEMA, "table": table},
                    ).fetchall()
                }
                if "id" not in columns:
                    continue

                kind, label_col = KIND_BY_TABLE.get(table, ("note", ""))
                if not label_col or label_col not in columns:
                    label_col = next(
                        (c for c in LABEL_CANDIDATES if c in columns), "id"
                    )

                select_cols = ["id", label_col]
                if "tags" in columns:
                    select_cols.append("tags")
                if "status" in columns:
                    select_cols.append("status")

                quoted = ", ".join(
                    '"' + c + '"' for c in dict.fromkeys(select_cols)
                )
                rows = (
                    conn.execute(
                        text(
                            f'SELECT {quoted} FROM "{SCOUT_SCHEMA}"."{table}" '
                            "ORDER BY id DESC LIMIT :limit"
                        ),
                        {"limit": ROW_LIMIT},
                    )
                    .mappings()
                    .fetchall()
                )

                if rows:
                    add_node(f"src:{table}", table, "source", weight=6, detail="table")
                    add_edge("src:crm", f"src:{table}", "table")

                for row in rows:
                    node_id = f"{table}:{row['id']}"
                    label = str(row.get(label_col) or f"{table}#{row['id']}")
                    add_node(
                        node_id,
                        label[:80],
                        kind,
                        weight=4,
                        detail=str(row.get("status") or table),
                        meta={"table": f"{SCOUT_SCHEMA}.{table}", "id": row["id"]},
                    )
                    add_edge(f"src:{table}", node_id, "row")

                    for tag in row.get("tags") or []:
                        tag_id = f"tag:{tag}"
                        tags.add(tag)
                        add_node(tag_id, f"#{tag}", "tag", weight=2)
                        add_edge(node_id, tag_id, "tagged")
    except Exception as exc:
        log_warning(f"brain graph: database unavailable ({exc})")

    # --- wiki --------------------------------------------------------------
    for wiki_id, root in (wiki_roots or {}).items():
        src = f"src:{wiki_id}"
        add_node(src, wiki_id, "source", weight=7)
        add_edge("brain", src, "provides")
        try:
            for path in sorted(Path(root).rglob("*.md"))[:ROW_LIMIT]:
                rel = path.relative_to(root).as_posix().removesuffix(".md")
                if rel.upper() == "README":
                    continue
                node_id = f"wiki:{wiki_id}/{rel}"
                add_node(
                    node_id,
                    rel,
                    "wiki",
                    weight=4,
                    detail=str(path.parent.name or wiki_id),
                    meta={"path": str(path)},
                )
                add_edge(src, node_id, "page")
                # Wiki pages inherit the folder as a tag so prose and rows
                # cluster together in the graph.
                folder = rel.split("/")[0] if "/" in rel else None
                if folder:
                    tag_id = f"tag:{folder}"
                    add_node(tag_id, f"#{folder}", "tag", weight=2)
                    add_edge(node_id, tag_id, "tagged")
        except Exception as exc:  # pragma: no cover - defensive
            log_warning(f"brain graph: wiki {wiki_id} unreadable ({exc})")

    # Drop edges that dangle (a capped table can orphan a tag link).
    valid = {n["id"] for n in nodes}
    edges = [e for e in edges if e["source"] in valid and e["target"] in valid]

    return {"nodes": nodes, "edges": edges}
