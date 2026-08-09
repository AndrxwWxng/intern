# The Intern — High-Level Design

Status: draft · 9 Aug 2026
Companion doc: [`IDEA.md`](../IDEA.md) (read that first)
Mockup: https://claude.ai/code/artifact/fcb48b5a-f684-456e-a91c-56c60e1bdb9e

---

## 1. Scope

This describes the system at the level needed to start building: the model, the flows, the
data, and where the hard parts are. It does not specify APIs, schemas down to column types,
or UI components.

**In scope:** the shared brain, the intern roster, task execution, handovers, ingestion,
identity and permissions.

**Out of scope for now:** billing, multi-org tenancy, an intern marketplace, mobile.

## 2. The model in one paragraph

A company connects its tools once. A continuous stream of observations flows in and is
projected into a shared knowledge graph — **the brain**. Anyone can assign work to an
**intern**: an agent that reads the brain to resolve what a request left out, acts in real
systems using the requester's own credentials, and **hands over to a person** before
anything consequential. What the person changes before approving is appended to the stream,
so the next task starts better informed.

Interns are the write path to the brain. The graph is the read path.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Observation** | One immutable thing that was seen at a source. A Slack message, a calendar event, a row in an HR system. Never edited. |
| **Fact** | A promoted, deduplicated, citable claim about the company. Derived from one or more observations. Has provenance, confidence and a validity window. |
| **Brain** | The graph of facts and the typed relations between them. A projection, rebuildable from the log. |
| **Intern** | An agent with a job description, a permitted slice of the brain, a set of tools, and a trust level per kind of task. |
| **Task** | One unit of assigned work. A DAG of steps. |
| **Handover** | The transfer of work from one party to the next — intern→intern or intern→person. Approval is the second kind. |
| **Graduation** | An intern moving from supervised to unsupervised on one kind of task, based on how often its work is accepted unedited. |

**Design note.** Approval is not a special case. An approval gate is a handover whose
recipient happens to be a person, so dispatch and resume are one code path.

## 4. Architecture

```
  callers ─── web UI · API key · cron · another intern · VoiceOS
                             │
                             ▼
   ┌───────────────────────────────────────────────┐
   │  INTERNS                                      │
   │  job description · permitted scope · tools    │
   │  trust level per task kind                    │
   └───────────────────────────────────────────────┘
                │  handover (intern→intern | intern→person)
                ▼
   ┌───────────────────────────────────────────────┐
   │  ORCHESTRATOR                                 │
   │  task = DAG of steps · durable · resumable    │
   │  a step needing sign-off parks, does not poll │
   └───────────────────────────────────────────────┘
        │ reads facts                    │ acts via tools
        │                                ▼
        │                    ┌──────────────────────┐
        │                    │  TOOL LAYER (MCP)    │
        │                    │  one server per      │
        │                    │  system, acts AS the │
        │                    │  requesting user     │
        │                    └──────────────────────┘
        ▼                                │
   ┌───────────────────────────────────────────────┐
   │  BRAIN — facts + relations + embeddings       │
   │  a projection, rebuildable from the log       │
   └───────────────────────────────────────────────┘
        ▲
        │  promote (only if citable)
   ┌───────────────────────────────────────────────┐
   │  EVENT LOG — append-only, source of truth     │
   │  observations · task events · handover diffs  │
   └───────────────────────────────────────────────┘
        ▲                                    ▲
        │ webhook / backfill                 │ every task writes back
   ┌─────────────────────┐
   │  CONNECTORS         │  Slack · Gmail · Notion · Salesforce · HR
   │  OAuth, server-side │
   └─────────────────────┘
```

**The log is the spine.** Facts and relations are derived and disposable — a bad extraction
rule is fixed by reprojecting, not by migrating. Replaying to a timestamp *is* "the brain as
of April", so time travel is something we avoid preventing rather than something we build.

## 5. Data model

Essential tables only.

**`observations`** — immutable landing zone
`id · source_id · external_id · actor_user_id · payload · observed_at · ingested_at`
`(source_id, external_id)` is unique. That one constraint makes replay and retry safe.

**`facts`** — the promoted, citable layer
`id · kind · title · body · embedding · confidence · valid_from · valid_to · visibility_scopes[]`
Facts supersede rather than overwrite. A superseded fact gets `valid_to` set; nothing is
destroyed, so a September audit can still see what was true in February.

**`fact_observations`** — provenance, many-to-many
`fact_id · observation_id`
Two people seeing the same Slack message produce **one fact with two observations**, not two
facts. Multiple independent observations raise confidence.

**`relations`** — the edges
`from_fact · to_fact · type · valid_from · valid_to`

**`interns`** — the roster
`id · name · job_description · readable_kinds[] · writable_kinds[] · tools[] · requires_approval`

**`tasks`** / **`steps`**
`steps: id · task_id · intern_id · args · depends_on[] · status · output · context_snapshot`
`context_snapshot` records exactly which fact versions the plan was built on, so a run in
flight is not destabilised by ingestion, and a later "why did it do that" is answerable.

**`handovers`** — the spine of the work side
`id · step_id · from · to · to_kind(intern|person) · proposed · accepted · edited · decided_at · rejection_note`

**`proposed` and `accepted` never collapse into one column.** That diff is the training
signal and the reason the system improves.

**`events`** — append-only activity, drives the live UI
`id · actor_user_id · intern_id · source_id · type · ref · at`
Every event carries the **actor triple** — which person, via which intern, through which
credential. One field serving provenance, permissions, and the record of who contributed.

## 6. Key flows

### 6.1 Ingestion

Facts arrive by two paths, and only one of them is ours to authenticate.

**Pushed by a person, through a channel.** Someone points at something — *"add this thread
to the brain"* — and the channel's own agent reads it and calls our capture tool. VoiceOS
Agent Mode has built-in Slack, Gmail, Calendar, Notion and Drive connections and can call
its tool and ours in the same turn, so this path costs us no OAuth at all. It is bounded:
turn-scoped, under ~30s, and requires a person present and speaking.

**Pulled continuously, by us.** Webhooks and scheduled backfill against our own per-user
OAuth connections, running whether or not anyone is at a desk. This is the path that keeps
a shared brain current, and there is nothing to delegate it to — channel integrations are
sandboxed from each other's credentials, and inbound webhooks are not available to them.

Both paths land in the same place:

```
capture (pushed) or webhook / scheduled backfill (pulled)
  → write observation (idempotent on source_id + external_id)
  → extract candidate facts and relations
  → resolve against existing facts
       confident match  → attach observation, raise confidence
       confident new    → create fact
       ambiguous        → HANDOVER to a person
  → embed (skip if content hash unchanged)
  → commit, emit event
```

Ingestion runs on the same orchestrator as work — same steps, same handovers, same
visualisation. It is not a separate subsystem, which is most of why this design is small.

**Promotion discipline:** an observation becomes a fact only if an intern could plausibly
cite it. Everything else stays in the landing zone, unindexed and unembedded. Without this
rule the brain is an expensive log.

### 6.2 Task execution

```
request (voice or text)
  → planner intern resolves entities against the brain
       missing context → ASK, never guess
  → snapshot context, write task + steps
  → dispatch steps whose dependencies are met
  → step completes → emit event → dispatch successors
  → step needs sign-off → write handover(to_kind=person), park
```

Parked means parked. No polling loop, no timeout that fires the action anyway.

### 6.3 Handover to a person

The person sees the proposal, the intern's reasoning in plain language, and the facts it
cited as links into the graph. Three outcomes:

- **Accept** — successors dispatch.
- **Accept with edits** — the diff is appended to the log as a preference fact, then dispatch.
- **Not like this** — the task halts and the person says what should have happened. That
  answer is also appended as a fact.

### 6.4 Learning

There is no training job. Corrections become facts; facts are retrieved by the next planner;
behaviour changes. An intern's **trust level** per task kind is computed from its accepted-
unedited rate over a rolling window. Crossing a threshold proposes graduation — a person
confirms it. Graduation is never automatic.

## 7. Identity, auth and permissions

All of it lives in our application. No channel can hold it for us: their integrations are
sandboxed from one another's credentials, and their permission model has no grant for
reaching a host's connected accounts. Three surfaces, and we own all three.

**People** sign in to the web app — Supabase Auth, so row-level security keys off
`auth.uid()` without a second identity system to reconcile.

**Connectors** are per-user OAuth, server-side, with refresh tokens so ingestion continues
when every laptop is shut. An intern acting for you uses your token, so it can only ever
reach what you could reach. This removes the need for a policy engine.


**Reading the brain** is filtered at query time. Each fact carries `visibility_scopes[]`
derived from the union of its observations' sources — e.g. `slack:C0192`, `gmail:user:42`,
`company:public`. A reader's scopes come from their connected accounts; a fact is visible if
the sets intersect. Enforced in the database with row-level security, not in application
code, so a missed check in one query path can't leak.

Company-wide material (org chart, SOPs, policies) carries `company:public` and everyone
sees it.

**Machine callers** — cron, scripts, a channel integration — get an API key bound to a
person, with an allowlist of interns. Calls inherit that person's scopes, so nothing gets
ambient authority. That key is the only secret a channel ever holds.

## 8. Stack

| Concern | Choice | Note |
|---|---|---|
| Store | Postgres (Supabase) | one store for log, facts and jobs — no distributed transaction to get wrong |
| Retrieval | `pgvector` | embeddings live next to the facts they belong to |
| Permissions | Postgres RLS | scope filtering enforced below the application |
| Live UI | Supabase Realtime | Postgres changes streamed over WebSocket; the graph subscribes |
| Orchestration | job table + worker loop | durable and resumable; no new vendor |
| UI | Next.js on Vercel | |
| Tools | MCP server per system | identical interface for fixtures and real integrations, so they swap without touching the orchestrator |

**Swapping this out.** Only this section is stack-coupled. Convex would replace the Store,
Live UI and Orchestration rows — reactive queries and a built-in scheduler in exchange for
Postgres's RLS and SQL. Everything above stays as written either way.

**The seam to know about:** at real Slack volume for a large company the log outgrows a
Postgres table, and a proper log goes in front while Postgres keeps the projections. Not
worth building now; worth not designing against.

## 9. Failure modes

| What breaks | What happens |
|---|---|
| Connector token expires | Source marked stale in the UI. Ingestion stops loudly rather than serving silently stale facts. |
| A step fails mid-task | Task halts, prior steps stand. No automatic rollback — undoing a Slack invite is not the same as undoing a database write. A person decides. |
| Extraction was wrong | Fix the rule, reproject from the log. Facts are derived, so this is cheap. |
| Two sources disagree | Fact enters conflict state, renders as such, and asks a person. Never silently picks a winner. |
| A fact changes mid-task | The context snapshot holds. If the change is material to a parked step, the handover is flagged before a person approves against stale reasoning. |

## 10. Build order

1. **Schema and the live graph** — real subscriptions, seeded facts, a fake ingestion writer. Proves the hardest question (does a live graph feel good) before any intern exists.
2. **One intern end to end** — plan, execute against fixture tools, one handover to a person, edits stored.
3. **Capture without connectors** — sign-in, API keys, and the pushed path. A person can
   put facts into the brain through a channel before we have written a single OAuth flow.
   This is deliberately ahead of step 4: it makes the demo possible without connectors.
4. **Real ingestion** — the first per-user OAuth connector, entity resolution, promotion.
5. **Roster and trust** — several interns, accepted-unedited rate, graduation.
6. **Channels** — the VoiceOS integration proper and the public intern directory.

## 11. Risks

1. **Entity resolution.** Sarah in Slack, `sarah@northwind.co` in Workspace and employee #1182 in Rippling are one person. Get it wrong and the graph fragments silently — retrieval degrades and nobody notices until an intern cites the wrong thing. The single problem that decides whether this works. Mitigation: resolve conservatively, hand ambiguity to a person, and make merges reversible.
2. **Graph legibility past a few thousand facts.** 400 nodes is a picture; 40,000 is a grey blob. Needs clustering or level-of-detail on zoom. Only bites after real ingestion.
3. **Demonstrating shared-ness.** On one connected account this is indistinguishable from a personal tool. Two users, where one person's ingestion visibly feeds another's approval.
4. **Ingestion cost.** Embedding everything continuously is expensive. Content-hash before re-embedding, and enforce the promotion discipline.
