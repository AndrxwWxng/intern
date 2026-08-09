# Intern

A terminal for the company brain.

Two panes, one idea: on the left a graph of everything the company knows, on the
right and below a stream of **interns** — long-running subagents you dispatch at
a brief and leave alone. When an intern finds something durable it files it into
the brain, and you watch the graph grow while it happens.

The brain itself is [Scout](./scout) — the Agno company-intelligence agent in
this repo. Intern is its cockpit.

```bash
npm run dev     # http://localhost:3000
```

## Two modes

The cockpit probes Scout on startup and every 20s, and flips between:

| Mode | When | What you get |
|---|---|---|
| **LIVE** | Scout answers at `SCOUT_API_URL` | Interns are real agent runs (`POST /agents/scout/runs`, streamed). The graph is read from the `scout` Postgres schema and the wiki. |
| **SIM** | Scout is unreachable | A seeded company graph plus scripted intern traces. Clearly labelled `SIM` everywhere — it's a stand-in for the shape of the thing, not a fake result. |

Nothing has to be configured to see it work. Start Scout later and the header
flips to `LIVE` on its own.

```bash
# .env.local
SCOUT_API_URL=http://localhost:8000   # default
SCOUT_AGENT_ID=scout                  # default
```

To run the real backend, follow [`scout/README.md`](./scout/README.md)
(`docker compose up -d --build`).

## Using it

Everything runs from the command bar at the bottom. Bare text is a brief.

```
spawn   map every mention of the ramp pilot across slack, drive and the wiki
ask     who owns the git-backed wiki
kill    int-01kx
focus   int-01kx | all
outbox · approve act-01hw · reject act-01hw
graph   refresh
clear · help
```

Press `/` to focus the bar, `↑`/`↓` for history.

**Graph.** Drag to pan, scroll to zoom, drag a node to pull it, click to inspect.
The camera auto-frames the whole brain until you take it. `layers` in the left
rail toggles node kinds; the search box dims everything that doesn't match.
Working interns pulse on the graph as nodes of their own, wired to whatever they
write.

## VoiceOS

VoiceOS integrates by MCP server URL, so Intern ships as one:

```
http://localhost:3000/api/mcp
```

Paste that into VoiceOS and it gets thirteen tools — search the brain, inspect a
node, dispatch an intern, check on one, and work the outbox.

### Interns draft. They never send.

There is no send tool on this server, by design. An intern that decides
something should go out writes a draft into the outbox and stops.

```
intern finishes → draft lands in the outbox, status=pending
       ↓
VoiceOS: outbox_list → outbox_get → reads the recipient, subject and body aloud
       ↓
you say yes → outbox_approve(confirmed: true) → returns the draft
       ↓
VoiceOS sends it with its own Gmail credentials
       ↓
outbox_record_result → the outcome is written back into the brain
```

`outbox_approve` refuses unless `confirmed` is true, and the server instructions
tell the assistant it may only set that after reading the draft out loud in the
same turn. You can also approve or reject in the cockpit — the right rail shows
every pending draft with the full body.

Two reasons the send lives on the VoiceOS side rather than here. Credentials
stay in the one process that already holds your identity, so Intern never needs
an OAuth surface. And a draft is assembled from web pages, Slack messages and
documents the intern read — untrusted text — so `outbox_get` marks the body as
data and nothing derived from it leaves the building without a person saying so.

### The tools

| Tool | Does |
|---|---|
| `brain_search` `brain_node` `brain_stats` `brain_refresh` | read the graph |
| `intern_spawn` `interns_list` `intern_get` `intern_cancel` | run the workforce |
| `outbox_list` `outbox_get` | see what's waiting |
| `outbox_approve` `outbox_reject` | decide, with `confirmed` required |
| `outbox_record_result` | report what actually happened |

Transport is streamable HTTP (JSON-RPC 2.0), answering as plain JSON or a single
SSE frame depending on `Accept`. For a remote VoiceOS, tunnel it — `ngrok http
3000` — and hand it the public `/api/mcp` URL.

## How it fits together

```
app/api/events      SSE — one multiplexed stream: logs, intern state, graph deltas
app/api/interns     POST spawn · GET list · DELETE cancel
app/api/brain       GET the graph (?refresh=1 re-reads it)
app/api/ask         one-shot question, answer streams back over /api/events
app/api/outbox      GET drafts · POST a decision on one
app/api/mcp         MCP server — the URL VoiceOS connects to

lib/store.ts        intern registry, log ring buffer, run loop, event bus
lib/scout.ts        Scout client — health, contexts, graph, streamed runs
lib/sim.ts          seeded brain + scripted intern traces for SIM mode
lib/mcp.ts          MCP tool definitions and dispatch

components/BrainGraph.tsx   canvas force-directed graph (no graph library)
components/Terminal.tsx     the stream, filterable per intern
```

Interns live in server memory (pinned to `globalThis` so hot-reload doesn't
orphan a run), capped at 4 concurrent. Restarting the server clears them —
what they filed into Scout survives, because that's the point.

## The Scout side

One endpoint was added to the backend for this UI:

```
GET /brain/graph   → { nodes, edges }
```

It reads the `scout` schema and the wiki structurally — see
[`scout/app/brain.py`](./scout/app/brain.py). Asking the CRM sub-agent for this
in natural language would be slow and non-deterministic; the graph is
structural, so it's read structurally. Read-only by construction.
