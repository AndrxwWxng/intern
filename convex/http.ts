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
    // Slack takes both grants in one handshake: the user token that posts as
    // you, and the bot token that is the only thing allowed to receive a reply.
    if (config.botScopes?.length) params.set("scope", config.botScopes.join(" "));

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
      providerUserId: config.providerUserIdFrom?.(token),
      botToken: config.botTokenFrom?.(token),
      accountLabel: config.labelFrom?.(token),
      scopes: config.scopes,
    });

    const back = pending.redirectTo ?? APP_URL();
    return Response.redirect(back, 302);
  }),
});

// ---------------------------------------------------------------------------
// The ask-and-answer loop
// ---------------------------------------------------------------------------

/**
 * Constant-time string compare. A shared secret checked with `===` leaks its
 * prefix to anyone willing to time the responses.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function serviceAuthorised(request: Request): boolean {
  const expected = process.env.INTERN_SERVICE_SECRET;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") return false;
  return secretsMatch(rest.join(" ").trim(), expected);
}

/**
 * The cockpit telling us an intern is stuck.
 *
 * Authenticated with a shared secret, not a user token: the caller is the Next
 * process acting on an intern's behalf, and by the time an intern gets stuck
 * the person who dispatched it is long gone from the request.
 */
http.route({
  path: "/notify/question",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!serviceAuthorised(request)) {
      return Response.json({ error: "unauthorised" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      userId?: unknown;
      questionId?: unknown;
      internId?: unknown;
      role?: unknown;
      question?: unknown;
      context?: unknown;
    } | null;

    if (
      !body ||
      typeof body.userId !== "string" ||
      typeof body.questionId !== "string" ||
      typeof body.question !== "string"
    ) {
      return Response.json({ error: "bad request" }, { status: 400 });
    }

    const result = await ctx.runAction(internal.slack.askOwner, {
      userId: body.userId as Id<"users">,
      questionId: body.questionId,
      internId: typeof body.internId === "string" ? body.internId : null,
      role: typeof body.role === "string" ? body.role : "intern",
      question: body.question.slice(0, 1000),
      context: typeof body.context === "string" ? body.context.slice(0, 1000) : "",
    });

    return Response.json(result);
  }),
});

/**
 * Verify Slack's request signature.
 *
 * The raw body has to be hashed exactly as sent, so this takes the text rather
 * than a parsed object. The timestamp check is what stops a captured request
 * being replayed later — the signature alone stays valid forever.
 */
async function slackSignatureValid(request: Request, raw: string): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;

  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${raw}`),
  );
  const expected =
    "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return secretsMatch(signature, expected);
}

/**
 * Slack Events. This is the half a user token could never do — Slack delivers
 * events to a bot, which is why the handshake asks for both grants.
 *
 * Always acknowledges within the 3s budget and does the work afterwards:
 * Slack retries anything slower, and a retry here would answer a question
 * twice and dispatch two resuming interns.
 */
http.route({
  path: "/slack/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();

    if (!(await slackSignatureValid(request, raw))) {
      return new Response("bad signature", { status: 401 });
    }

    const body = (() => {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    if (!body) return new Response("bad body", { status: 400 });

    // One-time endpoint verification when you paste the URL into Slack.
    if (body.type === "url_verification") {
      return Response.json({ challenge: String(body.challenge ?? "") });
    }

    const event = body.event as Record<string, unknown> | undefined;
    if (body.type === "event_callback" && event?.type === "message") {
      const isDm = event.channel_type === "im";
      // `bot_id` is us: without this the "got it" reply would be read as a new
      // answer and the loop would talk to itself.
      const fromHuman = !event.bot_id && !event.subtype;
      const user = typeof event.user === "string" ? event.user : "";
      const text = typeof event.text === "string" ? event.text : "";

      if (isDm && fromHuman && user && text) {
        await ctx.scheduler.runAfter(0, internal.slack.handleReply, {
          slackUserId: user,
          threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
          text,
        });
      }
    }

    return new Response("ok");
  }),
});

export default http;
