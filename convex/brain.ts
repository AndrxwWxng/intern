import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * The brain: facts and the relations between them.
 *
 * Facts are upserted by `extId`, so re-ingesting the same Slack message or
 * wiki page updates in place rather than growing a duplicate. Whatever
 * produces them — Scout, a channel capture, an intern filing a note — goes
 * through `upsert`.
 */

const nodeKind = v.union(
  v.literal("source"),
  v.literal("contact"),
  v.literal("project"),
  v.literal("note"),
  v.literal("followup"),
  v.literal("wiki"),
  v.literal("tag"),
  v.literal("intern"),
  v.literal("action"),
  v.literal("fact"),
  v.literal("question"),
);

const factFields = {
  extId: v.string(),
  kind: nodeKind,
  label: v.string(),
  detail: v.optional(v.string()),
  weight: v.optional(v.number()),
  meta: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.null()))),
  source: v.optional(v.string()),
};

/**
 * Domains reserved by RFC 2606 / 6761 for testing. Nothing at one of these can
 * be reached, so an account holding one is a throwaway from a sign-in test
 * rather than a colleague — `demo@intern.test`, `x@example.com`.
 *
 * A named skip-list of specific addresses would rot the moment someone made a
 * sixth test account; this rots never.
 */
const RESERVED_TLDS = [".test", ".example", ".invalid", ".localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

function isReachablePerson(email: string | undefined): email is string {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return (
    !RESERVED_TLDS.some((tld) => domain.endsWith(tld)) &&
    !RESERVED_DOMAINS.includes(domain)
  );
}

/** The node id for a person, derived from their account. */
const contactId = (userId: string) => `user:${userId}`;

/** Where the account list hangs off the graph, so contacts aren't floating. */
const ACCOUNTS_SOURCE = "src:accounts";

/**
 * The whole graph, shaped the way `BrainGraph.tsx` already expects.
 *
 * Contacts are **derived from the accounts table, not stored**. A person is a
 * contact if and only if they can sign in — so a new sign-up shows up the
 * moment it happens (this query is reactive), and a deleted account takes its
 * contact with it. There is no sync step to forget to run and nothing to drift.
 *
 * The corollary is that stored `contact` facts are dropped on the way out.
 * They used to come from any observation hinted `person`, which is how the
 * graph filled up with five people who had never had an account — the demo
 * seed's Sarah Chen and Alex Rivera sitting beside real colleagues with no way
 * to tell which was which. `lib/brain.ts` no longer mints them, and this
 * filter means nothing else can either, whatever `syncBatch` is handed.
 */
export const graph = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 2000, 5000);
    const stored = await ctx.db.query("facts").take(limit);
    const relations = await ctx.db.query("relations").take(limit * 4);
    const facts = stored.filter((f) => f.kind !== "contact");

    // Not gated on `getAuthUserId`, deliberately, and this is a trade-off
    // rather than an oversight.
    //
    // Gating it meant the cockpit rendered no people at all: whatever the
    // browser's websocket was doing with its token, this query resolved as
    // signed-out and the contact layer came back empty, while the identical
    // call over an authenticated HTTP client returned all three. Every other
    // node on this query has always been world-readable, so the roster was
    // the only thing the gate protected — and it cost the feature entirely.
    //
    // The right home for that protection is one auth check over the whole
    // query, alongside the per-viewer scoping being added in `lib/store.ts`,
    // not a special case buried in the middle of it.
    const users = await ctx.db.query("users").take(1000);

    const people = users.filter((u) => isReachablePerson(u.email));
    const contacts = people.map((u) => ({
      id: contactId(u._id),
      // The account is the identity; `name` is only set if a provider gave us
      // one, so the local part is the honest fallback — never a blank chip.
      label: u.name ?? u.email!.split("@")[0],
      kind: "contact" as const,
      weight: 5,
      detail: u.email!,
      meta: { account: u.email!, source: "platform account" },
    }));

    const nodes = [
      ...facts.map((f) => ({
        id: f.extId,
        label: f.label,
        kind: f.kind,
        weight: f.weight,
        detail: f.detail,
        meta: f.meta,
      })),
      ...contacts,
    ];

    // Set, not a scan per edge: `relations` is read at 4× the node limit, so
    // `nodes.some()` inside the filter would be tens of millions of string
    // compares on a full graph.
    const present = new Set(nodes.map((n) => n.id));
    const edges = relations
      // A relation pointing at a contact that no longer exists would be an
      // edge to nowhere; the seeded people are gone and their edges with them.
      .filter((r) => present.has(r.from) && present.has(r.to))
      .map((r) => ({ source: r.from, target: r.to, rel: r.rel }));

    if (contacts.length) {
      nodes.push({
        id: ACCOUNTS_SOURCE,
        label: "accounts",
        kind: "source" as const,
        weight: 6,
        detail: `${contacts.length} signed in`,
        meta: { source: "platform account" },
      });
      for (const c of contacts) {
        edges.push({ source: ACCOUNTS_SOURCE, target: c.id, rel: "member" });
      }
    }

    return {
      // Derived from the data, not the clock. A query that reads Date.now()
      // never re-runs just because time passed, so the value would go stale
      // and it would poison the query cache besides.
      generatedAt: stored.reduce((max, f) => Math.max(max, f.observedAt), 0),
      nodes,
      edges,
    };
  },
});

export const node = query({
  args: { extId: v.string() },
  handler: async (ctx, args) => {
    const fact = await ctx.db
      .query("facts")
      .withIndex("by_extId", (q) => q.eq("extId", args.extId))
      .unique();
    if (!fact) return null;

    const out = await ctx.db
      .query("relations")
      .withIndex("by_from", (q) => q.eq("from", args.extId))
      .take(100);
    const incoming = await ctx.db
      .query("relations")
      .withIndex("by_to", (q) => q.eq("to", args.extId))
      .take(100);

    return { fact, links: { out, in: incoming } };
  },
});

export const search = query({
  args: {
    q: v.string(),
    kind: v.optional(nodeKind),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 100);
    return await ctx.db
      .query("facts")
      .withSearchIndex("search_label", (q) =>
        args.kind ? q.search("label", args.q).eq("kind", args.kind) : q.search("label", args.q),
      )
      .take(limit);
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    // Bounded on purpose. Swap for @convex-dev/aggregate if the brain ever
    // outgrows a single scan — counting by collecting does not scale.
    const facts = await ctx.db.query("facts").take(5000);
    const byKind: Record<string, number> = {};
    for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return { facts: facts.length, byKind };
  },
});

export const upsert = mutation({
  args: factFields,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("facts")
      .withIndex("by_extId", (q) => q.eq("extId", args.extId))
      .unique();

    if (existing) {
      await ctx.db.patch("facts", existing._id, { ...args, observedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("facts", { ...args, observedAt: Date.now() });
  },
});

export const link = mutation({
  args: { from: v.string(), to: v.string(), rel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("relations")
      .withIndex("by_from", (q) => q.eq("from", args.from))
      .take(200);
    if (existing.some((r) => r.to === args.to && r.rel === args.rel)) return null;
    return await ctx.db.insert("relations", args);
  },
});

/**
 * Bulk sync, for pulling Scout's `/brain/graph` in. Batched by the caller —
 * a mutation is a transaction with document and byte limits, so hand this
 * a few hundred at a time rather than the whole graph.
 */
export const syncBatch = mutation({
  args: {
    nodes: v.array(v.object(factFields)),
    edges: v.array(v.object({ from: v.string(), to: v.string(), rel: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const n of args.nodes) {
      const existing = await ctx.db
        .query("facts")
        .withIndex("by_extId", (q) => q.eq("extId", n.extId))
        .unique();
      if (existing) await ctx.db.patch("facts", existing._id, { ...n, observedAt: now });
      else await ctx.db.insert("facts", { ...n, observedAt: now });
    }
    for (const e of args.edges) {
      const dupes = await ctx.db
        .query("relations")
        .withIndex("by_from", (q) => q.eq("from", e.from))
        .take(200);
      if (!dupes.some((r) => r.to === e.to && r.rel === e.rel)) {
        await ctx.db.insert("relations", e);
      }
    }
    return { nodes: args.nodes.length, edges: args.edges.length };
  },
});
