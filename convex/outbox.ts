import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Interns propose. A human decides. Something else sends.
 *
 * There is no `send` here by design — approving returns the draft so the
 * caller (VoiceOS, with its own credentials) can send it, then reports back
 * through `recordResult`.
 */

const STATUSES = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("sent"),
  v.literal("rejected"),
  v.literal("failed"),
);

export const list = query({
  args: {
    status: v.optional(STATUSES),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 50, 200);
    if (args.status) {
      return await ctx.db
        .query("actions")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("actions").order("desc").take(limit);
  },
});

export const get = query({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actions")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
  },
});

export const propose = mutation({
  args: {
    handle: v.string(),
    internHandle: v.union(v.string(), v.null()),
    kind: v.union(v.literal("email"), v.literal("slack"), v.literal("calendar")),
    title: v.string(),
    draft: v.object({
      to: v.array(v.string()),
      cc: v.optional(v.array(v.string())),
      subject: v.string(),
      body: v.string(),
    }),
    rationale: v.string(),
    sources: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("actions")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("actions", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/**
 * Approve and hand the draft back for sending.
 *
 * `confirmed` is not ceremony. The assistant may only set it after reading
 * the draft to the user and hearing an explicit yes — a draft is assembled
 * from web pages, Slack messages and documents the intern read, all untrusted
 * text, and this is the one place a human stands between that text and the
 * outside world.
 */
export const approve = mutation({
  args: {
    handle: v.string(),
    confirmed: v.boolean(),
    via: v.union(v.literal("voice"), v.literal("cockpit")),
  },
  handler: async (ctx, args) => {
    if (!args.confirmed) {
      return {
        error:
          "not approved: confirmed must be true, and only after reading the draft to the user and hearing an explicit yes",
      };
    }

    const action = await ctx.db
      .query("actions")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (!action) return { error: `no action ${args.handle}` };
    if (action.status !== "pending") {
      return { error: `${args.handle} is already ${action.status}` };
    }

    await ctx.db.patch("actions", action._id, {
      status: "approved",
      decidedAt: Date.now(),
      decidedVia: args.via,
    });

    // Hand the draft back so the caller can send it with its own credentials.
    return { handle: action.handle, kind: action.kind, draft: action.draft };
  },
});

export const reject = mutation({
  args: {
    handle: v.string(),
    via: v.union(v.literal("voice"), v.literal("cockpit")),
    /** What should have happened instead. This is the training signal. */
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db
      .query("actions")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (!action) return { error: `no action ${args.handle}` };

    await ctx.db.patch("actions", action._id, {
      status: "rejected",
      decidedAt: Date.now(),
      decidedVia: args.via,
      result: args.note,
    });
    return { ok: true };
  },
});

/** What actually happened once someone tried to send it. */
export const recordResult = mutation({
  args: {
    handle: v.string(),
    ok: v.boolean(),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db
      .query("actions")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (!action) return { error: `no action ${args.handle}` };

    await ctx.db.patch("actions", action._id, {
      status: args.ok ? "sent" : "failed",
      settledAt: Date.now(),
      result: args.detail,
    });
    return { ok: true };
  },
});
