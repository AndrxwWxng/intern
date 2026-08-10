/**
 * Connectors — the things that actually perform an approved action.
 *
 * One per outbound surface. A connector is only ever reached after a human has
 * approved the draft; nothing here decides *whether* to send, only *how*.
 */

import type { ActionKind, ProposedAction } from "../types";

export type SendResult = {
  ok: boolean;
  /** Message id, permalink, event id — whatever identifies what went out. */
  detail: string;
  /** True when DRY_RUN swallowed the call. */
  dryRun?: boolean;
  /**
   * The approver has no working grant for this surface, so nothing was even
   * attempted.
   *
   * Distinct from `ok: false` on purpose. A failure means we tried and the
   * provider said no, which is worth showing as a red line against the draft.
   * This means the draft is still perfectly good and is waiting on a person to
   * link an account — marking that "failed" reads as "this draft is broken"
   * and sends people looking in the wrong place.
   */
  notConnected?: boolean;
};

export type Connector = {
  id: string;
  kind: ActionKind;
  /** Human-readable target, e.g. "gmail · andrew@…". */
  label: string;
  /** Which env vars this connector needs, for the status panel. */
  requires: string[];
  configured: () => boolean;
  send: (action: ProposedAction) => Promise<SendResult>;
};

/** Set OUTBOX_DRY_RUN=1 to exercise the whole path without anything leaving. */
export const DRY_RUN = process.env.OUTBOX_DRY_RUN === "1";

export const has = (...names: string[]) =>
  names.every((n) => Boolean(process.env[n]));

export function dry(what: string): SendResult {
  return { ok: true, detail: `DRY RUN — would have ${what}`, dryRun: true };
}

/** Non-ASCII headers need RFC 2047 encoding or Gmail mangles them. */
export function encodeHeader(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
