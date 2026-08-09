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

/** The whole graph, shaped the way `BrainGraph.tsx` already expects. */
export const graph = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 2000, 5000);
    const facts = await ctx.db.query("facts").take(limit);
    const relations = await ctx.db.query("relations").take(limit * 4);

    return {
      // Derived from the data, not the clock. A query that reads Date.now()
      // never re-runs just because time passed, so the value would go stale
      // and it would poison the query cache besides.
      generatedAt: facts.reduce((max, f) => Math.max(max, f.observedAt), 0),
      nodes: facts.map((f) => ({
        id: f.extId,
        label: f.label,
        kind: f.kind,
        weight: f.weight,
        detail: f.detail,
        meta: f.meta,
      })),
      edges: relations.map((r) => ({ source: r.from, target: r.to, rel: r.rel })),
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
