/**
 * Trust and graduation.
 *
 * Trust on a kind of work is its accepted-unedited rate: of every handover a
 * person actually decided on, how often did they take it as written? Not "did
 * it succeed" — a person editing a draft before sending it is the intern
 * getting it wrong, even though the email went out.
 *
 * The unit is the **kind of action**, not the kind of intern. Interns used to
 * carry a job title and trust was tracked against that, which produced numbers
 * nobody could act on. What a person decides on is an outgoing email, Slack
 * post or invite, so that is what earns trust — and it is exactly what
 * graduation switches off, so the record and the permission are about the same
 * thing.
 *
 * Crossing the threshold *proposes* graduation. A person confirms it. That is
 * deliberate and not a formality: graduation is the moment work stops being
 * reviewed, and nothing should arrive at that moment automatically.
 *
 * It is revocable. One rejection of graduated work drops the kind straight back
 * to supervised — earning trust should be slow and losing it should be fast,
 * because the cost is asymmetric.
 */

import { decide as recordDecision, decisions, note } from "./brain";
import { ACTION_KINDS } from "./types";
import type { ActionKind, TrustRecord } from "./types";

/** Enough decided handovers that the rate means something. */
const MIN_DECISIONS = 4;
/** Accepted-unedited rate at which graduation is offered. */
const THRESHOLD = 0.8;

type Ledger = {
  graduated: Set<ActionKind>;
  /** Kinds that crossed the threshold and are waiting on a person. */
  proposed: Set<ActionKind>;
};

declare global {
  var __internTrust: Ledger | undefined;
}

const ledger: Ledger = (globalThis.__internTrust ??= {
  graduated: new Set(),
  proposed: new Set(),
});

function tally(kind: ActionKind) {
  let unedited = 0;
  let edited = 0;
  let rejected = 0;
  for (const d of decisions()) {
    if (d.kind !== kind) continue;
    if (d.outcome === "unedited") unedited++;
    else if (d.outcome === "edited") edited++;
    else rejected++;
  }
  const total = unedited + edited + rejected;
  return { unedited, edited, rejected, total };
}

export function get(kind: ActionKind): TrustRecord {
  const { unedited, edited, rejected, total } = tally(kind);
  return {
    kind,
    decisions: total,
    unedited,
    edited,
    rejected,
    rate: total ? unedited / total : 0,
    graduated: ledger.graduated.has(kind),
    proposed: ledger.proposed.has(kind),
  };
}

export const all = (): TrustRecord[] => ACTION_KINDS.map(get);

export const isGraduated = (kind: ActionKind) => ledger.graduated.has(kind);

/**
 * Record what a person did with a handover, and return whether that decision
 * just moved this kind of work across a line worth telling them about.
 */
export function record(
  kind: ActionKind,
  actionId: string,
  outcome: "unedited" | "edited" | "rejected",
): { trust: TrustRecord; proposed: boolean; revoked: boolean } {
  recordDecision({ actionId, kind, outcome, at: Date.now() });

  let revoked = false;
  if (outcome === "rejected" && ledger.graduated.delete(kind)) {
    revoked = true;
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: kind,
      detail: "graduation revoked — work rejected while unsupervised",
    });
  }

  const trust = get(kind);
  const eligible =
    !trust.graduated &&
    !trust.proposed &&
    trust.decisions >= MIN_DECISIONS &&
    trust.rate >= THRESHOLD;

  if (eligible) {
    ledger.proposed.add(kind);
    note({
      kind: "graduation",
      actor: "system",
      internId: null,
      sourceId: null,
      ref: kind,
      detail: `proposed for graduation · ${Math.round(trust.rate * 100)}% unedited over ${trust.decisions}`,
    });
  }

  return { trust: get(kind), proposed: eligible, revoked };
}

/**
 * Confirm or decline a proposed graduation. Only ever called by a person —
 * there is no path from `record` to here.
 */
export function graduate(kind: ActionKind, confirmed: boolean): TrustRecord {
  ledger.proposed.delete(kind);
  if (confirmed) {
    ledger.graduated.add(kind);
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: kind,
      detail: "graduated — goes out without review",
    });
  } else {
    ledger.graduated.delete(kind);
    note({
      kind: "graduation",
      actor: "you",
      internId: null,
      sourceId: null,
      ref: kind,
      detail: "graduation declined — stays supervised",
    });
  }
  return get(kind);
}

export const THRESHOLDS = { MIN_DECISIONS, THRESHOLD };
