/**
 * Google Calendar connector — creates an event and invites the recipients.
 *
 * `draft.startsAt` / `draft.endsAt` are ISO 8601. When the intern didn't
 * specify a window we refuse rather than invent one: a meeting at a guessed
 * time is worse than no meeting.
 */

import { googleAccessToken, googleConfigured, invalidateGoogleToken } from "./google";
import { DRY_RUN, dry, type Connector, type SendResult } from "./types";
import { outgoing } from "../types";

const endpoint = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId,
  )}/events?sendUpdates=all`;

export const calendar: Connector = {
  id: "calendar",
  kind: "calendar",
  label: `calendar · ${process.env.GOOGLE_CALENDAR_ID ?? "primary"}`,
  requires: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  configured: googleConfigured,

  async send(action): Promise<SendResult> {
    const { to, subject, body, startsAt, endsAt } = outgoing(action);
    if (!startsAt || !endsAt) {
      return {
        ok: false,
        detail: "no startsAt/endsAt on the draft — refusing to guess a time",
      };
    }

    const when = `${startsAt} → ${endsAt}`;
    if (DRY_RUN) return dry(`created "${subject}" ${when} for ${to.join(", ")}`);

    const send = async (retry = true): Promise<Response> => {
      const token = await googleAccessToken();
      const res = await fetch(endpoint(process.env.GOOGLE_CALENDAR_ID ?? "primary"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: subject,
          description: body,
          start: { dateTime: startsAt },
          end: { dateTime: endsAt },
          attendees: to.map((email) => ({ email })),
        }),
        cache: "no-store",
      });
      if (res.status === 401 && retry) {
        invalidateGoogleToken();
        return send(false);
      }
      return res;
    };

    const res = await send();
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      htmlLink?: string;
      error?: { message?: string };
    };

    if (!res.ok || !data.id) {
      return {
        ok: false,
        detail: `calendar ${res.status}: ${data.error?.message ?? "insert failed"}`,
      };
    }
    return { ok: true, detail: data.htmlLink ?? `event ${data.id}` };
  },
};
