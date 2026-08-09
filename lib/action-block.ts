/**
 * The ```action block an intern ends its report with, parsed.
 *
 * Kept apart from the outbox it feeds so it can be exercised on its own — this
 * is the seam where a run that did everything right still produces nothing, and
 * it has already done that once.
 *
 * The brief shows one example and that example is an email, so a model writing
 * a Slack post reaches for the field Slack actually has (`channel`) and leaves
 * out the one it doesn't (`subject`). Both spellings are accepted rather than
 * demanded, because the alternative is throwing away a correct draft over a
 * synonym.
 */

import type { ActionKind, Draft } from "./types";

export type ParsedAction = {
  kind: ActionKind;
  draft: Draft;
  rationale: string;
  sources: string[];
  /** One line, written to be spoken. */
  title: string;
};

/** First line of the body, for a Slack post that has no subject of its own. */
const headline = (body: string) =>
  body.split("\n").find((l) => l.trim())?.trim().replace(/^[*_#\s]+/, "").slice(0, 80) ??
  "";

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim())
    : typeof v === "string" && v.trim()
      ? [v.trim()]
      : [];

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Pull the action out of a final report.
 *
 * Returns `null` when there is no block at all — the normal case for a run that
 * had nothing to send. Returns `{ error }` when there *is* a block that cannot
 * be used, which the caller must surface: an intern that drafted something and
 * had it quietly dropped looks identical to one that decided not to draft.
 */
export function parseActionBlock(
  report: string,
): ParsedAction | { error: string } | null {
  const match = report.match(/```action\s*([\s\S]*?)```/);
  if (!match) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
  } catch {
    return { error: "action block was not valid JSON" };
  }

  const kind: ActionKind =
    raw.kind === "slack" || raw.kind === "calendar" ? raw.kind : "email";

  // `to` for email, `channel`/`channels` for Slack — same field, three names.
  const to = [...list(raw.to), ...list(raw.channel), ...list(raw.channels)];
  const body = text(raw.body);
  const subject = text(raw.subject);

  const missing = [!to.length && "a recipient", !body && "a body"].filter(Boolean);
  if (missing.length) return { error: `action block had no ${missing.join(" and no ")}` };

  return {
    kind,
    draft: {
      to,
      cc: list(raw.cc).length ? list(raw.cc) : undefined,
      // A Slack post has no subject line; forcing one would print a bold
      // heading above every message. An email without one gets the first line.
      subject: subject || (kind === "slack" ? "" : headline(body)),
      body,
      startsAt: text(raw.startsAt) || undefined,
      endsAt: text(raw.endsAt) || undefined,
    },
    rationale: text(raw.rationale) || "proposed by the intern from its findings",
    sources: list(raw.sources),
    title: `${kind} to ${to.join(", ")} — ${subject || headline(body)}`,
  };
}
