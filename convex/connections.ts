/**
 * Per-user account connections.
 *
 * Every function here derives the user from `ctx.auth`, never from an
 * argument — a userId parameter on a public function is an impersonation
 * hole, and this table holds live grants to people's mail.
 *
 * The handshake is deliberately split:
 *   `start`    authenticated, binds the user to a one-time state
 *   `complete` unauthenticated (internal), trusts only that state row
 *
 * That split is what lets the OAuth callback be a plain HTTP action with no
 * session of its own — the provider redirects a browser we can't authenticate,
 * so identity has to have been decided before it left.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { PROVIDERS, type ProviderId } from "./providers";

const providerValidator = v.union(v.literal("google"), v.literal("slack"));

/** How long a half-finished handshake stays valid. */
const STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * What the signed-in person has connected. Never returns token material —
 * the UI needs to know *that* Google is connected, not the grant itself.
 */
export const mine = query({
  args: {},
  returns: v.array(
    v.object({
      provider: providerValidator,
      label: v.string(),
      accountLabel: v.optional(v.string()),
      scopes: v.array(v.string()),
      connectedAt: v.number(),
      broken: v.boolean(),
      brokenReason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const rows = await ctx.db
      .query("connections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(20);

    return rows.map((row) => ({
      provider: row.provider,
      label: PROVIDERS[row.provider as ProviderId].label,
      accountLabel: row.accountLabel,
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      broken: row.brokenAt !== undefined,
      brokenReason: row.brokenReason,
    }));
  },
});

/** Everything connectable, and whether this person has it. Drives the UI. */
export const available = query({
  args: {},
  returns: v.array(
    v.object({
      provider: providerValidator,
      label: v.string(),
      connected: v.boolean(),
      accountLabel: v.optional(v.string()),
      broken: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const rows = userId
      ? await ctx.db
          .query("connections")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .take(20)
      : [];
    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
      const row = byProvider.get(id);
      return {
        provider: id,
        label: PROVIDERS[id].label,
        connected: Boolean(row),
        accountLabel: row?.accountLabel,
        broken: row?.brokenAt !== undefined,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * Begin connecting. Returns nothing but a state token — the caller hands it to
 * the HTTP route that builds the consent URL, so client secrets never leave
 * the backend.
 */
export const start = mutation({
  args: { provider: providerValidator, redirectTo: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in before connecting an account");

    const state = crypto.randomUUID().replace(/-/g, "");
    await ctx.db.insert("oauthStates", {
      state,
      userId,
      provider: args.provider,
      redirectTo: args.redirectTo,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return state;
  },
});

/** Look up a pending handshake. Internal: the state string is the capability. */
export const takeState = internalMutation({
  args: { state: v.string() },
  returns: v.union(
    v.object({
      userId: v.id("users"),
      provider: providerValidator,
      redirectTo: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (!row) return null;

    // Single use, expired or not — a replayed state should never work twice.
    await ctx.db.delete("oauthStates", row._id);
    if (row.expiresAt < Date.now()) return null;

    return {
      userId: row.userId,
      provider: row.provider,
      redirectTo: row.redirectTo,
    };
  },
});

/** Store the grant. Replaces any existing connection for that provider. */
export const complete = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    refreshToken: v.string(),
    providerUserId: v.optional(v.string()),
    botToken: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    scopes: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();

    const row = {
      userId: args.userId,
      provider: args.provider,
      refreshToken: args.refreshToken,
      providerUserId: args.providerUserId,
      botToken: args.botToken,
      accountLabel: args.accountLabel,
      scopes: args.scopes,
      connectedAt: Date.now(),
      // Reconnecting is how you fix a broken grant, so clear the flag.
      brokenAt: undefined,
      brokenReason: undefined,
    };

    if (existing) await ctx.db.replace("connections", existing._id, row);
    else await ctx.db.insert("connections", row);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Use
// ---------------------------------------------------------------------------

/**
 * The stored grant for one user and provider. Internal only — this returns
 * token material, so it must never be reachable from a browser.
 */
export const credential = internalQuery({
  args: { userId: v.id("users"), provider: providerValidator },
  returns: v.union(
    v.object({ refreshToken: v.string(), scopes: v.array(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (!row || row.brokenAt !== undefined) return null;
    return { refreshToken: row.refreshToken, scopes: row.scopes };
  },
});

/**
 * Everything needed to DM one person on Slack: the bot token that can open the
 * conversation, and their own `U…` to open it with. Internal — token material.
 */
export const slackDelivery = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.object({ botToken: v.string(), providerUserId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", "slack"),
      )
      .unique();
    if (!row || row.brokenAt !== undefined) return null;
    // A connection made before bot scopes existed has neither field. That is a
    // reconnect, not an error — the caller degrades to "no Slack" and says so.
    if (!row.botToken || !row.providerUserId) return null;
    return { botToken: row.botToken, providerUserId: row.providerUserId };
  },
});

/**
 * Which of our accounts a Slack user id belongs to.
 *
 * This is how an inbound DM becomes an authenticated actor: the event carries
 * a `U…`, and only the person who completed the OAuth handshake could have put
 * that value in this table.
 */
export const bySlackUser = internalQuery({
  args: { providerUserId: v.string() },
  returns: v.union(
    v.object({ userId: v.id("users"), botToken: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("by_provider_and_providerUserId", (q) =>
        q.eq("provider", "slack").eq("providerUserId", args.providerUserId),
      )
      .unique();
    if (!row) return null;
    return { userId: row.userId, botToken: row.botToken ?? null };
  },
});

/**
 * Mark a grant dead. Called when a refresh comes back `invalid_grant`, which
 * means revoked, password-changed, or expired out of a Testing-mode consent
 * screen. Better a visible "reconnect Google" than a send that fails nightly.
 */
export const markBroken = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .unique();
    if (row) {
      await ctx.db.patch("connections", row._id, {
        brokenAt: Date.now(),
        brokenReason: args.reason.slice(0, 300),
      });
    }
    return null;
  },
});

/** Hand the account back. The grant at the provider stays until revoked there. */
export const disconnect = mutation({
  args: { provider: providerValidator },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");

    const row = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_provider", (q) =>
        q.eq("userId", userId).eq("provider", args.provider),
      )
      .unique();
    if (!row) return false;

    await ctx.db.delete("connections", row._id);
    return true;
  },
});
