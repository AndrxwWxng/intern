import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Interns propose. A human decides. Someone else sends.
 *
 * There is no `send` here by design — approving returns what was approved, so
 * the caller does the sending (Intern's own connector, or VoiceOS with its
 * credentials when none is configured) and reports back via `recordResult`.
 */

const DRAFT = v.object({
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  subject: v.string(),
  body: v.string(),
});

const VIA = v.union(v.literal("voice"), v.literal("cockpit"), v.literal("graduated"));

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
    draft: DRAFT,
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
    via: VIA,
    /** Present when the person rewrote the draft before approving it. */
    accepted: v.optional(DRAFT),
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

    // The edit is the training signal, so record which fields moved rather
    // than just the final text.
    const editedFields = args.accepted
      ? (["to", "cc", "subject", "body"] as const).filter(
          (f) => JSON.stringify(args.accepted![f]) !== JSON.stringify(action.draft[f]),
        )
      : [];

    await ctx.db.patch("actions", action._id, {
      status: "approved",
      decidedAt: Date.now(),
      decidedVia: args.via,
      ...(args.accepted ? { accepted: args.accepted, editedFields: [...editedFields] } : {}),
    });

    // Hand back what was approved, not what was proposed.
    return {
      handle: action.handle,
      kind: action.kind,
      draft: args.accepted ?? action.draft,
      edited: editedFields.length > 0,
    };
  },
});

export const reject = mutation({
  args: {
    handle: v.string(),
    via: VIA,
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
