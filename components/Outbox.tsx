"use client";

import { useState } from "react";
import type { ActionStatus, ProposedAction } from "@/lib/types";

const STATUS: Record<ActionStatus, { dot: string; text: string }> = {
  pending: { dot: "bg-k-action pulse-slow", text: "text-k-action" },
  approved: { dot: "bg-ok", text: "text-ok" },
  sent: { dot: "bg-line-2", text: "text-dim" },
  rejected: { dot: "bg-faint", text: "text-faint" },
  failed: { dot: "bg-err", text: "text-err" },
};

export default function Outbox({
  actions,
  onDecide,
}: {
  actions: ProposedAction[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const pending = actions.filter((a) => a.status === "pending");
  const rest = actions.filter((a) => a.status !== "pending");
  const shown = [...pending, ...rest.slice(0, 4)];

  return (
    <section className="flex max-h-[46%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">outbox</h2>
        <span
          className={`tabular-nums ${pending.length ? "text-k-action" : "text-faint"}`}
        >
          {pending.length} awaiting you
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="p-3 text-faint leading-relaxed">
            nothing waiting. interns draft outbound messages here — they never
            send. you approve, VoiceOS sends.
          </p>
        ) : null}

        {shown.map((a) => {
          const s = STATUS[a.status];
          const expanded = open === a.id;
          return (
            <article
              key={a.id}
              className="enter border-b border-line px-3 py-2"
            >
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : a.id)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                <span className="text-fg">{a.kind}</span>
                <span className={s.text}>{a.status}</span>
                <span className="ml-auto shrink-0 text-faint">
                  {expanded ? "−" : "+"}
                </span>
              </button>

              <p className="mt-1 truncate text-dim" title={a.draft.to.join(", ")}>
                → {a.draft.to.join(", ")}
              </p>
              <p className="truncate text-fg">{a.draft.subject}</p>

              {expanded ? (
                <div className="mt-2 space-y-2">
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l border-line-2 pl-2 text-dim">
                    {a.draft.body}
                  </pre>
                  <p className="text-faint">{a.rationale}</p>
                  {a.sources.length ? (
                    <p className="text-faint">from: {a.sources.join(", ")}</p>
                  ) : null}
                  {a.result ? <p className="text-faint">{a.result}</p> : null}
                </div>
              ) : null}

              {a.status === "pending" ? (
                <div className="mt-2 flex gap-px">
                  <button
                    type="button"
                    onClick={() => onDecide(a.id, "approve")}
                    className="flex-1 border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
                  >
                    approve
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecide(a.id, "reject")}
                    className="flex-1 border border-line py-0.5 text-faint transition-colors hover:border-err/40 hover:text-err"
                  >
                    reject
                  </button>
                </div>
              ) : null}

              {a.status === "approved" ? (
                <p className="mt-1.5 text-faint">
                  approved via {a.decidedVia} · waiting for the sender
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
