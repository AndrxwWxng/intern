/**
 * Slack connector — posts an approved draft to one or more channels.
 *
 * Scout's own Slack provider is read-only on purpose; writing lives here,
 * behind the approval gate, so there is exactly one path to a sent message.
 *
 * Needs a bot token with `chat:write` (and `chat:write.public` to post to a
 * channel it hasn't been invited to).
 */

import { DRY_RUN, dry, has, type Connector, type SendResult } from "./types";
import { outgoing } from "../types";

const ENDPOINT = "https://slack.com/api/chat.postMessage";

export const slack: Connector = {
  id: "slack",
  kind: "slack",
  label: "slack · chat.postMessage",
  requires: ["SLACK_BOT_TOKEN"],
  configured: () => has("SLACK_BOT_TOKEN"),

  async send(action): Promise<SendResult> {
    const { to, subject, body } = outgoing(action);
    if (!to.length) return { ok: false, detail: "no channel" };

    const text = subject ? `*${subject}*\n${body}` : body;
    if (DRY_RUN) return dry(`posted to ${to.join(", ")}`);

    const sent: string[] = [];
    for (const channel of to) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        ts?: string;
        error?: string;
      };
      if (!data.ok) {
        return {
          ok: false,
          detail: `slack ${channel}: ${data.error ?? res.status}${
            sent.length ? ` (already posted to ${sent.join(", ")})` : ""
          }`,
        };
      }
      sent.push(`${channel}@${data.ts}`);
    }
    return { ok: true, detail: `slack ${sent.join(", ")}` };
  },
};
