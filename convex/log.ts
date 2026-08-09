import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * The append-only log, and the replay that rebuilds everything from it.
 *
 * This is the direct replacement for `.data/brain.jsonl`. Same two row types,
 * same uniqueness rule, same replay contract — the only change is that the log
 * now lives where more than one process can reach it. A local file makes the
 * brain personal, which is the one thing the product is trying not to be.
 */

const HINT = v.object({
  kind: v.union(
    v.literal("note"),
    v.literal("decision"),
    v.literal("preference"),
    v.literal("correction"),
    v.literal("answer"),
    v.literal("person"),
    v.literal("project"),
  ),
  tags: v.optional(v.array(v.string())),
  subject: v.optional(v.string()),
  /** Graph nodes a person attached this to by hand. Replayed, so it sticks. */
  links: v.optional(v.array(v.string())),
});

/**
 * Land one observation. Idempotent on `(sourceId, externalId)`, so capture can
 * be called twice — a retrying client, or two people forwarding the same Slack
 * message — and the second call is a no-op rather than a duplicate.
 */
export const appendObservation = mutation({
  args: {
    obsId: v.string(),
    sourceId: v.string(),
    externalId: v.string(),
    actor: v.string(),
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
    observedAt: v.number(),
    ingestedAt: v.number(),
    hint: v.optional(HINT),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("observations")
      .withIndex("by_source_and_external", (q) =>
        q.eq("sourceId", args.sourceId).eq("externalId", args.externalId),
      )
      .unique();
    if (existing) return { obsId: existing.obsId, fresh: false };

    await ctx.db.insert("observations", args);
    return { obsId: args.obsId, fresh: true };
  },
});

export const appendDecision = mutation({
  args: {
    actionId: v.string(),
    role: v.string(),
    outcome: v.union(v.literal("unedited"), v.literal("edited"), v.literal("rejected")),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("decisions")
      .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
      .unique();
    if (existing) return { ok: true, fresh: false };

    await ctx.db.insert("decisions", args);
    return { ok: true, fresh: true };
  },
});

/**
 * Everything needed to rebuild the brain, oldest first.
 *
 * ponytail: one shot, bounded at 8k observations. Past that this needs to
 * paginate — replay is the one read where "just take everything" eventually
 * stops being true. It is a boot-time read, so the cap failing loudly beats
 * a silent truncation.
 */
export const replay = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 8000, 8000);
    const observations = await ctx.db.query("observations").take(limit);
    const decisions = await ctx.db.query("decisions").take(2000);

    return {
      observations: observations
        .sort((a, b) => a.ingestedAt - b.ingestedAt)
        .map((o) => ({
          id: o.obsId,
          sourceId: o.sourceId,
          externalId: o.externalId,
          actor: o.actor,
          title: o.title,
          body: o.body,
          url: o.url,
          observedAt: o.observedAt,
          ingestedAt: o.ingestedAt,
          hint: o.hint,
        })),
      decisions: decisions
        .sort((a, b) => a.at - b.at)
        .map((d) => ({
          actionId: d.actionId,
          role: d.role,
          outcome: d.outcome,
          at: d.at,
        })),
      truncated: observations.length >= limit,
    };
  },
});
