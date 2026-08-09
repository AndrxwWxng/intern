# Connecting Scout to MCP Servers

Scout can pull any [Model Context Protocol](https://modelcontextprotocol.io) server into its context registry. Each server becomes one `MCPContextProvider`, exposes a single `query_mcp_<slug>` tool on Scout, and runs behind a dedicated sub-agent so tool-name collisions between MCP servers stay isolated.

## Why run an MCP server as a context

- **No custom provider to write** — any stdio/HTTP MCP server works.
- **Tool discovery stays fresh.** The sub-agent's instructions are built from the server's `list_tools()` response at connect, so rename a tool on the server and Scout picks it up on the next restart.
- **Graceful degradation.** A crashed or unreachable server surfaces as `ok=false` on `/contexts/<id>/status` instead of taking Scout down.

## Wire one up

Add an `MCPContextProvider` entry to `_create_mcp_providers()` in [`scout/contexts.py`](../scout/contexts.py). Secrets come from the process env via `getenv(...)`.

**stdio (local subprocess):**

```python
MCPContextProvider(
    server_name="linear",
    transport="stdio",
    command="npx",
    args=["-y", "@linear/mcp"],
    env={"LINEAR_API_KEY": getenv("LINEAR_API_KEY", "")},
    model=default_model(),
)
```

**streamable-http (hosted):**

```python
MCPContextProvider(
    server_name="github",
    transport="streamable-http",
    url="https://mcp.github.com/mcp",
    headers={"Authorization": f"Bearer {getenv('GITHUB_TOKEN', '')}"},
    model=default_model(),
)
```

**sse:**

```python
MCPContextProvider(
    server_name="notion",
    transport="sse",
    url="https://mcp.notion.so/sse",
    model=default_model(),
)
```

### Constructor parameters

| Parameter | Required | Description |
|---|---|---|
| `server_name` | yes | Derives `id=mcp_<server_name>` and the tool name `query_mcp_<server_name>`. |
| `transport` | yes | One of `"stdio"`, `"sse"`, `"streamable-http"`. |
| `command` | stdio | Executable (`npx`, `uvx`, `python`, ...). Must be on `PATH`. |
| `args` | stdio (optional) | CLI args as a `list[str]`. |
| `env` | stdio (optional) | Env vars passed to the child process. |
| `url` | sse / streamable-http | Server URL. |
| `headers` | sse / streamable-http (optional) | HTTP headers dict. |
| `timeout_seconds` | optional | Bounds both the initial connect (in `asetup()`) and each MCP read. Default 30. |
| `mcp_kwargs` | optional | Escape hatch: `dict` of extra kwargs passed through to `agno.tools.mcp.MCPTools(**kwargs)`. User's keys win over our computed ones. |
| `mode` | optional | `ContextMode.default` (sub-agent wrap — one `query_mcp_<slug>` tool on Scout) or `ContextMode.tools` (flatten — the server's tools appear directly on Scout). |

### When to pick `mode=tools` vs `mode=default`

`default` routes Scout → sub-agent → MCP, which adds two LLM hops but isolates tool namespaces. Right when the server has many tools, cryptic tool names, or names that collide with another MCP server (e.g. `search`, `create_issue`).

`tools` flattens the server's tools onto Scout directly. Cheaper (no extra hops) and simpler. Right when the server has few, distinctively-named tools (e.g. `get_current_time`) — Scout can route perfectly well with no help.

MCP sessions connect on startup (via `asetup()` on the lifespan task), regardless of mode. That's required for `mode=tools` to see the server's functions, and it keeps the `mcp` SDK's anyio cancel scope on the same task that `aclose()` will exit on.

### stdio executables

`command` must be an executable that's actually on `PATH` inside Scout's runtime. The ship image bundles Python tooling (`uv`, `uvx`, `python`), so Python MCP servers like `uvx --from mcp-server-time mcp-server-time` work out of the box. **Node-based servers (`npx @something/mcp`) need Node installed in your deploy image** — add `RUN apt-get install -y nodejs npm` (or the equivalent) to the Dockerfile before shipping.

## Lifecycle

- **Connect is lazy.** The first `query_mcp_<slug>(...)` call pays the `MCPTools.initialize()` cost. `/contexts/<id>/status` also triggers a connect.
- **Sub-agent instructions come from `list_tools()`** — if the server updates its tool set, restart Scout to pick up the changes.
- **Shutdown closes sessions cleanly.** The app lifespan awaits `aclose()` across every registered provider with `return_exceptions=True` so one stuck teardown can't block the others.

## Verifying

```bash
curl -sS http://localhost:8000/contexts | jq '.[] | select(.id | startswith("mcp_"))'
# { "id": "mcp_linear", "name": "linear", "ok": true,  "detail": "mcp: linear (12 tools)" }
# { "id": "mcp_github", "name": "github", "ok": false, "detail": "mcp github: TimeoutError: ..." }
```

Then ask Scout a question that should route via the MCP tool:

```bash
curl -sS -X POST http://localhost:8000/agents/scout/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"Search Linear for issues assigned to me this week","user_id":"demo"}' \
  | jq -r '.content'
```

## Debugging

- **`/contexts/mcp_<slug>/status` returns `ok=false`.** Either the server isn't reachable or `initialize()` errored. For stdio: check that `command` is on `PATH` (inside the container if running under compose). For HTTP: curl the URL directly to confirm it's live and your headers auth.
- **Tool calls fail but status is OK.** Look at `MCPContextProvider` logs — agno's `MCPTools` logs tool-call exceptions at `ERROR`. Some servers declare tools they don't actually implement.
- **Tool list looks stale.** The list is cached at connect time. Restart Scout to re-discover.

## Known gaps (v1)

- **Writes aren't gated.** If an MCP server exposes a `create_issue` tool, Scout's sub-agent will call it when the user explicitly asks. There's no per-tool policy layer yet.
- **No auto-reconnect.** A dropped session raises on the next call; the provider resets and the call after that reconnects. No retry loop beyond that.
- **`list_contexts` shows tool counts, not tool schemas.** If you need the schema for a specific server, call the sub-agent directly or inspect `MCPTools.functions` in a debug shell.
