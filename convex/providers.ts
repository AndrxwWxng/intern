/**
 * What each provider needs to run an OAuth handshake and refresh a token.
 *
 * Adding a surface is a row here plus a connector — nothing in the callback,
 * the store, or the UI has to learn about it.
 *
 * Client credentials live in Convex env vars (`npx convex env set ...`), not
 * in the Next.js process, because both the callback and the refresh run here.
 *
 * No Node built-ins in this file: it is imported by an httpAction that runs in
 * Convex's default runtime, where `Buffer` does not exist. `atob` does.
 */

export type ProviderId = "google" | "slack";

export type TokenResponse = Record<string, unknown>;

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdVar: string;
  clientSecretVar: string;
  /**
   * Whether the stored token is a refresh token traded for short-lived access
   * tokens, or a long-lived token used directly. Slack user tokens don't
   * expire unless the app enables rotation, so there is nothing to refresh.
   */
  refreshable: boolean;
  /** Extra params on the consent URL. */
  authParams?: Record<string, string>;
  /** Slack wants user-level grants under `user_scope`, not `scope`. */
  scopeParam?: "scope" | "user_scope";
  /** Pull the durable token out of the provider's token response. */
  tokenFrom: (token: TokenResponse) => string | undefined;
  /** Pull a human label — which account this actually is. */
  labelFrom?: (token: TokenResponse) => string | undefined;
  /**
   * The provider's own id for this person, when we need to address them there
   * rather than just act as them. Slack's `U…`, so an intern can open a DM.
   */
  providerUserIdFrom?: (token: TokenResponse) => string | undefined;
  /**
   * A workspace-level token, where the provider issues one alongside the user
   * grant. Only Slack does: a bot is the only identity that can *receive* a
   * reply, so the ask-and-answer loop needs one even though every outbound
   * draft still goes as the person.
   */
  botTokenFrom?: (token: TokenResponse) => string | undefined;
  /** Bot-level scopes, requested under `scope` beside the user grant. */
  botScopes?: string[];
};

/** Read `authed_user.<field>` out of Slack's oauth.v2.access response. */
function authedUser(token: TokenResponse, field: string): string | undefined {
  const authed = token.authed_user;
  if (!authed || typeof authed !== "object") return undefined;
  const value = (authed as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/** base64url → string, without Node's Buffer. */
function decodeSegment(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  google: {
    id: "google",
    label: "Google — Gmail + Calendar",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events",
      "openid",
      "email",
    ],
    clientIdVar: "GOOGLE_CLIENT_ID",
    clientSecretVar: "GOOGLE_CLIENT_SECRET",
    refreshable: true,
    // `offline` is what asks for a refresh token at all; `consent` forces a
    // fresh one even when this account has authorised before. Without both, a
    // reconnect silently returns only an access token.
    authParams: { access_type: "offline", prompt: "consent" },
    tokenFrom: (token) =>
      typeof token.refresh_token === "string" ? token.refresh_token : undefined,
    labelFrom: (token) => {
      if (typeof token.id_token !== "string") return undefined;
      try {
        const claims = JSON.parse(decodeSegment(token.id_token.split(".")[1])) as {
          email?: string;
        };
        return claims.email;
      } catch {
        return undefined;
      }
    },
  },

  slack: {
    id: "slack",
    label: "Slack — post as you",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    // Posting *as the person* needs a user token, which Slack grants under
    // user_scope. A bot token would post as the app, which is the thing
    // per-user auth exists to avoid — for outbound drafts.
    scopes: ["chat:write", "users:read"],
    scopeParam: "user_scope",
    // The ask-and-answer loop is the exception, and it is not a preference:
    // Slack only delivers events to a bot, so a user token can send a question
    // but can never hear the answer. `im:write` opens the DM, `im:history`
    // lets the Events API deliver what you type back into it.
    botScopes: ["chat:write", "im:write", "im:history"],
    clientIdVar: "SLACK_CLIENT_ID",
    clientSecretVar: "SLACK_CLIENT_SECRET",
    refreshable: false,
    tokenFrom: (token) => authedUser(token, "access_token"),
    providerUserIdFrom: (token) => authedUser(token, "id"),
    botTokenFrom: (token) =>
      typeof token.access_token === "string" ? token.access_token : undefined,
    labelFrom: (token) => {
      const team = token.team;
      if (team && typeof team === "object" && "name" in team) {
        const name = (team as { name?: unknown }).name;
        return typeof name === "string" ? name : undefined;
      }
      return undefined;
    },
  },
};

export const isProviderId = (value: string): value is ProviderId =>
  value in PROVIDERS;
