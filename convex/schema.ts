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
  v.literal("fact"),
  v.literal("question"),
);

const draft = v.object({
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  subject: v.string(),
  body: v.string(),
});

/** Trust is tracked per role, so every proposal has to carry one. */
const roleId = v.union(
  v.literal("researcher"),
  v.literal("correspondent"),
  v.literal("archivist"),
  v.literal("onboarder"),
);

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
  // The log — the only thing that is actually the truth
  //
  // Facts and relations above are a projection rebuilt from these rows, which
  // is what "facts are a projection" has to mean if it means anything. This
  // replaces .data/brain.jsonl: same append-only shape, somewhere every
  // instance and every teammate can reach.
  // -------------------------------------------------------------------------

  observations: defineTable({
    obsId: v.string(),
    sourceId: v.string(),
    /** `(sourceId, externalId)` is unique — the constraint that makes retry safe. */
    externalId: v.string(),
    actor: v.string(),
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
    observedAt: v.number(),
    ingestedAt: v.number(),
    /** What extraction made of it, so replay rebuilds the same facts. */
    hint: v.optional(
      v.object({
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
      }),
    ),
  })
    .index("by_obsId", ["obsId"])
    .index("by_source_and_external", ["sourceId", "externalId"]),

  /**
   * A person's decision on a handover. Lives in the log beside observations
   * because the accepted-unedited rate is the one number that must survive a
   * restart — an intern that forgot it had been trusted would have to earn it
   * again on every deploy.
   */
  decisions: defineTable({
    actionId: v.string(),
    role: v.string(),
    outcome: v.union(v.literal("unedited"), v.literal("edited"), v.literal("rejected")),
    at: v.number(),
  }).index("by_actionId", ["actionId"]),

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
    role: roleId,
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
    /** What the intern proposed. Never overwritten. */
    draft,
    /**
     * What the person was actually willing to send, when they changed
     * something. Kept apart from `draft` on purpose — collapsing the two
     * throws away the only record of what the intern got wrong, and that
     * difference is the entire learning loop.
     */
    accepted: v.optional(draft),
    /** Which fields the person rewrote before approving. */
    editedFields: v.optional(v.array(v.string())),
    rationale: v.string(),
    /** Fact extIds and urls the draft was built from. */
    sources: v.array(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    decidedVia: v.optional(
      v.union(v.literal("voice"), v.literal("cockpit"), v.literal("graduated")),
    ),
    decidedBy: v.optional(v.id("users")),
    result: v.optional(v.string()),
  })
    .index("by_handle", ["handle"])
    .index("by_status", ["status"])
    .index("by_internHandle", ["internHandle"]),
});
