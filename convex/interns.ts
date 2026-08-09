import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Interns are durable now. They used to live in server memory pinned to
 * `globalThis`, which meant a hot reload lost every running intern and every
 * pending draft it had produced.
 */

const STATUS = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const ARTIFACT = v.object({
  kind: v.union(
    v.literal("note"),
    v.literal("wiki"),
    v.literal("contact"),
    v.literal("project"),
    v.literal("followup"),
    v.literal("answer"),
  ),
  label: v.string(),
  ref: v.optional(v.string()),
});

export const list = query({
  args: { status: v.optional(STATUS), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 50, 200);
    if (args.status) {
      return await ctx.db
        .query("interns")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("interns").order("desc").take(limit);
  },
});

export const get = query({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("interns")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
  },
});

export const spawn = mutation({
  args: {
    handle: v.string(),
    task: v.string(),
    mode: v.union(v.literal("live"), v.literal("sim")),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    // Never trust a caller-supplied user id — derive it server-side.
    const userId = await getAuthUserId(ctx);

    return await ctx.db.insert("interns", {
      handle: args.handle,
      task: args.task,
      status: "queued",
      mode: args.mode,
      sessionId: args.sessionId,
      createdAt: Date.now(),
      tools: [],
      toolCalls: 0,
      artifacts: [],
      ...(userId ? { userId } : {}),
    });
  },
});

export const update = mutation({
  args: {
    handle: v.string(),
    status: v.optional(STATUS),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    tools: v.optional(v.array(v.string())),
    toolCalls: v.optional(v.number()),
    artifacts: v.optional(v.array(ARTIFACT)),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { handle, ...patch } = args;
    const intern = await ctx.db
      .query("interns")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!intern) return { error: `no intern ${handle}` };

    await ctx.db.patch("interns", intern._id, patch);
    return { ok: true };
  },
});

export const cancel = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const intern = await ctx.db
      .query("interns")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (!intern) return { error: `no intern ${args.handle}` };
    if (intern.status === "done" || intern.status === "failed") {
      return { error: `${args.handle} already ${intern.status}` };
    }

    await ctx.db.patch("interns", intern._id, {
      status: "cancelled",
      endedAt: Date.now(),
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Log lines — their own table so appending never rewrites the intern
// ---------------------------------------------------------------------------

export const log = mutation({
  args: {
    internHandle: v.union(v.string(), v.null()),
    level: v.union(
      v.literal("sys"),
      v.literal("in"),
      v.literal("out"),
      v.literal("tool"),
      v.literal("ok"),
      v.literal("warn"),
      v.literal("err"),
    ),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("logs", { ...args, ts: Date.now() });
  },
});

export const recentLogs = query({
  args: { internHandle: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    if (args.internHandle) {
      return await ctx.db
        .query("logs")
        .withIndex("by_internHandle", (q) => q.eq("internHandle", args.internHandle!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("logs").order("desc").take(limit);
  },
});
