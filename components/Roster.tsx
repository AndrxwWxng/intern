"use client";

import type { BrainStats, RoleId, TrustRecord } from "@/lib/types";

const BLURB: Record<RoleId, string> = {
  researcher: "maps a topic and files what it finds",
  correspondent: "drafts what goes out",
  archivist: "makes what exists citable",
  onboarder: "sets a person up, asks before guessing",
};

/**
 * The roster, with each role's accepted-unedited rate.
 *
 * The bar is the whole point of the panel: it is the only number that says
 * whether the thing is actually learning. A role that keeps getting edited has
 * a short bar however many tasks it finishes.
 */
export default function Roster({
  trust,
  brain,
  onGraduate,
}: {
  trust: TrustRecord[];
  brain: BrainStats | null;
  onGraduate: (role: RoleId, confirmed: boolean) => void;
}) {
  return (
    <>
      {trust.map((t) => (
        <div key={t.role} className="py-1">
          <div className="flex items-baseline gap-2">
            <span className={t.graduated ? "text-ok" : "text-dim"}>{t.role}</span>
            {t.graduated ? (
              <span className="text-ok" title="works unsupervised">
                ✓
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-faint">
              {t.decisions ? `${Math.round(t.rate * 100)}%` : "—"}
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
              : BLURB[t.role]}
          </p>

          {t.proposed ? (
            <div className="mt-1 flex gap-px">
              <button
                type="button"
                onClick={() => onGraduate(t.role, true)}
                className="flex-1 border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
                title="its drafts stop being reviewed"
              >
                graduate
              </button>
              <button
                type="button"
                onClick={() => onGraduate(t.role, false)}
                className="flex-1 border border-line py-0.5 text-faint hover:text-fg"
              >
                not yet
              </button>
            </div>
          ) : null}

          {t.graduated ? (
            <button
              type="button"
              onClick={() => onGraduate(t.role, false)}
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
