/**
 * Turning a stored grant into something you can call an API with.
 *
 * Internal only. This is the one place token material is handled, and it is
 * never reachable from a browser or from the Next.js process — the send path
 * asks Convex for a token at the moment it needs one, so a grant to somebody's
 * mail never sits in another service's memory.
 *
 * Default runtime: `fetch` only, no Node built-ins.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { PROVIDERS } from "./providers";

const providerValidator = v.union(v.literal("google"), v.literal("slack"));

type Token = { token: string; scopes: string[] };
type Credential = { refreshToken: string; scopes: string[] };

/**
 * A token the caller can put in an Authorization header, for this user and
 * this provider. Returns null when there is no connection, or when the grant
 * is dead — the caller turns that into "reconnect your account", not a retry.
 */
export const accessToken = internalAction({
  args: { userId: v.id("users"), provider: providerValidator },
  returns: v.union(
    v.object({ token: v.string(), scopes: v.array(v.string()) }),
    v.null(),
  ),
  // Annotated because this file imports `internal`, which is generated from
  // this file — without them TypeScript gives up and infers `any` (TS7022).
  handler: async (ctx, args): Promise<Token | null> => {
    const credential: Credential | null = await ctx.runQuery(
      internal.connections.credential,
      { userId: args.userId, provider: args.provider },
    );
    if (!credential) return null;

    const config = PROVIDERS[args.provider];

    // Slack user tokens don't expire unless the app turns on rotation, so the
    // stored value is already the bearer token.
    if (!config.refreshable) {
      return { token: credential.refreshToken, scopes: credential.scopes };
    }

    const clientId = process.env[config.clientIdVar];
    const clientSecret = process.env[config.clientSecretVar];
    if (!clientId || !clientSecret) {
      throw new Error(
        `${config.clientIdVar} / ${config.clientSecretVar} not set on this deployment`,
      );
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !data.access_token) {
      const reason = data.error_description ?? data.error ?? `HTTP ${response.status}`;

      // invalid_grant is terminal: revoked, password changed, or expired out
      // of a Testing-mode consent screen. Retrying will never fix it, so mark
      // it and let the UI ask for a reconnect.
      if (data.error === "invalid_grant") {
        await ctx.runMutation(internal.connections.markBroken, {
          userId: args.userId,
          provider: args.provider,
          reason,
        });
        return null;
      }
      throw new Error(`token refresh failed: ${reason}`);
    }

    return { token: data.access_token, scopes: credential.scopes };
  },
});
