/**
 * Gmail connector — sends an approved draft as the authorised user.
 *
 * Raw REST over fetch rather than googleapis: one dependency-free call, and
 * the message we build is the message that goes out with nothing in between.
 */

import { googleAccessToken, googleConfigured, invalidateGoogleToken } from "./google";
import { DRY_RUN, dry, encodeHeader, type Connector, type SendResult } from "./types";
import { outgoing, type ProposedAction } from "../types";

const ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function buildRfc822(action: ProposedAction): string {
  const { to, cc, subject, body } = outgoing(action);
  const from = process.env.GOOGLE_SENDER;

  const headers = [
    from ? `From: ${from}` : null,
    `To: ${to.join(", ")}`,
    cc?.length ? `Cc: ${cc.join(", ")}` : null,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  return `${headers.join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`;
}

async function post(raw: string, retry = true): Promise<Response> {
  const token = await googleAccessToken();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: Buffer.from(raw, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    }),
    cache: "no-store",
  });

  // A stale cached token is the one failure worth one silent retry.
  if (res.status === 401 && retry) {
    invalidateGoogleToken();
    return post(raw, false);
  }
  return res;
}

export const gmail: Connector = {
  id: "gmail",
  kind: "email",
  label: process.env.GOOGLE_SENDER
    ? `gmail · ${process.env.GOOGLE_SENDER}`
    : "gmail · authorised account",
  requires: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  configured: googleConfigured,

  async send(action): Promise<SendResult> {
    const { to, subject } = outgoing(action);
    if (!to.length) return { ok: false, detail: "no recipients" };
    if (DRY_RUN) return dry(`emailed "${subject}" to ${to.join(", ")}`);

    const res = await post(buildRfc822(action));
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      threadId?: string;
      error?: { message?: string };
    };

    if (!res.ok || !data.id) {
      return {
        ok: false,
        detail: `gmail ${res.status}: ${data.error?.message ?? "send failed"}`,
      };
    }
    return { ok: true, detail: `gmail message ${data.id} (thread ${data.threadId})` };
  },
};
