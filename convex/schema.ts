import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The company brain, and the work done against it.
 *
 * Shapes mirror `lib/types.ts` so the cockpit and the MCP surface keep
 * speaking the same language. The one deliberate difference: every record
 * that the outside world names by string (`int-01vr`, `act-01jo`) keeps that
 * string in a `handle` field alongside Convex's `_id`, so VoiceOS and the
 * existing tool contracts do not have to learn Convex ids.
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
);

const draft = v.object({
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  subject: v.string(),
  body: v.string(),
});

export default defineSchema({
  ...authTables,

  // -------------------------------------------------------------------------
  // The brain
  // -------------------------------------------------------------------------

  /**
   * One thing the company knows. `extId` is the stable identity across
   * re-syncs — a Scout row id, a wiki path, a Slack permalink — so repeated
   * ingestion updates in place instead of duplicating.
   *
   * No vector index yet: `dimensions` must match the embedder exactly, and
   * the embedder is still an open choice. Add it in the same change that
   * picks one.
   */
  facts: defineTable({
    extId: v.string(),
    kind: nodeKind,
    label: v.string(),
    detail: v.optional(v.string()),
    weight: v.optional(v.number()),
    meta: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.null()))),
    /** Where this came from, for citation at the approval gate. */
    source: v.optional(v.string()),
    observedAt: v.number(),
  })
    .index("by_extId", ["extId"])
    .index("by_kind", ["kind"])
    .searchIndex("search_label", { searchField: "label", filterFields: ["kind"] }),

  relations: defineTable({
    from: v.string(),
    to: v.string(),
    rel: v.optional(v.string()),
  })
    .index("by_from", ["from"])
    .index("by_to", ["to"]),

  // -------------------------------------------------------------------------
  // Interns
  // -------------------------------------------------------------------------

  interns: defineTable({
    handle: v.string(),
    task: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    mode: v.union(v.literal("live"), v.literal("sim")),
    /** Who dispatched it. Null for machine callers with no user attached. */
    userId: v.optional(v.id("users")),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    tools: v.array(v.string()),
    toolCalls: v.number(),
    artifacts: v.array(
      v.object({
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
      }),
    ),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    sessionId: v.string(),
  })
    .index("by_handle", ["handle"])
    .index("by_status", ["status"])
    .index("by_userId", ["userId"]),

  /**
   * Log lines are the high-churn half of an intern — kept in their own table
   * so appending a line never rewrites the intern document.
   */
  logs: defineTable({
    internHandle: v.union(v.string(), v.null()),
    ts: v.number(),
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
  }).index("by_internHandle", ["internHandle"]),

  // -------------------------------------------------------------------------
  // Outbox — interns propose, a human decides, someone else sends
  // -------------------------------------------------------------------------

  /**
   * Survives a restart, which the in-memory version did not. A pending draft
   * outliving a hot reload is the difference between a demo that holds and
   * one that doesn't.
   */
  actions: defineTable({
    handle: v.string(),
    internHandle: v.union(v.string(), v.null()),
    kind: v.union(v.literal("email"), v.literal("slack"), v.literal("calendar")),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    /** One line, written to be spoken aloud. */
    title: v.string(),
    draft,
    rationale: v.string(),
    /** Fact extIds and urls the draft was built from. */
    sources: v.array(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    decidedVia: v.optional(v.union(v.literal("voice"), v.literal("cockpit"))),
    decidedBy: v.optional(v.id("users")),
    result: v.optional(v.string()),
  })
    .index("by_handle", ["handle"])
    .index("by_status", ["status"])
    .index("by_internHandle", ["internHandle"]),
});
