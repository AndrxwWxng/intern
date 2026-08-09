"use client";

import type { ActionKind, BrainStats, TrustRecord } from "@/lib/types";

/** What graduating this kind actually switches off, in one line. */
const BLURB: Record<ActionKind, string> = {
  email: "no email approved yet",
  slack: "no Slack post approved yet",
  calendar: "no invite approved yet",
};

/**
 * Trust, per kind of thing that goes out.
 *
 * The bar is the whole point of the panel: it is the only number that says
 * whether the thing is actually learning. Work that keeps getting edited has a
 * short bar however many tasks finish.
 *
 * It reads per surface rather than per intern because that is the honest unit —
 * "8 of 9 Slack posts went out unedited" is a claim about a real capability, and
 * it is exactly what graduation stops reviewing.
 */
export default function Trust({
  trust,
  brain,
  onGraduate,
}: {
  trust: TrustRecord[];
  brain: BrainStats | null;
  onGraduate: (kind: ActionKind, confirmed: boolean) => void;
}) {
  return (
    <>
      {trust.map((t) => (
        <div key={t.kind} className="py-1">
          <div className="flex items-baseline gap-2">
            <span className={t.graduated ? "text-ok" : "text-dim"}>{t.kind}</span>
            {t.graduated ? (
              <span className="text-ok" title="goes out unsupervised">
                ✓
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-faint">
              {t.decisions ? `${t.unedited}/${t.decisions}` : "—"}
            </span>
          </div>

          <div className="mt-1 h-px w-full bg-line">
            <div
              className={`h-px ${t.graduated ? "bg-ok" : "bg-k-fact"}`}
              style={{ width: `${Math.round(t.rate * 100)}%` }}
            />
          </div>

          <p className="mt-0.5 text-faint">
            {t.decisions
              ? `${t.unedited} unedited · ${t.edited} edited · ${t.rejected} rejected`
              : BLURB[t.kind]}
          </p>

          {t.proposed ? (
            <div className="mt-1 flex gap-px">
              <button
                type="button"
                onClick={() => onGraduate(t.kind, true)}
                className="flex-1 border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
                title="these drafts stop being reviewed"
              >
                graduate
              </button>
              <button
                type="button"
                onClick={() => onGraduate(t.kind, false)}
                className="flex-1 border border-line py-0.5 text-faint hover:text-fg"
              >
                not yet
              </button>
            </div>
          ) : null}

          {t.graduated ? (
            <button
              type="button"
              onClick={() => onGraduate(t.kind, false)}
              className="mt-1 w-full border border-line py-0.5 text-faint transition-colors hover:border-warn/40 hover:text-warn"
            >
              put back under review
            </button>
          ) : null}
        </div>
      ))}

      {brain ? (
        <p className="mt-2 border-t border-line pt-2 text-faint leading-relaxed">
          {brain.facts} fact{brain.facts === 1 ? "" : "s"} from{" "}
          {brain.observations} observation{brain.observations === 1 ? "" : "s"}
          {brain.superseded ? ` · ${brain.superseded} superseded` : ""}
        </p>
      ) : null}
    </>
  );
}
