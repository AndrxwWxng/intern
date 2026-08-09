# Intern — setup manifest

Every credential this project needs, where it lives, and what it unlocks.

Status as of the last update below. Re-check any time with:

```sh
curl -s localhost:3000/api/connectors | python3 -m json.tool   # what can send
npx convex env list                                            # deployment vars (prints VALUES — careful)
```

---

## Where configuration lives

There are **four** places, and putting a value in the wrong one fails silently.

| File / store | Read by | Committed? |
|---|---|---|
| `.env.local` | the Next.js cockpit — connectors, Scout URL, Convex client | no (gitignored) |
| `scout/.env` | the Python brain — model, read-side providers | no (gitignored) |
| Convex deployment env (`npx convex env set`) | Convex functions — OAuth callback, token refresh | n/a, lives in the cloud |
| Google Cloud / Slack consoles | the OAuth clients themselves | n/a |

Rule of thumb: **sending** is configured in `.env.local`, **reading** in `scout/.env`, and **per-user OAuth** on the Convex deployment.

### Three different Google credentials

They are not interchangeable, and this is the easiest thing in the project to get wrong.

| Credential | What it is | For |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | OAuth client + a user's grant | sending mail and creating events **as a person** |
| `GOOGLE_API_KEY` | an AI Studio key | the Gemini model Scout runs on |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | a service account JSON | Scout **reading** Drive as itself |

A service account cannot send mail as you; an API key cannot do either.

---

## Current state

### ✅ Working

| What | Where | Notes |
|---|---|---|
| `SCOUT_API_URL` / `SCOUT_AGENT_ID` | `.env.local` | defaults are fine |
| `GOOGLE_CLIENT_ID` / `_SECRET` | `.env.local` | Desktop-app OAuth client |
| `GOOGLE_REFRESH_TOKEN` | `.env.local` | verified valid — `gmail.send` + `calendar.events` |
| `CONVEX_DEPLOYMENT` | `.env.local` | `dev:graceful-albatross-202` (shared, Mihir's) |
| `NEXT_PUBLIC_CONVEX_URL` / `_SITE_URL` | `.env.local` | written by `convex dev` |
| `JWKS` / `JWT_PRIVATE_KEY` / `SITE_URL` | Convex deployment | written by `@convex-dev/auth` |

Connectors: **email ✅ · calendar ✅ · slack ❌**

### ❌ Not set yet

| What | Where | Unlocks | Effort |
|---|---|---|---|
| `OUTBOX_DRY_RUN=0` | `.env.local` | actually sending — currently every send is simulated | 10 s |
| `OUTBOX_TEST_RECIPIENT` | `.env.local` | routes every simulated draft to your own inbox | 10 s |
| `SLACK_BOT_TOKEN` | `.env.local` | the Slack connector | 5 min |
| `GOOGLE_API_KEY` | `scout/.env` (file doesn't exist yet) | LIVE mode — real agent runs instead of scripted | 15 min |
| `SLACK_BOT_TOKEN` | `scout/.env` | Scout reading your Slack | same token as above |
| `SLACK_SIGNING_SECRET` | `scout/.env` | Scout as a Slack bot you can talk to | +10 min, needs ngrok |
| `PARALLEL_API_KEY` | `scout/.env` | better web search; falls back to a keyless MCP without it | optional |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | `scout/.env` | Scout reading Drive — **different credential type** to the trio above | optional |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Convex deployment | per-user Google OAuth | blocked |
| `SLACK_CLIENT_ID` / `_SECRET` | Convex deployment | per-user Slack OAuth | blocked |

---

## Ordered next steps

### 1 · Send for real (2 min)

```sh
# .env.local
OUTBOX_TEST_RECIPIENT=andrewwang123118@gmail.com
OUTBOX_DRY_RUN=0
```

Restart, `spawn email josh thanking him for the rlm paper`, approve in the rail.

> With `OUTBOX_DRY_RUN=0` **every approval sends.** The approve button dropping the "(dry run)" label is the only cue.

### 2 · Slack connector (5 min)

api.slack.com/apps → Create New App → From scratch → **OAuth & Permissions** → Bot Token Scopes:

```
chat:write          sending
chat:write.public   posting to channels the bot isn't in
channels:history    Scout reading public channels
groups:history      private channels
users:read          resolving names
```

Install to Workspace → copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN` in `.env.local`.

The bot must be `/invite`d to private channels. Slack message *search* needs a **user** token (`search:read` isn't a bot scope) — history and threads work without it.

### 3 · Scout LIVE (15 min)

Scout runs on **Gemini** (`gemini-flash-latest`, pinned to the alias), so it wants
`GOOGLE_API_KEY` from AI Studio. Note `scout/example.env` still says
`OPENAI_API_KEY` — it wasn't updated when the model changed, so ignore that line.

```sh
cp scout/example.env scout/.env      # add GOOGLE_API_KEY (+ SLACK_BOT_TOKEN from step 2)
cd scout && docker compose up -d --build
```

Header flips SIM → LIVE.

### 4 · Per-user OAuth — blocked

In order:

1. **Client auth wiring** — `components/ConvexClientProvider.tsx` uses a plain `ConvexProvider`, which never sends auth tokens, so `getAuthUserId` is null in the browser and nobody can sign in.
2. `npx convex env set GOOGLE_CLIENT_ID …` etc. on the deployment.
3. A **Web application** Google client (not Desktop) with redirect `https://graceful-albatross-202.convex.site/oauth/callback`.
4. A Slack app redirect at the same URL — per-user Slack needs `user_scope`, a different install flow from step 2.
5. Connectors read per-user tokens keyed off `actions.decidedBy`; a Connect button in the rail.

Steps 1–4 of the backend are already built: `convex/connections.ts`, `convex/http.ts`, `convex/tokens.ts`, `convex/providers.ts`.

---

## Known hazards

**Shared dev deployment.** `graceful-albatross-202` is Mihir's personal dev deployment and you both push to it. Convex dev deployments are single-developer by design — **whoever pushes last wins, for the whole team.** A push from here already deleted indexes on `observations` and `decisions`, tables that exist on the deployment but not in this repo's `schema.ts`. Agree on one watcher (`npx convex dev`) and have everyone else use `npx convex dev --once`.

**Google refresh token expires every 7 days.** The consent screen is in Testing mode, where Google caps refresh-token lifetime at 7 days. Sending will start failing with `invalid_grant`. Re-run `node scripts/google-token.mjs <id> <secret>` to fix. Publishing to Production removes the cap but `gmail.send` is a sensitive scope needing verification — weeks.

**Test users list.** Anyone demoing must be added under OAuth consent screen → Test users, or they get `Error 403: access_denied`.

**Seeded contacts point at `example.com`** (RFC 2606, routes nowhere) so an accidental real send can't reach a stranger. Don't change them back to real-looking domains.

**One identity, for now.** Until per-user OAuth lands, every send goes out as the single Google account whose refresh token is in `.env.local` — regardless of who approved it. `actions.decidedBy` and the From header will disagree.

**`JWT_PRIVATE_KEY` was printed to a chat transcript.** If that log is shared, rotate: delete the var and re-run `npx @convex-dev/auth`.

---

## Quick reference

```sh
npm run dev                      # cockpit → localhost:3000
npx convex dev                   # function watcher (only one person at a time)
npx convex dev --once            # push once and exit
cd scout && docker compose up -d # the brain → localhost:8000

curl -s localhost:3000/api/connectors   # what can send
curl -s localhost:3000/api/outbox       # what's waiting for approval
curl -s localhost:3000/api/brain        # the graph
```

Command bar: `spawn <task>` · `ask <q>` · `outbox` · `approve <id>` · `reject <id> <reason>` · `graph refresh` · `help`
