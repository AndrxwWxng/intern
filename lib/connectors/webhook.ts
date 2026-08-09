/**
 * Webhook connector — the escape hatch.
 *
 * POSTs the approved action wherever you point it, so anything Intern doesn't
 * speak natively (your own mailer, a queue, VoiceOS itself) can still be the
 * executor. Lowest priority: a native connector wins when both are configured.
 */

import { DRY_RUN, dry, has, type Connector, type SendResult } from "./types";
import { outgoing, type ActionKind } from "../types";

const url = () => process.env.OUTBOX_WEBHOOK_URL ?? "";

export function webhookFor(kind: ActionKind): Connector {
  return {
    id: "webhook",
    kind,
    label: `webhook · ${url().replace(/^https?:\/\//, "").slice(0, 40)}`,
    requires: ["OUTBOX_WEBHOOK_URL"],
    configured: () => has("OUTBOX_WEBHOOK_URL"),

    async send(action): Promise<SendResult> {
      if (DRY_RUN) return dry(`POSTed ${action.id} to the webhook`);

      const secret = process.env.OUTBOX_WEBHOOK_SECRET;
      const res = await fetch(url(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          id: action.id,
          kind: action.kind,
          draft: outgoing(action),
          rationale: action.rationale,
          sources: action.sources,
          intern: action.internId,
        }),
        cache: "no-store",
      });

      const text = (await res.text().catch(() => "")).slice(0, 200);
      return res.ok
        ? { ok: true, detail: `webhook ${res.status}${text ? ` · ${text}` : ""}` }
        : { ok: false, detail: `webhook ${res.status}: ${text || "failed"}` };
    },
  };
}
