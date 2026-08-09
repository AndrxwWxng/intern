/**
 * Trust and graduation.
 *
 * An intern's trust on a kind of work is its accepted-unedited rate: of every
 * handover a person actually decided on, how often did they take it as written?
 * Not "did it succeed" — a person editing a draft before sending it is the
 * intern getting it wrong, even though the email went out.
 *
 * Crossing the threshold *proposes* graduation. A person confirms it. That is
 * deliberate and not a formality: graduation is the moment work stops being
 * reviewed, and nothing should arrive at that moment automatically.
 *
 * It is revocable. One rejection of graduated work drops the role straight back
 * to supervised — earning trust should be slow and losing it should be fast,
 * because the cost is asymmetric.
 */

import { decide as recordDecision, decisions, note } from "./brain";
import { ROLES } from "./roster";
import type { RoleId, TrustRecord } from "./types";

/** Enough decided handovers that the rate means something. */
const MIN_DECISIONS = 4;
/** Accepted-unedited rate at which graduation is offered. */
const THRESHOLD = 0.8;

type Ledger = {
  graduated: Set<RoleId>;
  /** Roles that crossed the threshold and are waiting on a person. */
  proposed: Set<RoleId>;
};

declare global {
  var __internTrust: Ledger | undefined;
}

const ledger: Ledger = (globalThis.__internTrust ??= {
  graduated: new Set(),
  proposed: new Set(),
});

function tally(role: RoleId) {
  let unedited = 0;
  let edited = 0;
  let rejected = 0;
  for (const d of decisions()) {
    if (d.role !== role) continue;
    if (d.outcome === "unedited") unedited++;
    else if (d.outcome === "edited") edited++;
    else rejected++;
  }
  const total = unedited + edited + rejected;
  return { unedited, edited, rejected, total };
}

export function get(role: RoleId): TrustRecord {
  const { unedited, edited, rejected, total } = tally(role);
  return {
    role,
    decisions: total,
    unedited,
    edited,
    rejected,
    rate: total ? unedited / total : 0,
    graduated: ledger.graduated.has(role),
    proposed: ledger.proposed.has(role),
  };
}

export const all = (): TrustRecord[] => ROLES.map((r) => get(r.id));

export const isGraduated = (role: RoleId) => ledger.graduated.has(role);

/**
 * Record what a person did with a handover, and return whether that decision
 * just moved the role across a line worth telling them about.
 */
export function record(
  role: RoleId,
  actionId: string,
  outcome: "unedited" | "edited" | "rejected",
): { trust: TrustRecord; proposed: boolean; revoked: boolean } {
  recordDecision({ actionId, role, outcome, at: Date.now() });

  let revoked = false;
  if (outcome === "rejected" && ledger.graduated.delete(role)) {
    revoked = true;
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: role,
      detail: "graduation revoked — work rejected while unsupervised",
    });
  }

  const trust = get(role);
  const eligible =
    !trust.graduated &&
    !trust.proposed &&
    trust.decisions >= MIN_DECISIONS &&
    trust.rate >= THRESHOLD;

  if (eligible) {
    ledger.proposed.add(role);
    note({
      kind: "graduation",
      actor: "system",
      internId: null,
      sourceId: null,
      ref: role,
      detail: `proposed for graduation · ${Math.round(trust.rate * 100)}% unedited over ${trust.decisions}`,
    });
  }

  return { trust: get(role), proposed: eligible, revoked };
}

/**
 * Confirm or decline a proposed graduation. Only ever called by a person —
 * there is no path from `record` to here.
 */
export function graduate(role: RoleId, confirmed: boolean): TrustRecord {
  ledger.proposed.delete(role);
  if (confirmed) {
    ledger.graduated.add(role);
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: role,
      detail: "graduated — works unsupervised on this kind of task",
    });
  } else {
    ledger.graduated.delete(role);
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: role,
      detail: "graduation declined — stays supervised",
    });
  }
  return get(role);
}

export const THRESHOLDS = { MIN_DECISIONS, THRESHOLD };
