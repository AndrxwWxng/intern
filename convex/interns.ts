import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { type QueryCtx, mutation, query } from "./_generated/server";

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

/**
 * An intern belongs to whoever dispatched it, and to nobody else.
 *
 * Every read below is scoped through `by_userId`, never `by_status` alone —
 * an index that doesn't start at the owner is a query that can return someone
 * else's work, and the only reliable way not to leak is not to have the row in
 * hand in the first place. Signed out reads nothing rather than reading all.
 */
export const list = query({
  args: { status: v.optional(STATUS), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const limit = Math.min(args.limit ?? 50, 200);
    if (args.status) {
      return await ctx.db
        .query("interns")
        .withIndex("by_userId_and_status", (q) =>
          q.eq("userId", userId).eq("status", args.status!),
        )
        .order("desc")
        .take(limit);
    }
    return await ctx.db
      .query("interns")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});

export const get = query({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const intern = await ctx.db
      .query("interns")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    // Same answer for "no such intern" and "not yours" — telling them apart
    // turns this into an oracle for which handles exist.
    return intern?.userId === userId ? intern : null;
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
    // An ownerless intern would be one nobody can see and nobody can stop, so
    // it is refused at the door rather than created and then hidden.
    if (!userId) throw new Error("sign in to dispatch an intern");

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
      userId,
    });
  },
});

/** The caller's own intern by handle, or null — used by every guard below. */
async function ownIntern(ctx: QueryCtx, handle: string) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const intern = await ctx.db
    .query("interns")
    .withIndex("by_handle", (q) => q.eq("handle", handle))
    .unique();
  return intern?.userId === userId ? intern : null;
}

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
    const intern = await ownIntern(ctx, handle);
    if (!intern) return { error: `no intern ${handle}` };

    await ctx.db.patch("interns", intern._id, patch);
    return { ok: true };
  },
});

export const cancel = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const intern = await ownIntern(ctx, args.handle);
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
    // A log line carries whatever the intern read, so it is exactly as private
    // as the intern. Ownership lives on the intern rather than being copied
    // onto every line — one owner per intern, not one per thousand log rows.
    if (args.internHandle !== null && !(await ownIntern(ctx, args.internHandle))) {
      return { error: `no intern ${args.internHandle}` };
    }
    return await ctx.db.insert("logs", { ...args, ts: Date.now() });
  },
});

export const recentLogs = query({
  args: { internHandle: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const limit = Math.min(args.limit ?? 200, 500);
    if (args.internHandle) {
      if (!(await ownIntern(ctx, args.internHandle))) return [];
      return await ctx.db
        .query("logs")
        .withIndex("by_internHandle", (q) => q.eq("internHandle", args.internHandle!))
        .order("desc")
        .take(limit);
    }

    // No handle given: the caller's own interns, newest first, then their
    // lines. Bounded by how many interns one person has, not by table size.
    const mine = await ctx.db
      .query("interns")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);

    const lines = (
      await Promise.all(
        mine.map((intern) =>
          ctx.db
            .query("logs")
            .withIndex("by_internHandle", (q) => q.eq("internHandle", intern.handle))
            .order("desc")
            .take(limit),
        ),
      )
    ).flat();

    return lines.sort((a, b) => b.ts - a.ts).slice(0, limit);
  },
});
