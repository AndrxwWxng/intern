# The Intern

**One shared company brain. A roster of interns that work against it.**

Read time: 3 minutes. This is the idea, not the spec.

---

## What we're building

Two halves that need each other:

**The brain** — a live knowledge graph of how a company actually works. People, systems,
docs, SOPs, policies, decisions. It is fed continuously from the tools the company already
uses (Slack, Gmail, Notion, Salesforce), and it keeps updating as work happens.

**The interns** — a roster of agents anyone can assign work to. They read the brain to
figure out what to do, act in real systems, and stop for a human before anything
consequential. Whatever they do goes back into the brain.

> Interns are the write path to the brain. The graph is the read path.

## How work actually happens

1. You assign a task, by voice or text — *"onboard Sarah Chen as a product designer starting Monday."*
2. An intern reads the brain and works out what the sentence left out: who she reports to,
   which laptop, which Slack channels, which email convention. It never invents. Missing
   context becomes a question, not a guess.
3. It executes the steps in the real systems, using **your** connected accounts, so it can
   only ever touch what you could touch.
4. Anything consequential — sends, pays, grants access, externally visible — **stops and
   hands over to a person.** You see the draft, why it wrote it, and which facts it used.
   You edit it or send it back.
5. Everything that happened — including what you changed before approving — goes into
   the brain.

## Why it gets better

Step 5 is the whole business.

When someone corrects a draft, that correction becomes a fact. The next task retrieves it.
Nobody wrote a rule; the company just got encoded a little more.

And because the brain is shared, **hire one intern and every intern after that starts
smarter.** A new intern is useful on day one because it inherits the company context
instead of needing its own onboarding.

## What it is not

- **Not a chatbot.** No message thread as the main surface. You assign work and review it.
- **Not Zapier.** Those need the workflow specified up front, correctly, in advance — which
  is exactly the thing nobody has done. Interns figure it out from context.
- **Not a personal assistant.** If the brain were per-person, it'd just be Obsidian. The
  claim is that it's *one* brain the whole company contributes to.

## The interface

The main screen is a live graph — the brain, with interns working in it. Facts fade in as
they're ingested; handovers travel along edges as they fire. At rest it's dark and calm, so
"is anything happening" is answerable at a glance.

Mockup: https://claude.ai/code/artifact/fcb48b5a-f684-456e-a91c-56c60e1bdb9e

## Trust, and how interns graduate

Every intern shows how often you accept its work unedited. It stays supervised on a kind of
task until it's proven, then graduates to doing it unsupervised. Same as a real new hire.
The approval gate isn't friction — it's the training loop.

## Stack

- **Convex** — database, realtime subscriptions, scheduling. The graph updates live with no
  polling because Convex pushes changes to every connected client.
- **Next.js** on Vercel — the UI.
- **OAuth per connector**, server-side, so ingestion keeps running when everyone's laptop
  is shut.

## Where VoiceOS fits

A channel, not a dependency. VoiceOS is a Mac voice assistant that can call our hosted
interns and show results in the notch. Useful for voice intake; it holds one API key and
nothing else.

It cannot host the brain: its integrations are sandboxed from each other, it has no OAuth
store to borrow, tool calls must finish in under ~30s, and installs are per-Mac with no
sync. Connectors and the brain live on our side.

## First thing we build

The Convex schema and the live graph canvas, fed by real subscriptions with seeded facts.
That proves the hardest question — whether a live graph actually feels good — before any
intern exists. Interns and the approval gate come second, real connectors third.

## Still undecided

1. **Entity resolution.** Sarah in Slack, `sarah@northwind.co` in Workspace, employee #1182
   in Rippling are one person. Get this wrong and the graph silently fragments. This is the
   problem that decides whether any of it works.
2. **Graph legibility at scale.** 400 facts is a nice picture. 40,000 is a grey blob.
3. **Making shared-ness visible.** On one connected account this looks identical to a
   personal tool. The demo needs two people.

---

*Current shared understanding as of 9 Aug 2026. Argue with any of it.*
