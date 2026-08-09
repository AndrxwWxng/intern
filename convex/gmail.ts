/**
 * Sending mail as the person who approved it.
 *
 * This lives in Convex rather than in the Next process on purpose: the grant
 * belongs to one person's mailbox, and `tokens.accessToken` is internal so
 * that material never has to travel anywhere else. The Next side asks over the
 * service-secret route in `http.ts` and gets back only a verdict.
 *
 * There is deliberately no fallback to a shared account. A draft that cannot
 * go out as its approver does not go out — the product's whole claim is that
 * what an intern writes leaves as *you*, and a shared sender quietly breaks
 * that while still reporting success.
 *
 * Default runtime: `fetch` only, no Node built-ins — hence the hand-rolled
 * base64url below rather than `Buffer`.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** The scope a send actually needs. Present in `providers.ts`'s google entry. */
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type SendVerdict =
  | { status: "sent"; detail: string }
  | { status: "not-connected"; detail: string }
  | { status: "failed"; detail: string };

/** RFC 2047 for non-ASCII headers, or Gmail mangles them. */
function encodeHeader(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const sendAs = internalAction({
  args: {
    userId: v.id("users"),
    to: v.array(v.string()),
    cc: v.optional(v.array(v.string())),
    subject: v.string(),
    body: v.string(),
  },
  returns: v.object({
    status: v.union(v.literal("sent"), v.literal("not-connected"), v.literal("failed")),
    detail: v.string(),
  }),
  handler: async (ctx, args): Promise<SendVerdict> => {
    if (!args.to.length) return { status: "failed", detail: "no recipients" };

    // `accessToken` returns null for "never connected" and for "grant is dead"
    // alike. Both mean the same thing to the person looking at the outbox:
    // reconnect. Neither is a retry.
    let credential: { token: string; scopes: string[] } | null;
    try {
      credential = await ctx.runAction(internal.tokens.accessToken, {
        userId: args.userId,
        provider: "google",
      });
    } catch (err) {
      return {
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (!credential) {
      return {
        status: "not-connected",
        detail: "connect your Google account to send as you",
      };
    }

    // A grant minted before gmail.send was requested will 403 at the API with
    // a message about scopes that reads like a bug. Saying it here names the
    // fix instead: reconnect and approve the mail permission.
    if (credential.scopes.length && !credential.scopes.includes(SEND_SCOPE)) {
      return {
        status: "not-connected",
        detail: "your Google connection cannot send mail — reconnect and allow sending",
      };
    }

    const headers = [
      `To: ${args.to.join(", ")}`,
      args.cc?.length ? `Cc: ${args.cc.join(", ")}` : null,
      `Subject: ${encodeHeader(args.subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ].filter(Boolean);

    // No From header: Gmail stamps the authorised account itself, and letting
    // a caller set one is how a draft ends up claiming to be from someone it
    // isn't.
    const raw = `${headers.join("\r\n")}\r\n\r\n${args.body.replace(/\n/g, "\r\n")}`;

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64url(raw) }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      id?: string;
      threadId?: string;
      error?: { message?: string };
    };

    if (!response.ok || !data.id) {
      return {
        status: "failed",
        detail: `gmail ${response.status}: ${data.error?.message ?? "send failed"}`,
      };
    }

    return { status: "sent", detail: `gmail message ${data.id}` };
  },
});
