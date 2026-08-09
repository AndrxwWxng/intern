/**
 * OAuth handshake endpoints.
 *
 * Two routes, both unauthenticated by necessity — a provider redirect arrives
 * as a bare browser navigation we cannot attach a session to. Identity comes
 * from the one-time `state` row minted by `connections.start`, which *was*
 * authenticated. The state string is the capability, so it is single-use and
 * deleted on first sight whether or not the exchange then succeeds.
 *
 * Runs in Convex's default runtime: `fetch` is available, Node built-ins are
 * not. Nothing here imports one.
 */

import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { httpAction } from "./_generated/server";
import { PROVIDERS, isProviderId, type ProviderId, type TokenResponse } from "./providers";
import type { Id } from "./_generated/dataModel";

type PendingHandshake = {
  userId: Id<"users">;
  provider: ProviderId;
  redirectTo?: string;
};

const http = httpRouter();

/**
 * Must come before anything else here.
 *
 * `auth.config.ts` names CONVEX_SITE_URL as the token issuer, so Convex
 * resolves `/.well-known/openid-configuration` and `/.well-known/jwks.json`
 * against *this* router to validate a session. Without this line those two
 * paths 404, discovery fails, and every sign-in hangs at "checking session"
 * with a freshly created account already in the database — the failure is on
 * the verify side, so it looks like the form is stuck rather than rejected.
 */
auth.addHttpRoutes(http);

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const CALLBACK = () => `${process.env.CONVEX_SITE_URL}/oauth/callback`;

function page(title: string, detail: string, ok: boolean) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:14px ui-monospace,monospace;background:#08090a;color:#e4e6e9;padding:3rem">` +
      `<h1 style="font-size:15px;font-weight:400;color:${ok ? "#4ec9a5" : "#e05a5a"}">${title}</h1>` +
      `<p style="color:#797f88;max-width:44ch;line-height:1.6">${detail}</p>` +
      `<p><a style="color:#797f88" href="${APP_URL()}">← back to intern</a></p></body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html" } },
  );
}

/**
 * Build the consent URL and bounce the browser to it.
 *
 * This exists as a redirect rather than returning a URL to the client so the
 * client id never has to be shipped to the browser bundle.
 */
http.route({
  path: "/oauth/start",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const providerId = url.searchParams.get("provider") ?? "";
    const state = url.searchParams.get("state") ?? "";

    if (!isProviderId(providerId)) {
      return page("Unknown provider", `No connector for "${providerId}".`, false);
    }
    if (!state) return page("Missing state", "Start the connection from the app.", false);

    const config = PROVIDERS[providerId];
    const clientId = process.env[config.clientIdVar];
    if (!clientId) {
      return page(
        "Not configured",
        `${config.clientIdVar} is not set on the Convex deployment. ` +
          `Run: npx convex env set ${config.clientIdVar} ...`,
        false,
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CALLBACK(),
      response_type: "code",
      state,
      ...(config.authParams ?? {}),
    });
    params.set(config.scopeParam ?? "scope", config.scopes.join(" "));

    return Response.redirect(`${config.authUrl}?${params}`, 302);
  }),
});

http.route({
  path: "/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const denied = url.searchParams.get("error");

    if (denied) return page("Not connected", `The provider said: ${denied}`, false);
    if (!code || !state) return page("Incomplete", "No code or state came back.", false);

    const pending: PendingHandshake | null = await ctx.runMutation(
      internal.connections.takeState,
      { state },
    );
    if (!pending) {
      return page(
        "Expired",
        "That connection link was already used or is more than ten minutes old. Start again from the app.",
        false,
      );
    }

    const config = PROVIDERS[pending.provider];
    const clientId = process.env[config.clientIdVar];
    const clientSecret = process.env[config.clientSecretVar];
    if (!clientId || !clientSecret) {
      return page("Not configured", `${config.clientIdVar} / ${config.clientSecretVar} missing.`, false);
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: CALLBACK(),
        grant_type: "authorization_code",
      }),
    });

    const token = (await response.json().catch(() => ({}))) as TokenResponse;

    // Slack answers 200 with {ok:false} rather than an HTTP error.
    if (!response.ok || token.ok === false) {
      const detail =
        (typeof token.error_description === "string" && token.error_description) ||
        (typeof token.error === "string" && token.error) ||
        `HTTP ${response.status}`;
      return page("Exchange failed", detail, false);
    }

    const durable = config.tokenFrom(token);
    if (!durable) {
      return page(
        "No usable token",
        config.refreshable
          ? "The provider returned an access token but no refresh token. Revoke this app in your account settings and connect again."
          : "The provider did not return a user token.",
        false,
      );
    }

    await ctx.runMutation(internal.connections.complete, {
      userId: pending.userId,
      provider: pending.provider,
      refreshToken: durable,
      accountLabel: config.labelFrom?.(token),
      scopes: config.scopes,
    });

    const back = pending.redirectTo ?? APP_URL();
    return Response.redirect(back, 302);
  }),
});

export default http;
