/**
 * Gmail connector — sends an approved draft as the person who approved it.
 *
 * This process never holds anyone's mail grant. It hands the action's owner id
 * and the message to Convex over the service-secret route, and learns only
 * whether it went. `convex/gmail.ts` does the sending, next to the only place
 * refresh tokens live.
 *
 * There is no shared-account fallback, and that removal is the point of this
 * file. It used to send with a single `GOOGLE_REFRESH_TOKEN` from the
 * environment whenever one was set — so a draft went out from whichever
 * account happened to have minted that token, the outbox recorded "sent", and
 * the person who approved it saw success with nothing in their own Sent mail.
 * A connector that cannot send as you now declines, and says so.
 */

import { DRY_RUN, dry, type Connector, type SendResult } from "./types";
import { outgoing, type ProposedAction } from "../types";

const SITE_URL = () =>
  process.env.CONVEX_SITE_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.replace(".convex.cloud", ".convex.site");

/**
 * Whether the *bridge* is wired — not whether any particular person has
 * connected. Per-person state is only knowable once we have an action to look
 * at an owner on, so it is decided in `send`, not here.
 */
const bridgeReady = () =>
  Boolean(process.env.INTERN_SERVICE_SECRET && SITE_URL());

type Verdict = { status: "sent" | "not-connected" | "failed"; detail: string };

export const gmail: Connector = {
  id: "gmail",
  kind: "email",
  label: "gmail · as the approver",
  // What an operator has to set for *anyone* to be able to send. The Google
  // client id and secret live on the Convex deployment, not here, because that
  // is the side that performs the OAuth exchange.
  requires: ["INTERN_SERVICE_SECRET", "NEXT_PUBLIC_CONVEX_URL"],
  configured: bridgeReady,

  async send(action: ProposedAction): Promise<SendResult> {
    const { to, cc, subject, body } = outgoing(action);
    if (!to.length) return { ok: false, detail: "no recipients" };
    if (DRY_RUN) return dry(`emailed "${subject}" to ${to.join(", ")}`);

    // No owner means the draft predates per-user ownership, or was made by a
    // machine caller with nobody attached. Either way there is no mailbox this
    // could honestly go out from.
    if (!action.ownerId) {
      return {
        ok: false,
        notConnected: true,
        detail: "no owner on this draft — spawn a new intern so it can send as you",
      };
    }

    const site = SITE_URL();
    const secret = process.env.INTERN_SERVICE_SECRET;
    if (!site || !secret) {
      return { ok: false, detail: "email bridge not configured" };
    }

    try {
      const res = await fetch(`${site}/send/email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: action.ownerId, to, cc, subject, body }),
        cache: "no-store",
      });

      const data = (await res.json().catch(() => ({}))) as Partial<Verdict> & {
        error?: string;
      };
      if (!res.ok) {
        return { ok: false, detail: data.error ?? `HTTP ${res.status}` };
      }

      if (data.status === "sent") {
        return { ok: true, detail: data.detail ?? "sent" };
      }
      if (data.status === "not-connected") {
        return {
          ok: false,
          notConnected: true,
          detail: data.detail ?? "connect your Google account to send as you",
        };
      }
      return { ok: false, detail: data.detail ?? "send failed" };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : "convex unreachable",
      };
    }
  },
};
